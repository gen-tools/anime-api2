/**
 * StreamFlix — Firebase-backed Indian streaming catalogue.
 *
 * Ported from temp/HindiAPI/HindiAPI/providers/streamflix.js.
 * A Google Apps Script proxy resolves the TMDB id to StreamFlix database
 * entries. Each entry has a `movielink` (for movies) or `moviekey` (for TV);
 * the TV path fetches an episode link from Firebase. The final stream URL is
 * constructed by prefixing with `config.premium[]` CDN bases.
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchJson,
  toStream,
  isAborted,
  isBudgetExhausted,
  HI_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
} from '../shared.js';

const SITE = 'https://api.streamflix.app';
const CONFIG_URL = `${SITE}/config/config-streamflixapp.json`;
const FIREBASE_DB = 'https://chilflix-410be-default-rtdb.asia-southeast1.firebasedatabase.app';
const PROXY_URL = 'https://script.google.com/macros/s/AKfycbzKvHoxL0rV7PGsti4EN0oNMoiFmizAmipZ2R_ZoCQeIyAC_xeXVBeI2vB2GDa4fGIYYg/exec';
const LABEL = 'StreamFlix';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': `${SITE}/`,
  'Accept': 'application/json, text/plain, */*',
};

interface SfItem {
  movielink?: string;
  moviekey?: string;
  moviename?: string;
  movieyear?: string;
}

interface SfConfig {
  premium?: string[];
}

function detectLang(moviename: string): string {
  const t = (moviename ?? '').toLowerCase();
  const langs: string[] = [];
  if (t.includes('hindi')) langs.push('Hindi');
  if (t.includes('tamil')) langs.push('Tamil');
  if (t.includes('telugu')) langs.push('Telugu');
  if (t.includes('english')) langs.push('English');
  if (langs.length > 1) return 'MULTI';
  if (langs.length === 1) return langs[0].toUpperCase();
  return 'HINDI';
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || !ctx.tmdbId || ctx.titles.length === 0) return [];
  const startTime = Date.now();

  // Fetch metadata via proxy
  const proxyUrl = `${PROXY_URL}?tmdb=${ctx.tmdbId}&title=${encodeURIComponent(ctx.titles[0])}`;
  const proxyData = await siteFetchJson<{ success?: boolean; data?: SfItem[] }>(proxyUrl, {
    headers: HEADERS,
    acceptLanguage: HI_ACCEPT_LANGUAGE,
    timeoutMs: 10_000,
    signal: ctx.signal,
  });
  if (!proxyData?.success || !proxyData.data?.length) return [];

  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  const config = await siteFetchJson<SfConfig>(CONFIG_URL, {
    headers: HEADERS,
    timeoutMs: 6_000,
    signal: ctx.signal,
  });
  if (!config?.premium?.length) return [];

  const streams: NuvioStream[] = [];
  const lang = detectLang(proxyData.data[0].moviename ?? '');

  for (const item of proxyData.data.slice(0, 3)) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;

    if (ctx.type === 'movie' && item.movielink) {
      for (const base of config.premium) {
        streams.push(toStream(`${base}${item.movielink}`, lang, LABEL, SITE, {
          quality: '1080p',
          headers: { ...HEADERS, Origin: SITE },
        }));
      }
    } else if (ctx.type === 'tv' && item.moviekey && ctx.season != null && ctx.episode != null) {
      const epData = await siteFetchJson<{ link?: string; name?: string }>(
        `${FIREBASE_DB}/Data/${item.moviekey}/seasons/${ctx.season}/episodes/${ctx.episode - 1}.json`,
        { timeoutMs: 8_000, signal: ctx.signal }
      );
      if (epData?.link) {
        for (const base of config.premium) {
          streams.push(toStream(`${base}${epData.link}`, lang, LABEL, SITE, {
            quality: '1080p',
            headers: { ...HEADERS, Origin: SITE },
          }));
        }
      }
    }
  }

  return streams;
}

export const streamflix = createNuvioProvider({
  name: 'streamflix',
  sites: [SITE],
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'hi',
});
