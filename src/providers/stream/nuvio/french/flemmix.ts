/**
 * Flemmix — French films and series catalogue (VF, VO, VOSTFR).
 *
 * Ported from temp/French/French/src/flemmix.
 *
 * The cleanest of the French sites to scrape: `/search?q=` answers with JSON, and
 * every watch page lists its servers as `<button data-url="…">` tabs carrying their
 * own quality and language pills. So there is no AJAX round-trip per server and no
 * id-to-index guesswork — one page fetch yields the full set.
 *
 * Series are three levels deep: the show page lists `a.season-card` links ending in
 * `/saison-N`, a season page lists `a.episode-card` links ending in `/NxM`, and the
 * episode page holds the tabs. When search returns nothing the category listing
 * (`/films`, `/series`) is walked instead, which is a real fallback here because
 * those pages render the whole catalogue as plain links.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  loadHtml,
  normalize,
  countExtraWords,
  stripSeasonSuffix,
  absoluteUrl,
  siteFetchText,
  siteFetchJson,
  resolveEmbedsUntil,
  isAborted,
  isBudgetExhausted,
  FR_ACCEPT_LANGUAGE,
  type TokoCheerio,
} from '../shared.js';

const SITE = 'https://flemmix.me';
const LABEL = 'Flemmix';

const SEARCH_URL = `${SITE}/search?q=`;

const SEASON_LINK = /\/saison-(\d+)$/i;
const EPISODE_LINK = /\/(\d+)x(\d+)$/i;

/** The site's own thresholds, not the shared defaults. */
const SCORES = { MIN_MATCH: 30, EXACT_MATCH: 150, STRONG_MATCH: 100 };

const SEARCH_TIMEOUT_MS = 15_000;
const PAGE_TIMEOUT_MS = 15_000;
const MAX_SEARCH_TITLES = 3;
/** Past three mirrors per language the remaining tabs are the same file again. */
const MAX_SERVERS_PER_LANGUAGE = 3;

/** Pill text is a locale code on some pages and a version tag on others. */
const LANGUAGE_MAP: Record<string, string> = {
  fr: 'VF',
  en: 'VO',
  us: 'VO',
  vf: 'VF',
  vo: 'VO',
  vostfr: 'VOSTFR',
};

interface Candidate {
  url: string;
  title: string;
  isSeries: boolean;
}

interface ServerTab {
  url: string;
  quality: string;
  language: string;
  isActive: boolean;
}

interface SeasonLink {
  num: number;
  link: string;
}

interface EpisodeLink {
  season: number;
  episode: number;
  link: string;
}

interface SearchJsonItem {
  url?: string;
  title?: string;
  type?: string;
  year?: number | string;
}

/**
 * Match a catalogue title against a search title.
 *
 * Season markers are stripped first, because the site titles an entry
 * "One Piece Saison 2" while the query is the bare show name. Each significant word
 * the result adds beyond the query costs 25 points, which is what stops a recut
 * ("Naruto Shippuden Kai" for a "Naruto" query) from beating the exact entry. The
 * final clause rejects a multi-word query that shares fewer than two words with the
 * result — otherwise "Law & Order" lands on "Police in a Pod".
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

function bestMatch(items: Candidate[], title: string): Candidate | null {
  let best: Candidate | null = null;
  let bestScore = 0;
  for (const item of items) {
    const score = scoreMatch(item.title, title);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return bestScore >= SCORES.MIN_MATCH ? best : null;
}

/**
 * Read the server tabs off a watch page.
 *
 * The active tab is the site's own default, and it is listed first here because
 * resolution stops once enough streams are playable — so the order decides which
 * servers actually get tried.
 */
function parseServerTabs(
  $: TokoCheerio,
  tabSelector: string,
  qualitySelector: string,
  langSelector: string
): ServerTab[] {
  const servers: ServerTab[] = [];
  $(tabSelector).each((_i, el) => {
    const $tab = $(el);
    const url = $tab.attr('data-url');
    if (!url) return;

    const isActive = ($tab.attr('class') || '').split(/\s+/).includes('is-active');
    const quality = $tab.find(qualitySelector).first().text().trim() || 'HD';
    const langRaw = $tab.find(langSelector).first().text().trim().toLowerCase();
    const language = LANGUAGE_MAP[langRaw] || 'VF';

    servers.push({ url, quality, language, isActive });
  });

  return [
    ...servers.filter((s) => s.isActive),
    ...servers.filter((s) => !s.isActive),
  ];
}

