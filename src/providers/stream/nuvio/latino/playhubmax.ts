/**
 * PlayHubMax — AES-256-CBC encrypted API at api.playhubmax.com.
 *
 * Ported from temp/Latino/Latino/providers/playhubmax.js.
 * The site exposes a JSON API that returns an AES-CBC encrypted payload. The
 * upstream code includes a full pure-JS AES implementation — we reuse the same
 * algorithm ported to TypeScript. The decrypted JSON contains server objects
 * with `url` and `lang` fields.
 *
 * Key: "33dff3b1c1362e45e1425fcc9724d6f3" (UTF-8 bytes, 32 bytes → AES-256)
 * IV:  "33dff3b1c1362e45" (UTF-8 bytes, 16 bytes)
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchJson,
  resolveEmbedsUntil,
  isAborted,
  isBudgetExhausted,
  decodeBase64,
  ES_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
} from '../shared.js';

const SITE = 'https://www.playhubmax.com';
const API  = 'https://api.playhubmax.com/api';
const LABEL = 'PlayHubMax';

const AES_KEY_STR = '33dff3b1c1362e45e1425fcc9724d6f3';
const AES_IV_STR  = '33dff3b1c1362e45';

// Pure-JS AES-256-CBC decryption ported verbatim from upstream
const AES_SBOX = [99,124,119,123,242,107,111,197,48,1,103,43,254,215,171,118,202,130,201,125,250,89,71,240,173,212,162,175,156,164,114,192,183,253,147,38,54,63,247,204,52,165,229,241,113,216,49,21,4,199,35,195,24,150,5,154,7,18,128,226,235,39,178,117,9,131,44,26,27,110,90,160,82,59,214,179,41,227,47,132,83,209,0,237,32,252,177,91,106,203,190,57,74,76,88,207,208,239,170,251,67,77,51,133,69,249,2,127,80,60,159,168,81,163,64,143,146,157,56,245,188,182,218,33,16,255,243,210,205,12,19,236,95,151,68,23,196,167,126,61,100,93,25,115,96,129,79,220,34,42,144,136,70,238,184,20,222,94,11,219,224,50,58,10,73,6,36,92,194,211,172,98,145,149,228,121,231,200,55,109,141,213,78,169,108,86,244,234,101,122,174,8,186,120,37,46,28,166,180,198,232,221,116,31,75,189,139,138,112,62,181,102,72,3,246,14,97,53,87,185,134,193,29,158,225,248,152,17,105,217,142,148,155,30,135,233,206,85,40,223,140,161,137,13,191,230,66,104,65,153,45,15,176,84,187,22];
const AES_SBOX_INV = AES_SBOX.reduce((inv, v, i) => { inv[v] = i; return inv; }, new Array<number>(256));
const AES_RCON = [1,2,4,8,16,32,64,128,27,54];

function gmul(a: number, b: number): number {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    const hbs = a & 128;
    a = (a << 1) & 255;
    if (hbs) a ^= 27;
    b >>= 1;
  }
  return p;
}

function aesKeyExpansion(k: number[]): number[][] {
  const w: number[][] = [];
  for (let i = 0; i < 8; i++) w[i] = k.slice(i * 4, i * 4 + 4);
  for (let i = 8; i < 60; i++) {
    let temp = w[i - 1].slice();
    if (i % 8 === 0) {
      let rot = [temp[1], temp[2], temp[3], temp[0]];
      temp = rot.map(b => AES_SBOX[b]);
      temp[0] ^= AES_RCON[i / 8 - 1];
    } else if (i % 8 === 4) {
      temp = temp.map(b => AES_SBOX[b]);
    }
    w[i] = [0,1,2,3].map(j => w[i-8][j] ^ temp[j]);
  }
  return w;
}

function aesDecryptBlock(block: number[], rk: number[][]): number[] {
  let s = [[block[0],block[1],block[2],block[3]],[block[4],block[5],block[6],block[7]],[block[8],block[9],block[10],block[11]],[block[12],block[13],block[14],block[15]]];
  for (let c = 0; c < 4; c++) { const r = rk[56+c]; for (let i = 0; i < 4; i++) s[c][i] ^= r[i]; }
  for (let round = 13; round >= 1; round--) {
    const t = s[0][1]; s[0][1]=s[1][1]; s[1][1]=s[2][1]; s[2][1]=s[3][1]; s[3][1]=t;
    const t2 = s[0][2]; s[0][2]=s[2][2]; s[2][2]=t2; const t3=s[1][2]; s[1][2]=s[3][2]; s[3][2]=t3;
    const t4=s[3][3]; s[3][3]=s[2][3]; s[2][3]=s[1][3]; s[1][3]=s[0][3]; s[0][3]=t4;
    for (let c = 0; c < 4; c++) for (let i = 0; i < 4; i++) s[c][i] = AES_SBOX_INV[s[c][i]];
    for (let c = 0; c < 4; c++) { const r = rk[round*4+c]; for (let i = 0; i < 4; i++) s[c][i] ^= r[i]; }
    for (let c = 0; c < 4; c++) {
      const a = s[c].slice();
      s[c][0]=gmul(a[0],14)^gmul(a[1],11)^gmul(a[2],13)^gmul(a[3],9);
      s[c][1]=gmul(a[0],9)^gmul(a[1],14)^gmul(a[2],11)^gmul(a[3],13);
      s[c][2]=gmul(a[0],13)^gmul(a[1],9)^gmul(a[2],14)^gmul(a[3],11);
      s[c][3]=gmul(a[0],11)^gmul(a[1],13)^gmul(a[2],9)^gmul(a[3],14);
    }
  }
  const t = s[0][1]; s[0][1]=s[1][1]; s[1][1]=s[2][1]; s[2][1]=s[3][1]; s[3][1]=t;
  const t2 = s[0][2]; s[0][2]=s[2][2]; s[2][2]=t2; const t3=s[1][2]; s[1][2]=s[3][2]; s[3][2]=t3;
  const t4=s[3][3]; s[3][3]=s[2][3]; s[2][3]=s[1][3]; s[1][3]=s[0][3]; s[0][3]=t4;
  for (let c = 0; c < 4; c++) for (let i = 0; i < 4; i++) s[c][i] = AES_SBOX_INV[s[c][i]];
  for (let c = 0; c < 4; c++) { const r = rk[c]; for (let i = 0; i < 4; i++) s[c][i] ^= r[i]; }
  return [s[0][0],s[1][0],s[2][0],s[3][0],s[0][1],s[1][1],s[2][1],s[3][1],s[0][2],s[1][2],s[2][2],s[3][2],s[0][3],s[1][3],s[2][3],s[3][3]];
}

function aesDecryptCBC(cipherBytes: number[], keyBytes: number[], ivBytes: number[]): string {
  const rk = aesKeyExpansion(keyBytes);
  const out: number[] = [];
  let prevBlock = ivBytes.slice();
  for (let i = 0; i < cipherBytes.length; i += 16) {
    const block = cipherBytes.slice(i, i + 16);
    const dec = aesDecryptBlock(block, rk);
    const plain = dec.map((b, j) => b ^ prevBlock[j]);
    out.push(...plain);
    prevBlock = block;
  }
  // Remove PKCS7 padding
  const padLen = out[out.length - 1];
  return out.slice(0, out.length - padLen).map(b => String.fromCharCode(b)).join('');
}

function strToBytes(s: string): number[] {
  return s.split('').map(c => c.charCodeAt(0));
}

function decryptPayload(encrypted: string): string | null {
  try {
    const cipherBytes = Array.from(Uint8Array.from(atob(encrypted), c => c.charCodeAt(0)));
    const keyBytes = strToBytes(AES_KEY_STR);
    const ivBytes = strToBytes(AES_IV_STR);
    return aesDecryptCBC(cipherBytes, keyBytes, ivBytes);
  } catch {
    return null;
  }
}

function langTag(lang: string): string {
  const l = (lang ?? '').toLowerCase();
  if (l.includes('cast') || l.includes('esp')) return 'CAST';
  if (l.includes('sub')) return 'SUB';
  return 'LAT';
}

interface PhmResponse {
  success?: boolean;
  data?: string;
  servers?: Array<{ url?: string; lang?: string; server?: string }>;
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || !ctx.tmdbId) return [];
  const startTime = Date.now();

  let apiUrl = `${API}/${ctx.type}/${ctx.tmdbId}`;
  if (ctx.type === 'tv' && ctx.season != null && ctx.episode != null) {
    apiUrl += `/${ctx.season}/${ctx.episode}`;
  }

  const resp = await siteFetchJson<PhmResponse>(apiUrl, {
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Origin': SITE,
      'Referer': `${SITE}/`,
    },
    acceptLanguage: ES_ACCEPT_LANGUAGE,
    timeoutMs: 10_000,
    signal: ctx.signal,
  });
  if (!resp?.success) return [];

  let servers: Array<{ url?: string; lang?: string; server?: string }> = [];
  if (resp.data) {
    const decrypted = decryptPayload(resp.data);
    if (decrypted) {
      try {
        const parsed = JSON.parse(decrypted) as { servers?: typeof servers };
        servers = parsed.servers ?? [];
      } catch { return []; }
    }
  } else if (resp.servers) {
    servers = resp.servers;
  }

  if (servers.length === 0) return [];
  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  const embeds = servers
    .filter(s => s.url?.startsWith('http'))
    .map(s => ({ url: s.url!, language: langTag(s.lang ?? '') }));

  return resolveEmbedsUntil(embeds, {
    language: 'LAT',
    providerLabel: LABEL,
    siteUrl: SITE,
    signal: ctx.signal,
    budgetMs: PROVIDER_BUDGET_MS - (Date.now() - startTime),
  });
}

export const playhubmax = createNuvioProvider({
  name: 'playhubmax',
  sites: [SITE],
  language: 'es',
  extract,
  supportsMovie: true,
});
