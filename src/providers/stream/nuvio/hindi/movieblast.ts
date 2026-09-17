/**
 * MovieBlast — Signed API provider on app.cloud-mb.xyz
 *
 * Search uses a token-authenticated endpoint. Results are then drilled into for
 * video links. Each link URL is signed with HMAC-SHA256 using a shared secret.
 * For TV: season → episode → video list hierarchy.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  siteFetchJson,
  scoreTitleMatch,
  isAborted,
  isBudgetExhausted,
  HI_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
  NUVIO_UA,
} from '../shared.js';

const SITE = 'https://app.cloud-mb.xyz';
const LABEL = 'MovieBlast';
const TOKEN = 'jdvhhjv255vghhghdhvfch2565656jhdcghfdf';
const APP_ID = 'com.movieblast';
const SIGN_SECRET = 'GJ8reydarI7Jqat9rvbAJKNQ9gY4DoEQF2H5nfuI1gi';

const BASE_HEADERS = {
  'user-agent': 'okhttp/5.0.0-alpha.6',
  'x-request-x': APP_ID,
};

const SEARCH_HEADERS = {
  ...BASE_HEADERS,
  hash256: '86dc03244adddb3cbedbf0ae36074a736ee293a64774b18e82a6244eafd0df30',
  packagename: APP_ID,
};

// ── Types ────────────────────────────────────────────────────────────────────

interface SearchItem {
  id?: string | number;
  name?: string;
  type?: string;
  release_date?: string;
}

interface SearchResponse {
  search?: SearchItem[];
}

interface VideoItem {
  link?: string;
  server?: string;
  lang?: string;
}

interface SeasonItem {
  season_number?: number;
  episodes?: EpisodeItem[];
}

interface EpisodeItem {
  episode_number?: number;
  videos?: VideoItem[];
}

interface DetailResponse {
  videos?: VideoItem[];
  seasons?: SeasonItem[];
}

interface SeriesDetailResponse {
  seasons?: SeasonItem[];
}

// ── HMAC signing ─────────────────────────────────────────────────────────────

/**
 * Generate a signed URL using HMAC-SHA256.
 * Implemented without crypto-js — uses Web Crypto API (available in Deno/Node 18+).
 */
