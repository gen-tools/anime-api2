/**
 * CTGMovies — Multi-language streaming site at ctgmovies.com.
 *
 * Ported from temp/multi-clone/src/providers/durnel.rs.
 * The site has a headless cockpit CMS API at a static IP. Search returns posts
 * with direct MP4 / M3U8 links embedded in their content HTML.
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchJson,
  siteFetchText,
  loadHtml,
  toStream,
  isAborted,
  isBudgetExhausted,
  HI_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
} from '../shared.js';

const SITE = 'https://ctgmovies.com';
const API  = 'https://cockpit.103.109.92.178.nip.io/api/v1';
const LABEL = 'CTGMovies';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': HI_ACCEPT_LANGUAGE,
  'Referer': `${SITE}/`,
  'Origin': SITE,
};

function parseQuality(text: string): string {
  const t = (text ?? '').toUpperCase();
  if (/2160P|4K|UHD/.test(t)) return '2160p';
  if (/1440|2K/.test(t)) return '1440p';
  if (/1080/.test(t)) return '1080p';
  if (/720/.test(t)) return '720p';
  if (/480/.test(t)) return '480p';
  return 'HD';
}

function inferLang(text: string): string {
  const t = text.toLowerCase();
  const langs: string[] = [];
  if (t.includes('hindi'))   langs.push('HINDI');
  if (t.includes('english')) langs.push('ENGLISH');
  if (t.includes('bengali')) langs.push('BENGALI');
  if (t.includes('tamil'))   langs.push('TAMIL');
  if (langs.length > 1) return 'MULTI';
  return langs[0] ?? 'MULTI';
}

interface CtgPost { _id?: string; title?: string; slug?: string }

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];
  const startTime = Date.now();

  const query = encodeURIComponent(ctx.titles[0]);
  const searchData = await siteFetchJson<{ data?: CtgPost[] }>(
    `${API}/posts?filter[title][$regex]=${query}&limit=5`,
    { headers: HEADERS, timeoutMs: 8_000, signal: ctx.signal }
  );
  const posts = searchData?.data ?? [];
  if (posts.length === 0) return [];

  const best = posts[0];
  const postSlug = best.slug ?? best._id;
  if (!postSlug) return [];

  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  const postData = await siteFetchJson<{ content?: string; html?: string }>(
    `${API}/posts/${postSlug}`,
    { headers: HEADERS, timeoutMs: 8_000, signal: ctx.signal }
  );
  const html = postData?.content ?? postData?.html ?? '';
  if (!html) return [];

  const $ = loadHtml(html);
  const streams: NuvioStream[] = [];
  const seen = new Set<string>();

  // Extract direct video links
  const urlRe = /https?:\/\/[^\s"'<>]+\.(?:mp4|m3u8|mkv)[^\s"'<>]*/gi;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(html)) !== null) {
    const url = m[0];
    if (seen.has(url)) continue;
    seen.add(url);
    const q = parseQuality(url);
    const lang = inferLang(html.slice(Math.max(0, m.index - 200), m.index));
    streams.push(toStream(url, lang, LABEL, SITE, { quality: q, headers: { Referer: `${SITE}/` } }));
  }

  // Also resolve iframes
  $('iframe[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src?.startsWith('http') && !seen.has(src)) {
      seen.add(src);
      streams.push(toStream(src, 'MULTI', LABEL, SITE, { quality: '720p', headers: { Referer: `${SITE}/` } }));
    }
  });

  return streams;
}

export const ctgmovies = createNuvioProvider({
  name: 'ctgmovies',
  sites: [SITE],
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'en',
});
