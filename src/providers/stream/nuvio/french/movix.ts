/**
 * Movix — French aggregator that exposes other sites' catalogues through its own
 * JSON API, so nothing here is scraped from HTML.
 *
 * Ported from temp/French/French/src/movix. `api.movix.fun` fronts several
 * upstream scrapers: `/api/fstream/...` is the primary one, and `wiflix`, `j1f`
 * and `cpasmal` sit behind identical routes as fallbacks. Only cpasmal answers
 * for series — the other two return an error for anything but a film, so they
 * are not asked.
 *
 * Two details are load-bearing. The API's domain-restriction middleware checks
 * `Origin`/`Referer` against the site, so every request carries movix.fun rather
 * than the API host. And a missing title is reported as `{"success": false}` with
 * an HTTP 200, which is why that flag is checked before parsing.
 *
 * The response shape is not stable across the five upstream scrapers, hence the
 * five layouts parsed here; they were observed live and any of them can appear
 * for the same request depending on which scraper answered.
 *
 * Search results carry Movix's internal id in `id` and the real TMDB id in
 * `tmdb_id`; only the latter works against `/api/fstream`.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  siteFetchJson,
  toStream,
  resolveEmbedsUntil,
  normalizeLangTag,
  isAborted,
  isBudgetExhausted,
  FR_ACCEPT_LANGUAGE,
} from '../shared.js';

const API = 'https://api.movix.fun';
const SITE = 'https://movix.fun';
const LABEL = 'Movix';

/** Hosts whose resolution reliably takes longer than the whole budget allows. */
const SLOW_HOSTS = [
  'up4fun', 'dood', 'doodstream', 'moonplayer', 'filemoon', 'streamtape', 'stape',
];
/** Hosts that resolve in a couple of seconds, so they are worth trying first. */
const FAST_HOSTS = [
  'voe', 'uqload', 'fsvid', 'vidzy', 'netu', 'younetu', 'sendvid', 'sibnet',
];

interface FallbackSource {
  name: string;
  movie: boolean;
  tv: boolean;
}

const FALLBACK_SOURCES: FallbackSource[] = [
  { name: 'wiflix', movie: true, tv: false },
  { name: 'j1f', movie: true, tv: false },
  { name: 'cpasmal', movie: true, tv: true },
];

/** Embeds resolved per language, so VF and VOSTFR each get their own attempts. */
const MAX_RESOLVE_PER_LANGUAGE = 3;
const MAX_SEARCH_ALTERNATES = 5;

interface MovixItem {
  name?: string;
  player?: string;
  url?: string;
  quality?: string;
}

interface MovixResponse {
  success?: boolean;
  players?: Record<string, unknown>;
  links?: Record<string, unknown>;
  episodes?: Record<string, unknown>;
  [key: string]: unknown;
}

interface MovixSearchResult {
  id?: string | number;
  tmdb_id?: string | number;
  media_type?: string;
  type?: string;
}

interface MovixSearchResponse {
  results?: MovixSearchResult[];
}

interface Candidate {
  url: string;
  language: string;
  quality: string;
  server: string;
}

// ── Ordering and filtering ───────────────────────────────────────────────────

/** Lower sorts first: French dub before subtitled, quick hosts before slow. */
function streamPriority(url: string, language: string): number {
  const value = (url || '').toLowerCase();
  let score = 0;

  const lang = (language || '').toUpperCase();
  if (lang === 'VF' || lang === 'VFF' || lang === 'VFQ') score += 0;
  else if (lang === 'DEFAULT' || lang === 'MULTI') score += 10;
  else if (lang === 'VOSTFR') score += 20;
  else score += 30;

  const isSlow = SLOW_HOSTS.some((host) => value.includes(host));
  const isFast = FAST_HOSTS.some((host) => value.includes(host));
  if (isSlow) score += 100;
  else if (isFast) score += 0;
  else score += 50;

  return score;
}