async function generateSignedUrl(urlStr: string): Promise<string> {
  try {
    const url = new URL(urlStr);
    const path = url.pathname;
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const encoder = new TextEncoder();
    const keyData = encoder.encode(SIGN_SECRET);
    const message = encoder.encode(path + timestamp);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, message);
    const signatureBytes = new Uint8Array(signatureBuffer);
    const base64 = btoa(String.fromCharCode(...signatureBytes));
    const encodedSignature = encodeURIComponent(base64);

    return `${urlStr}?verify=${timestamp}-${encodedSignature}`;
  } catch {
    return urlStr;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function matchQuality(s: string): string {
  const v = String(s || '').toLowerCase();
  if (v.includes('2160') || v.includes('4k')) return '2160p';
  if (v.includes('1440')) return '1440p';
  if (v.includes('1080')) return '1080p';
  if (v.includes('720')) return '720p';
  if (v.includes('480')) return '480p';
  if (v.includes('360')) return '360p';
  return 'HD';
}

function inferLanguage(lang: string): string {
  const t = String(lang || '').toUpperCase();
  if (t.includes('HI') || t.includes('HINDI')) return 'HINDI';
  if (t.includes('TA') || t.includes('TAMIL')) return 'TAMIL';
  if (t.includes('TE') || t.includes('TELUGU')) return 'TELUGU';
  if (t.includes('MULTI')) return 'MULTI';
  if (t.includes('DUAL')) return 'DUAL';
  if (t.includes('EN') || t.includes('ENGLISH')) return 'ENGLISH';
  return 'HINDI';
}

// ── Search ───────────────────────────────────────────────────────────────────

async function searchMovieBlast(
  query: string,
  ctx: NuvioContext
): Promise<SearchItem[]> {
  const safeQuery = encodeURIComponent(query);
  const searchUrl = `${SITE}/api/search/${safeQuery}/${TOKEN}`;
  const data = await siteFetchJson<SearchResponse>(searchUrl, {
    headers: SEARCH_HEADERS,
    signal: ctx.signal,
    timeoutMs: 10_000,
  });
  return data?.search ?? [];
}

// ── Detail fetch ─────────────────────────────────────────────────────────────

async function fetchVideos(
  internalId: string | number,
  isSeries: boolean,
  ctx: NuvioContext
): Promise<VideoItem[]> {
  const detailPath = isSeries ? 'series/show' : 'media/detail';
  const detailUrl = `${SITE}/api/${detailPath}/${internalId}/${TOKEN}`;
  const data = await siteFetchJson<DetailResponse | SeriesDetailResponse>(detailUrl, {
    headers: BASE_HEADERS,
    signal: ctx.signal,
    timeoutMs: 10_000,
  });
  if (!data) return [];

  if (!isSeries) {
    return (data as DetailResponse).videos ?? [];
  }
  return []; // TV handled separately
}

async function fetchEpisodeVideos(
  internalId: string | number,
  season: number,
  episode: number,
  ctx: NuvioContext
): Promise<VideoItem[]> {
  const detailUrl = `${SITE}/api/series/show/${internalId}/${TOKEN}`;
  const data = await siteFetchJson<SeriesDetailResponse>(detailUrl, {
    headers: BASE_HEADERS,
    signal: ctx.signal,
    timeoutMs: 10_000,
  });
  if (!data?.seasons) return [];

  const targetSeason = data.seasons.find((s) => s.season_number === season);
  if (!targetSeason?.episodes) return [];

  const targetEpisode = targetSeason.episodes.find((e) => e.episode_number === episode);
  return targetEpisode?.videos ?? [];
}

// ── Main extractor ───────────────────────────────────────────────────────────

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];
  const startTime = Date.now();

  for (const title of ctx.titles) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime, PROVIDER_BUDGET_MS)) break;

    const searchResults = await searchMovieBlast(title, ctx);
    if (searchResults.length === 0) continue;

    // Find best match
    let bestMatch: SearchItem | null = null;
    let bestScore = -1;
    for (const result of searchResults) {
      let score = scoreTitleMatch(result.name || '', title);
      if (score > bestScore && score > 40) {
        bestScore = score;
        bestMatch = result;
      }
    }
    if (!bestMatch?.id) continue;

    const isSeries =
      String(bestMatch.type || '').toLowerCase().includes('serie') ||
      ctx.type === 'tv';

    if (isAborted(ctx.signal) || isBudgetExhausted(startTime, PROVIDER_BUDGET_MS)) break;

    let targetVideos: VideoItem[] = [];
    if (isSeries && ctx.season != null && ctx.episode != null) {
      targetVideos = await fetchEpisodeVideos(bestMatch.id, ctx.season, ctx.episode, ctx);
    } else if (!isSeries) {
      targetVideos = await fetchVideos(bestMatch.id, false, ctx);
    }

    if (targetVideos.length === 0) continue;

    const streams: NuvioStream[] = [];
    for (const vid of targetVideos) {
      if (!vid.link) continue;
      const httpsUrl = vid.link.startsWith('http') ? vid.link : `https://${vid.link}`;
      const signedUrl = await generateSignedUrl(httpsUrl);

      const language = inferLanguage(vid.lang ?? '');
      const quality = matchQuality(vid.server ?? '');

      streams.push({
        url: signedUrl,
        name: LABEL,
        title: `[${language}] ${LABEL} · ${vid.server || 'Server'} (${vid.lang || 'EN'})`,
        quality,
        language,
        headers: {
          'User-Agent': 'MovieBlast',
          Referer: 'MovieBlast',
          'x-request-x': APP_ID,
        },
      });
    }

    if (streams.length > 0) return streams;
  }

  return [];
}

export const movieblast = createNuvioProvider({
  name: 'movieblast',
  sites: [SITE],
  language: 'hi',
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'hi',
});
