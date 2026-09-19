/**
 * Movies4U — Hindi/multi-audio content on movies4u.finance
 *
 * Search by title → find m4uplay.store embed links → extract HLS master playlist
 * → resolve quality variants and audio tracks. Supports movies only currently
 * (TV episode matching not reliable on this site).
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  siteFetchText,
  siteFetchHtml,
  scoreTitleMatch,
  isAborted,
  isBudgetExhausted,
  absoluteUrl,
  HI_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
  NUVIO_UA,
} from '../shared.js';

const SITE = 'https://movies4u.finance';
const M4UPLAY_BASE = 'https://m4uplay.store';
const LABEL = 'Movies4U';

const SITE_HEADERS = {
  'User-Agent': NUVIO_UA,
  Referer: `${SITE}/`,
};

const M4U_HEADERS = {
  'User-Agent': NUVIO_UA,
  Referer: `${M4UPLAY_BASE}/`,
  Origin: M4UPLAY_BASE,
};

// ── Types ────────────────────────────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
}

interface WatchLink {
  url: string;
  quality: string;
  label: string;
}

interface HlsVariant {
  url: string;
  quality: string;
}

interface HlsResult {
  masterUrl: string;
  variants: HlsVariant[];
  audios: Array<{ name: string; language: string }>;
  isMaster: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseQuality(text: string): string {
  if (/2160p|4k|uhd/i.test(text)) return '2160p';
  if (/1440p|2k/i.test(text)) return '1440p';
  if (/1080p/i.test(text)) return '1080p';
  if (/720p/i.test(text)) return '720p';
  if (/480p/i.test(text)) return '480p';
  return 'HD';
}

function inferLanguage(text: string): string {
  const t = String(text || '').toLowerCase();
  const langs: string[] = [];
  if (t.includes('hindi')) langs.push('Hindi');
  if (t.includes('tamil')) langs.push('Tamil');
  if (t.includes('telugu')) langs.push('Telugu');
  if (t.includes('english') || /\beng\b/.test(t)) langs.push('English');
  if (langs.length > 2) return 'MULTI';
  if (langs.length === 2) return 'DUAL';
  if (langs.length === 1) return langs[0].toUpperCase();
  if (t.includes('dual')) return 'DUAL';
  if (t.includes('multi')) return 'MULTI';
  return 'HINDI';
}

function unpackEval(p: string, a: number, c: number, k: string[]): string {
  let result = p;
  while (c-- > 0) {
    if (k[c]) {
      const placeholder = c.toString(a);
      result = result.replace(new RegExp(`\\b${placeholder}\\b`, 'g'), k[c]);
    }
  }
  return result;
}

// ── Search ───────────────────────────────────────────────────────────────────

async function searchMovies(query: string, ctx: NuvioContext): Promise<SearchResult[]> {
  const searchUrl = `${SITE}/?s=${encodeURIComponent(query)}`;
  const html = await siteFetchHtml(searchUrl, {
    headers: SITE_HEADERS,
    acceptLanguage: HI_ACCEPT_LANGUAGE,
    signal: ctx.signal,
    timeoutMs: 12_000,
  });
  if (!html) return [];

  const results: SearchResult[] = [];
  html('h3.entry-title a').each((_, el) => {
    const title = html(el).text().trim();
    const url = html(el).attr('href') || '';
    if (title && url) results.push({ title, url });
  });
  return results;
}

// ── Watch link extraction ─────────────────────────────────────────────────────

async function extractWatchLinks(movieUrl: string, ctx: NuvioContext): Promise<WatchLink[]> {
  const html = await siteFetchHtml(movieUrl, {
    headers: SITE_HEADERS,
    signal: ctx.signal,
    timeoutMs: 12_000,
  });
  if (!html) return [];

  const links: WatchLink[] = [];
  html('a.btn.btn-zip').each((_, el) => {
    const href = html(el).attr('href') || '';
    const text = html(el).text().trim();
    if (!href.includes('m4uplay')) return;
    links.push({
      url: href,
      quality: parseQuality(text),
      label: text,
    });
  });
  return links;
}

// ── HLS resolution ───────────────────────────────────────────────────────────

async function resolveHlsPlaylist(masterUrl: string, ctx: NuvioContext): Promise<HlsResult> {
  const result: HlsResult = { masterUrl, variants: [], audios: [], isMaster: false };

  const content = await siteFetchText(masterUrl, {
    headers: M4U_HEADERS,
    signal: ctx.signal,
    timeoutMs: 8_000,
  });
  if (!content?.includes('#EXTM3U')) return result;

  if (!content.includes('#EXT-X-STREAM-INF')) return result;
  result.isMaster = true;

  // Parse audio tracks
  const audioRegex = /#EXT-X-MEDIA:TYPE=AUDIO.*?NAME="([^"]+)"(?:.*?LANGUAGE="([^"]+)")?/g;
  let m: RegExpExecArray | null;
  while ((m = audioRegex.exec(content)) !== null) {
    const name = m[1];
    const language = m[2] || 'unknown';
    if (!result.audios.some((a) => a.name === name)) {
      result.audios.push({ name, language });
    }
  }

  // Parse stream variants
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.includes('#EXT-X-STREAM-INF')) continue;

    let quality = 'HD';
    const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/i);
    if (resMatch) {
      const h = parseInt(resMatch[2], 10);
      quality = h >= 2160 ? '2160p' : h >= 1080 ? '1080p' : h >= 720 ? '720p' : h >= 480 ? '480p' : `${h}p`;
    }

    let j = i + 1;
    while (j < lines.length && (lines[j].trim().startsWith('#') || !lines[j].trim())) j++;
    if (j < lines.length) {
      let variantUrl = lines[j].trim();
      if (variantUrl && !variantUrl.startsWith('http')) {
        const base = masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1);
        variantUrl = base + variantUrl;
      }
      if (variantUrl && !result.variants.some((v) => v.url === variantUrl)) {
        result.variants.push({ url: variantUrl, quality });
      }
    }
    i = j;
  }

  return result;
}

// ── M4UPlay extraction ───────────────────────────────────────────────────────

async function extractFromM4UPlay(embedUrl: string, ctx: NuvioContext): Promise<NuvioStream[]> {
  const html = await siteFetchText(embedUrl, {
    headers: { ...SITE_HEADERS, Referer: SITE },
    signal: ctx.signal,
    timeoutMs: 12_000,
  });
  if (!html) return [];

  // Try to unpack eval-packed content
  let content = html;
  const packerMatch = html.match(/eval\(function\(p,a,c,k,e,d\)\{.*?\}\s*\((.*)\)\s*\)/s);
  if (packerMatch) {
    try {
      const rawArgs = packerMatch[1].trim();
      const argsMatch = rawArgs.match(/^['"](.*)['"],\s*(\d+),\s*(\d+),\s*['"](.*)['"]\.split\(['"]\|['"]\)/s);
      if (argsMatch) {
        content += '\n' + unpackEval(
          argsMatch[1],
          parseInt(argsMatch[2], 10),
          parseInt(argsMatch[3], 10),
          argsMatch[4].split('|')
        );
      }
    } catch {
      // ignore unpack failure
    }
  }

  // Find HLS URL
  const hlsPatterns = [
    /https?:\/\/[^\s"']+\.m3u8(?:\?[^\s"']*)?/,
    /["']file["']\s*:\s*["']([^"']+\.m3u8[^"']*)["']/,
    /https?:\/\/[^\s"']*master\.m3u8[^\s"']*/,
    /(\/(?:stream|3o)\/[^"'\s]+\.m3u8)/,
  ];

  let finalStreamUrl: string | null = null;
  for (const pattern of hlsPatterns) {
    const match = content.match(pattern);
    if (match) {
      let url = match[1] || match[0];
      if (url.startsWith('/')) url = M4UPLAY_BASE + url;
      finalStreamUrl = url;
      break;
    }
  }

  if (!finalStreamUrl) return [];

  if (finalStreamUrl.includes('master.m3u8')) {
    const resolution = await resolveHlsPlaylist(finalStreamUrl, ctx);
    if (resolution.isMaster) {
      const audioNames = resolution.audios.map((a) => a.name);
      const language = audioNames.length > 2 ? 'MULTI' : audioNames.length === 2 ? 'DUAL' : inferLanguage(audioNames[0] || '');
      const bestQ = resolution.variants.find((v) => v.quality === '1080p')?.quality ||
        resolution.variants[0]?.quality || 'HD';

      return [
        {
          url: resolution.masterUrl,
          name: `${LABEL} | ${bestQ}`,
          title: `[${language}] ${LABEL} · ${bestQ}`,
          quality: bestQ,
          language,
          headers: M4U_HEADERS,
        },
      ];
    }
  }

  const language = inferLanguage(finalStreamUrl);
  return [
    {
      url: finalStreamUrl,
      name: LABEL,
      title: `[HINDI] ${LABEL}`,
      quality: parseQuality(finalStreamUrl),
      language: 'HINDI',
      headers: M4U_HEADERS,
    },
  ];
}