function parseSearchResults(json: unknown): Candidate[] {
  if (!Array.isArray(json)) return [];
  return (json as SearchJsonItem[])
    .filter((item) => item.url && item.title)
    .map((item) => ({
      url: absoluteUrl(String(item.url), SITE),
      title: String(item.title),
      isSeries: item.type === 'tvshow',
    }));
}

function parseSeasons(html: string): SeasonLink[] {
  const $ = loadHtml(html);
  const seasons: SeasonLink[] = [];
  $('a.season-card').each((_i, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(SEASON_LINK);
    if (m) {
      seasons.push({
        num: Number.parseInt(m[1], 10),
        link: absoluteUrl(href, SITE),
      });
    }
  });
  return seasons;
}

function parseSeasonEpisodes(html: string): EpisodeLink[] {
  const $ = loadHtml(html);
  const episodes: EpisodeLink[] = [];
  $('a.episode-card').each((_i, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(EPISODE_LINK);
    if (m) {
      episodes.push({
        season: Number.parseInt(m[1], 10),
        episode: Number.parseInt(m[2], 10),
        link: absoluteUrl(href, SITE),
      });
    }
  });
  return episodes;
}

async function fetchPage(url: string, signal: AbortSignal): Promise<string | null> {
  return siteFetchText(url, {
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    timeoutMs: PAGE_TIMEOUT_MS,
    signal,
  });
}

/**
 * Search each title until one produces a confident match.
 *
 * Results are filtered to the requested media type first, but fall back to the
 * unfiltered set: the JSON `type` field is missing on older entries, and dropping
 * them would lose real matches.
 */
async function trySearch(
  titles: string[],
  wantSeries: boolean,
  signal: AbortSignal,
  startTime: number
): Promise<Candidate | null> {
  for (const title of titles.slice(0, MAX_SEARCH_TITLES)) {
    if (isAborted(signal) || isBudgetExhausted(startTime)) break;

    const json = await siteFetchJson<unknown>(
      `${SEARCH_URL}${encodeURIComponent(title)}`,
      {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        acceptLanguage: FR_ACCEPT_LANGUAGE,
        timeoutMs: SEARCH_TIMEOUT_MS,
        signal,
      }
    );
    const results = parseSearchResults(json);
    if (results.length === 0) continue;

    const filtered = results.filter((r) => r.isSeries === wantSeries);
    const match = bestMatch(filtered.length > 0 ? filtered : results, title);
    if (match) return match;
  }
  return null;
}

/**
 * Walk the category listing when search comes up empty.
 *
 * `/films` and `/series` render every entry as a plain link, so scoring their anchor
 * text is equivalent to searching an index the endpoint has not caught up with.
 */
async function browseCategory(
  type: 'movie' | 'tv',
  titles: string[],
  signal: AbortSignal
): Promise<Candidate | null> {
  const baseType = type === 'movie' ? 'films' : 'series';
  const linkPattern = type === 'movie' ? '/film/' : '/serie/';

  const html = await fetchPage(`${SITE}/${baseType}`, signal);
  if (!html) return null;

  const $ = loadHtml(html);
  const items: Candidate[] = [];
  $(`a[href*="${linkPattern}"]`).each((_i, el) => {
    const href = $(el).attr('href') || '';
    const title = $(el).text().trim() || $(el).find('img').first().attr('alt') || '';
    if (href && title) {
      items.push({
        url: absoluteUrl(href, SITE),
        title,
        isSeries: type === 'tv',
      });
    }
  });
  if (items.length === 0) return null;

  for (const title of titles.slice(0, MAX_SEARCH_TITLES)) {
    if (isAborted(signal)) break;
    const match = bestMatch(items, title);
    if (match) return match;
  }
  return null;
}