/**
 * Sample clips the upstream scrapers emit as placeholders.
 *
 * They play, which makes them worse than a broken link: without this they reach
 * the player as a working stream of the wrong film.
 */
function isPlaceholderUrl(url: string): boolean {
  const value = (url || '').toLowerCase();
  return (
    value.includes('test-videos.co.uk') ||
    value.includes('sample-videos.com') ||
    value.includes('big_buck_bunny')
  );
}

/**
 * True when the URL is already a manifest or media file.
 *
 * Such entries skip the host resolvers entirely — the API sometimes returns a
 * finished HLS URL alongside embed pages, and resolving it would only unwrap
 * what is already unwrapped.
 */
function isDirectMediaUrl(url: string): boolean {
  if (!url) return false;
  const value = url.toLowerCase();
  if (
    value.includes('/embed') ||
    value.includes('/e/') ||
    value.includes('iframe') ||
    value.includes('index.php')
  ) {
    return false;
  }
  if (
    value.includes('.m3u8') ||
    value.includes('.mp4') ||
    value.includes('.mkv') ||
    value.includes('.webm') ||
    value.includes('.ts')
  ) {
    return true;
  }
  return value.includes('manifest') || value.includes('playlist') || value.includes('/hls/');
}

// ── Response parsing ─────────────────────────────────────────────────────────

function asItems(value: unknown): MovixItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is MovixItem => !!item && typeof item === 'object'
  );
}

function pushCandidate(
  out: Candidate[],
  provider: string,
  server: string | undefined,
  lang: string,
  item: MovixItem
): void {
  const url = item.url;
  if (!url || typeof url !== 'string') return;
  if (isPlaceholderUrl(url)) return;
  out.push({
    url,
    language: normalizeLangTag(lang),
    quality: item.quality || 'HD',
    server: `${provider} · ${server || 'Player'}`,
  });
}

/**
 * Every playable entry in one API response.
 *
 * `fstream` names the host field `player` while wiflix and j1f use `name`, and
 * series data arrives either under `episodes[n].languages` or as bare language
 * keys on the episode object, so both are read.
 */
function parseCandidates(
  data: MovixResponse,
  provider: string,
  isMovie: boolean,
  episodeNum: number
): Candidate[] {
  const out: Candidate[] = [];

  if (data.players && typeof data.players === 'object') {
    for (const lang of Object.keys(data.players)) {
      for (const item of asItems(data.players[lang])) {
        pushCandidate(out, provider, item.player || item.name, lang, item);
      }
    }
  }

  if (data.links && typeof data.links === 'object') {
    for (const lang of Object.keys(data.links)) {
      for (const item of asItems(data.links[lang])) {
        pushCandidate(out, provider, item.name || item.player, lang, item);
      }
    }
  }

  if (!isMovie && data.episodes && typeof data.episodes === 'object') {
    const raw = data.episodes[String(episodeNum)];
    if (raw && typeof raw === 'object') {
      const episode = raw as Record<string, unknown>;

      const languages = episode.languages;
      if (languages && typeof languages === 'object') {
        const byLang = languages as Record<string, unknown>;
        for (const lang of Object.keys(byLang)) {
          for (const item of asItems(byLang[lang])) {
            pushCandidate(out, provider, item.player, lang, item);
          }
        }
      }

      for (const lang of ['vf', 'vostfr', 'vo', 'VFF', 'VFQ', 'VOSTFR', 'Default']) {
        for (const item of asItems(episode[lang])) {
          pushCandidate(out, provider, item.name || item.player, lang, item);
        }
      }
    }
  }

  // Some scrapers hang the language arrays straight off the root object.
  for (const lang of ['vf', 'vostfr', 'vo', 'VFF', 'VFQ']) {
    for (const item of asItems(data[lang])) {
      pushCandidate(out, provider, item.player || item.name, lang, item);
    }
  }

  return out;
}

// ── API access ───────────────────────────────────────────────────────────────

