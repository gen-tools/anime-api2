/**
 * HindMoviez — Morpheus-based stream proxy at badboysxs-morpheus.hf.space.
 *
 * Ported from temp/HindiAPI/HindiAPI/providers/hindmoviez.js.
 * Uses the same IMDB-keyed Stremio stream format as cinestream. Only streams
 * whose URL starts with the proxy base are accepted (the upstream `isHindMovieSource`
 * filter). We emit those as-is with the HINDI language tag.
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchJson,
  toStream,
  isAborted,
  HI_ACCEPT_LANGUAGE,
} from '../shared.js';

const SITE = 'https://badboysxs-morpheus.hf.space';
const LABEL = 'HindMoviez';

interface StremioStream { url?: string; title?: string; name?: string }

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
    .filter(s => Boolean(s.url) && String(s.url).startsWith('http'))
    .map(s => {
      const url = !s.url!.startsWith('http') ? `${SITE}${s.url}` : s.url!;
      return toStream(url, 'HINDI', LABEL, SITE, { quality: '720p' });
    });
}

export const hindmoviez = createNuvioProvider({
  name: 'hindmoviez',
  sites: [SITE],
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'hi',
});
