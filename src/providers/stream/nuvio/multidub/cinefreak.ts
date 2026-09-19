/**
 * CineFreak — Multi-language streaming site at cinefreak.net.
 *
 * Ported from temp/multi-clone/src/providers/novus.rs.
 * The site is a WordPress site searched by TMDB id or title. A companion CDN
 * at new5.cinecloud.site exposes a JSON API with episode links.
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchText,
  siteFetchJson,
  loadHtml,
  resolveEmbedsUntil,
  isAborted,
  isBudgetExhausted,
  HI_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
} from '../shared.js';

const SITE = 'https://cinefreak.net';
const CDN  = 'https://new5.cinecloud.site';
const LABEL = 'CineFreak';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': HI_ACCEPT_LANGUAGE,
};

interface CfResult { id?: number; slug?: string; link?: string }

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];
  const startTime = Date.now();

  // Search via WP JSON
  let postUrl: string | null = null;
  if (ctx.tmdbId) {
    const posts = await siteFetchJson<CfResult[]>(
      `${SITE}/wp-json/wp/v2/posts?search=${ctx.tmdbId}&per_page=5`,
      { headers: HEADERS, timeoutMs: 8_000, signal: ctx.signal }
    );
    if (posts?.length) postUrl = posts[0].link ?? null;
  }
  if (!postUrl) {
    const posts = await siteFetchJson<CfResult[]>(
      `${SITE}/wp-json/wp/v2/posts?search=${encodeURIComponent(ctx.titles[0])}&per_page=5`,
      { headers: HEADERS, timeoutMs: 8_000, signal: ctx.signal }
    );
    if (posts?.length) postUrl = posts[0].link ?? null;
  }
  if (!postUrl || isAborted(ctx.signal)) return [];

  let targetUrl = postUrl;
  if (ctx.type === 'tv' && ctx.season != null && ctx.episode != null) {
    // Try CDN API for episode link
    const epData = await siteFetchJson<{ link?: string }>(
      `${CDN}/episode?tmdb=${ctx.tmdbId}&season=${ctx.season}&episode=${ctx.episode}`,
      { headers: HEADERS, timeoutMs: 8_000, signal: ctx.signal }
    );
    if (epData?.link) targetUrl = epData.link;
  }

  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  const pageHtml = await siteFetchText(targetUrl, {
    headers: HEADERS,
    timeoutMs: 8_000,
    signal: ctx.signal,
  });
  if (!pageHtml) return [];

  const $ = loadHtml(pageHtml);
  const embeds: Array<{ url: string; language: string }> = [];
  const seen = new Set<string>();

  $('iframe[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src?.startsWith('http') && !seen.has(src)) {
      seen.add(src);
      embeds.push({ url: src, language: 'MULTI' });
    }
  });
  if (embeds.length === 0) return [];

  return resolveEmbedsUntil(embeds, {
    language: 'MULTI',
    providerLabel: LABEL,
    siteUrl: SITE,
    signal: ctx.signal,
    budgetMs: PROVIDER_BUDGET_MS - (Date.now() - startTime),
  });
}

export const cinefreak = createNuvioProvider({
  name: 'cinefreak',
  sites: [SITE],
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'en',
});
