/**
 * BrazucaPlay — Single-server variant of the Videasy API, Brazilian market.
 *
 * Ported from temp/Latino/Latino/providers/brazucaplay.js.
 * Identical to videasy.ts but uses only the Gekko/Cuevana endpoint and emits
 * streams with a DUB (pt-BR) tag instead of LAT since this server is Brazilian.
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchText,
  siteFetchJson,
  toStream,
  isAborted,
  PROVIDER_BUDGET_MS,
} from '../shared.js';

const SITE = 'https://brazucaplay.com';
const LABEL = 'BrazucaPlay';
const CUEVANA_API = 'https://api2.videasy.net/cuevana/sources-with-title';
const API_DEC = 'https://enc-dec.app/api/dec-videasy';
const CINEBY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 OPR/126.0.0.0 (Edition std-2)';

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || !ctx.tmdbId || ctx.titles.length === 0) return [];

  const doubleEncTitle = encodeURIComponent(encodeURIComponent(ctx.titles[0]));
  let searchUrl = `${CUEVANA_API}?title=${doubleEncTitle}&mediaType=${ctx.type}&tmdbId=${ctx.tmdbId}`;
  if (ctx.type === 'tv' && ctx.season != null && ctx.episode != null) {
    searchUrl += `&episodeId=${ctx.episode}&seasonId=${ctx.season}`;
  }

  const reqHeaders = {
    'Accept': '*/*',
    'Origin': 'https://cineby.sc',
    'Referer': 'https://cineby.sc/',
    'User-Agent': CINEBY_UA,
  };

  const encText = await siteFetchText(searchUrl, {
    headers: reqHeaders,
    timeoutMs: 8_000,
    signal: ctx.signal,
  });
  if (!encText || encText.length < 20) return [];

  const decData = await siteFetchJson<{ result?: { sources?: Array<{ url?: string; quality?: string }> } }>(
    API_DEC,
    {
      method: 'POST',
      body: JSON.stringify({ text: encText, id: String(ctx.tmdbId) }),
      headers: { 'Content-Type': 'application/json', 'User-Agent': CINEBY_UA },
      timeoutMs: 8_000,
      signal: ctx.signal,
    }
  );
  if (!decData?.result?.sources) return [];

  return decData.result.sources
    .filter(s => Boolean(s.url))
    .map(s => toStream(s.url!, 'DUB', LABEL, SITE, {
      quality: (s.quality ?? 'HD').toUpperCase() === 'AUTO' ? '1080p' : (s.quality ?? 'HD'),
      server: 'Cuevana',
      headers: reqHeaders,
    }));
}

export const brazucaplay = createNuvioProvider({
  name: 'brazucaplay',
  sites: [SITE],
  language: 'pt',
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'pt-BR',
});
