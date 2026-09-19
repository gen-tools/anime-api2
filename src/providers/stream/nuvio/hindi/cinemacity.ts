/**
 * CinemaCity (Hindi variant) — cinemacity.pro
 *
 * DLE-engine site. Searches via the DLE search form, extracts atob-encoded
 * player file data from the media page, then resolves streams. Hindi-specific:
 * uses HINDI/DUAL/MULTI language tags and does not emit VOSTFR/VF.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  siteFetchText,
  siteFetchHtml,
  decodeBase64,
  scoreTitleMatch,
  isAborted,
  isBudgetExhausted,
  HI_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
  NUVIO_UA,
} from '../shared.js';

const SITE = 'https://cinemacity.pro';
const LABEL = 'CinemaCity';

const BASE_HEADERS = {
  'User-Agent': NUVIO_UA,
  'Accept-Language': 'en-US,en;q=0.5',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function atobPolyfill(str: string): string {
  try {
    return decodeBase64(str);
  } catch {
    return '';
  }
}

function extractQualityFromUrl(url: string): string {
  const low = String(url || '').toLowerCase();
  if (low.includes('2160p') || low.includes('4k')) return '2160p';
  if (low.includes('1080p')) return '1080p';
  if (low.includes('720p')) return '720p';
  if (low.includes('480p')) return '480p';
  if (low.includes('360p')) return '360p';
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

// ── Search ───────────────────────────────────────────────────────────────────

async function searchSite(
  query: string,
  ctx: NuvioContext
): Promise<Array<{ title: string; href: string }>> {
  const searchUrl = `${SITE}/?do=search&subaction=search&search_start=0&full_search=0&story=${encodeURIComponent(query)}`;
  const html = await siteFetchHtml(searchUrl, {
    headers: BASE_HEADERS,
    acceptLanguage: HI_ACCEPT_LANGUAGE,
    signal: ctx.signal,
    timeoutMs: 12_000,
  });
  if (!html) return [];

  const results: Array<{ title: string; href: string }> = [];
  html('div.dar-short_item').each((_, el) => {
    const anchor = html(el)
      .find('a')
      .filter((__, a) => (html(a).attr('href') || '').includes('.html'))
      .first();
    if (!anchor.length) return;
    const title = anchor.text().split('(')[0].trim();
    const href = anchor.attr('href') || '';
    if (title && href) results.push({ title, href });
  });
  return results;
}

// ── Stream extraction ────────────────────────────────────────────────────────

interface PlaylistEntry {
  title?: string;
  file?: string;
  folder?: PlaylistEntry[];
}

function addStreamFromString(
  urlStr: string,
  titlePart: string,
  streams: NuvioStream[]
): void {
  const language = inferLanguage(titlePart);

  const push = (url: string, quality: string) => {
    if (!url || !url.startsWith('http') || url.length < 15) return;
    streams.push({
      url,
      name: `${LABEL} | ${quality}`,
      title: `[${language}] ${LABEL} · ${quality}`,
      quality,
      language,
      headers: {
        Referer: `${SITE}/`,
        'User-Agent': NUVIO_UA,
      },
    });
  };

  if (urlStr.includes('.urlset/master.m3u8')) {
    push(urlStr, 'Auto');
    return;
  }

  if (urlStr.includes('[')) {
    const parts = urlStr.split(',');
    for (const part of parts) {
      const m = part.match(/\[(.*?)\](.*)/);
      if (m) push(m[2].trim(), m[1].trim());
      else push(part.trim(), extractQualityFromUrl(part));
    }
  } else {
    push(urlStr, extractQualityFromUrl(urlStr));
  }
}

async function extractFromPage(
  mediaUrl: string,
  mediaType: 'movie' | 'tv',
  season: number | undefined,
  episode: number | undefined,
  ctx: NuvioContext
): Promise<NuvioStream[]> {
  const html = await siteFetchText(mediaUrl, {
    headers: BASE_HEADERS,
    signal: ctx.signal,
    timeoutMs: 12_000,
  });
  if (!html) return [];

  // Attempt to find atob-encoded player data in scripts
  let fileData: string | PlaylistEntry[] | null = null;

  const scriptRegex = /atob\s*\(\s*(['"])(.*?)\1\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(html)) !== null) {
    const decoded = atobPolyfill(match[2]);
    if (!decoded) continue;
    const fileMatch =
      decoded.match(/file\s*:\s*(['"])(.*?)\1/s) ||
      decoded.match(/file\s*:\s*(\[.*?\])/s);
    if (!fileMatch) continue;
    const rawFile = fileMatch[2] || fileMatch[1];
    if (!rawFile || rawFile.length < 5) continue;

    if (rawFile.startsWith('[') || rawFile.startsWith('{')) {
      try {
        fileData = JSON.parse(rawFile.replace(/\\(.)/g, '$1')) as PlaylistEntry[];
      } catch {
        try {
          fileData = JSON.parse(rawFile) as PlaylistEntry[];
        } catch {
          fileData = rawFile;
        }
      }
    } else {
      fileData = rawFile;
    }
    if (fileData) break;
  }

  if (!fileData) return [];

  const streams: NuvioStream[] = [];

  if (mediaType === 'movie') {
    if (Array.isArray(fileData)) {
      const obj = (fileData as PlaylistEntry[]).find((f) => !f.folder && f.file) || (fileData as PlaylistEntry[])[0];
      if (obj?.file) addStreamFromString(obj.file, obj.title || '', streams);
    } else if (typeof fileData === 'string') {
      addStreamFromString(fileData, '', streams);
    }
  } else if (mediaType === 'tv' && season != null && episode != null) {
    if (Array.isArray(fileData)) {
      const sLabel = `Season ${season}`;
      const sObj = (fileData as PlaylistEntry[]).find(
        (s) =>
          (s.title || '').includes(sLabel) ||
          (s.title || '').includes(`S${season}`)
      );
      if (sObj?.folder) {
        const eLabel = `Episode ${episode}`;
        const eObj = sObj.folder.find(
          (e) =>
            (e.title || '').includes(eLabel) ||
            (e.title || '').includes(`E${episode}`)
        );
        if (eObj?.file) {
          addStreamFromString(eObj.file, eObj.title || '', streams);
        }
      }
    }
  }

  return streams;
}

// ── Main extractor ───────────────────────────────────────────────────────────

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];
  const startTime = Date.now();

  for (const title of ctx.titles) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime, PROVIDER_BUDGET_MS)) break;

    const results = await searchSite(title, ctx);
    if (results.length === 0) continue;

    let mediaUrl: string | null = null;
    let bestScore = -1;
    for (const r of results) {
      const score = scoreTitleMatch(r.title, title);
      if (
        score > bestScore &&
        (r.title.toLowerCase().includes(title.toLowerCase()) ||
          title.toLowerCase().includes(r.title.split('(')[0].trim().toLowerCase()))
      ) {
        bestScore = score;
        mediaUrl = r.href;
      }
    }
    if (!mediaUrl) {
      // simple first-hit fallback
      mediaUrl = results[0].href;
    }

    if (isAborted(ctx.signal) || isBudgetExhausted(startTime, PROVIDER_BUDGET_MS)) break;

    const streams = await extractFromPage(mediaUrl, ctx.type, ctx.season, ctx.episode, ctx);
    if (streams.length > 0) return streams;
  }

  return [];
}

export const cinemacityhindi = createNuvioProvider({
  name: 'cinemacityhindi',
  sites: [SITE],
  language: 'hi',
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'hi',
});
