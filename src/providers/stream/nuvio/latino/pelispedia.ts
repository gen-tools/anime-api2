/**
 * PelisPedia — Latin American streaming site at pelispedia.mov.
 *
 * Ported from temp/Latino/Latino/providers/pelispedia.js.
 * Searches by title, finds the correct /pelicula/ or /serie/ URL, then
 * navigates to the episode for TV. Embeds are collected from `.player-content
 * iframe` elements; a regex fallback catches any remaining iframe[src] values.
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchText,
  loadHtml,
  resolveEmbedsUntil,
  isAborted,
  isBudgetExhausted,
  ES_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
} from '../shared.js';

const SITE = 'https://pelispedia.mov';
const LABEL = 'PelisPedia';

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];
  const startTime = Date.now();

  const searchHtml = await siteFetchText(
    `${SITE}/search?s=${encodeURIComponent(ctx.titles[0])}`,
    {
      headers: { Referer: `${SITE}/` },
      acceptLanguage: ES_ACCEPT_LANGUAGE,
      timeoutMs: 8_000,
      signal: ctx.signal,
    }
  );
  if (!searchHtml || isAborted(ctx.signal)) return [];

  const re = /href="(https:\/\/pelispedia\.mov\/(pelicula|serie)\/([^"]+))"/gi;
  const matches: Array<{ url: string; type: string; slug: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(searchHtml)) !== null) {
    matches.push({ url: m[1], type: m[2], slug: m[3] });
  }
  if (matches.length === 0) return [];

  const best = matches[0];
  let targetUrl = best.url;

  if (best.type === 'serie' && ctx.season && ctx.episode) {
    targetUrl = `${SITE}/serie/${best.slug}/temporada/${ctx.season}/capitulo/${ctx.episode}`;
  }

  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  const pageHtml = await siteFetchText(targetUrl, {
    headers: { Referer: `${SITE}/` },
    acceptLanguage: ES_ACCEPT_LANGUAGE,
    timeoutMs: 8_000,
    signal: ctx.signal,
  });
  if (!pageHtml) return [];

  const $ = loadHtml(pageHtml);
  const embeds: Array<{ url: string; language: string }> = [];
  const seen = new Set<string>();

  $('.player-content iframe').each((_, el) => {
    const src = $(el).attr('src');
    if (src && !seen.has(src)) {
      seen.add(src);
      embeds.push({ url: src, language: 'LAT' });
    }
  });

  if (embeds.length === 0) {
    const iframeRe = /<iframe[^>]+src="([^"]+)"/gi;
    while ((m = iframeRe.exec(pageHtml)) !== null) {
      const u = m[1];
      if (!seen.has(u)) {
        seen.add(u);
        embeds.push({ url: u, language: 'LAT' });
      }
    }
  }

  if (embeds.length === 0) return [];

  return resolveEmbedsUntil(embeds, {
    language: 'LAT',
    providerLabel: LABEL,
    siteUrl: SITE,
    signal: ctx.signal,
    budgetMs: PROVIDER_BUDGET_MS - (Date.now() - startTime),
  });
}

export const pelispedia = createNuvioProvider({
  name: 'pelispedia',
  sites: [SITE],
  language: 'es',
  extract,
  supportsMovie: true,
});
