/**
 * Per-host embed resolvers.
 *
 * Each function takes one embed/player page URL and returns a directly playable
 * media URL, or `null` when the host cannot be resolved without a real browser.
 * They are deliberately total — a resolver that throws would abort the whole
 * provider fan-out in `resolveStream`, so every body is wrapped.
 *
 * The extraction regexes are carried over verbatim from the upstream library.
 * They look redundant but are not: each alternative corresponds to a player
 * build a given host actually serves (JWPlayer `file:`, VideoJS `src:`,
 * `sources: [...]`, bare URL in a string), and the ordering encodes which one
 * is trustworthy when a page contains several candidates.
 */

import { fetchText, fetchResponse, fetchJson } from '../http/fetch.js';
import { unpack } from './unpack.js';

export interface ResolvedStream {
  url: string;
  headers?: Record<string, string>;
  quality?: string;
  type?: string;
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/** Base headers shared by all hosts; individual resolvers add their Referer. */
export const BASE_HEADERS: Record<string, string> = { 'User-Agent': USER_AGENT };

// ─── Page cache ──────────────────────────────────────────────────────────────
// A single episode routinely yields several mirror URLs pointing at the same
// embed page, and iframe peeling revisits pages too. The upstream library had a
// global fetch cache for exactly this reason; this is the same idea scoped to
// the resolvers, as a plain Map with a TTL.

interface FetchedPage {
  html: string;
  /** URL after redirects — some hosts sign the real CDN host into it. */
  finalUrl: string;
  status: number;
}

interface CacheEntry<T> {
  data: T;
  ts: number;
}

const PAGE_CACHE_TTL = 120_000;
const PAGE_CACHE_MAX = 150;
const pageCache = new Map<string, CacheEntry<FetchedPage>>();

function cacheGet(key: string): FetchedPage | null {
  const entry = pageCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts >= PAGE_CACHE_TTL) {
    pageCache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key: string, data: FetchedPage): void {
  // Evict the oldest fifth rather than clearing, so a burst of misses does not
  // throw away entries the current lookup is still going to need.
  if (pageCache.size >= PAGE_CACHE_MAX) {
    const victims = [...pageCache.entries()]
      .sort((a, b) => a[1].ts - b[1].ts)
      .slice(0, Math.ceil(PAGE_CACHE_MAX * 0.2));
    for (const [k] of victims) pageCache.delete(k);
  }
  pageCache.set(key, { data, ts: Date.now() });
}

/**
 * GET an embed page, with the body kept even for error statuses (several hosts
 * signal "file removed" or "temporarily unavailable" with a 4xx/5xx body the
 * resolvers need to read). Only successful responses are cached.
 */
async function getPage(
  url: string,
  headers?: Record<string, string>,
  timeoutMs?: number
): Promise<FetchedPage | null> {
  const key = `GET|${url}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  try {
    const res = await fetchResponse(url, {
      headers: { ...BASE_HEADERS, ...(headers || {}) },
      timeoutMs: timeoutMs ?? 15000,
    });
    let html = '';
    try {
      html = await res.text();
    } catch {
      html = '';
    }
    const page: FetchedPage = { html, finalUrl: res.url || url, status: res.status };
    if (res.status >= 200 && res.status < 300) cacheSet(key, page);
    return page;
  } catch {
    return null;
  }
}

// ─── Dead embeds ─────────────────────────────────────────────────────────────

const DEAD_EMBED_TTL = 600_000;
const deadEmbeds = new Map<string, number>();

/**
 * Record an embed whose file the host says is gone. A deleted file is deleted on
 * every mirror, so `resolveStream` skips its generic fallback (re-fetch, unpack,
 * iframe peel) for these instead of burning budget on a tombstone page.
 */
export function markDeadEmbed(url: string): void {
  if (deadEmbeds.size > 300) deadEmbeds.clear();
  deadEmbeds.set(url, Date.now());
}

export function isDeadEmbed(url: string): boolean {
  const ts = deadEmbeds.get(url);
  if (ts === undefined) return false;
  if (Date.now() - ts >= DEAD_EMBED_TTL) {
    deadEmbeds.delete(url);
    return false;
  }
  return true;
}

// ─── Small helpers ───────────────────────────────────────────────────────────

/** Run patterns in order and return the first match. Order is significant. */
function matchAny(html: string, patterns: RegExp[]): RegExpMatchArray | null {
  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m) return m;
  }
  return null;
}

/** First capture group if present, else the whole match. */
function captured(m: RegExpMatchArray): string {
  return m[1] ?? m[0];
}

function decodeBase64(value: string): string | null {
  try {
    return atob(value);
  } catch {
    return null;
  }
}

/** Upstream `_atob`: leaves the value alone when it is not valid base64. */
function atobOrSelf(value: string): string {
  return decodeBase64(value) ?? value;
}

function hostOf(url: string): string {
  return url.match(/^https?:\/\/([^/]+)/)?.[1] || '';
}

function originOf(url: string): string {
  return url.match(/^https?:\/\/[^/]+/)?.[0] || '';
}

function maybeUnpack(html: string): string {
  return html.includes('p,a,c,k,e,d') || html.includes('eval(function') ? unpack(html) : html;
}

/**
 * Placeholder media some hosts serve to scrapers instead of a 404.
 *
 * `/troll/master.m3u8` is fsvid/vidzy's anti-scraper decoy — it is byte-identical
 * for every embed, so returning it looks like success and plays a test clip.
 */
export function isKnownFakeDirectUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return true;
  const u = url.toLowerCase();
  return (
    u.includes('test-videos.co.uk') ||
    u.includes('big_buck_bunny') ||
    u.includes('bigbuckbunny') ||
    u.includes('sample-videos.com') ||
    u.includes('example.com') ||
    u.includes('localhost') ||
    u.includes('/troll/master.m3u8')
  );
}

/** True when the URL can go straight to the player with no further resolving. */
export function isPlayableMediaUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  const u = url.toLowerCase();
  if (isKnownFakeDirectUrl(u)) return false;
  // .mpd is included because ExoPlayer/Media3 infers DASH natively.
  return /\.(mp4|m3u8|mkv|webm|mpd)(\?.*)?$/.test(u) || u.includes('/hls2/') || u.includes('/master.m3u8');
}

/** Container hint for the player. Returns undefined when the URL gives none. */
export function inferMediaType(url: string): string | undefined {
  if (!url || typeof url !== 'string') return undefined;
  const u = url.toLowerCase();
  if (
    u.includes('.m3u8') ||
    u.includes('/hls/') ||
    u.includes('/hls2/') ||
    u.includes('master.m3u8') ||
    u.includes('playlist.m3u8')
  ) {
    return 'hls';
  }
  if (u.includes('.mpd')) return 'dash';
  if (u.includes('.mp4')) return 'mp4';
  if (u.includes('.mkv')) return 'mkv';
  if (u.includes('.webm')) return 'webm';
  if (u.includes('.ts') && !u.includes('test') && !u.includes('textures')) return 'hls';
  return undefined;
}

// ─── Host resolvers ──────────────────────────────────────────────────────────

/**
 * video.sibnet.ru — plain MP4 path in the player config, then a 302 to a signed
 * CDN host. The redirect is followed here so the player gets the final URL and
 * does not have to re-send the Referer on a hop it cannot see.
 */
export async function resolveSibnet(url: string): Promise<ResolvedStream | null> {
  try {
    const page = await getPage(url, { Referer: 'https://video.sibnet.ru/' });
    if (!page) return null;
    const html = page.html;

    let videoUrl: string | null = null;
    const fileMatch = html.match(/file\s*:\s*["']([^"']*\.mp4[^"']*)['"]/i);
    if (fileMatch) videoUrl = fileMatch[1];
    if (!videoUrl) {
      const srcMatch = html.match(/src\s*:\s*["']([^"']*\.mp4[^"']*)['"]/i);
      if (srcMatch) videoUrl = srcMatch[1];
    }
    if (!videoUrl) {
      const playerSrcMatch = html.match(
        /player\.src\(\s*\[\s*\{\s*src\s*:\s*["']([^"']+\.mp4[^"']*)['"]/i
      );
      if (playerSrcMatch) videoUrl = playerSrcMatch[1];
    }
    if (!videoUrl) {
      const genericMatch = html.match(/["']((?:https?:)?\/\/[^"'\s]+\.mp4[^"'\s]*)["']/i);
      if (genericMatch) videoUrl = genericMatch[1];
    }
    if (!videoUrl) return null;

    if (videoUrl.startsWith('//')) videoUrl = 'https:' + videoUrl;
    else if (videoUrl.startsWith('/')) videoUrl = 'https://video.sibnet.ru' + videoUrl;

    try {
      const head = await fetchResponse(videoUrl, {
        method: 'HEAD',
        headers: { ...BASE_HEADERS, Referer: 'https://video.sibnet.ru/' },
        timeoutMs: 5000,
      });
      if (head.url && head.url !== videoUrl && head.url.includes('.mp4')) {
        videoUrl = head.url;
      }
    } catch {
      /* keep the pre-redirect URL */
    }

    return { url: videoUrl, headers: { Referer: 'https://video.sibnet.ru/' } };
  } catch {
    return null;
  }
}

/**
 * vidmoly / voembed — packed JS, sometimes behind a JWT bounce page
 * (`window.location.replace('...?ch=1&js=<jwt>')`). Its domain rotates
 * constantly, so known-live TLDs are tried in turn; dead ones (.biz, .me) are
 * skipped and short bodies are treated as ad/404 interstitials.
 */
export async function resolveVidmoly(url: string): Promise<ResolvedStream | null> {
  const PATTERNS = [
    /file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    /sources\s*:\s*\[["']([^"']+\.(?:m3u8|mp4)[^"']*)["']\]/i,
    /["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
  ];

  try {
    const originalDomain = hostOf(url);
    const originalReferer = originalDomain ? `https://${originalDomain}/` : 'https://vidmoly.to/';

    const tldVariants = ['to', 'net', 'ru', 'is'];
    const domains = [url];
    for (const tld of tldVariants) {
      const altUrl = url.replace(/vidmoly\.(net|to|ru|is|biz|me)/, `vidmoly.${tld}`);
      if (altUrl !== url) domains.push(altUrl);
    }
    const uniqueDomains = [...new Set(domains)].slice(0, 4);

    for (const fetchUrl of uniqueDomains) {
      try {
        const fetchDomain = hostOf(fetchUrl);
        const ref = fetchDomain ? `https://${fetchDomain}/` : originalReferer;
        const page = await getPage(fetchUrl, { Referer: ref, Origin: ref });
        if (!page || page.status < 200 || page.status >= 300) continue;

        let html = page.html;
        const hasJsRedirect = /window\.location\.replace/.test(html);
        if ((html.length < 500 && !hasJsRedirect) || html.includes('finisheddaysflamboyant')) continue;

        html = maybeUnpack(html);

        const match = matchAny(html, PATTERNS);
        if (match) return { url: captured(match), headers: { Referer: ref, Origin: ref } };

        const jsRedirect =
          html.match(/window\.location\.replace\(['"]([^'"]+)['"]\)/) ||
          html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
        if (jsRedirect && jsRedirect[1] !== fetchUrl) {
          const hop = await getPage(jsRedirect[1], { Referer: ref, Origin: ref });
          if (hop) {
            const hopHtml = maybeUnpack(hop.html);
            const match2 = matchAny(hopHtml, PATTERNS);
            if (match2) return { url: captured(match2), headers: { Referer: ref, Origin: ref } };
          }
        }
      } catch {
        /* try the next TLD */
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

interface MailRuMeta {
  videos?: Array<{ key?: string; url?: string }>;
}

/**
 * my.mail.ru — the embed page is a shell, but `/+/video/meta/<id>` returns JSON
 * with signed direct MP4s per resolution. The embed URL must be the Referer or
 * the metadata endpoint 403s.
 */
export async function resolveMailRu(url: string): Promise<ResolvedStream | null> {
  try {
    const id = url.match(/\/video\/embed\/(\d+)/)?.[1];
    if (!id) return null;

    const data = await fetchJson<MailRuMeta>(`https://my.mail.ru/+/video/meta/${id}`, {
      headers: { ...BASE_HEADERS, Referer: url, Accept: 'application/json' },
    });
    const videos = Array.isArray(data?.videos) ? data.videos : [];
    // Keys are labels like "1080p"/"720p"; highest first.
    const sorted = [...videos].sort(
      (a, b) => (parseInt(String(b.key), 10) || 0) - (parseInt(String(a.key), 10) || 0)
    );
    const best = sorted.find((v) => v && v.url);
    if (!best || !best.url) return null;

    const videoUrl = best.url.startsWith('//') ? 'https:' + best.url : best.url;
    return {
      url: videoUrl,
      headers: { Referer: 'https://my.mail.ru/' },
      quality: best.key || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * uqload — packed JS. Mirrors are probed in parallel because the live domain
 * changes often, but an expired file is expired on all of them, so that page is
 * detected by its wording and the embed is marked dead instead of retried.
 */
export async function resolveUqload(url: string): Promise<ResolvedStream | null> {
  const EXPIRED_MARKERS = [
    'file is no longer available',
    'expired or has been deleted',
    'file no longer exists',
  ];
  const isExpiredPage = (html: string): boolean => {
    const low = html.toLowerCase();
    return EXPIRED_MARKERS.some((m) => low.includes(m));
  };

  try {
    const normalizedPath = url.replace(/^https?:\/\/[^/]+/, '');
    const originalDomain = hostOf(url) || 'uqload.co';
    const fallbackDomains = [originalDomain];
    if (originalDomain.endsWith('.bz')) fallbackDomains.push('uqload.co', 'uqload.to');
    if (originalDomain.endsWith('.to')) fallbackDomains.push('uqload.co');
    const uniqueDomains = [...new Set(fallbackDomains)];

    type Attempt = ResolvedStream | 'dead' | null;

    const attempts: Attempt[] = await Promise.all(
      uniqueDomains.map(async (domain): Promise<Attempt> => {
        try {
          const tryUrl = `https://${domain}${normalizedPath}`;
          const ref = `https://${domain}/`;
          const page = await getPage(tryUrl, { Referer: ref });
          if (!page) return null;
          if (isExpiredPage(page.html)) return 'dead';

          const content = maybeUnpack(page.html);
          const match = matchAny(content, [
            /sources\s*:\s*\[[^\]]*?\{[^}]*?file\s*:\s*["']([^"']+\.(?:mp4|m3u8))["']/i,
            /sources\s*:\s*\[["']([^"']+\.(?:mp4|m3u8))["']\]/i,
            /file\s*:\s*["']([^"']+\.(?:mp4|m3u8))["']/i,
          ]);
          if (match) return { url: captured(match), headers: { Referer: ref } };
          return null;
        } catch {
          return null;
        }
      })
    );

    if (attempts.includes('dead')) {
      markDeadEmbed(url);
      return null;
    }
    for (const attempt of attempts) {
      if (attempt && attempt !== 'dead') return attempt;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * voe and its rotating mirror domains — the legacy player packs the HLS URL
 * under an `'hls'` key. The current frontend is a React SPA that resolves the
 * stream through an AES-GCM-fingerprinted REST API with an optional PoW captcha:
 * no URL of any kind is in the HTML, so that build is detected and abandoned
 * immediately rather than regex-scanned.
 */
export async function resolveVoe(url: string): Promise<ResolvedStream | null> {
  try {
    const page = await getPage(url);
    if (!page) return null;
    let html = page.html;

    if (html.includes('<div id="root">') && html.includes('/assets/index-')) return null;

    let fetchUrl = url;
    const redirect = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
    if (redirect) {
      fetchUrl = redirect[1];
      const hop = await getPage(fetchUrl);
      if (hop) html = hop.html;
    }

    html = maybeUnpack(html);

    const match = matchAny(html, [
      /'hls'\s*:\s*'([^']+)'/,
      /"hls"\s*:\s*"([^"]+)"/,
      /file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
      /sources\s*:\s*\[["']([^"']+\.(?:m3u8|mp4)[^"']*)["']\]/i,
      /https?:\/\/[^"']+\.m3u8[^"']*/,
    ]);
    if (match) {
      let videoUrl = captured(match);
      if (videoUrl.includes('base64')) videoUrl = atobOrSelf(videoUrl.split(',')[1] || videoUrl);
      if (isKnownFakeDirectUrl(videoUrl)) return null;
      return { url: videoUrl, headers: { Referer: fetchUrl } };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * fsvid / vidzy — the HLS URL is base64 then XOR-obfuscated inside an IIFE, with
 * the key derived from the page's own hostname (so a copy of the payload fetched
 * through the wrong mirror decodes to garbage). Two key schemes exist: a
 * dynamic one (`0x3d + i*89 + hostnameHash`) and a legacy static array.
 *
 * fsvid.lol also 403s without a Referer, which was the single biggest cause of
 * resolution failures — it is derived from the embed's own domain so every
 * mirror is covered.
 */
export async function resolveFsvidVidzy(url: string): Promise<ResolvedStream | null> {
  try {
    const embedDomain = hostOf(url);
    const embedRef = embedDomain ? `https://${embedDomain}/` : 'https://fsvid.lol/';
    const page = await getPage(url, { Referer: embedRef });
    if (!page) return null;

    const html = maybeUnpack(page.html);

    let videoUrl: string | null = null;

    const hostname = embedDomain
      ? embedDomain.split('/')[0]
      : (embedRef.split('//')[1] || '').replace(/\//g, '');

    // Pattern 1 (2024+): reverse + XOR with a hostname-derived rolling key.
    const newPattern = html.match(/\}\)\(["']([A-Za-z0-9+/=_-]{50,})["']\)/);
    if (newPattern && html.includes('reverse().join')) {
      const b64 = newPattern[1].replace(/-/g, '+').replace(/_/g, '/');
      const bin = decodeBase64(b64);
      if (bin) {
        let hostHash = 0;
        for (let j = 0; j < hostname.length; j++) {
          hostHash = (hostHash + hostname.charCodeAt(j)) & 255;
        }
        const reversed = bin.split('').reverse().join('');
        let decoded = '';
        for (let i = 0; i < reversed.length; i++) {
          const kk = (0x3d + i * 89 + hostHash) & 255;
          decoded += String.fromCharCode(reversed.charCodeAt(i) ^ kk);
        }
        if (decoded.startsWith('http') && decoded.includes('.m3u8') && !decoded.includes('/troll/')) {
          videoUrl = decoded;
        }
      }
    }

    // Pattern 2 (legacy): static key array `var k=[...]`.
    if (!videoUrl) {
      const legacyPattern =
        /(?:var|let|const)\s*k=\[([0-9,\s]+)\],b=atob\(s\)[\s\S]*?return\s+\w+\}\)\(["']([A-Za-z0-9+/=_-]+)["']\)/g;
      let match: RegExpExecArray | null;
      while ((match = legacyPattern.exec(html)) !== null) {
        const key = match[1].split(',').map((n) => parseInt(n, 10));
        const b64 = match[2].replace(/-/g, '+').replace(/_/g, '/');
        const bin = decodeBase64(b64);
        if (!bin) continue;
        let decoded = '';
        for (let i = 0; i < bin.length; i++) {
          decoded += String.fromCharCode(bin.charCodeAt(i) ^ key[i % key.length]);
        }
        if (decoded.startsWith('http') && decoded.includes('.m3u8') && !decoded.includes('/troll/')) {
          videoUrl = decoded;
          break;
        }
      }
    }

    if (!videoUrl) return null;

    // The CDN checks Referer, and it must be the brand's canonical host.
    const referer = url.includes('vidzy') ? 'https://vidzy.live/' : 'https://fsvid.lol/';
    return { url: videoUrl, headers: { Referer: referer } };
  } catch {
    return null;
  }
}

/**
 * streamtape — the URL is assembled at runtime by writing to `#robotlink`'s
 * innerHTML from concatenated string fragments, some sliced with `substring(n)`.
 * The concatenation is replayed rather than evaluated.
 */
export async function resolveStreamtape(url: string): Promise<ResolvedStream | null> {
  try {
    const page = await getPage(url);
    if (!page) return null;
    const html = maybeUnpack(page.html);

    const match = html.match(/robotlink['"]\)\.innerHTML\s*=\s*['"]([^'"]+)['"]\s*\+\s*([^;]+)/);
    if (match) {
      let videoUrl = 'https:' + match[1];
      const parts = match[2].split('+');
      for (const p of parts) {
        const innerMatch = p.match(/['"]([^'"]+)['"]/);
        if (innerMatch) {
          let val = innerMatch[1];
          const sub = p.match(/substring\((\d+)\)/);
          if (sub) val = val.substring(parseInt(sub[1], 10));
          videoUrl += val;
        }
      }
      return { url: videoUrl, headers: { Referer: 'https://streamtape.com/' } };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * sendvid — plain `video_source:` / `<source src=>` in the embed page. 502/503
 * is its "Technical Difficulties" page, which is a transient outage rather than
 * a parse failure, so nothing is extracted from it.
 */
export async function resolveSendvid(url: string): Promise<ResolvedStream | null> {
  try {
    let target = url;
    // daisukianime wraps sendvid ids in its own query string.
    if (target.includes('daisukianime')) {
      const idMatch = target.match(/[?&]id=([a-z0-9]+)/i);
      if (idMatch) target = `https://sendvid.com/embed/${idMatch[1]}`;
    }
    const embedUrl = target.includes('/embed/')
      ? target
      : target.replace(/sendvid\.com\/([a-z0-9]+)/i, 'sendvid.com/embed/$1');

    const page = await getPage(embedUrl, { Referer: 'https://sendvid.com/' });
    if (!page) return null;
    if (page.status === 502 || page.status === 503) return null;

    const match = matchAny(page.html, [
      /video_source\s*:\s*["']([^"']+\.mp4[^"']*)["|']/,
      /source\s+src=["']([^"']+\.mp4[^"']*)["|']/,
      /<source[^>]+src=["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/,
      /file\s*:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["|']/,
      /["'](https?:\/\/[^"']+\.mp4[^"']*)["']/,
    ]);
    if (match) return { url: captured(match), headers: { Referer: 'https://sendvid.com/' } };
  } catch {
    /* fall through */
  }
  return null;
}

/** luluvid family — packed JS, occasionally with the source as a base64 data URL. */
export async function resolveLuluvid(url: string): Promise<ResolvedStream | null> {
  try {
    const page = await getPage(url);
    if (!page) return null;
    const html = maybeUnpack(page.html);

    const match = matchAny(html, [
      /sources\s*:\s*\[["']([^"']+\.(?:m3u8|mp4)[^"']*)["']\]/,
      /file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/,
    ]);
    if (match) {
      let videoUrl = captured(match);
      if (videoUrl.includes('base64')) videoUrl = atobOrSelf(videoUrl.split(',')[1] || videoUrl);
      return { url: videoUrl, headers: { Referer: url } };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** hgcloud / savefiles — bare m3u8 in a script or player config, no obfuscation. */
export async function resolveHGCloud(url: string): Promise<ResolvedStream | null> {
  try {
    const page = await getPage(url);
    if (!page) return null;
    const match = page.html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/);
    if (match) return { url: match[1], headers: { Referer: url } };
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * doodstream family — the page holds a token, not a URL. `/pass_md5/<token>`
 * returns a URL prefix that has to be completed with a random 10-char suffix
 * plus the token and a timestamp, mirroring what the player's JS does.
 */
export async function resolveDood(url: string): Promise<ResolvedStream | null> {
  try {
    const domain = url.match(/https?:\/\/([^/]+)/)?.[1] || 'dood.to';
    const page = await getPage(url);
    if (!page) return null;
    const html = maybeUnpack(page.html);

    const passMatch = html.match(/\$\.get\(['"]\/pass_md5\/([^'"]+)['"]/);
    if (passMatch) {
      const token = passMatch[1];
      const content = await fetchText(`https://${domain}/pass_md5/${token}`, {
        headers: { ...BASE_HEADERS, Referer: url },
      });
      if (content) {
        const randomStr = Math.random().toString(36).substring(2, 12);
        return {
          url: content + randomStr + '?token=' + token + '&expiry=' + Date.now(),
          headers: { Referer: `https://${domain}/` },
        };
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * myvi.ru / mytv — sometimes packed, sometimes a plain player config; falls back
 * to the site's own `/api/video/<id>` endpoint when the page yields nothing.
 */
export async function resolveMyTV(url: string): Promise<ResolvedStream | null> {
  try {
    const page = await getPage(url, { Referer: 'https://www.myvi.ru/' });
    if (!page) return null;
    const html = maybeUnpack(page.html);

    const match = matchAny(html, [
      /["'](?:file|src|url|stream_url)["']\s*:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/,
      /["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/,
      /source\s+src=["']([^"']+\.(?:mp4|m3u8)[^"']*)/,
    ]);
    if (match) return { url: captured(match), headers: { Referer: 'https://www.myvi.ru/' } };

    const idMatch = url.match(/\/(?:embed\/|watch\/|video\/)([a-zA-Z0-9_-]+)/);
    if (idMatch) {
      const data = await fetchText(`https://www.myvi.ru/api/video/${idMatch[1]}`, {
        headers: { ...BASE_HEADERS, Referer: url },
      });
      if (data) {
        const apiMatch = data.match(
          /["'](?:url|src|file)["']\s*:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/
        );
        if (apiMatch) return { url: apiMatch[1], headers: { Referer: 'https://www.myvi.ru/' } };
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** younetu / netu — packed JS; the CDN requires the embed's own origin as Referer. */
export async function resolveYounetu(url: string): Promise<ResolvedStream | null> {
  try {
    const origin = originOf(url) || 'https://younetu.org';
    const page = await getPage(url, { Referer: origin + '/' });
    if (!page) return null;
    const html = maybeUnpack(page.html);

    const match = matchAny(html, [
      /src\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
      /file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
      /sources\s*:\s*\[["']([^"']+\.(?:m3u8|mp4)[^"']*)["']\]/i,
      /["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    ]);
    if (match) return { url: captured(match), headers: { Referer: origin + '/' } };
  } catch {
    /* fall through */
  }
  return null;
}

/** vidoza — unobfuscated player config. */
export async function resolveVidoza(url: string): Promise<ResolvedStream | null> {
  try {
    const page = await getPage(url, { Referer: 'https://vidoza.net/' });
    if (!page) return null;

    const match = matchAny(page.html, [
      /src\s*:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i,
      /file\s*:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i,
      /["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/i,
    ]);
    if (match) return { url: captured(match), headers: { Referer: 'https://vidoza.net/' } };
  } catch {
    /* fall through */
  }
  return null;
}

/** filemoon / moonplayer — packed JS with the source under `file:`. */
export async function resolveMoon(url: string): Promise<ResolvedStream | null> {
  try {
    const page = await getPage(url);
    if (!page) return null;
    const html = maybeUnpack(page.html);
    const match = html.match(/file\s*:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/);
    if (match) return { url: match[1], headers: { Referer: url } };
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Generic packed-JS player (vidstream, vidcdn, kakaflix, luluvdo, veev,
 * wishonly, vidhsareup…). These are all the same Jetpack/JWPlayer template with
 * different branding, so one resolver covers the family.
 */
export async function resolvePackedPlayer(url: string): Promise<ResolvedStream | null> {
  try {
    const origin = originOf(url) || url;
    const page = await getPage(url, { Referer: origin + '/' });
    if (!page) return null;
    const html = maybeUnpack(page.html);

    const match = matchAny(html, [
      /file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
      /sources\s*:\s*\[[^\]]*?["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
      /["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    ]);
    if (match) return { url: captured(match), headers: { Referer: origin + '/' } };
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * lecteurvideo.com — a link aggregator, not a player: `/embed.php?id&tp&url`
 * returns a page of links to real hosts. The `url` query parameter names the
 * referring site and has to be sent back as the Referer, and some referrers only
 * work under a different working domain (wookafr.tel → wookafr.center).
 *
 * Candidates are ranked: a direct media URL beats a download host (megaup,
 * 1fichier, usually directly playable) which beats an SPA host that will need
 * another resolver pass.
 */
export async function resolveLecteurVideo(url: string): Promise<ResolvedStream | null> {
  try {
    const origin = originOf(url) || 'https://lecteurvideo.com';
    const refParam = url.match(/[?&]url=([^&]+)/)?.[1] || '';
    const referrerMap: Record<string, string> = {
      'wookafr.tel': 'https://wookafr.center',
      'wookafr.to': 'https://wookafr.center',
      'wookafr.app': 'https://wookafr.center',
      'wookafr.fyi': 'https://wookafr.center',
    };
    const referer = referrerMap[refParam] || (refParam ? `https://${refParam}` : origin + '/');

    const page = await getPage(
      url,
      { Referer: referer, Origin: referer.replace(/\/$/, '') },
      12000
    );
    if (!page) return null;
    const html = maybeUnpack(page.html);

    // 1. Direct video URL in a player config (older format).
    const directMatch = matchAny(html, [
      /file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
      /sources\s*:\s*\[["']([^"']+\.(?:m3u8|mp4)[^"']*)["']\]/i,
      /src\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
      /data-src=["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    ]);
    if (directMatch) {
      let videoUrl = captured(directMatch);
      if (videoUrl.startsWith('//')) videoUrl = 'https:' + videoUrl;
      if (!isKnownFakeDirectUrl(videoUrl)) {
        return { url: videoUrl, headers: { Referer: origin + '/' } };
      }
    }

    // 2. Newer format: harvest every external link and rank it.
    const allUrls = [...html.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)]
      .map((m) => m[1])
      .concat([...html.matchAll(/["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1]))
      .filter(
        (u) =>
          !u.includes('lecteurvideo.com') &&
          !u.includes('youtube.com') &&
          !u.includes('googlevideo.com') &&
          !u.includes('fonts.googleapis.com') &&
          !u.includes('jsdelivr.net') &&
          !u.includes('cloudflareinsights.com') &&
          !u.includes('themoviedb.org') &&
          !u.includes('imagizer.imageshack.com') &&
          !u.includes('cloudflare') &&
          !u.includes('plyr.')
      );

    const DIRECT_VIDEO_RE = /^https?:\/\/[^"']+\.(?:m3u8|mp4|mkv|webm)(?:\?[^"']*)?$/i;
    const directVideo = allUrls.find((u) => DIRECT_VIDEO_RE.test(u) && !isKnownFakeDirectUrl(u));
    if (directVideo) return { url: directVideo, headers: { Referer: origin + '/' } };

    const directHosts = ['megaup.net', '1fichier.com'];
    for (const host of directHosts) {
      const found = allUrls.find((u) => u.includes(host));
      if (found) return { url: found, headers: { Referer: origin + '/' } };
    }

    const spaHosts = [
      'sibnet.ru',
      'sendvid.com',
      'dood.to',
      'listeamed.net',
      'voe.sx',
      'veev.to',
      'filemoon.sx',
    ];
    for (const host of spaHosts) {
      const found = allUrls.find((u) => u.includes(host));
      if (found) return { url: found, headers: { Referer: origin + '/' } };
    }

    // 3. An iframe to another host.
    const iframeMatch = html.match(/<iframe[^>]+src=["'](https?:\/\/[^"']+)["']/i);
    if (iframeMatch) {
      const iframeSrc = iframeMatch[1];
      if (!iframeSrc.includes('lecteurvideo.com') && !iframeSrc.includes('youtube.com')) {
        return { url: iframeSrc, headers: { Referer: origin + '/' } };
      }
    }

    // 4. Last resort: any known download/host link.
    const downloadLink = allUrls.find(
      (u) =>
        u.includes('1fichier.com') ||
        u.includes('megaup.net') ||
        u.includes('filemoon') ||
        u.includes('voe.sx') ||
        u.includes('veev.to') ||
        u.includes('listeamed.net')
    );
    if (downloadLink) return { url: downloadLink, headers: { Referer: origin + '/' } };
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * down-paradise.com — parked domain fronting a multi-hop anti-bot chain
 * (parklogic → ww1.down-paradise → tratobid). Unresolvable without a browser,
 * and every hop costs seconds, so it fails immediately by design.
 */
export async function resolveDownParadise(_url: string): Promise<ResolvedStream | null> {
  return null;
}

/**
 * up4fun.top — routinely takes 60s+ to answer. One lightweight attempt only;
 * `resolveStream` also skips its generic fallback for this host.
 */
export async function resolveUp4fun(url: string): Promise<ResolvedStream | null> {
  try {
    const page = await getPage(url, { Referer: 'https://up4fun.top/' });
    if (!page) return null;

    const match = matchAny(page.html, [
      /["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
      /file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    ]);
    if (match) return { url: captured(match), headers: { Referer: 'https://up4fun.top/' } };
  } catch {
    /* fall through */
  }
  return null;
}

// ─── Deformed domain correction ──────────────────────────────────────────────
// Some sites (VoirAnime, French-Manga…) deliberately misspell host domains in
// the iframes their player PHP emits, to slip past adblock filter lists:
//
//   streamtape.com → stredamtape.com, streamtapde.com, streamtape.cdom
//   get_video      → get_viddeo
//
// Detection is by character-sequence similarity against known hosts: if the
// characters of the real name appear in order within the deformed one at >=75%
// and the lengths are close, it is treated as a deformation.

const KNOWN_HOST_NAMES: Array<{ name: string; domain: string }> = [
  { name: 'streamtape', domain: 'streamtape.com' },
  { name: 'sibnet', domain: 'sibnet.ru' },
  { name: 'vidmoly', domain: 'vidmoly.to' },
  { name: 'uqload', domain: 'uqload.co' },
  { name: 'voe', domain: 'voe.sx' },
  { name: 'dood', domain: 'dood.to' },
  { name: 'younetu', domain: 'younetu.org' },
  { name: 'netu', domain: 'netu.tv' },
  { name: 'vidoza', domain: 'vidoza.net' },
  { name: 'sendvid', domain: 'sendvid.com' },
  { name: 'myvi', domain: 'myvi.ru' },
  { name: 'moon', domain: 'filemoon.sx' },
  { name: 'luluvid', domain: 'luluvid.com' },
  { name: 'fsvid', domain: 'fsvid.lol' },
  { name: 'vidzy', domain: 'vidzy.live' },
  { name: 'lecteurvideo', domain: 'lecteurvideo.com' },
  { name: 'vidhsareup', domain: 'vidhsareup.fun' },
  { name: 'hgcloud', domain: 'hgcloud.xyz' },
  { name: 'up4fun', domain: 'up4fun.top' },
  { name: 'lulu', domain: 'luluvdo.com' },
];

/**
 * Legitimate domains the fuzzy matcher must never touch.
 *
 * Without this list `"voembed".includes('voe')` with a length delta of 4 rewrites
 * voembed.net to voe.sx, which breaks VidMoly resolution outright.
 */
const NEVER_CORRECT_DOMAINS = [
  'voembed.net', // VidMoly family (plain m3u8) — not voe
  'gn1r5n.org', // VoirAnime's "myTV" embed
  'streamhide.to', // ParkLogic gate — not streamtape
];

const PATH_CORRECTIONS: Array<[RegExp, string]> = [
  [/get_viddeo/gi, 'get_video'],
  [/get_videeo/gi, 'get_video'],
  [/getv_video/gi, 'get_video'],
  [/gdet_video/gi, 'get_video'],
  [/gett_video/gi, 'get_video'],
  [/get_vvdo/gi, 'get_video'],
  [/get_vide0/gi, 'get_video'],
];

/** Undo deliberate domain/path misspellings. Returns the URL unchanged if none. */
export function correctDeformedVideoUrl(url: string): string {
  if (!url || typeof url !== 'string') return url;

  const urlMatch = url.match(/^https?:\/\/([^/]+)(.*)/);
  if (!urlMatch) return url;

  const fullDeformedDomain = urlMatch[1].toLowerCase();
  if (
    NEVER_CORRECT_DOMAINS.some(
      (d) => fullDeformedDomain === d || fullDeformedDomain.endsWith('.' + d)
    )
  ) {
    return url;
  }

  // The host name proper is the second-to-last label ("stredamtape" in
  // "cdn.stredamtape.com").
  const domainParts = fullDeformedDomain.split('.');
  const deformedBase =
    domainParts.length >= 2 ? domainParts[domainParts.length - 2] : domainParts[0];

  // Already a valid subdomain of a known host: keep the subdomain intact.
  const isKnownSubdomain = KNOWN_HOST_NAMES.some((h) =>
    fullDeformedDomain.endsWith('.' + h.domain)
  );

  // More than two labels means a plausible CDN subdomain (u14.vidzy.cc), which
  // must not be flattened to the canonical domain.
  const isSubdomain = domainParts.length > 2;

  let correctedUrl = url;
  let domainCorrected = isKnownSubdomain;

  // 1. The real name appears as a substring ("streamtape.cdom").
  if (!domainCorrected) {
    for (const host of KNOWN_HOST_NAMES) {
      if (deformedBase.includes(host.name)) {
        const lenDiff = Math.abs(deformedBase.length - host.name.length);
        if (lenDiff <= 4) {
          if (isSubdomain) {
            // An exact name under a subdomain is a real CDN host, not a typo.
            if (deformedBase === host.name) continue;
            // A short alphanumeric prefix ("u14", "cdn") also means CDN, not typo.
            const prefix = domainParts[domainParts.length - 3];
            if (/^[a-z0-9]{1,6}$/i.test(prefix)) continue;
          }
          correctedUrl = correctedUrl.replace(fullDeformedDomain, host.domain);
          domainCorrected = true;
          break;
        }
      }
    }
  }

  // 2. Fuzzy in-order character match, which catches insertions and swaps
  //    (stredamtape → streamtape). Skipped for subdomains to avoid mangling
  //    valid CDN hosts.
  if (!domainCorrected && !isSubdomain) {
    for (const host of KNOWN_HOST_NAMES) {
      const knownBase = host.name;
      if (knownBase.length < 5) continue;

      let matches = 0;
      let j = 0;
      for (let i = 0; i < knownBase.length; i++) {
        const target = knownBase[i];
        while (j < deformedBase.length && deformedBase[j] !== target) j++;
        if (j < deformedBase.length) {
          matches++;
          j++;
        } else {
          break;
        }
      }

      const ratio = matches / knownBase.length;
      if (ratio >= 0.75) {
        const lenDiff = Math.abs(deformedBase.length - knownBase.length);
        if (lenDiff <= 4) {
          correctedUrl = correctedUrl.replace(fullDeformedDomain, host.domain);
          domainCorrected = true;
          break;
        }
      }
    }
  }

  // 3. Path patterns are always corrected: the domain can be right while the
  //    path is still deformed.
  for (const [pattern, replacement] of PATH_CORRECTIONS) {
    correctedUrl = correctedUrl.replace(pattern, replacement);
  }

  return correctedUrl;
}

// ─── Iframe selection ────────────────────────────────────────────────────────

/** Iframe hosts that are ads/analytics rather than players. */
const AD_IFRAME_PATTERNS = [
  'googleads',
  'doubleclick',
  'googlesyndication',
  'googletagmanager',
  'facebook.com/plugins',
  'twitter.com/share',
  'disqus.com',
  'hotjar.com',
  'analytics',
  'tracking',
  'pixel',
  'gtag',
  'adservice',
  'adserver',
  'ad.doubleclick',
  'amazon-adsystem',
  'criteo',
  'taboola',
  'outbrain',
];

/** Likelihood that an iframe URL is the actual player. Higher wins. */
const VIDEO_IFRAME_SCORE: Record<string, number> = {
  sibnet: 3,
  vidmoly: 3,
  uqload: 3,
  voe: 3,
  dood: 3,
  streamtape: 3,
  sendvid: 2,
  younetu: 2,
  netu: 2,
  moonplayer: 2,
  filemoon: 2,
  vidoza: 2,
  myvi: 2,
  luluvid: 2,
  lulu: 2,
  embed: 2,
  player: 2,
  video: 2,
  cdn: 1,
  hls: 3,
  mp4: 3,
  m3u8: 3,
};

/**
 * Pick the iframe most likely to be the video player.
 *
 * Scoring rather than "first iframe wins" matters because player pages typically
 * embed several ad iframes before the real one.
 */
export function findBestVideoIframe(html: string, pageUrl: string): string | null {
  const iframeRegex = /<iframe\s+[^>]*src=["']([^"']+)["']/gi;
  const candidates: Array<{ url: string; score: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = iframeRegex.exec(html)) !== null) {
    let iframeUrl = match[1];

    if (iframeUrl.startsWith('//')) iframeUrl = 'https:' + iframeUrl;
    if (iframeUrl.startsWith('/')) {
      const origin = originOf(pageUrl);
      if (origin) iframeUrl = origin + iframeUrl;
    }

    if (!iframeUrl.startsWith('http')) continue;
    if (iframeUrl === pageUrl) continue;

    const lower = iframeUrl.toLowerCase();
    if (AD_IFRAME_PATTERNS.some((p) => lower.includes(p))) continue;

    let score = 0;
    for (const [keyword, pts] of Object.entries(VIDEO_IFRAME_SCORE)) {
      if (lower.includes(keyword)) score += pts;
    }

    candidates.push({ url: iframeUrl, score });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].url;
}

// Exported for the dispatcher in ./index.ts.
export { getPage as fetchEmbedPage };
export type { FetchedPage };