async function fetchApi(
  path: string,
  ctx: NuvioContext
): Promise<MovixResponse | null> {
  const data = await siteFetchJson<MovixResponse>(`${API}${path}`, {
    // The API rejects requests whose Origin is not the site itself.
    headers: { Referer: `${SITE}/`, Origin: SITE, Accept: 'application/json, text/plain, */*' },
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    signal: ctx.signal,
    timeoutMs: 12_000,
  });
  if (!data || data.success === false) return null;
  return data;
}

function sourcePath(
  scraper: string,
  id: string,
  isMovie: boolean,
  season: number
): string {
  return isMovie
    ? `/api/${scraper}/movie/${id}`
    : `/api/${scraper}/tv/${id}/season/${season}`;
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * Resolve candidates language by language.
 *
 * Bucketing is what keeps both versions available: the priority sort puts every
 * VF host ahead of the first VOSTFR one, so a single capped pass would always
 * return French dubs only.
 */
async function resolveCandidates(
  candidates: Candidate[],
  ctx: NuvioContext,
  startTime: number
): Promise<NuvioStream[]> {
  const seen = new Set<string>();
  const unique: Candidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    unique.push(candidate);
  }
  if (unique.length === 0) return [];

  unique.sort(
    (a, b) =>
      streamPriority(a.url, a.language) - streamPriority(b.url, b.language)
  );

  const byLanguage = new Map<string, Candidate[]>();
  for (const candidate of unique) {
    const bucket = byLanguage.get(candidate.language);
    if (bucket) bucket.push(candidate);
    else byLanguage.set(candidate.language, [candidate]);
  }

  const out: NuvioStream[] = [];
  for (const [language, bucket] of byLanguage) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;

    const embeds: Candidate[] = [];
    for (const candidate of bucket) {
      if (isDirectMediaUrl(candidate.url)) {
        out.push(
          toStream(candidate.url, language, LABEL, SITE, {
            quality: candidate.quality,
            server: candidate.server,
            type: candidate.url.toLowerCase().includes('.m3u8') ? 'hls' : 'mp4',
            title: `[${language}] ${candidate.server}`,
          })
        );
      } else {
        embeds.push(candidate);
      }
    }

    if (embeds.length === 0) continue;
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;

    const streams = await resolveEmbedsUntil(
      embeds.slice(0, MAX_RESOLVE_PER_LANGUAGE).map((candidate) => ({
        url: candidate.url,
        language,
        quality: candidate.quality,
        server: candidate.server,
      })),
      {
        language,
        providerLabel: LABEL,
        siteUrl: SITE,
        signal: ctx.signal,
        target: 2,
        budgetMs: 9_000,
      }
    );
    out.push(...streams);
  }

  return out;
}

// ── Discovery ────────────────────────────────────────────────────────────────

/** `ctx.episode`, then `ctx.absoluteEpisode` — deduped, in that order. */
function episodeCandidates(ctx: NuvioContext): number[] {
  const out: number[] = [];
  for (const value of [ctx.episode, ctx.absoluteEpisode]) {
    if (value === undefined || !Number.isFinite(value)) continue;
    if (!out.includes(value)) out.push(value);
  }
  return out.length > 0 ? out : [1];
}

async function candidatesForId(
  id: string,
  scraper: string,
  ctx: NuvioContext,
  isMovie: boolean,
  season: number,
  episodes: number[]
): Promise<Candidate[]> {
  const data = await fetchApi(sourcePath(scraper, id, isMovie, season), ctx);
  if (!data) return [];

  if (isMovie) return parseCandidates(data, scraper, true, 1);

  // One season payload holds every episode, so the episode candidates are tried
  // against the same response rather than re-fetching it.
  for (const episode of episodes) {
    const found = parseCandidates(data, scraper, false, episode);
    if (found.length > 0) return found;
  }
  return [];
}