// ── Main extractor ───────────────────────────────────────────────────────────

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];
  const startTime = Date.now();

  for (const title of ctx.titles) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime, PROVIDER_BUDGET_MS)) break;

    const results = await searchMovies(title, ctx);
    if (results.length === 0) continue;

    // Pick best match
    let bestMatch: SearchResult | null = null;
    let bestScore = -1;
    for (const r of results) {
      const score = scoreTitleMatch(r.title, title);
      if (score > bestScore && score > 30) {
        bestScore = score;
        bestMatch = r;
      }
    }
    if (!bestMatch) bestMatch = results[0];

    if (isAborted(ctx.signal) || isBudgetExhausted(startTime, PROVIDER_BUDGET_MS)) break;

    const watchLinks = await extractWatchLinks(bestMatch.url, ctx);
    if (watchLinks.length === 0) continue;

    const streams: NuvioStream[] = [];
    for (const watchLink of watchLinks) {
      if (isAborted(ctx.signal) || isBudgetExhausted(startTime, PROVIDER_BUDGET_MS)) break;
      const extracted = await extractFromM4UPlay(watchLink.url, ctx);
      streams.push(...extracted);
    }

    if (streams.length > 0) return streams;
  }

  return [];
}

export const movies4u = createNuvioProvider({
  name: 'movies4u',
  sites: [SITE],
  language: 'hi',
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'hi',
});
