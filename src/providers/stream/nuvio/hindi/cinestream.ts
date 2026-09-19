/**
 * CineStream — Stremio-compatible stream proxy at webstreamr.hayd.uk.
 *
 * Ported from temp/HindiAPI/HindiAPI/providers/cinestream.js.
 * The API returns Stremio-format stream objects at /stream/movie/IMDBID.json
 * and /stream/series/IMDBID:S:E.json. We resolve the IMDB id from TMDB once
 * and reuse it. Streams carry no explicit language tag; we default to HINDI.
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchJson,
  toStream,
  isAborted,
  HI_ACCEPT_LANGUAGE,
} from '../shared.js';

const SITE = 'https://webstreamr.hayd.uk';
const LABEL = 'CineStream';

interface StremioStream {
  url?: string;
  name?: string;
  title?: string;
  behaviorHints?: { proxyHeaders?: { request?: Record<string, string> } };
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || !ctx.tmdbId) return [];

  const tmdbEndpoint = ctx.type === 'tv' ? 'tv' : 'movie';
  const ext = await siteFetchJson<{ imdb_id?: string }>(
    `https://api.themoviedb.org/3/${tmdbEndpoint}/${ctx.tmdbId}/external_ids`,
    { timeoutMs: 5_000, signal: ctx.signal }
  );
  const imdbId = ext?.imdb_id;
  if (!imdbId) return [];

  if (isAborted(ctx.signal)) return [];

  let apiUrl: string;
  if (ctx.type === 'tv' && ctx.season != null && ctx.episode != null) {
    apiUrl = `${SITE}/stream/series/${imdbId}:${ctx.season}:${ctx.episode}.json`;
  } else {
    apiUrl = `${SITE}/stream/movie/${imdbId}.json`;
  }

  const data = await siteFetchJson<{ streams?: StremioStream[] }>(apiUrl, {
    headers: { Referer: `${SITE}/` },
    acceptLanguage: HI_ACCEPT_LANGUAGE,
    timeoutMs: 8_000,
    signal: ctx.signal,
  });
  if (!data?.streams?.length) return [];

  return data.streams
    .filter(s => Boolean(s.url))
    .map(s => {
      const headers = s.behaviorHints?.proxyHeaders?.request ?? { Referer: SITE };
      const quality = (s.title ?? '').includes('1080p') ? '1080p'
        : (s.title ?? '').includes('720p') ? '720p' : '720p';
      return toStream(s.url!, 'HINDI', LABEL, SITE, { quality, headers });
    });
}

export const cinestream = createNuvioProvider({
  name: 'cinestream',
  sites: [SITE],
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'hi',
});
