/**
 * DuLourd — French films and series catalogue (VF + VOSTFR) on DataLife Engine.
 *
 * Ported from temp/French/French/src/dulourd.
 *
 * Episode pages contain no player markup. They carry `playEpisode(this, 'ID',
 * 'server_lang')` handlers, and each distinct `server_lang` pair ("voe_vf",
 * "uqload_vostfr") has to be POSTed back to `Season.php` to get an iframe fragment
 * with the real embed URL. That means one request per server × language, which is
 * also where every language variant the site offers comes from.
 *
 * The site rotates domains, so both known hosts are tried in order for every
 * request. When the DLE search finds nothing, the fallback probes the URL the site
 * would have used — but the genre is part of the path, so it has to be guessed
 * across the whole genre list.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  loadHtml,
  normalize,
  toSlug,
  siteFetchText,
  resolveEmbedStreams,
  isAborted,
  isBudgetExhausted,
  FR_ACCEPT_LANGUAGE,
} from '../shared.js';

const SITE = 'https://www.dulourd.hair';
const MIRRORS = [SITE, 'https://www.dulourd.net'];
const LABEL = 'DuLourd';

const SEASON_API = '/engine/inc/serial/app/ajax/Season.php';

/** Genre is baked into every content URL, so a slug probe has to try them all. */
const GENRES = [
  'action_s', 'animation_s', 'aventure_s', 'comedie_s',
  'documentaire-s', 'drame_s', 'famille-s', 'fantastique_s',
  'guerre_s', 'historique_s', 'horreur_s', 'judiciare_s',
  'musical_s', 'policier_s', 'romance_s', 'science-fiction_s',
  'thriller_s', 'western_s',
];

const SERVER_LABELS: Record<string, string> = {
  voe: 'VOE',
  filemoon: 'Filemoon',
  doodstream: 'Doodstream',
  uqload: 'Uqload',
  vidoza: 'Vidoza',
  netu: 'Netu',
};

const LANGUAGE_MAP: Record<string, string> = {
  vf: 'VF',
  vostfr: 'VOSTFR',
};

const MAX_SEARCH_QUERIES = 5;

interface SearchResult {
  url: string;
  genre: string;
  slug: string;
  title: string;
}

/** GET a path from the first mirror that answers with usable content. */
async function fetchFromMirrors(
  pathOrUrl: string,
  signal: AbortSignal,
  timeoutMs = 20_000
): Promise<string | null> {
  const isAbsolute = /^https?:\/\//i.test(pathOrUrl);
  for (const mirror of MIRRORS) {
    if (isAborted(signal)) return null;
    const url = isAbsolute ? pathOrUrl : `${mirror}${pathOrUrl}`;
    const html = await siteFetchText(url, {
      acceptLanguage: FR_ACCEPT_LANGUAGE,
      timeoutMs,
      signal,
    });
    if (html) return html;
    // An absolute URL names its own host; retrying it against another mirror
    // would just repeat the same request.
    if (isAbsolute) return null;
  }
  return null;
}

/**
 * Ask the site for one server's embed.
 *
 * Returns the raw HTML fragment; the caller pulls the `src` out of it.
 */
async function fetchEpisodeEmbed(
  episodeId: string,
  xfield: string,
  signal: AbortSignal
): Promise<string | null> {
  for (const mirror of MIRRORS) {
    if (isAborted(signal)) return null;
    const html = await siteFetchText(`${mirror}${SEASON_API}`, {
      form: { id: episodeId, xfield, action: 'playEpisode' },
      acceptLanguage: FR_ACCEPT_LANGUAGE,
      timeoutMs: 15_000,
      signal,
    });
    if (html) return html;
  }
  return null;
}

