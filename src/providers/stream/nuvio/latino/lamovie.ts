/**
 * LaMovie — Latin American movie/series site at lamovie.cc.
 *
 * Ported from temp/Latino/Latino/providers/lamovie.js.
 * The site has a custom REST API (/wp-api/v1) and a cheerio-based search at
 * /search?keyword=. For movies the embed URLs live in .server-video[data-video]
 * elements under .lang-group. For TV the series page is found first, then a
 * season/episode list API call narrows it to the specific episode URL.
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchText,
  siteFetchJson,
  loadHtml,
  resolveEmbedsUntil,
  isAborted,
  isBudgetExhausted,
  normalize,
  ES_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
} from '../shared.js';

const SITE = 'https://lamovie.cc';
const API = 'https://lamovie.cc/wp-api/v1';
const LABEL = 'LaMovie';

function langTag(text: string): string {
  const t = text.toLowerCase();
  if (t.includes('castellano') || t.includes('españa')) return 'CAST';
  if (t.includes('sub') || t.includes('vose')) return 'SUB';
  return 'LAT';
}

interface SearchPost { url: string; title: string }

async function searchContent(title: string, ctx: NuvioContext): Promise<SearchPost | null> {
  const html = await siteFetchText(`${SITE}/search?keyword=${encodeURIComponent(title)}`, {
    headers: { Referer: `${SITE}/` },
    acceptLanguage: ES_ACCEPT_LANGUAGE,
    timeoutMs: 8_000,
    signal: ctx.signal,
  });
  if (!html) return null;

  const $ = loadHtml(html);
  const posts: SearchPost[] = [];
  $('.popular-card').each((_, el) => {
    const t = $(el).find('.popular-card__title p').text().trim();
    const link = $(el).find('.popular-card__title a').attr('href');
    if (link) posts.push({ title: t, url: link });
  });

  if (!posts.length) return null;
  const normQ = normalize(title);
  const scored = posts.map(p => ({
    post: p,
    score: (() => {
      const n = normalize(p.title);
      if (n === normQ) return 100;
      if (n.includes(normQ) || normQ.includes(n)) return 70;
      return 0;
    })(),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0].score >= 20 ? scored[0].post : null;
}

async function getEpisodeUrl(
  seriesUrl: string,
  season: number,
  episode: number,
  ctx: NuvioContext
): Promise<string | null> {
  const html = await siteFetchText(seriesUrl, {
    headers: { Referer: `${SITE}/` },
    acceptLanguage: ES_ACCEPT_LANGUAGE,
    timeoutMs: 8_000,
    signal: ctx.signal,
  });
  if (!html) return null;

  const $ = loadHtml(html);
  // Try data-post for WordPress AJAX episode list
  const dpost = html.match(/data-post="(\d+)"/)?.[1];
  if (dpost) {
    const form = new URLSearchParams({
      action: 'action_select_season',
      post: dpost,
      season: String(season),
    });
    const epData = await siteFetchText(`${SITE}/wp-admin/admin-ajax.php`, {
      method: 'POST',
      body: form.toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: seriesUrl,
      },
      acceptLanguage: ES_ACCEPT_LANGUAGE,
      timeoutMs: 8_000,
      signal: ctx.signal,
    });
    if (epData) {
      const epUrls = [...epData.matchAll(/href="([^"]+\/capitulo\/[^"]+)"/g)].map(m => m[1]);
      const match = epUrls.find(u => {
        const m = u.match(/temporada-(\d+)-capitulo-(\d+)/);
        return m && parseInt(m[1]) === season && parseInt(m[2]) === episode;
      });
      if (match) return match;
    }
  }

  // Fallback: direct href patterns
  let found: string | null = null;
  $('a[href]').each((_, el) => {
    if (found) return;
    const href = $(el).attr('href') ?? '';
    const m = href.match(/temporada-(\d+)-capitulo-(\d+)/);
    if (m && parseInt(m[1]) === season && parseInt(m[2]) === episode) found = href;
  });
  return found;
}

async function extractEmbeds(
  targetUrl: string,
  ctx: NuvioContext
): Promise<Array<{ url: string; language: string }>> {
  const html = await siteFetchText(targetUrl, {
    headers: { Referer: `${SITE}/` },
    acceptLanguage: ES_ACCEPT_LANGUAGE,
    timeoutMs: 8_000,
    signal: ctx.signal,
  });
  if (!html) return [];

  const $ = loadHtml(html);
  const embeds: Array<{ url: string; language: string }> = [];

  // Build id→language map from server tabs
  const langMap: Record<string, string> = {};
  $('.server-tab .tab').each((_, el) => {
    const id = $(el).attr('data-id');
    const type = $(el).attr('data-type') ?? $(el).text();
    if (id && type) langMap[id] = type.trim().toLowerCase();
  });

  $('.lang-group').each((_, group) => {
    const groupId = $(group).attr('data-id') ?? '';
    const langText = langMap[groupId] ?? $(group).find('.lang-title').text().trim().toLowerCase() ?? '';
    const tag = langTag(langText);

    $(group).find('.server-video[data-video]').each((_, sv) => {
      const videoUrl = $(sv).attr('data-video');
      if (videoUrl) embeds.push({ url: videoUrl, language: tag });
    });
  });

  // Fallback: any iframe src
  if (embeds.length === 0) {
    $('iframe[src]').each((_, el) => {
      const src = $(el).attr('src');
      if (src?.startsWith('http')) embeds.push({ url: src, language: 'LAT' });
    });
  }

  return embeds;
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];
  const startTime = Date.now();

  const found = await searchContent(ctx.titles[0], ctx);
  if (!found || isAborted(ctx.signal)) return [];

  const contentUrl = found.url.startsWith('http') ? found.url : `${SITE}${found.url}`;
  let targetUrl = contentUrl;

  if (ctx.type === 'tv' && ctx.season && ctx.episode) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];
    const epUrl = await getEpisodeUrl(contentUrl, ctx.season, ctx.episode, ctx);
    if (!epUrl) return [];
    targetUrl = epUrl.startsWith('http') ? epUrl : `${SITE}${epUrl}`;
  }

  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  const embeds = await extractEmbeds(targetUrl, ctx);
  if (embeds.length === 0) return [];

  return resolveEmbedsUntil(embeds, {
    language: 'LAT',
    providerLabel: LABEL,
    siteUrl: SITE,
    signal: ctx.signal,
    budgetMs: PROVIDER_BUDGET_MS - (Date.now() - startTime),
  });
}

export const lamovie = createNuvioProvider({
  name: 'lamovie',
  sites: [SITE],
  language: 'es',
  extract,
  supportsMovie: true,
});
