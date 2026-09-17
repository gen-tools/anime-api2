/**
 * Nakios — French film and series catalogue exposed entirely as a JSON API, so
 * there is no HTML to scrape: `/api/sources/...` answers with ready CDN URLs.
 *
 * Ported from temp/French/French/src/nakios. Three things about this site drive
 * the shape of the code:
 *
 *   Its CDN gates on `Referer`. Requests without one are redirected to a
 *   Telegram invite instead of the media, which is why every request and every
 *   emitted stream carries the *site* origin rather than the API origin.
 *
 *   Responses mix free and premium entries. Premium URLs usually 402 for an
 *   anonymous client, so they are emitted last rather than dropped — a paywalled
 *   entry that occasionally works still beats an empty provider.
 *
 *   The catalogue is keyed by TMDB id but not exhaustively indexed. When the
 *   direct id returns nothing, `/api/search/multi` is used to find the sibling
 *   ids the site *does* index (re-releases, alternate cuts) and those are tried
 *   in turn.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  siteFetchJson,
  toStream,
  resolveEmbedStreams,
  scoreTitleMatch,
  isAborted,
  isBudgetExhausted,
  FR_ACCEPT_LANGUAGE,
  DEFAULT_SCORES,
} from '../shared.js';

const SITE = 'https://nakios.store';
const API = 'https://api.nakios.store';
const LABEL = 'Nakios';

/** Alternate ids to try when the mapped TMDB id yields nothing. */
const MAX_ALTERNATE_IDS = 3;

/**
 * Hosts that appear in the `url` field but never serve media.
 *
 * When the CDN's anti-leech check fails it answers with a redirect chain that
 * ends on a Telegram invite, and ad networks are injected into the same array.
 * Both look like ordinary sources until the player tries to open them.
 */
const BLOCKED_URL_PATTERNS = [
  't.me',
  'telegram.me',
  'telegram.org',
  'cheksum.lol',
  'doubleclick.net',
  'googleadservices.com',
  'googlesyndication.com',
];

interface NakiosSource {
  id?: string | number;
  name?: string;
  provider?: string;
  url?: string;
  quality?: string;
  lang?: string;
  language?: string;
  isPremium?: boolean;
  isM3U8?: boolean;
  isEmbed?: boolean;
  size?: string | number;
}

/** `/api/sources/...` returns either a `sources` array or a bare source. */
interface NakiosSourceResponse extends NakiosSource {
  sources?: NakiosSource[];
}

interface NakiosSearchResult {
  id?: number;
  media_type?: string;
  title?: string;
  name?: string;
}

interface NakiosSearchResponse {
  results?: NakiosSearchResult[];
}

function isValidStreamUrl(url: string | undefined): boolean {
  if (!url || typeof url !== 'string') return false;
  const value = url.toLowerCase().trim();
  if (!value.startsWith('https://')) return false;
  return !BLOCKED_URL_PATTERNS.some((pattern) => value.includes(pattern));
}

/** Site origin, not API origin — the CDN's anti-leech check compares against it. */
function siteRefererHeaders(): Record<string, string> {
  return { Referer: `${SITE}/`, Origin: SITE };
}

async function fetchSources(
  path: string,
  signal: AbortSignal
): Promise<NakiosSource[]> {
  const data = await siteFetchJson<NakiosSourceResponse>(`${API}${path}`, {
    headers: siteRefererHeaders(),
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    signal,
    timeoutMs: 12_000,
  });
  if (!data) return [];

  const raw: NakiosSource[] =
    Array.isArray(data.sources) && data.sources.length > 0
      ? data.sources
      : data.url
        ? [data]
        : [];

  const valid = raw.filter((source) => isValidStreamUrl(source?.url));
  // Free first, premium last. Upstream returned only the first free entry and
  // fell back to a single premium one; keeping the whole list preserves the
  // site's mirrors, and the ordering still puts the openly playable ones first.
  return [
    ...valid.filter((source) => source.isPremium !== true),
    ...valid.filter((source) => source.isPremium === true),
  ];
}

async function sourceToStreams(source: NakiosSource): Promise<NuvioStream[]> {
  const url = String(source.url || '');
  const language = source.lang || source.language || 'VF';
  const quality = source.quality || 'HD';
  const server = source.name || source.provider || LABEL;
  const headers = siteRefererHeaders();

  // `isEmbed` marks a player page rather than a manifest. Handing that to the
  // player produces a source that fails on click, so it goes through the host
  // resolvers instead and is dropped when they cannot peel it.
  if (source.isEmbed === true && source.isM3U8 !== true) {
    return resolveEmbedStreams(url, {
      language,
      providerLabel: LABEL,
      siteUrl: SITE,
      quality,
      server,
      headers,
    });
  }

  return [
    toStream(url, language, LABEL, SITE, {
      quality,
      server,
      type: source.isM3U8 === true ? 'hls' : 'mp4',
      headers,
      title: `[${language}] ${server} - ${quality}`,
      size: source.size !== undefined ? String(source.size) : undefined,
    }),
  ];
}

