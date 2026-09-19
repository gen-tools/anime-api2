/**
 * CineCalidad — Latin American Spanish movie site at cinecalidad.vg.
 *
 * Ported from temp/Latino/Latino/providers/cinecalidad.js.
 * The site stores embed URLs base64-encoded in `data-src` attributes. There are
 * two levels: a base64 value either decodes directly to an embed URL or to an
 * intermediate page that has a `#btn_enlace` link or an iframe. We try the slug
 * derived from the title first, then fall back to the site's ?s= search.
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchText,
  loadHtml,
  toSlug,
  resolveEmbedsUntil,
  isAborted,
  isBudgetExhausted,
  decodeBase64,
  ES_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
} from '../shared.js';

const SITE = 'https://www.cinecalidad.vg';
const LABEL = 'CineCalidad';

function buildSlug(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function findContentUrl(ctx: NuvioContext, slug: string): Promise<string | null> {
  const category = ctx.type === 'movie' ? 'pelicula' : 'serie';

  for (const s of [slug, `${slug}-2`, `${slug}-3`]) {
    if (isAborted(ctx.signal)) return null;
    const url = `${SITE}/${category}/${s}/`;
    const html = await siteFetchText(url, {
      headers: { Referer: `${SITE}/` },
      acceptLanguage: ES_ACCEPT_LANGUAGE,
      timeoutMs: 7_000,
      signal: ctx.signal,
      noBypass: true,
    });
    if (html && !html.includes('404') && (html.includes('data-src=') || html.includes('trembed='))) {
      return url;
    }
  }

  // Search fallback
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
  let found: string | null = null;
  $(`a[href*="${category}"]`).each((_, el) => {
    if (!found) found = $(el).attr('href') ?? null;
  });
  return found;
}

async function getEmbedUrls(pageUrl: string, ctx: NuvioContext): Promise<string[]> {
  const html = await siteFetchText(pageUrl, {
    headers: { Referer: `${SITE}/` },
    acceptLanguage: ES_ACCEPT_LANGUAGE,
    timeoutMs: 8_000,
    signal: ctx.signal,
  });
  if (!html) return [];

  const embedUrls: string[] = [];
  const b64Re = /data-src="([A-Za-z0-9+/=]{20,})"/g;
  let m: RegExpExecArray | null;

  while ((m = b64Re.exec(html)) !== null) {
    const decoded = decodeBase64(m[1]);
    if (decoded && decoded.startsWith('http')) {
      embedUrls.push(decoded);
    } else if (decoded) {
      // Intermediate URL — fetch it to get the real embed
      const midHtml = await siteFetchText(decoded, {
        headers: { Referer: pageUrl },
        timeoutMs: 6_000,
        signal: ctx.signal,
        noBypass: true,
      });
      if (midHtml) {
        const btnMatch = midHtml.match(/id="btn_enlace"[\s\S]*?href="([^"]+)"/);
        if (btnMatch) { embedUrls.push(btnMatch[1]); continue; }
        const iframeMatch = midHtml.match(/<iframe[^>]+src="([^"]+)"/);
        if (iframeMatch) { embedUrls.push(iframeMatch[1]); }
      }
    }
  }

  return [...new Set(embedUrls)];
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];
  const startTime = Date.now();

  const slug = buildSlug(ctx.titles[0]);
  if (!slug) return [];

  const contentUrl = await findContentUrl(ctx, slug);
  if (!contentUrl || isAborted(ctx.signal)) return [];

  // For TV: navigate to the episode page
  let targetUrl = contentUrl;
  if (ctx.type === 'tv' && ctx.season && ctx.episode) {
    const serieHtml = await siteFetchText(contentUrl, {
      headers: { Referer: `${SITE}/` },
      acceptLanguage: ES_ACCEPT_LANGUAGE,
      timeoutMs: 8_000,
      signal: ctx.signal,
    });
    if (serieHtml) {
      const $ = loadHtml(serieHtml);
      let epUrl: string | null = null;
      $(`a[href*="temporada-${ctx.season}"][href*="capitulo-${ctx.episode}"],
         a[href*="season-${ctx.season}"][href*="episode-${ctx.episode}"]`).each((_, el) => {
        if (!epUrl) epUrl = $(el).attr('href') ?? null;
      });
      if (epUrl) targetUrl = epUrl;
    }
  }

  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  const embedUrls = await getEmbedUrls(targetUrl, ctx);
  if (embedUrls.length === 0) return [];

  const embeds = embedUrls.map(url => ({ url, language: 'LAT' }));
  return resolveEmbedsUntil(embeds, {
    language: 'LAT',
    providerLabel: LABEL,
    siteUrl: SITE,
    signal: ctx.signal,
    budgetMs: PROVIDER_BUDGET_MS - (Date.now() - startTime),
  });
}

export const cinecalidad = createNuvioProvider({
  name: 'cinecalidad',
  sites: [SITE],
  language: 'es',
  extract,
  supportsMovie: true,
});
