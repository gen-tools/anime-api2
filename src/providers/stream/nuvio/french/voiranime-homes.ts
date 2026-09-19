/**
 * Voiranime.homes — French anime catalogue, DLE-based, VF and VOSTFR per episode.
 *
 * Ported from temp/French/French/src/voiranime-homes. What makes this site cheap
 * to scrape is its episode API: one JSON call keyed on a series' internal news id
 * returns every episode in every language with a named server per link, so no
 * episode page is ever fetched. Finding that id is the whole problem.
 *
 * Its `?s=` search is decorative — every query answers with the same listing of
 * newest entries — so the real search is an AJAX POST, and the listing survives
 * here only as a fallback for very recent releases, cached under a single key
 * precisely because it does not vary by query. When neither search scores a
 * match, low-scoring candidates are opened and confirmed against the page's
 * `#serie-config` block and a live API response; slower, but it catches entries
 * whose displayed title resembles none of the titles we searched for.
 *
 * Seasons are the other quirk: each cour is filed as its own entry with "Saison N"
 * in the title, so matching the wrong one yields a plausible stream from the wrong
 * arc. Season agreement is therefore scored apart from title similarity, a wrong
 * season is penalised below the match threshold, and a season-qualified query is
 * retried whenever the best hit is not the season that was asked for.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  siteFetchText,
  siteFetchJson,
  loadHtml,
  normalize,
  countExtraWords,
  stripSeasonSuffix,
  resolveEmbedsUntil,
  isAborted,
  isBudgetExhausted,
  PROVIDER_BUDGET_MS,
  FR_ACCEPT_LANGUAGE,
  type MatchScores,
} from '../shared.js';

const SITE = 'https://voiranime.homes';
const LABEL = 'VoirAnime-Homes';

/** Answers with the newest entries whatever the query, hence the single cache key. */
const LISTING_URL = `${SITE}/?s=`;
const AJAX_SEARCH_URL = `${SITE}/engine/ajax/search.php`;
const EPISODE_API_URL = `${SITE}/engine/ajax/manga_episodes_api.php?id=`;

const MAX_SEARCH_TITLES = 3;
/** Candidates opened and verified individually once scoring has found nothing. */
const MAX_DEEP_CANDIDATES = 5;

const SCORES: MatchScores = { MIN_MATCH: 30, EXACT_MATCH: 150, STRONG_MATCH: 100 };

const NEWSID = /index\.php\?newsid=(\d+)/;
/** AJAX hits link to `/<newsid>-<slug>.html` instead of the query form. */
const NEWSID_IN_PATH = /(\d+)-/;
const SEASON_IN_TITLE = /Saison\s*(\d+)/i;
const ONCLICK_HREF = /location\.href\s*=\s*['"]([^'"]+)['"]/;

/**
 * The language keys the site's API uses.
 *
 * Only `vf` and `vostfr` are common, but the site names all four and a series
 * occasionally carries `vo`, so every one is read rather than the two that
 * usually show up.
 */
const LANGUAGE_LABELS: Record<string, string> = {
  vf: 'VF',
  vostfr: 'VOSTFR',
  vo: 'VO',
  multi: 'MULTI',
};

// ── Cache ────────────────────────────────────────────────────────────────────

/**
 * Small in-process cache, kept from upstream because two responses here are worth
 * not refetching: the `?s=` listing is identical for every query in a run, and one
 * lookup can ask the episode API for the same series id more than once — during
 * candidate verification and then again to read the episodes off it.
 */
interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 120;
const cache = new Map<string, CacheEntry>();

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.value as T;

  const value = await load();

  if (cache.size >= MAX_CACHE_ENTRIES) {
    const now = Date.now();
    for (const [k, entry] of cache) {
      if (now >= entry.expiresAt) cache.delete(k);
    }
    // A Map iterates in insertion order, so this evicts the oldest entries.
    while (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface SearchHit {
  url: string;
  /** Internal DLE id, when the card's href exposed one. */
  newsId: string | null;
  title: string;
  /** Poster alt text, which sometimes carries a season the title omits. */
  altTitle: string;
  /** The card's version badge, e.g. 'VF'. Informational: the API is authoritative. */
  version: string;
  season: number | null;
}

interface ServerLink {
  server: string;
  url: string;
}

interface ApiEpisode {
  num: number;
  servers: ServerLink[];
}

interface EpisodeApiData {
  /** Keyed by display label ('VF', 'VOSTFR', …), episodes sorted by number. */
  versions: Map<string, ApiEpisode[]>;
}

/** Raw API shape: `{ vf: { "3": { Sibnet: "https://…" } }, info: …, alt_titles: … }`. */
type EpisodeApiJson = Record<string, unknown>;

// ── HTTP ─────────────────────────────────────────────────────────────────────

function fetchPage(
  url: string,
  ctx: NuvioContext,
  timeoutMs = 15_000
): Promise<string | null> {
  return siteFetchText(url, {
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    timeoutMs,
    signal: ctx.signal,
  });
}

/**
 * Tidy a query for the AJAX endpoint.
 *
 * Regular hyphens survive on purpose — several titles here are indexed with them
 * ("Re-Kan") — while em-dashes and bracketing punctuation are dropped because the
 * endpoint treats them as literal characters and returns nothing.
 */
function sanitizeQuery(query: string): string {
  return String(query || '')
    .replace(/[–—]/g, ' ')
    .replace(/[‘’`]/g, "'")
    .replace(/[()[\]{}:;,!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function ajaxSearch(query: string, ctx: NuvioContext): Promise<string | null> {
  const sanitized = sanitizeQuery(query);
  if (!sanitized) return null;
  return siteFetchText(AJAX_SEARCH_URL, {
    form: { query: sanitized, page: '1' },
    headers: {
      Referer: `${SITE}/`,
      Origin: SITE,
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/html, */*',
    },
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    timeoutMs: 15_000,
    signal: ctx.signal,
  });
}

// ── Matching ─────────────────────────────────────────────────────────────────

function parseSeason(title: string): number | null {
  const match = String(title || '').match(SEASON_IN_TITLE);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Score a card title against a query, with season markers stripped from both.
 *
 * Season agreement is scored separately in `bestMatch`, and taking it out here is
 * what makes that possible: left in, "One Piece Saison 2" and "One Piece Saison 1"
 * would score differently against a bare "One Piece" for no reason to do with
 * which season was asked for.
 *
 * The extra-word penalty is what stops a fan edit winning — a query for "Naruto"
 * is a substring of "Naruto Shippuden Kai", so substring similarity alone ranks a
 * derivative upload as a perfect hit.
 */
function scoreMatch(resultTitle: string, searchTitle: string): number {
  const query = normalize(searchTitle);
  const result = normalize(resultTitle);
  if (!query || !result) return 0;

  const cleanQuery = query.replace(/saison\s*\d+/g, '').replace(/:\s*$/, '').trim();
  const cleanResult = result.replace(/saison\s*\d+/g, '').replace(/:\s*$/, '').trim();

  if (cleanResult === cleanQuery || result === query) return SCORES.EXACT_MATCH;

  if (result.includes(query) || query.includes(result)) {
    const extra = countExtraWords(result, query);
    if (extra > 0) {
      const penalty = Math.min(
        extra * 25,
        SCORES.STRONG_MATCH - SCORES.MIN_MATCH - 5
      );
      return Math.max(SCORES.STRONG_MATCH - penalty, 0);
    }
    return SCORES.STRONG_MATCH;
  }

  const words = cleanQuery.split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return 0;
  const resultWords = new Set(cleanResult.split(/\s+/));
  const matched = words.filter((w) => resultWords.has(w)).length;
  // A single shared word is a coincidence on a catalogue this size: "Law & Order"
  // would otherwise half-match "Police in a Pod".
  if (words.length >= 2 && matched < 2) return 0;
  return Math.round((matched / words.length) * 50);
}

/**
 * Pick the best hit, weighing season agreement on top of title similarity.
 *
 * The season adjustment only applies once a title has scored above zero. Without
 * that guard an unrelated show carrying the right season number in its title — a
 * "Saison 3" of anything at all — would collect the bonus purely for the digit.
 *
 * The right season is only rewarded on an otherwise clean match, so a derivative
 * already penalised for extra words cannot be lifted back above the exact title,
 * and a wrong season is penalised hard: for a split-cour show, the neighbouring
 * cour is the single most likely wrong answer and it looks entirely plausible.
 */
function bestMatch(
  hits: SearchHit[],
  title: string,
  targetSeason: number | null
): SearchHit | null {
  let best: SearchHit | null = null;
  let bestScore = 0;

  for (const hit of hits) {
    let score = scoreMatch(hit.title, title);

    if (targetSeason && score > 0) {
      const found = hit.season;
      if (found === targetSeason) {
        if (score >= SCORES.STRONG_MATCH) score += 40;
      } else if (found && Math.abs(found - targetSeason) === 1) {
        score -= 60;
      } else if (found && found !== targetSeason) {
        score -= 80;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      best = hit;
    }
  }

  return bestScore >= SCORES.MIN_MATCH ? best : null;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Read search hits out of either markup shape the site serves.
 *
 * The listing and category pages use `div.short` cards with a real anchor; the
 * AJAX endpoint uses `div.search-item` and puts the destination in an `onclick`
 * handler instead of an href. Both are parsed unconditionally because a single
 * response only ever contains one of them.
 */
function parseSearchResults(html: string | null): SearchHit[] {
  if (!html) return [];
  const $ = loadHtml(html);
  const results: SearchHit[] = [];

  for (const el of $('div.short').toArray()) {
    const $card = $(el);
    const $poster = $card.find('a.short-poster').first();
    const href = $poster.attr('href') || '';
    const title = $card.find('div.short-title').first().text().trim();
    if (!href || !title) continue;

    const altTitle = $poster.attr('alt') || '';
    const newsIdMatch = href.match(NEWSID);
    results.push({
      url: href.startsWith('http') ? href : `${SITE}${href}`,
      newsId: newsIdMatch ? newsIdMatch[1] : null,
      title,
      altTitle,
      version: $card.find('span.film-version a').first().text().trim() || 'VF',
      season: parseSeason(title) ?? parseSeason(altTitle),
    });
  }

  for (const el of $('div.search-item').toArray()) {
    const $item = $(el);
    const hrefMatch = ($item.attr('onclick') || '').match(ONCLICK_HREF);
    const href = hrefMatch ? hrefMatch[1] : '';
    const title =
      $item.find('.search-title').first().text().trim() ||
      $item.find('.search-item-title').first().text().trim();
    if (!href || !title) continue;

    const poster =
      $item.find('.search-poster img').attr('alt') ||
      $item.find('.search-item-poster img').attr('alt') ||
      '';
    const newsIdMatch = href.match(NEWSID_IN_PATH);
    results.push({
      url: href.startsWith('http') ? href : `${SITE}${href}`,
      newsId: newsIdMatch ? newsIdMatch[1] : null,
      title,
      altTitle: poster,
      version: 'VF',
      season: parseSeason(title) ?? parseSeason(poster),
    });
  }

  return results;
}

interface SerieConfig {
  title: string;
  newsId: string;
  pageUrl: string;
}

/** The series page's own declaration of what it is — the id the API needs. */
function parseSerieConfig(html: string | null): SerieConfig | null {
  if (!html) return null;
  const $ = loadHtml(html);
  const config = $('#serie-config').first();
  if (config.length === 0) return null;

  return {
    title: config.attr('data-title') || '',
    newsId: config.attr('data-news-id') || '',
    pageUrl: config.attr('data-page-url') || '',
  };
}

/**
 * Flatten the episode API into per-language episode lists.
 *
 * Upstream read only `vf` and `vostfr` despite naming four keys; all four are
 * read here so a series published in `vo` is not silently dropped.
 */
function parseEpisodeApi(json: EpisodeApiJson | null): EpisodeApiData | null {
  if (!json || typeof json !== 'object') return null;

  const versions = new Map<string, ApiEpisode[]>();

  for (const [langKey, label] of Object.entries(LANGUAGE_LABELS)) {
    const block = json[langKey];
    if (!block || typeof block !== 'object') continue;

    const episodes: ApiEpisode[] = [];
    for (const [epNum, servers] of Object.entries(block as Record<string, unknown>)) {
      const num = Number.parseInt(epNum, 10);
      if (!Number.isFinite(num)) continue;
      if (!servers || typeof servers !== 'object') continue;

      const links: ServerLink[] = [];
      for (const [server, url] of Object.entries(servers as Record<string, unknown>)) {
        if (typeof url === 'string' && url.startsWith('http')) {
          links.push({ server, url });
        }
      }
      if (links.length > 0) episodes.push({ num, servers: links });
    }

    if (episodes.length === 0) continue;
    episodes.sort((a, b) => a.num - b.num);
    versions.set(label, episodes);
  }

  return versions.size > 0 ? { versions } : null;
}

function fetchEpisodeApi(newsId: string, ctx: NuvioContext): Promise<EpisodeApiData | null> {
  return cached(`episodes_${newsId}`, async () => {
    const json = await siteFetchJson<EpisodeApiJson>(`${EPISODE_API_URL}${newsId}`, {
      headers: { Referer: `${SITE}/`, 'X-Requested-With': 'XMLHttpRequest' },
      acceptLanguage: FR_ACCEPT_LANGUAGE,
      timeoutMs: 10_000,
      signal: ctx.signal,
    });
    return parseEpisodeApi(json);
  });
}

// ── Search ───────────────────────────────────────────────────────────────────

/** The newest-entries listing, fetched at most once per run. */
async function searchListing(
  title: string,
  targetSeason: number | null,
  ctx: NuvioContext
): Promise<SearchHit | null> {
  const html = await cached('listing', () => fetchPage(LISTING_URL, ctx));
  const results = parseSearchResults(html);
  if (results.length === 0) return null;
  return bestMatch(results, title, targetSeason);
}

/**
 * Open low-scoring candidates and confirm them against the page and the API.
 *
 * Titles on the cards are shortened and sometimes localized differently from
 * anything ani.zip returns, so a series can be present and still score below the
 * threshold. `#serie-config`'s `data-title` is the full one, and requiring a live
 * API response on top means a confirmed candidate is known to have episodes rather
 * than merely to exist.
 *
 * Sequential where upstream ran all five at once: the answer is the same — it took
 * the first fulfilled promise in array order, not the first to arrive — for a fifth
 * of the requests in the common case where the first candidate is right.
 */
async function verifyCandidates(
  hits: SearchHit[],
  titles: string[],
  ctx: NuvioContext,
  startTime: number
): Promise<SearchHit | null> {
  const query = normalize(titles[0] || '');
  if (!query || hits.length === 0) return null;

  const unique: SearchHit[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    if (!hit.url || seen.has(hit.url)) continue;
    seen.add(hit.url);
    unique.push(hit);
  }

  for (const hit of unique.slice(0, MAX_DEEP_CANDIDATES)) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;

    const html = await fetchPage(hit.url, ctx, 8_000);
    const config = parseSerieConfig(html);
    if (!config?.title || !config.newsId) continue;

    const found = normalize(config.title);
    const related =
      found === query || found.includes(query) || query.includes(found);
    // Two or more unexpected significant words means a derivative, not this show.
    if (!related || countExtraWords(found, query) >= 2) continue;

    const api = await fetchEpisodeApi(config.newsId, ctx);
    if (!api) continue;

    return {
      url: config.pageUrl || hit.url,
      newsId: config.newsId,
      title: config.title,
      altTitle: hit.altTitle,
      version: hit.version,
      season: parseSeason(config.title) ?? hit.season,
    };
  }

  return null;
}

/**
 * Find the series, cheapest search first.
 *
 * Every AJAX result seen along the way is kept even when it scored too low,
 * because they are the only input the verification pass has to work with.
 */
async function findSeries(
  titles: string[],
  targetSeason: number | null,
  ctx: NuvioContext,
  startTime: number
): Promise<SearchHit | null> {
  const queries = titles.slice(0, MAX_SEARCH_TITLES).map((t) => stripSeasonSuffix(t));
  const collected: SearchHit[] = [];
  const seen = new Set<string>();

  for (const query of queries) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return null;

    const html = await ajaxSearch(query, ctx);
    if (html && html.length > 50) {
      const results = parseSearchResults(html);
      if (results.length > 0) {
        for (const hit of results) {
          const key = hit.newsId || hit.url;
          if (!key || seen.has(key)) continue;
          seen.add(key);
          collected.push(hit);
        }
        const match = bestMatch(results, query, targetSeason);
        if (match) return match;
      }
    }

    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return null;
    const listingMatch = await searchListing(query, targetSeason, ctx);
    if (listingMatch) return listingMatch;
  }

  if (collected.length > 0) {
    return verifyCandidates(collected, titles, ctx, startTime);
  }
  return null;
}

/**
 * Re-search with the season spelled out when the first match is the wrong cour.
 *
 * A hit with no season at all is just as suspect as an explicitly wrong one: it is
 * usually a film or a compilation entry sitting under the bare series name. One
 * attempt is enough, since stripping the suffix off any of the titles yields the
 * same base string.
 */
async function retryForSeason(
  match: SearchHit,
  titles: string[],
  targetSeason: number,
  ctx: NuvioContext
): Promise<SearchHit> {
  const query = `${stripSeasonSuffix(titles[0] || '')} Saison ${targetSeason}`;
  const html = await ajaxSearch(query, ctx);
  if (!html || html.length <= 50) return match;

  const results = parseSearchResults(html);
  if (results.length === 0) return match;

  const seasonMatch = bestMatch(results, titles[0] || '', targetSeason);
  // Only accept a replacement that actually is the season asked for; anything
  // else is no better than what we already have.
  return seasonMatch?.season === targetSeason ? seasonMatch : match;
}

/** The API id, from the search card when it carried one or the page if not. */
async function resolveNewsId(
  match: SearchHit,
  ctx: NuvioContext
): Promise<string | null> {
  if (match.newsId) return match.newsId;
  const html = await fetchPage(match.url, ctx);
  const config = parseSerieConfig(html);
  return config?.newsId || null;
}

// ── Streams ──────────────────────────────────────────────────────────────────

function remainingBudget(startTime: number): number {
  return Math.max(2_000, PROVIDER_BUDGET_MS - (Date.now() - startTime));
}

function targetEpisodes(ctx: NuvioContext): number[] {
  const out: number[] = [];
  for (const value of [ctx.episode, ctx.absoluteEpisode]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * Locate one episode in a language's list.
 *
 * The positional fallback is for entries numbered absolutely — a cour published as
 * episodes 1076-1088 has no episode 3 even though episode 3 of that cour exists —
 * and it is only reachable when the numeric lookup fails, which for a list
 * numbered from 1 it cannot.
 */
function findEpisode(episodes: ApiEpisode[], targets: number[]): ApiEpisode | null {
  for (const target of targets) {
    const exact = episodes.find((e) => e.num === target);
    if (exact) return exact;
  }
  for (const target of targets) {
    const positional = episodes[target - 1];
    if (positional) return positional;
  }
  return null;
}

async function streamsFor(
  episode: ApiEpisode,
  language: string,
  ctx: NuvioContext,
  startTime: number
): Promise<NuvioStream[]> {
  return resolveEmbedsUntil(
    episode.servers.map((s) => ({ url: s.url, server: s.server, quality: 'HD' })),
    {
      language,
      providerLabel: LABEL,
      siteUrl: SITE,
      headers: { Referer: `${SITE}/` },
      signal: ctx.signal,
      // Per language, so a long list of dead VF mirrors cannot starve VOSTFR.
      target: 2,
      budgetMs: remainingBudget(startTime),
    }
  );
}

// ── Extraction ───────────────────────────────────────────────────────────────

async function extractMovie(
  ctx: NuvioContext,
  startTime: number
): Promise<NuvioStream[]> {
  const match = await findSeries(ctx.titles, null, ctx, startTime);
  if (!match) return [];

  const newsId = await resolveNewsId(match, ctx);
  if (!newsId) return [];

  const api = await fetchEpisodeApi(newsId, ctx);
  if (!api) return [];

  const streams: NuvioStream[] = [];
  // A film is filed as a one-episode series, so the first entry is the film.
  for (const [language, episodes] of api.versions) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    const first = episodes[0];
    if (!first) continue;
    streams.push(...(await streamsFor(first, language, ctx, startTime)));
  }

  return streams;
}

async function extractSeries(
  ctx: NuvioContext,
  startTime: number
): Promise<NuvioStream[]> {
  const targetSeason = ctx.season ?? 1;
  const targets = targetEpisodes(ctx);
  if (targets.length === 0) return [];

  let match = await findSeries(ctx.titles, targetSeason, ctx, startTime);
  if (!match) return [];

  if (
    targetSeason >= 1 &&
    match.season !== targetSeason &&
    !isAborted(ctx.signal) &&
    !isBudgetExhausted(startTime)
  ) {
    match = await retryForSeason(match, ctx.titles, targetSeason, ctx);
  }

  const newsId = await resolveNewsId(match, ctx);
  if (!newsId) return [];

  const api = await fetchEpisodeApi(newsId, ctx);
  if (!api) return [];

  const streams: NuvioStream[] = [];
  for (const [language, episodes] of api.versions) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    const episode = findEpisode(episodes, targets);
    if (!episode) continue;
    streams.push(...(await streamsFor(episode, language, ctx, startTime)));
  }

  return streams;
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];
  const startTime = Date.now();
  return ctx.type === 'movie'
    ? extractMovie(ctx, startTime)
    : extractSeries(ctx, startTime);
}

export const voiranimehomes = createNuvioProvider({
  name: 'voiranimehomes',
  sites: [SITE],
  language: 'fr',
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'ja',
});
