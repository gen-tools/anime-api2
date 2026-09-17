/**
 * French-Manga — French anime catalogue (VF + VOSTFR) built on DataLife Engine.
 *
 * Ported from temp/French/French/src/french-manga.
 *
 * The site does not render its player links into the episode page. Every entry
 * carries a DLE `newsid`, and a single JSON endpoint
 * (`manga_episodes_api.php?id=<newsid>`) returns the full grid of
 * language → episode → server → embed URL for that entry. So the whole scrape is
 * "find the newsid, read one JSON blob", and the only hard part is picking the
 * right entry out of a catalogue full of derivative uploads.
 *
 * Two search paths exist because they cover different gaps: the AJAX endpoint is
 * a real search but only indexes the site's own French titles, while the plain
 * GET always returns the same 36-item "latest updates" listing regardless of the
 * query — useless as a search, but it does catch currently-airing shows the AJAX
 * index has not picked up yet.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  loadHtml,
  normalize,
  countExtraWords,
  stripSeasonSuffix,
  siteFetchText,
  siteFetchJson,
  resolveEmbedsUntil,
  isAborted,
  isBudgetExhausted,
  FR_ACCEPT_LANGUAGE,
} from '../shared.js';

const SITE = 'https://w16.french-manga.net';
const LABEL = 'FrenchManga';

const SEARCH_URL = `${SITE}/?s=`;
const AJAX_SEARCH_URL = `${SITE}/engine/ajax/search.php`;
const EPISODES_API = `${SITE}/engine/ajax/manga_episodes_api.php?id=`;

const NEWSID = /index\.php\?newsid=(\d+)/;
const SEASON_IN_TITLE = /Saison\s*(\d+)/i;

/** The site's own scores, not the shared defaults — see `scoreMatch`. */
const SCORES = { MIN_MATCH: 30, EXACT_MATCH: 150, STRONG_MATCH: 100 };

const MAX_SEARCH_TITLES = 5;
/** Beyond two servers per language the remaining mirrors are near-duplicates. */
const MAX_SERVERS_PER_LANG = 2;

interface SearchResult {
  url: string;
  newsid: string | null;
  title: string;
  altTitle: string;
  version: string;
  season: number | null;
}

interface SerieConfig {
  title: string;
  newsId: string;
  pageUrl: string;
}

interface ServerLink {
  name: string;
  url: string;
}

interface EpisodeEntry {
  num: number;
  servers: ServerLink[];
}

/** `{ vf: { "12": { sibnet: "https://…" } }, vostfr: {…}, info: {…} }` */
interface EpisodeApiJson {
  [language: string]: unknown;
}

interface EpisodeApiData {
  /** Keyed by the site's language label: 'VF', 'VOSTFR'. */
  versions: Record<string, EpisodeEntry[]>;
}

const LANGUAGE_MAP: Record<string, string> = {
  vf: 'VF',
  vostfr: 'VOSTFR',
  vo: 'VO',
  multi: 'MULTI',
};

/**
 * Match a catalogue title against a search title.
 *
 * Diverges from the shared `scoreTitleMatch` in three ways the site needs. Season
 * markers are stripped before comparison, because an entry is titled
 * "One Piece Saison 2" while the query is the bare show name. A query of three
 * words or fewer is rejected outright when the result adds three or more
 * significant words — "Invincible" must not match "Became Invincible …". And a
 * multi-word query that shares fewer than two words with the result is rejected,
 * which is what stops "Law & Order" from landing on "Police in a Pod".
 */
function scoreMatch(resultTitle: string, searchTitle: string): number {
  const nt = normalize(searchTitle);
  const nr = normalize(resultTitle);
  if (!nt || !nr) return 0;

  const cleanNr = nr.replace(/saison\s*\d+/g, '').replace(/:\s*$/, '').trim();
  const cleanNt = nt.replace(/saison\s*\d+/g, '').replace(/:\s*$/, '').trim();

  if (cleanNr === cleanNt || nr === nt) return SCORES.EXACT_MATCH;
  if (nr.includes(nt) || nt.includes(nr)) {
    const extra = countExtraWords(nr, nt);
    const qWordCount = cleanNt.split(/\s+/).length;
    if (qWordCount <= 3 && extra >= 3) return 0;
    if (extra > 0) {
      return Math.max(
        SCORES.STRONG_MATCH -
          Math.min(extra * 25, SCORES.STRONG_MATCH - SCORES.MIN_MATCH - 5),
        0
      );
    }
    return SCORES.STRONG_MATCH;
  }

  const words = cleanNt.split(/\s+/).filter((w) => w.length > 2);
  const rWords = new Set(cleanNr.split(/\s+/));
  const matched = words.filter((w) => rWords.has(w)).length;
  if (words.length > 0) {
    if (words.length >= 2 && matched < 2) return 0;
    return Math.round((matched / words.length) * 50);
  }
  return 0;
}

