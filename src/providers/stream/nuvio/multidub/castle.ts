/**
 * Castle — Android-app-based multi-language stream service at api.hlowb.com.
 *
 * Ported from temp/multi-clone/src/providers/karnis.rs.
 * The API uses AES-128-CBC encryption. The security key is derived from a
 * base64-encoded key in the API response, combined with a hardcoded suffix.
 * We query TMDB for the title, then search the Castle API, decrypt the result,
 * and emit the stream URLs.
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchJson,
  toStream,
  isAborted,
  isBudgetExhausted,
  HI_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
  decodeBase64,
} from '../shared.js';

const API = 'https://api.hlowb.com';
const SITE = 'https://api.hlowb.com';
const LABEL = 'Castle';
const KARNIS_SUFFIX = 'T!BgJB';

const API_HEADERS = {
  'User-Agent': 'okhttp/4.9.3',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Connection': 'Keep-Alive',
  'Referer': `${API}/`,
};

// AES-128-CBC pure-TS decryption
function strToBytes(s: string): Uint8Array {
  return new Uint8Array(s.split('').map(c => c.charCodeAt(0)));
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  return new Uint8Array(bin.split('').map(c => c.charCodeAt(0)));
}

function deriveKey(securityKeyB64: string): Uint8Array | null {
  try {
    const keyBytes = Array.from(b64ToBytes(securityKeyB64));
    const suffix = Array.from(strToBytes(KARNIS_SUFFIX));
    const material = [...keyBytes, ...suffix];
    const key = new Uint8Array(16);
    key.set(material.slice(0, 16));
    return key;
  } catch { return null; }
}

// We rely on Web Crypto for AES decryption since it's available in the runtime
async function decryptKarnis(encryptedB64: string, securityKeyB64: string): Promise<string | null> {
  try {
    const key = deriveKey(securityKeyB64);
    if (!key) return null;
    const ciphertext = b64ToBytes(encryptedB64.trim());

    const cryptoKey = await crypto.subtle.importKey(
      'raw', key.buffer as ArrayBuffer, { name: 'AES-CBC' }, false, ['decrypt']
    );
    // For AES-128-CBC the IV is the same 16-byte key in this implementation
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: key.buffer as ArrayBuffer },
      cryptoKey,
      ciphertext.buffer as ArrayBuffer
    );
    return new TextDecoder().decode(decrypted);
  } catch { return null; }
}

interface KarnisSearchResult {
  id?: string | number;
  title?: string;
  security_key?: string;
  encrypted_data?: string;
}

interface KarnisStream {
  url?: string;
  quality?: string;
  language?: string;
  resolution?: number;
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];
  const startTime = Date.now();

  const title = encodeURIComponent(ctx.titles[0]);
  const searchData = await siteFetchJson<KarnisSearchResult[]>(
    `${API}/search?q=${title}&type=${ctx.type === 'tv' ? 'tv' : 'movie'}`,
    { headers: API_HEADERS, timeoutMs: 8_000, signal: ctx.signal }
  );
  if (!searchData?.length) return [];

  const best = searchData[0];
  if (!best.id || !best.security_key) return [];
  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  let streamUrl = `${API}/stream/${ctx.type === 'tv' ? 'tv' : 'movie'}/${best.id}`;
  if (ctx.type === 'tv' && ctx.season != null && ctx.episode != null) {
    streamUrl += `/${ctx.season}/${ctx.episode}`;
  }
  streamUrl += `?resolutions=3,2`;

  const encData = await siteFetchJson<{ encrypted_data?: string; security_key?: string }>(
    streamUrl,
    { headers: API_HEADERS, timeoutMs: 10_000, signal: ctx.signal }
  );
  if (!encData?.encrypted_data) return [];

  const secKey = encData.security_key ?? best.security_key;
  const decrypted = await decryptKarnis(encData.encrypted_data, secKey);
  if (!decrypted) return [];

  let streams: KarnisStream[];
  try { streams = JSON.parse(decrypted) as KarnisStream[]; }
  catch { return []; }

  return streams
    .filter(s => {
      const res = s.resolution ?? 0;
      return s.url && res >= 720;
    })
    .map(s => {
      const lang = (s.language ?? '').toLowerCase();
      const tag = lang.includes('hindi') ? 'HINDI'
        : lang.includes('english') ? 'ENGLISH'
        : lang.includes('multi') ? 'MULTI' : 'HINDI';
      return toStream(s.url!, tag, LABEL, SITE, {
        quality: s.quality ?? `${s.resolution ?? 720}p`,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
          Referer: `${SITE}/`,
        },
      });
    });
}

export const castle = createNuvioProvider({
  name: 'castle',
  sites: [SITE],
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'hi',
});
