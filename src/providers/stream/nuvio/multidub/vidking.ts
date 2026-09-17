/**
 * VidKing — Streaming aggregator at vidking.net with a proprietary XOR cipher.
 *
 * Ported from temp/multi-clone/src/providers/fendrix.rs
 *
 * The API at api.speedracelight.com returns an encrypted payload (URL-safe
 * base-64). Decryption uses a custom stream cipher driven by:
 *  - An FNV hash of a seed string (fetched per request)
 *  - An "avalanche mix" hash of the TMDB media id
 *
 * The cipher state is a 61-slot array (SIZE=61) seeded with 8 rounds (ITIR=8).
 * Key stream bytes XOR the payload bytes after stripping a 4-byte magic prefix.
 *
 * Upstream queries the 'Hydrogen' server endpoint only, filters for 1080p/2160p.
 *
 * Languages: MULTI, DUAL — VidKing aggregates mixed-audio content.
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchText,
  siteFetchJson,
  toStream,
  isAborted,
  isBudgetExhausted,
  PROVIDER_BUDGET_MS,
  HI_ACCEPT_LANGUAGE,
} from '../shared.js';

const SITE = 'https://www.vidking.net';
const SPEED_API_BASE = 'https://api.speedracelight.com';
const DB_BASE_URL = 'https://db.speedracelight.com/3';
const LABEL = 'VidKing';

// ── Cipher constants ──────────────────────────────────────────────────────────

const SIZE = 61;
const ITIR = 8;
const RL = 2_654_435_769;
const ENC = [
  1_116_352_408, 1_899_447_441, 3_049_323_471, 3_921_009_573,
  961_987_163, 1_508_970_993, 2_453_635_748, 2_870_763_221,
  3_624_381_080, 310_598_401, 607_225_278, 1_426_881_987,
  1_925_078_388, 2_162_078_206, 2_614_888_103, 3_248_222_580,
];
const SF = new Uint8Array([109, 118, 109, 49]); // "mvm1"

// ── Cipher implementation ─────────────────────────────────────────────────────

function toU32(n: number): number {
  return n >>> 0;
}

function avalancheMix(v: number): number {
  v = toU32(v);
  v = toU32(v ^ (v >>> 16));
  v = toU32(Math.imul(v, 2_246_822_507));
  v = toU32(v ^ (v >>> 13));
  v = toU32(Math.imul(v, 3_266_489_909));
  v = toU32(v ^ (v >>> 16));
  return toU32(v);
}

function rotateLeft(v: number, shift: number): number {
  const s = shift & 31;
  if (s === 0) return toU32(v);
  return toU32((v << s) | (v >>> (32 - s)));
}

function fnvHash(value: string): number {
  let h = 2_166_136_261;
  for (let i = 0; i < value.length; i++) {
    h = toU32(h ^ value.charCodeAt(i));
    h = toU32(Math.imul(h, 16_777_619));
  }
  return avalancheMix(h);
}

interface Cipher {
  state: Array<number | null>;
  acc: number;
}

function createCipher(seed: string, mediaId: number): Cipher {
  const state: Array<number | null> = Array.from({ length: SIZE }, () => null);
  let acc = avalancheMix(toU32(fnvHash(seed) ^ avalancheMix(toU32(mediaId) ^ RL)));

  for (let round = 0; round < ITIR; round++) {
    const idx = toU32(acc % SIZE);
    acc = rotateLeft(toU32(acc + RL), 7 + (round & 7));
    state[idx] = toU32(acc ^ avalancheMix(acc));
    acc = avalancheMix(toU32(acc + idx));
  }

  return { state, acc: avalancheMix(toU32(acc ^ 2_779_096_485)) };
}

function nextWord(c: Cipher, index: number): number {
  const si = c.acc % SIZE;
  const sv = c.state[si] ?? 0;
  const mask = c.state[si] != null ? 0xFFFFFFFF : 0;
  const off = toU32(Math.imul(RL, index + 1));
  const combined = toU32(((c.acc ^ (sv ^ off)) | (c.acc & (sv ^ off) & mask)));
  const lr = si & 31;
  const rr = toU32(Math.imul(si, 7)) & 31;
  const value = toU32(rotateLeft(toU32(combined + c.acc), lr) ^ rotateLeft(c.acc, rr));
  c.acc = avalancheMix(toU32(value + RL));
  c.state[si] = c.acc;
  return c.acc;
}

function deriveKeyStream(seed: string, mediaId: number, length: number): Uint8Array {
  const cipher = createCipher(seed, mediaId);
  const out = new Uint8Array(length);
  let wi = 0;
  let i = 0;

  while (i < length) {
    const word = nextWord(cipher, wi++);
    out[i++] = word & 0xFF;
    if (i < length) out[i++] = (word >>> 8) & 0xFF;
    if (i < length) out[i++] = (word >>> 16) & 0xFF;
    if (i < length) out[i++] = (word >>> 24) & 0xFF;
  }

  return out;
}

function decryptPayload(payload: string, seed: string, mediaId: number): string | null {
  // URL-safe base64 → standard base64
  const std = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = std + '='.repeat((4 - std.length % 4) % 4);

  let bytes: Uint8Array;
  try {
    const binary = atob(padded);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    return null;
  }

  const ks = deriveKeyStream(seed, mediaId, bytes.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] ^= ks[i];

  // Verify magic prefix
  if (bytes.length < SF.length) return null;
  for (let i = 0; i < SF.length; i++) {
    if (bytes[i] !== SF[i]) return null;
  }

  try {
    return new TextDecoder().decode(bytes.slice(SF.length));
  } catch {
    return null;
  }
}

// ── API helpers ────────────────────────────────────────────────────────────────

interface VidKingMetadata {
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  external_ids?: { imdb_id?: string };
  imdb_id?: string;
}

interface VidKingSource {
  url?: string;
  quality?: string;
  label?: string;
  headers?: Record<string, string>;
  subtitles?: Array<{ url?: string; lang?: string; language?: string; label?: string; display?: string }>;
}

interface VidKingDecrypted {
  sources?: VidKingSource[];
  subtitles?: Array<{ url?: string; lang?: string; language?: string; label?: string; display?: string }>;
}

async function fetchMetadata(
  tmdbId: string,
  mediaType: string,
  signal: AbortSignal
): Promise<{ title: string; year: string; imdbId: string } | null> {
  const url = `${DB_BASE_URL}/${mediaType}/${tmdbId}?append_to_response=external_ids`;
  const data = await siteFetchJson<VidKingMetadata>(url, {
    signal,
    acceptLanguage: HI_ACCEPT_LANGUAGE,
    headers: { Origin: SITE, Referer: `${SITE}/` },
  });
  if (!data) return null;

  const title = (mediaType === 'movie' ? data.title : data.name) ?? '';
  if (!title) return null;

  const dateStr = (mediaType === 'movie' ? data.release_date : data.first_air_date) ?? '';
  const year = dateStr.slice(0, 4);
  const imdbId = data.external_ids?.imdb_id ?? data.imdb_id ?? '';

  return { title, year, imdbId };
}

function normalizeSubtitles(
  subs: VidKingDecrypted['subtitles']
): NuvioStream['subtitles'] {
  if (!Array.isArray(subs)) return undefined;
  return subs
    .filter((s) => s.url)
    .map((s) => ({
      url: s.url!,
      lang: s.lang ?? s.language ?? 'und',
      label: s.label ?? s.display ?? s.language ?? 'Subtitle',
    }));
}

async function fetchServerSources(
  serverName: string,
  serverEndpoint: string,
  mediaType: string,
  tmdbId: string,
  season: string,
  episode: string,
  title: string,
  year: string,
  imdbId: string,
  seed: string,
  signal: AbortSignal
): Promise<NuvioStream[]> {
  const ts = String(Date.now());

  const params = new URLSearchParams({
    title,
    mediaType,
    year,
    episodeId: episode,
    seasonId: season,
    tmdbId,
    imdbId,
    enc: '2',
    seed,
    _t: ts,
  });

  const url = `${SPEED_API_BASE}/${serverEndpoint}?${params.toString()}`;

  const text = await siteFetchText(url, {
    signal,
    acceptLanguage: HI_ACCEPT_LANGUAGE,
    headers: {
      Origin: SITE,
      Referer: `${SITE}/`,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    },
  });

  if (!text) return [];

  const mediaId = Number.parseInt(tmdbId, 10) || 0;
  const decrypted = decryptPayload(text.trim(), seed, mediaId);
  if (!decrypted) return [];

  let data: VidKingDecrypted;
  try {
    data = JSON.parse(decrypted) as VidKingDecrypted;
  } catch {
    return [];
  }

  const sources = data.sources ?? [];
  const sharedSubs = normalizeSubtitles(data.subtitles);

  return sources
    .filter((src) => src.url)
    .map((src) => {
      const srcSubs = normalizeSubtitles(src.subtitles);
      const allSubs = [...(srcSubs ?? []), ...(sharedSubs ?? [])];

      return toStream(src.url!, 'MULTI', LABEL, SITE, {
        quality: src.quality ?? src.label ?? '1080p',
        server: serverName,
        headers: {
          Origin: SITE,
          Referer: `${SITE}/`,
          ...(src.headers ?? {}),
        },
        subtitles: allSubs.length > 0 ? allSubs : undefined,
      });
    });
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || !ctx.tmdbId) return [];
  const startTime = Date.now();

  const normType = ctx.type === 'tv' ? 'tv' : 'movie';
  if (normType === 'tv' && (ctx.season == null || ctx.episode == null)) return [];

  const meta = await fetchMetadata(ctx.tmdbId, normType, ctx.signal);
  if (!meta || isAborted(ctx.signal) || isBudgetExhausted(startTime, PROVIDER_BUDGET_MS)) return [];

  // Fetch seed
  const seedUrl = `${SPEED_API_BASE}/seed?mediaId=${encodeURIComponent(ctx.tmdbId)}`;
  const seedData = await siteFetchJson<{ seed?: string }>(seedUrl, {
    signal: ctx.signal,
    headers: { Origin: SITE, Referer: `${SITE}/` },
  });

  if (!seedData?.seed || isAborted(ctx.signal) || isBudgetExhausted(startTime, PROVIDER_BUDGET_MS)) {
    return [];
  }

  const seed = seedData.seed;
  const sStr = String(ctx.season ?? 1);
  const eStr = String(ctx.episode ?? 1);

  const streams = await fetchServerSources(
    'Hydrogen',
    'cdn/sources-with-title',
    normType,
    ctx.tmdbId,
    sStr,
    eStr,
    meta.title,
    meta.year,
    meta.imdbId,
    seed,
    ctx.signal
  );

  // Filter and dedup
  const seen = new Set<string>();
  return streams.filter((s) => {
    const q = s.quality ?? '';
    if (q !== '1080p' && q !== '2160p') return false;
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}

export const vidking = createNuvioProvider({
  name: 'vidking',
  sites: [SITE],
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'hi',
});
