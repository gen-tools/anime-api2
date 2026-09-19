/**
 * VidUp — TMDB-keyed multi-language streaming site at vidup.to.
 *
 * Ported from temp/multi-clone/src/providers/qorva.rs.
 * The site uses an enc-dec.app API for decryption. The page at
 * /movie/TMDBID or /tv/TMDBID/S/E contains an encrypted token in a JS
 * variable; decrypting it yields server URLs. Each server is then resolved
 * via a POST to the stream endpoint.
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchText,
  siteFetchJson,
  toStream,
  isAborted,
  isBudgetExhausted,
  PROVIDER_BUDGET_MS,
} from '../shared.js';

const SITE = 'https://vidup.to';
const DECRYPT_API = 'https://enc-dec.app/api';
const LABEL = 'VidUp';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  'Referer': `${SITE}/`,
  'X-Requested-With': 'XMLHttpRequest',
};

interface DecResult {
  status?: number;
  result?: {
    status?: number;
    servers?: string;
    stream?: string;
    token?: string;
    url?: string;
    tracks?: Array<{ file?: string; label?: string }>;
  };
}

interface ServerList {
  status?: number;
  result?: Array<{ name?: string; data?: string }>;
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || !ctx.tmdbId) return [];
  const startTime = Date.now();

  const pageUrl = ctx.type === 'tv' && ctx.season != null && ctx.episode != null
    ? `${SITE}/tv/${ctx.tmdbId}/${ctx.season}/${ctx.episode}`
    : `${SITE}/movie/${ctx.tmdbId}`;

  const pageText = await siteFetchText(pageUrl, {
    headers: HEADERS,
    timeoutMs: 10_000,
    signal: ctx.signal,
  });
  if (!pageText || isAborted(ctx.signal)) return [];

  // Extract the "en" encrypted token from the page JS
  const needle = `"en":"`;
  const start = pageText.indexOf(needle);
  if (start === -1) return [];
  const tokenStart = start + needle.length;
  const tokenEnd = pageText.indexOf(`"`, tokenStart);
  if (tokenEnd === -1) return [];
  const enc = pageText.slice(tokenStart, tokenEnd);

  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  // Decrypt via enc-dec API
  const encData = await siteFetchJson<DecResult>(
    `${DECRYPT_API}/enc-vidup?text=${encodeURIComponent(enc)}`,
    { headers: HEADERS, timeoutMs: 8_000, signal: ctx.signal }
  );
  if (encData?.result?.status !== 200 && encData?.status !== 200) return [];

  const result = encData?.result;
  if (!result?.servers || !result?.stream || !result?.token) return [];

  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  // Fetch server list
  const serversEnc = await siteFetchText(result.servers, {
    method: 'POST',
    headers: { ...HEADERS, 'X-CSRF-Token': result.token },
    timeoutMs: 8_000,
    signal: ctx.signal,
  });
  if (!serversEnc) return [];

  const decServers = await siteFetchJson<ServerList>(
    `${DECRYPT_API}/dec-vidup`,
    {
      method: 'POST',
      body: JSON.stringify({ text: serversEnc }),
      headers: { ...HEADERS, 'Content-Type': 'application/json', 'X-CSRF-Token': result.token },
      timeoutMs: 8_000,
      signal: ctx.signal,
    }
  );
  if (decServers?.status !== 200 || !Array.isArray(decServers?.result)) return [];

  const streams: NuvioStream[] = [];
  const seen = new Set<string>();

  for (const server of decServers.result.slice(0, 5)) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    if (!server.data) continue;

    const serverEnc = await siteFetchText(`${result.stream}/${server.data}`, {
      method: 'POST',
      headers: { ...HEADERS, 'X-CSRF-Token': result.token },
      timeoutMs: 8_000,
      signal: ctx.signal,
    });
    if (!serverEnc) continue;

    const finalData = await siteFetchJson<DecResult>(
      `${DECRYPT_API}/dec-vidup`,
      {
        method: 'POST',
        body: JSON.stringify({ text: serverEnc }),
        headers: { ...HEADERS, 'Content-Type': 'application/json', 'X-CSRF-Token': result.token },
        timeoutMs: 8_000,
        signal: ctx.signal,
      }
    );
    if (finalData?.result?.status !== 200) continue;

    const streamUrl = finalData?.result?.url;
    if (!streamUrl || seen.has(streamUrl)) continue;
    seen.add(streamUrl);

    const subs = (finalData?.result?.tracks ?? [])
      .filter(t => t.file?.startsWith('https://'))
      .map(t => ({ url: t.file!, label: t.label ?? 'Unknown', language: t.label ?? 'und' }));

    streams.push(toStream(streamUrl, 'MULTI', `${LABEL} · ${server.name ?? 'Server'}`, SITE, {
      quality: '1080p',
      headers: { Referer: `${SITE}/`, Origin: SITE, 'User-Agent': UA },
      subtitles: subs,
    }));
  }

  return streams;
}

export const vidup = createNuvioProvider({
  name: 'vidup',
  sites: [SITE],
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'en',
});