function extractSeason(title: string): number | null {
  const m = (title || '').match(SEASON_IN_TITLE);
  return m ? Number.parseInt(m[1], 10) : null;
}

/**
 * Best candidate, with the season number acting as a tie-breaker.
 *
 * The season bonus only applies to results that already scored a clean title
 * match: otherwise an unrelated "Oshi no Ko - Saison 3" outranks the correct
 * entry purely because the digit lines up.
 */
function bestMatch(
  items: SearchResult[],
  title: string,
  targetSeason: number | null
): SearchResult | null {
  let best: SearchResult | null = null;
  let bestScore = 0;
  for (const item of items) {
    let score = scoreMatch(item.title, title);
    if (targetSeason && score > 0) {
      const rs = item.season;
      if (rs === targetSeason) {
        if (score >= SCORES.STRONG_MATCH) score += 40;
      } else if (rs && Math.abs(rs - targetSeason) === 1) {
        score -= 60;
      } else if (rs && rs !== targetSeason) {
        score -= 80;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return bestScore >= SCORES.MIN_MATCH ? best : null;
}

/**
 * Parse both card shapes the site emits.
 *
 * `div.short` is the home page and category listings; `div.search-item` is the
 * AJAX response, which puts the target URL in an `onclick` handler rather than an
 * href and labels its title `.search-title` (not `.search-item-title`, despite
 * the surrounding class names).
 */
function parseSearchResults(html: string): SearchResult[] {
  if (!html) return [];
  const $ = loadHtml(html);
  const results: SearchResult[] = [];

  $('div.short').each((_i, el) => {
    const $card = $(el);
    const $poster = $card.find('a.short-poster').first();
    const href = $poster.attr('href') || '';
    const title = $card.find('div.short-title').first().text().trim();
    const altTitle = $poster.attr('alt') || '';
    const version = $card.find('span.film-version a').first().text().trim() || 'VF';
    if (!href || !title) return;

    const newsidMatch = href.match(NEWSID);
    results.push({
      url: href.startsWith('http') ? href : `${SITE}${href}`,
      newsid: newsidMatch ? newsidMatch[1] : null,
      title,
      altTitle,
      version,
      season: extractSeason(title) || extractSeason(altTitle),
    });
  });

  $('div.search-item').each((_i, el) => {
    const $item = $(el);
    const onclick = $item.attr('onclick') || '';
    const hrefMatch = onclick.match(/location\.href\s*=\s*['"]([^'"]+)['"]/);
    const href = hrefMatch ? hrefMatch[1] : '';
    const title =
      $item.find('.search-title').first().text().trim() ||
      $item.find('.search-item-title').first().text().trim();
    const poster =
      $item.find('.search-poster img').attr('alt') ||
      $item.find('.search-item-poster img').attr('alt') ||
      '';
    if (!href || !title) return;

    const newsidMatch = href.match(/(\d+)-/);
    results.push({
      url: href.startsWith('http') ? href : `${SITE}${href}`,
      newsid: newsidMatch ? newsidMatch[1] : null,
      title,
      altTitle: poster,
      version: 'VF',
      season: extractSeason(title) || extractSeason(poster),
    });
  });

  return results;
}

/** `#serie-config` carries the authoritative newsid for an entry page. */
function parseSerieConfig(html: string): SerieConfig | null {
  if (!html) return null;
  const $ = loadHtml(html);
  const $config = $('#serie-config');
  if (!$config.length) return null;
  return {
    title: $config.attr('data-title') || '',
    newsId: $config.attr('data-news-id') || '',
    pageUrl: $config.attr('data-page-url') || '',
  };
}

function parseEpisodeApiData(json: EpisodeApiJson | null): EpisodeApiData | null {
  if (!json) return null;

  const versions: Record<string, EpisodeEntry[]> = {};
  for (const lang of ['vf', 'vostfr']) {
    const block = json[lang];
    if (!block || typeof block !== 'object') continue;

    const episodes: EpisodeEntry[] = [];
    for (const [epNum, servers] of Object.entries(block as Record<string, unknown>)) {
      const num = Number.parseInt(epNum, 10);
      if (Number.isNaN(num) || !servers || typeof servers !== 'object') continue;

      const serverLinks: ServerLink[] = [];
      for (const [name, url] of Object.entries(servers as Record<string, unknown>)) {
        if (typeof url === 'string' && url.startsWith('http')) {
          serverLinks.push({ name, url });
        }
      }
      if (serverLinks.length > 0) episodes.push({ num, servers: serverLinks });
    }

    episodes.sort((a, b) => a.num - b.num);
    versions[LANGUAGE_MAP[lang] || lang.toUpperCase()] = episodes;
  }

  return { versions };
}

/**
 * Strip the punctuation the AJAX endpoint chokes on.
 *
 * Regular hyphens survive: several entries index with them ("Re-Main").
 */
function sanitizeSearchQuery(query: string): string {
  return (query || '')
    .replace(/[–—]/g, ' ')
    .replace(/[''`]/g, "'")
    .replace(/[()[\]{}:;,!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function ajaxSearch(
  query: string,
  signal: AbortSignal
): Promise<SearchResult[]> {
  const html = await siteFetchText(AJAX_SEARCH_URL, {
    form: { query: sanitizeSearchQuery(query), page: '1' },
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    timeoutMs: 15_000,
    signal,
  });
  // A shorter body than this is the endpoint's empty-result wrapper.
  if (!html || html.length <= 50) return [];
  return parseSearchResults(html);
}

async function fetchEpisodeApi(
  newsid: string,
  signal: AbortSignal
): Promise<EpisodeApiData | null> {
  const json = await siteFetchJson<EpisodeApiJson>(`${EPISODES_API}${newsid}`, {
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    timeoutMs: 10_000,
    signal,
  });
  return parseEpisodeApiData(json);
}

/**
 * Last resort: open the top few low-scoring results and trust their own metadata.
 *
 * The AJAX index stores French titles, so an English query can score every result
 * at zero and still have the right entry among them. `#serie-config`'s
 * `data-title` is the site's canonical name, and confirming it has episode data
 * proves the page is a real entry rather than a stub.
 */
async function trySearchFallback(
  allResults: SearchResult[],
  titles: string[],
  signal: AbortSignal,
  startTime: number
): Promise<SearchResult | null> {
  const nt = normalize(titles[0] || '');
  if (!nt || allResults.length === 0) return null;

  const seen = new Set<string>();
  const unique: SearchResult[] = [];
  for (const r of allResults) {
    if (r.url && !seen.has(r.url)) {
      seen.add(r.url);
      unique.push(r);
    }
  }

  for (const result of unique.slice(0, 5)) {
    if (isAborted(signal) || isBudgetExhausted(startTime)) break;
    const html = await siteFetchText(result.url, {
      acceptLanguage: FR_ACCEPT_LANGUAGE,
      timeoutMs: 8_000,
      signal,
    });
    if (!html) continue;
    const config = parseSerieConfig(html);
    if (!config?.title || !config.newsId) continue;

    const nr = normalize(config.title);
    // A derivative with two or more significant extra words ("Naruto Shippuden
    // Kai" for a "Naruto" query) contains the query as a substring but is not it.
    const extra = countExtraWords(nr, nt);
    if (!(nr === nt || nr.includes(nt) || nt.includes(nr)) || extra >= 2) continue;

    const apiData = await fetchEpisodeApi(config.newsId, signal);
    if (apiData) {
      return {
        url: config.pageUrl || result.url,
        newsid: config.newsId,
        title: config.title,
        altTitle: '',
        version: 'VF',
        season: extractSeason(config.title),
      };
    }
  }
  return null;
}

async function trySearch(
  titles: string[],
  targetSeason: number | null,
  signal: AbortSignal,
  startTime: number
): Promise<SearchResult | null> {
  const cleanTitles = titles.map((t) => stripSeasonSuffix(t));
  const allPostResults: SearchResult[] = [];
  const dedup = new Set<string>();
  let listingFetched = false;
  let listing: SearchResult[] = [];

  for (const title of cleanTitles.slice(0, MAX_SEARCH_TITLES)) {
    if (isAborted(signal) || isBudgetExhausted(startTime)) break;

    const postResults = await ajaxSearch(title, signal);
    for (const r of postResults) {
      const key = r.newsid || r.url;
      if (key && !dedup.has(key)) {
        dedup.add(key);
        allPostResults.push(r);
      }
    }
    // Do not stop on a miss: the AJAX index answers "Attack on Titan" with
    // French titles that score zero, while "L'Attaque des Titans" matches.
    const postMatch = bestMatch(postResults, title, targetSeason);
    if (postMatch) return postMatch;

    if (!listingFetched) {
      listingFetched = true;
      const html = await siteFetchText(SEARCH_URL, {
        acceptLanguage: FR_ACCEPT_LANGUAGE,
        timeoutMs: 15_000,
        signal,
      });
      listing = html ? parseSearchResults(html) : [];
    }
    const getMatch = bestMatch(listing, title, targetSeason);
    if (getMatch) return getMatch;
  }

  if (allPostResults.length > 0) {
    const accumulated = bestMatch(allPostResults, cleanTitles[0], targetSeason);
    if (accumulated) return accumulated;
    return trySearchFallback(allPostResults, titles, signal, startTime);
  }
  return null;
}

async function resolveNewsId(
  match: SearchResult,
  signal: AbortSignal
): Promise<string | null> {
  if (match.newsid) return match.newsid;
  const html = await siteFetchText(match.url, {
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    timeoutMs: 15_000,
    signal,
  });
  if (!html) return null;
  return parseSerieConfig(html)?.newsId || null;
}

/**
 * Some resolved HLS URLs land on a CDN host that answers 403 for every request.
 * Its working sibling is `cdn-tnmr.org`, so the bare host is filtered rather than
 * the whole family.
 */
function isBlockedCdn(url: string): boolean {
  const value = url.toLowerCase();
  return value.includes('tnmr.org') && !value.includes('cdn-tnmr.org');
}

/**
 * Resolve one episode's servers, keeping each language separate.
 *
 * A URL that appears under both VF and VOSTFR is the same file, so the first
 * language listed wins — emitting it twice would advertise one of the two audio
 * tracks that does not exist.
 */
async function streamsForServers(
  versions: Record<string, EpisodeEntry[]>,
  pick: (episodes: EpisodeEntry[]) => EpisodeEntry | undefined,
  signal: AbortSignal
): Promise<NuvioStream[]> {
  const out: NuvioStream[] = [];
  const seenUrls = new Set<string>();

  for (const [lang, episodes] of Object.entries(versions)) {
    if (isAborted(signal)) break;
    const ep = pick(episodes);
    if (!ep) continue;

    const embeds = ep.servers
      .filter((s) => {
        if (seenUrls.has(s.url)) return false;
        seenUrls.add(s.url);
        return true;
      })
      .map((s) => ({ url: s.url, language: lang, server: s.name }));

    const resolved = await resolveEmbedsUntil(embeds, {
      language: lang,
      providerLabel: LABEL,
      siteUrl: SITE,
      target: MAX_SERVERS_PER_LANG,
      signal,
    });
    out.push(...resolved.filter((s) => !isBlockedCdn(s.url)));
  }

  return out;
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  const startTime = Date.now();
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];

  if (ctx.type === 'movie') {
    const match = await trySearch(ctx.titles, null, ctx.signal, startTime);
    if (!match) return [];
    const newsid = await resolveNewsId(match, ctx.signal);
    if (!newsid) return [];
    const apiData = await fetchEpisodeApi(newsid, ctx.signal);
    if (!apiData) return [];
    // A film is stored as a one-episode series.
    return streamsForServers(apiData.versions, (episodes) => episodes[0], ctx.signal);
  }

  const targetSeason = ctx.season ?? 1;
  const targets = [ctx.episode, ctx.absoluteEpisode].filter(
    (n): n is number => typeof n === 'number' && n > 0
  );
  const targetEpisodes = [...new Set(targets.length > 0 ? targets : [1])];

  let match = await trySearch(ctx.titles, targetSeason, ctx.signal, startTime);
  if (!match) return [];

  // The catalogue splits seasons across separate entries, and the generic search
  // happily returns "One Piece Film - Red" (no season) for a season-1 query. When
  // the winning entry does not carry the requested season, ask for it by name.
  const needsSeasonRetry =
    targetSeason >= 1 && (match.season == null || match.season !== targetSeason);
  if (needsSeasonRetry && !isAborted(ctx.signal) && !isBudgetExhausted(startTime)) {
    const baseTitle = stripSeasonSuffix(ctx.titles[0]);
    const results = await ajaxSearch(`${baseTitle} Saison ${targetSeason}`, ctx.signal);
    if (results.length > 0) {
      const seasonMatch = bestMatch(results, ctx.titles[0], targetSeason);
      if (seasonMatch && seasonMatch.season === targetSeason) match = seasonMatch;
    }
  }

  const newsid = await resolveNewsId(match, ctx.signal);
  if (!newsid) return [];
  const apiData = await fetchEpisodeApi(newsid, ctx.signal);
  if (!apiData) return [];

  return streamsForServers(
    apiData.versions,
    (episodes) => {
      for (const target of targetEpisodes) {
        const exact = episodes.find((e) => e.num === target);
        if (exact) return exact;
      }
      // Positional fallback: some entries number from the series start while the
      // grid itself is the cour, so index N-1 is the requested episode.
      return episodes[targetEpisodes[0] - 1];
    },
    ctx.signal
  );
}

export const frenchmanga = createNuvioProvider({
  name: 'frenchmanga',
  sites: [SITE],
  language: 'fr',
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'ja',
});