/**
 * Resolve the tabs, one language at a time.
 *
 * Grouping by language before capping is what keeps both VF and VOSTFR: a single
 * global cap would spend its whole budget on whichever version the site happened to
 * list first.
 */
async function streamsFromTabs(
  servers: ServerTab[],
  signal: AbortSignal
): Promise<NuvioStream[]> {
  const out: NuvioStream[] = [];
  for (const language of [...new Set(servers.map((s) => s.language))]) {
    if (isAborted(signal)) break;
    out.push(
      ...(await resolveEmbedsUntil(
        servers.filter((s) => s.language === language),
        {
          language,
          providerLabel: LABEL,
          siteUrl: SITE,
          target: MAX_SERVERS_PER_LANGUAGE,
          signal,
        }
      ))
    );
  }
  return out;
}

async function extractMovie(
  titles: string[],
  signal: AbortSignal,
  startTime: number
): Promise<NuvioStream[]> {
  const match =
    (await trySearch(titles, false, signal, startTime)) ||
    (await browseCategory('movie', titles, signal));
  if (!match || isAborted(signal) || isBudgetExhausted(startTime)) return [];

  const html = await fetchPage(match.url, signal);
  if (!html) return [];

  const servers = parseServerTabs(
    loadHtml(html),
    'button.video-server-tab',
    '.quality-pill',
    '.lang-pill'
  );
  if (servers.length === 0) return [];
  return streamsFromTabs(servers, signal);
}

async function extractSeries(
  ctx: NuvioContext,
  titles: string[],
  startTime: number
): Promise<NuvioStream[]> {
  const targetSeasonNum = ctx.season && ctx.season > 0 ? ctx.season : 1;
  const targets = [ctx.episode, ctx.absoluteEpisode].filter(
    (n): n is number => typeof n === 'number' && n > 0
  );
  const targetEpisodeNums = [...new Set(targets.length > 0 ? targets : [1])];

  const match =
    (await trySearch(titles, true, ctx.signal, startTime)) ||
    (await browseCategory('tv', titles, ctx.signal));
  if (!match || isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  const seriesHtml = await fetchPage(match.url, ctx.signal);
  if (!seriesHtml) return [];
  const seasons = parseSeasons(seriesHtml);
  if (seasons.length === 0) return [];

  // Falling back to the first season is what makes single-season shows work: the
  // site numbers some of them `/saison-1` and others not at all.
  const targetSeason = seasons.find((s) => s.num === targetSeasonNum) || seasons[0];
  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  const seasonHtml = await fetchPage(targetSeason.link, ctx.signal);
  if (!seasonHtml) return [];
  const episodes = parseSeasonEpisodes(seasonHtml);
  if (episodes.length === 0) return [];

  let ep: EpisodeLink | undefined;
  for (const epNum of targetEpisodeNums) {
    ep = episodes.find((e) => e.episode === epNum);
    if (ep) break;
  }
  // Positional fallback: a season page that starts at a non-1 episode number still
  // lists its episodes in order, so index N-1 is the requested one.
  if (!ep) ep = episodes[targetEpisodeNums[0] - 1];
  if (!ep || isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  const epHtml = await fetchPage(ep.link, ctx.signal);
  if (!epHtml) return [];

  const servers = parseServerTabs(
    loadHtml(epHtml),
    'button.episode-server-tab',
    '.quality-pill',
    '.lang-pill'
  );
  if (servers.length === 0) return [];
  return streamsFromTabs(servers, ctx.signal);
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  const startTime = Date.now();
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];

  // Season suffixes are stripped up front: the site indexes shows under their bare
  // name and puts the season in a separate page, so "Naruto Season 1" as a query
  // only dilutes the result set.
  const titles = [...new Set(ctx.titles.map((t) => stripSeasonSuffix(t)).filter(Boolean))];
  if (titles.length === 0) return [];

  return ctx.type === 'movie'
    ? extractMovie(titles, ctx.signal, startTime)
    : extractSeries(ctx, titles, startTime);
}

export const flemmix = createNuvioProvider({
  name: 'flemmix',
  sites: [SITE],
  language: 'fr',
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'fr',
});
