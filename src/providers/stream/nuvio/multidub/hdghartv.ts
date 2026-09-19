/**
 * HdGharTV — TMDB-keyed multi-language stream API at hdghartv.cc.
 *
 * Ported from temp/multi-clone/src/providers/waelum.rs.
 * The API accepts TMDB id and returns a list of stream objects with resolution
 * labels. Only streams with resolution >= 720p are included.
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchJson,
  toStream,
  isAborted,
  HI_ACCEPT_LANGUAGE,
} from '../shared.js';

const SITE = 'https://hdghartv.cc';
const LABEL = 'HdGharTV';
const MIN_RES = 720;

function qualityLabel(label: string): string {
  const m = label.match(/(\d{3,4})[pP]/);
  if (m) return `${m[1]}p`;
  const l = label.toLowerCase();
  if (l.includes('4k') || l.includes('8k')) return '2160p';
  if (l.includes('2k')) return '1440p';
  return '720p';
}

function parseResolution(label: string): number {
  const m = label.match(/(\d{3,4})/);
  return m ? parseInt(m[1]) : 0;
}

interface HdGharStream { url?: string; label?: string; language?: string }
interface HdGharResponse {
  streams?: HdGharStream[];
  sources?: HdGharStream[];
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || !ctx.tmdbId) return [];

  let apiUrl = `${SITE}/api/${ctx.type}/${ctx.tmdbId}`;
  if (ctx.type === 'tv' && ctx.season != null && ctx.episode != null) {
    apiUrl += `/${ctx.season}/${ctx.episode}`;
  }

  const data = await siteFetchJson<HdGharResponse>(apiUrl, {
    headers: { Referer: `${SITE}/`, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36' },
    acceptLanguage: HI_ACCEPT_LANGUAGE,
    timeoutMs: 10_000,
    signal: ctx.signal,
  });

  const items = data?.streams ?? data?.sources ?? [];
  return items
    .filter(s => s.url && parseResolution(s.label ?? '') >= MIN_RES)
    .map(s => {
      const lang = (s.language ?? '').toLowerCase().includes('hindi') ? 'HINDI'
        : (s.language ?? '').toLowerCase().includes('multi') ? 'MULTI' : 'HINDI';
      return toStream(s.url!, lang, LABEL, SITE, {
        quality: qualityLabel(s.label ?? '720p'),
        headers: { Referer: `${SITE}/` },
      });
    });
}

export const hdghartv = createNuvioProvider({
  name: 'hdghartv',
  sites: [SITE],
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'hi',
});