/** `ctx.episode`, then `ctx.absoluteEpisode` — deduped, in that order. */
function episodeCandidates(ctx: NuvioContext): number[] {
  const out: number[] = [];
  for (const value of [ctx.episode, ctx.absoluteEpisode]) {
    if (value === undefined || !Number.isFinite(value)) continue;
    if (!out.includes(value)) out.push(value);
  }
  return out.length > 0 ? out : [1];
}

function sourcePathFor(
  tmdbId: string,
  type: 'movie' | 'tv',
  season: number,
  episode: number
): string {
  return type === 'movie'
    ? `/api/sources/movie/${tmdbId}`
    : `/api/sources/tv/${tmdbId}/${season}/${episode}`;
}

/**
 * Find TMDB ids the site indexes for this title.
 *
 * Upstream fetched a localized title from TMDB first; `ctx.titles` already
 * carries it. Results are filtered by title score because upstream tried the
 * first three hits blindly, and `/api/search/multi` happily returns unrelated
 * entries for a short query.
 */
async function searchAlternateIds(
  ctx: NuvioContext,
  startTime: number
): Promise<NakiosSearchResult[]> {
  const queries: string[] = [];
  for (const title of ctx.titles.slice(0, 2)) {
    if (!title) continue;
    if (!queries.includes(title)) queries.push(title);
    const short = title.split(':')[0].trim();
    if (short && short !== title && !queries.includes(short)) queries.push(short);
  }

  for (const query of queries) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;

    const data = await siteFetchJson<NakiosSearchResponse>(
      `${API}/api/search/multi?query=${encodeURIComponent(query)}`,
      {
        headers: siteRefererHeaders(),
        acceptLanguage: FR_ACCEPT_LANGUAGE,
        signal: ctx.signal,
        timeoutMs: 10_000,
      }
    );
    const results = Array.isArray(data?.results) ? data.results : [];
    const usable = results.filter((result) => {
      if (result.media_type !== 'movie' && result.media_type !== 'tv') return false;
      const title = result.title || result.name || '';
      return scoreTitleMatch(title, query) >= DEFAULT_SCORES.MIN_MATCH;
    });
    if (usable.length === 0) continue;

    // The mapped id first, matching upstream's ordering, then the alternates.
    const original = ctx.tmdbId ? Number(ctx.tmdbId) : NaN;
    return [...usable].sort((a, b) => {
      if (a.id === original) return -1;
      if (b.id === original) return 1;
      return 0;
    });
  }

  return [];
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  const startTime = Date.now();
  const season = ctx.season ?? 1;
  const episodes = episodeCandidates(ctx);

  let sources: NakiosSource[] = [];

  if (ctx.tmdbId) {
    const paths =
      ctx.type === 'movie'
        ? [sourcePathFor(ctx.tmdbId, 'movie', season, 1)]
        : episodes.map((episode) => sourcePathFor(ctx.tmdbId!, 'tv', season, episode));

    for (const path of paths) {
      if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];
      sources = await fetchSources(path, ctx.signal);
      if (sources.length > 0) break;
    }
  }

  if (sources.length === 0) {
    const alternates = await searchAlternateIds(ctx, startTime);
    for (const alternate of alternates.slice(0, MAX_ALTERNATE_IDS)) {
      if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
      if (!alternate.id) continue;
      if (ctx.tmdbId && String(alternate.id) === String(ctx.tmdbId)) continue;

      // The search result's own media_type wins: the site indexes some series
      // as films and asking for the wrong shape returns an empty payload.
      const type = alternate.media_type === 'movie' ? 'movie' : 'tv';
      const paths =
        type === 'movie'
          ? [sourcePathFor(String(alternate.id), 'movie', season, 1)]
          : episodes.map((episode) =>
              sourcePathFor(String(alternate.id), 'tv', season, episode)
            );

      for (const path of paths) {
        if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
        sources = await fetchSources(path, ctx.signal);
        if (sources.length > 0) break;
      }
      if (sources.length > 0) break;
    }
  }

  if (sources.length === 0) return [];

  const out: NuvioStream[] = [];
  for (const source of sources) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    out.push(...(await sourceToStreams(source)));
  }
  return out;
}

export const nakios = createNuvioProvider({
  name: 'nakios',
  sites: [SITE, API],
  language: 'fr',
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'fr',
});