async function fallbackCandidates(
  id: string,
  ctx: NuvioContext,
  isMovie: boolean,
  season: number,
  episodes: number[],
  startTime: number
): Promise<Candidate[]> {
  const found: Candidate[] = [];
  for (const source of FALLBACK_SOURCES) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    if (!(isMovie ? source.movie : source.tv)) continue;
    found.push(
      ...(await candidatesForId(id, source.name, ctx, isMovie, season, episodes))
    );
  }
  return found;
}

/**
 * Find sibling TMDB ids the aggregator indexes for this title.
 *
 * Needed because the mapped id is sometimes absent from Movix's own catalogue
 * while a re-release or alternate cut of the same title is present.
 */
async function searchAlternates(
  ctx: NuvioContext,
  isMovie: boolean,
  season: number,
  episodes: number[],
  startTime: number
): Promise<Candidate[]> {
  const title = ctx.titles[0];
  if (!title) return [];

  // The endpoint's required parameter is `title`, not `q`.
  const data = await siteFetchJson<MovixSearchResponse | MovixSearchResult[]>(
    `${API}/api/search?title=${encodeURIComponent(title)}`,
    {
      headers: { Referer: `${SITE}/`, Origin: SITE },
      acceptLanguage: FR_ACCEPT_LANGUAGE,
      signal: ctx.signal,
      timeoutMs: 10_000,
    }
  );

  const results = Array.isArray(data) ? data : data?.results;
  if (!Array.isArray(results) || results.length === 0) return [];

  for (const result of results.slice(0, MAX_SEARCH_ALTERNATES)) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;

    const altId = result.tmdb_id || result.id;
    if (!altId) continue;
    if (ctx.tmdbId && String(altId) === String(ctx.tmdbId)) continue;

    // The search endpoint reports series as `series` or `show`; the source
    // endpoints only understand `tv`.
    let resultType = result.media_type || result.type || (isMovie ? 'movie' : 'tv');
    if (resultType === 'series' || resultType === 'show') resultType = 'tv';
    if (resultType !== 'movie' && resultType !== 'tv') continue;

    const found = await candidatesForId(
      String(altId),
      'fstream',
      ctx,
      resultType === 'movie',
      season,
      episodes
    );
    if (found.length > 0) return found;
  }

  return [];
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  const startTime = Date.now();
  if (isAborted(ctx.signal)) return [];

  const isMovie = ctx.type === 'movie';
  const season = Number(ctx.season) || 1;
  const episodes = episodeCandidates(ctx);

  let candidates: Candidate[] = [];
  let fallbackTried = false;

  if (ctx.tmdbId) {
    candidates = await candidatesForId(
      ctx.tmdbId,
      'fstream',
      ctx,
      isMovie,
      season,
      episodes
    );

    if (candidates.length === 0 && !isBudgetExhausted(startTime)) {
      candidates = await fallbackCandidates(
        ctx.tmdbId,
        ctx,
        isMovie,
        season,
        episodes,
        startTime
      );
      fallbackTried = true;
    }
  }

  if (candidates.length === 0 && !isAborted(ctx.signal) && !isBudgetExhausted(startTime)) {
    candidates = await searchAlternates(ctx, isMovie, season, episodes, startTime);
  }

  if (candidates.length === 0) return [];

  const streams = await resolveCandidates(candidates, ctx, startTime);
  if (streams.length > 0) return streams;

  // Every embed the primary scraper offered was dead. The alternate scrapers
  // carry different hosts for the same title, so they are worth one attempt —
  // unless they already supplied the candidates that just failed.
  if (
    !fallbackTried &&
    ctx.tmdbId &&
    !isAborted(ctx.signal) &&
    !isBudgetExhausted(startTime)
  ) {
    const retry = await fallbackCandidates(
      ctx.tmdbId,
      ctx,
      isMovie,
      season,
      episodes,
      startTime
    );
    if (retry.length > 0) return resolveCandidates(retry, ctx, startTime);
  }

  return [];
}

export const movix = createNuvioProvider({
  name: 'movix',
  sites: [SITE, API],
  language: 'fr',
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'fr',
});