function extractEpisodeId(html: string): string | null {
  return html.match(/playEpisode\([^,]+,\s*'(\d+)'/)?.[1] ?? null;
}

/** Every distinct `server_lang` key the page offers, in document order. */
function extractXfields(html: string): string[] {
  const xfields = new Set<string>();
  const re = /playEpisode\([^,]+,\s*'\d+',\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) xfields.add(m[1]);
  return [...xfields];
}

/**
 * Tiered title match.
 *
 * Length-aware rather than word-aware: a result that contains the query and is
 * within five characters of it is effectively the same title with a suffix, while
 * a longer containment is a weaker signal. The 60-point floor in `bestMatch` means
 * a bare containment still qualifies but ranks below a prefix or exact hit.
 */
function scoreMatch(resultTitle: string, searchTitle: string): number {
  const norm = normalize(resultTitle);
  const target = normalize(searchTitle);
  if (!norm || !target) return 0;
  if (norm === target) return 100;
  if (norm.includes(target) && norm.length - target.length < 5) return 90;
  if (norm.startsWith(target)) return 80;
  if (norm.includes(target)) return 60;
  if (target.includes(norm)) return 40;
  return 0;
}

function bestMatch(results: SearchResult[], titles: string[]): SearchResult | null {
  let bestScore = -1;
  let best: SearchResult | null = null;
  for (const result of results) {
    for (const title of titles) {
      const score = scoreMatch(result.title, title);
      if (score > bestScore) {
        bestScore = score;
        best = result;
      }
    }
  }
  return bestScore >= 60 ? best : null;
}

async function searchDle(query: string, signal: AbortSignal): Promise<SearchResult[]> {
  const html = await fetchFromMirrors(
    `/?do=search&subaction=search&story=${encodeURIComponent(query)}`,
    signal
  );
  if (!html) return [];

  const $ = loadHtml(html);
  const results: SearchResult[] = [];
  $('a[href*="/voir-series/"]').each((_i, el) => {
    const href = $(el).attr('href') || '';
    // Season and episode links share the prefix; only the series page is wanted.
    if (
      !href.includes('/voir-series/') ||
      !href.endsWith('.html') ||
      href.endsWith('-saison.html') ||
      href.endsWith('-episode.html')
    ) {
      return;
    }
    const m = href.match(/\/voir-series\/([^/]+)\/([^/]+)\.html/);
    if (!m) return;
    results.push({
      url: href.startsWith('http') ? href : SITE + href,
      genre: m[1],
      slug: m[2],
      title: $(el).text().trim(),
    });
  });
  return results;
}

/**
 * Search queries derived from the available titles.
 *
 * Both the display title and its slug are tried because DLE's index matches on
 * either, and a three-word prefix catches entries the site published under a
 * shortened name.
 */
function buildSearchQueries(titles: string[]): string[] {
  const frenchKeywords = ['fr', 'french', 'francais'];
  const priority: string[] = [];
  for (let i = 0; i < titles.length; i++) {
    if (i < 3) priority.push(titles[i]);
    else if (frenchKeywords.some((k) => titles[i].toLowerCase().includes(k))) {
      priority.push(titles[i]);
    }
  }
  if (priority.length === 0 && titles.length > 0) priority.push(titles[0]);

  const queries = new Set<string>();
  for (const title of priority) {
    queries.add(title);
    const slug = toSlug(title);
    queries.add(slug);
    const words = slug.split('-').filter((w) => w.length > 3 || w === 'dr' || w === 'st');
    if (words.length > 1) queries.add(words.slice(0, 3).join(' '));
    if (queries.size >= MAX_SEARCH_QUERIES) break;
  }
  return [...queries].slice(0, MAX_SEARCH_QUERIES);
}

/** Guess the content URL directly, one genre at a time. */
async function findSlugFallback(
  titles: string[],
  type: 'movie' | 'tv',
  signal: AbortSignal,
  startTime: number
): Promise<SearchResult | null> {
  const slug = toSlug(titles[0] || '');
  if (!slug) return null;
  const baseType = type === 'movie' ? 'films' : 'voir-series';

  for (const genre of GENRES) {
    if (isAborted(signal) || isBudgetExhausted(startTime)) break;
    const url = `${SITE}/${baseType}/${genre}/${slug}.html`;
    // A miss here is the expected outcome for 17 of 18 genres, so skip the
    // browser escalation: paying for it per probe would exhaust the budget.
    const html = await siteFetchText(url, {
      acceptLanguage: FR_ACCEPT_LANGUAGE,
      timeoutMs: 5_000,
      signal,
      noBypass: true,
    });
    if (html) return { url, genre, slug, title: titles[0] };
  }
  return null;
}

async function findContent(
  titles: string[],
  type: 'movie' | 'tv',
  signal: AbortSignal,
  startTime: number
): Promise<SearchResult | null> {
  const allResults: SearchResult[] = [];
  for (const query of buildSearchQueries(titles)) {
    if (isAborted(signal) || isBudgetExhausted(startTime)) break;
    allResults.push(...(await searchDle(query, signal)));
  }

  if (allResults.length > 0) {
    const match = bestMatch(allResults, titles);
    if (match?.url) return match;
  }

  return findSlugFallback(titles, type, signal, startTime);
}

/**
 * Resolve every `server_lang` pair on a page into streams.
 *
 * Sequential on purpose: the servers sit on a handful of shared CDNs, so firing
 * them together earns a challenge rather than a speedup.
 */
async function streamsForPage(
  html: string,
  signal: AbortSignal,
  startTime: number
): Promise<NuvioStream[]> {
  const episodeId = extractEpisodeId(html);
  if (!episodeId) return [];
  const xfields = extractXfields(html);
  if (xfields.length === 0) return [];

  const out: NuvioStream[] = [];
  for (const xfield of xfields) {
    if (isAborted(signal) || isBudgetExhausted(startTime)) break;

    const fragment = await fetchEpisodeEmbed(episodeId, xfield, signal);
    const embedUrl = fragment?.match(/src="([^"]+)"/)?.[1];
    if (!embedUrl) continue;

    const parts = xfield.split('_');
    const language =
      LANGUAGE_MAP[parts[1]] || (parts[1] ? parts[1].toUpperCase() : 'VF');
    const server = SERVER_LABELS[parts[0]] || parts[0];

    out.push(
      ...(await resolveEmbedStreams(embedUrl, {
        language,
        providerLabel: LABEL,
        siteUrl: SITE,
        server,
      }))
    );
  }
  return out;
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  const startTime = Date.now();
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];

  const info = await findContent(ctx.titles, ctx.type, ctx.signal, startTime);
  if (!info) return [];
  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  if (ctx.type === 'movie') {
    const html = await fetchFromMirrors(info.url, ctx.signal);
    if (!html) return [];
    return streamsForPage(html, ctx.signal, startTime);
  }

  const season = ctx.season;
  const episode = ctx.episode;
  if (!season || !episode) return [];

  const episodeUrl = `${info.url.replace('.html', '')}/${season}-saison/${episode}-episode.html`;
  const epHtml = await fetchFromMirrors(episodeUrl, ctx.signal);
  if (!epHtml) return [];

  return streamsForPage(epHtml, ctx.signal, startTime);
}

export const dulourd = createNuvioProvider({
  name: 'dulourd',
  sites: MIRRORS,
  language: 'fr',
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'fr',
});
