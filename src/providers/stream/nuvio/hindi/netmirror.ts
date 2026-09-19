/**
 * NetMirror — OTT content mirror API (Netflix / Prime Video / Hotstar).
 *
 * Ported from temp/HindiAPI/HindiAPI/providers/netmirror.js.
 * The API at tv.imgcdn.kim/newtv (URL from a remote config JSON) exposes a
 * search endpoint and a play endpoint per OTT service. Each service has its own
 * authentication headers. Streams carry language information in their titles.
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

const SITE = 'https://tv.imgcdn.kim';
const CONFIG_URL = 'https://raw.githubusercontent.com/SaurabhKaperwan/Utils/refs/heads/main/urls.json';
const FALLBACK_API = 'https://tv.imgcdn.kim/newtv';
const LABEL = 'NetMirror';

const OTT_SERVICES = [
  { code: 'nf', name: 'Netflix' },
  { code: 'pv', name: 'PrimeVideo' },
  { code: 'hs', name: 'Hotstar' },
];

let cachedApiBase: string | null = null;

async function getApiBase(ctx: NuvioContext): Promise<string> {
  if (cachedApiBase) return cachedApiBase;
  const data = await siteFetchJson<{ nfmirror?: string }>(CONFIG_URL, {
    timeoutMs: 6_000,
    signal: ctx.signal,
  });
  cachedApiBase = data?.nfmirror ?? FALLBACK_API;
  return cachedApiBase;
}

interface NfItem { id?: string; t?: string }

async function extractService(
  apiBase: string,
  service: typeof OTT_SERVICES[0],
  title: string,
  ctx: NuvioContext,
  season: number | undefined,
  episode: number | undefined,
): Promise<NuvioStream[]> {
  const headers = {
    'ott': service.code,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0 /OS.GatuNewTV v1.0',
    'x-requested-with': 'NetmirrorNewTV v1.0',
  };

  const searchData = await siteFetchJson<{ searchResult?: NfItem[] }>(
    `${apiBase}/search.php?s=${encodeURIComponent(title)}`,
    { headers, timeoutMs: 8_000, signal: ctx.signal }
  );
  const results = searchData?.searchResult ?? [];
  const match = results.find(r => r.t?.trim().toLowerCase() === title.toLowerCase());
  if (!match?.id) return [];

  if (isAborted(ctx.signal)) return [];

  let playUrl = `${apiBase}/play.php?id=${match.id}&ott=${service.code}`;
  if (ctx.type === 'tv' && season != null && episode != null) {
    playUrl += `&s=${season}&e=${episode}`;
  }

  const playData = await siteFetchJson<{ streams?: Array<{ url?: string; title?: string; quality?: string }> }>(
    playUrl,
    { headers, timeoutMs: 10_000, signal: ctx.signal }
  );
  if (!playData?.streams?.length) return [];

  return playData.streams
    .filter(s => Boolean(s.url))
    .map(s => {
      const lang = s.title?.toLowerCase().includes('hindi') ? 'HINDI'
        : s.title?.toLowerCase().includes('multi') ? 'MULTI' : 'HINDI';
      return toStream(s.url!, lang, `${LABEL} · ${service.name}`, SITE, {
        quality: s.quality ?? '720p',
        headers,
      });
    });
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];
  const startTime = Date.now();

  const apiBase = await getApiBase(ctx);
  if (isAborted(ctx.signal)) return [];

  const streams: NuvioStream[] = [];
  for (const service of OTT_SERVICES) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    const serviceStreams = await extractService(
      apiBase, service, ctx.titles[0], ctx, ctx.season, ctx.episode
    ).catch(() => []);
    streams.push(...serviceStreams);
  }
  return streams;
}

export const netmirror = createNuvioProvider({
  name: 'netmirror',
  sites: [SITE],
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'hi',
});
