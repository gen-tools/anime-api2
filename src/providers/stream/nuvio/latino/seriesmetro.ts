/**
 * SeriesMetro — Latin American series/movie site at seriesmetro.net.
 *
 * Ported from temp/Latino/Latino/providers/seriesmetro.js.
 * Tries the slug-derived URL first; if the content includes `trembed=` or
 * `data-post=` it is valid. For TV shows a WordPress AJAX call retrieves
 * the episode list and navigates to the correct episode URL. Embeds are
 * extracted from inline `trembed` objects in the page script.
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchText,
  loadHtml,
  resolveEmbedsUntil,
  isAborted,
  isBudgetExhausted,
  normalize,
  ES_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
} from '../shared.js';

const SITE = 'https://www3.seriesmetro.net';
const LABEL = 'SeriesMetro';

function buildSlug(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function langTag(text: string): string {
  const t = text.toLowerCase();
  if (t.includes('castellano') || t === 'esp') return 'CAST';
  if (t.includes('sub') || t.includes('vose')) return 'SUB';
  return 'LAT';
}

async function findContentUrl(
  category: string,
  ctx: NuvioContext
): Promise<{ url: string; html: string } | null> {
  for (const title of ctx.titles.slice(0, 3)) {
    const slug = buildSlug(title);
    const url = `${SITE}/${category}/${slug}/`;
    const html = await siteFetchText(url, {
      headers: { Referer: `${SITE}/` },
      acceptLanguage: ES_ACCEPT_LANGUAGE,
      timeoutMs: 7_000,
      signal: ctx.signal,
      noBypass: true,
    });
    if (html && (html.includes('trembed=') || html.includes('data-post='))) {
      return { url, html };
    }
  }

  // Active search fallback
  const searchHtml = await siteFetchText(
    `${SITE}/?s=${encodeURIComponent(ctx.titles[0] ?? '')}`,
    {
      headers: { Referer: `${SITE}/` },
      acceptLanguage: ES_ACCEPT_LANGUAGE,
      timeoutMs: 8_000,
      signal: ctx.signal,
    }
  );
  if (!searchHtml) return null;

  const $ = loadHtml(searchHtml);
  const matches = $(`a[href*="/${category}/"]`).toArray();
  for (const el of matches.slice(0, 3)) {
    const href = $(el).attr('href');
    if (!href) continue;
    const pageHtml = await siteFetchText(href, {
      headers: { Referer: `${SITE}/` },
      acceptLanguage: ES_ACCEPT_LANGUAGE,
      timeoutMs: 7_000,
      signal: ctx.signal,
      noBypass: true,
    });
    if (pageHtml && (pageHtml.includes('trembed=') || pageHtml.includes('data-post='))) {
      return { url: href, html: pageHtml };
    }
  }
  return null;
}

async function getEpisodeUrl(
  seriesUrl: string,
  seriesHtml: string,
  season: number,
  episode: number,
  ctx: NuvioContext
): Promise<string | null> {
  const dpost = seriesHtml.match(/data-post="(\d+)"/)?.[1];
  if (!dpost) return null;

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
  if (!epData) return null;

  const epUrls = [...epData.matchAll(/href="([^"]+\/capitulo\/[^"]+)"/g)].map(m => m[1]);
  return epUrls.find(u => {
    const m = u.match(/temporada-(\d+)-capitulo-(\d+)/);
    return m && parseInt(m[1]) === season && parseInt(m[2]) === episode;
  }) ?? null;
}

async function extractEmbedsFromPage(
  pageUrl: string,
  ctx: NuvioContext
): Promise<Array<{ url: string; language: string }>> {
  const html = await siteFetchText(pageUrl, {
    headers: { Referer: `${SITE}/` },
    acceptLanguage: ES_ACCEPT_LANGUAGE,
    timeoutMs: 8_000,
    signal: ctx.signal,
  });
  if (!html) return [];

  const embeds: Array<{ url: string; language: string }> = [];
  const LANG_PRIORITY = ['latino', 'lat', 'castellano', 'español', 'esp', 'vose', 'sub'];

  // Try trembed= patterns first
  const trembedRe = /trembed=([^&'"]+)/g;
  let m: RegExpExecArray | null;
  while ((m = trembedRe.exec(html)) !== null) {
    const url = decodeURIComponent(m[1]);
    if (url.startsWith('http')) embeds.push({ url, language: 'LAT' });
  }

  // Server lists in script blocks
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/g;
  while ((m = scriptRe.exec(html)) !== null) {
    const script = m[1];
    const objRe = /\{[^{}]*url\s*:\s*['"]([^'"]+)['"][^{}]*\}/g;
    let om: RegExpExecArray | null;
    while ((om = objRe.exec(script)) !== null) {
      const url = om[1];
      if (url.startsWith('http') && !embeds.some(e => e.url === url)) {
        const langMatch = om[0].match(/lang\s*:\s*['"]([^'"]+)['"]/);
        embeds.push({ url, language: langMatch ? langTag(langMatch[1]) : 'LAT' });
      }
    }
  }

  // iframe fallback
  if (embeds.length === 0) {
    const $ = loadHtml(html);
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

  const category = ctx.type === 'movie' ? 'pelicula' : 'serie';
  const content = await findContentUrl(category, ctx);
  if (!content || isAborted(ctx.signal)) return [];

  let targetUrl = content.url;

  if (ctx.type === 'tv' && ctx.season && ctx.episode) {
    if (isBudgetExhausted(startTime)) return [];
    const epUrl = await getEpisodeUrl(content.url, content.html, ctx.season, ctx.episode, ctx);
    if (!epUrl) return [];
    targetUrl = epUrl.startsWith('http') ? epUrl : `${SITE}${epUrl}`;
  }

  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  const embeds = await extractEmbedsFromPage(targetUrl, ctx);
  if (embeds.length === 0) return [];

  return resolveEmbedsUntil(embeds, {
    language: 'LAT',
    providerLabel: LABEL,
    siteUrl: SITE,
    signal: ctx.signal,
    budgetMs: PROVIDER_BUDGET_MS - (Date.now() - startTime),
  });
}

export const seriesmetro = createNuvioProvider({
  name: 'seriesmetro',
  sites: [SITE],
  language: 'es',
  extract,
  supportsMovie: true,
});
