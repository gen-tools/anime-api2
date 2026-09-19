/**
 * DesiDub Anime — Toko Stream Provider
 * Ported from extension/A1/src/providers/desidubanime/desidubanime.ts
 */
import { normalizeQuality, detectSourceType } from '../../utils/scraping/quality.js';
import { buildSearchQueries, scoreMatch } from '../../utils/scraping/title-normalizer.js';
import type { StreamProvider, SourceOptions, SourceResult } from '../../types/index.js';

import { fetchResponse, loadHtml } from '../../utils/http/fetch.js';

const BASE_URL = 'https://www.desidubanime.me';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function decodeB64(str: string): string {
  try { return atob(str); } catch { return ''; }
}

function extractEmbedUrl(value: string): string {
  const iframe = value.match(
    /<iframe\b[^>]*\b(?:src|data-src)\s*=\s*(['"])([^'"]+)\1/i,
  );
  return iframe?.[2]?.trim() || value.trim();
}

function extractAjaxEpisodeUrl(
  html: string,
  base: string,
  query: string,
  epNumber: number,
): string | null {
  const $ = loadHtml(html);
  const candidates: Array<{ url: string; title: string; order: number }> = [];

  $('article').each((index: number, article: any) => {
    const title =
      $(article).find('h3 span').first().text().trim() ||
      $(article).find('h3').first().text().trim();
    let episodeSlug: string | null = null;

    $(article).find('a[href]').each((_: number, anchor: any) => {
      if (episodeSlug) return;
      const href = String($(anchor).attr('href') ?? '').trim();
      const match = href.match(/\/watch\/([^/]+)-episode-(\d+)\/?$/i);
      if (match?.[1]) episodeSlug = match[1];
    });

    if (episodeSlug) {
      candidates.push({
        url: `${base}/watch/${episodeSlug}-episode-${epNumber}/`,
        title,
        order: index,
      });
    }
  });

  return candidates
    .sort((a, b) => scoreMatch(query, b.title) - scoreMatch(query, a.title) || a.order - b.order)
    .map(candidate => candidate.url)[0] ?? null;
}

async function findSources(titles: string[], epNumber: number): Promise<SourceResult[]> {
  const bases = [BASE_URL];
  for (const query of buildSearchQueries(titles)) {
    for (const base of bases) {
      try {
        let animeSlug: string | null = null;
        let candidateWatchUrl: string | null = null;

        // 1. WP REST API search (fast)
        try {
          const apiRes = await fetchResponse(
            `${base}/wp-json/wp/v2/anime?search=${encodeURIComponent(query)}&per_page=10`,
            { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(5000) } as RequestInit,
          );
          if (apiRes.ok) {
            const apiJson = (await apiRes.json()) as any[];
            if (Array.isArray(apiJson)) {
              const candidates = apiJson
                .filter(item => item?.slug)
                .map(item => ({
                  slug: String(item.slug),
                  title: String(item.title?.rendered ?? item.title ?? item.slug),
                }))
                .map(item => ({ ...item, score: scoreMatch(query, item.title) }))
                .sort((a, b) => b.score - a.score);
              if (candidates[0] && candidates[0].score >= 0.35) {
                animeSlug = candidates[0].slug;
              }
            }
          }
        } catch { /* fallback to HTML */ }

        // 2. HTML search fallback
        if (!animeSlug) {
          // KiraAnime's current search UI renders results through this AJAX
          // action. The normal /search/ page contains no result anchors until
          // JavaScript submits the form.
          try {
            const ajaxRes = await fetchResponse(
              `${base}/wp-admin/admin-ajax.php`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                  'User-Agent': UA,
                },
                body: `action=advanced_search&s_keyword=${encodeURIComponent(query)}`,
                signal: AbortSignal.timeout(5000),
              } as RequestInit,
            );
            if (ajaxRes.ok) {
              const payload = await ajaxRes.json() as any;
              const ajaxHtml = typeof payload?.data === 'string'
                ? payload.data
                : typeof payload?.data?.html === 'string'
                  ? payload.data.html
                  : '';
              if (payload?.success && ajaxHtml) {
                candidateWatchUrl = extractAjaxEpisodeUrl(ajaxHtml, base, query, epNumber);
              }
            }
          } catch { /* fallback to the rendered search page */ }
        }

        if (!animeSlug && !candidateWatchUrl) {
          const searchPaths = [
            `/search/${encodeURIComponent(query).replace(/%20/g, '+')}/`,
            `/?s=${encodeURIComponent(query)}`,
          ];
          for (const path of searchPaths) {
            const searchRes = await fetchResponse(
              `${base}${path}`,
              { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(5000) } as RequestInit,
            );
            if (!searchRes.ok) continue;

            const searchHtml = await searchRes.text();
            const $ = loadHtml(searchHtml);
            $.find('a[href]').each((_: number, el: any) => {
              if (candidateWatchUrl || animeSlug) return;
              const href: string = el.attr?.('href') ?? '';
              if (!href || !/^https?:\/\//i.test(href)) return;
              if (href.includes('/category/') || href.includes('/tag/') || href.includes('/az-list/')) return;
              const m = href.match(/\/(?:anime|series|watch)\/([^/]+)\/?$/) || href.match(/desidubanime\.me\/([^/]+)\/?$/) || href.match(/desidub\.com\/([^/]+)\/?$/);
              if (m && m[1] && !['search', 'disclaimer', 'dmca', 'page'].includes(m[1])) {
                animeSlug = m[1];
                candidateWatchUrl = href;
              }
            });
            if (animeSlug || candidateWatchUrl) break;
          }
        }

        if (!animeSlug && !candidateWatchUrl) continue;

        // 3. Fetch the episode watch page
        const watchUrl = candidateWatchUrl || `${base}/watch/${animeSlug}-episode-${epNumber}/`;
        const watchRes = await fetchResponse(watchUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(5000) } as RequestInit);
        if (!watchRes.ok) continue;
        const watchHtml = await watchRes.text();
        const $ = loadHtml(watchHtml);

        const results: SourceResult[] = [];

        // Base64-encoded server embeds
        $.find('span[data-embed-id]').each((_: number, el: any) => {
          const embedData: string = el.attr?.('data-embed-id') ?? '';
          if (!embedData) return;
          const [b64Name, b64Url] = embedData.split(':');
          if (!b64Name || !b64Url) return;
          const serverName = decodeB64(b64Name);
          const decoded = decodeB64(b64Url);
          let finalUrl = extractEmbedUrl(decoded);
          if (!finalUrl || finalUrl.includes('googletagmanager')) return;
          if (!/^https?:\/\//i.test(finalUrl)) return;
          const isDub = serverName.toLowerCase().includes('dub') || !serverName.toLowerCase().includes('sub');
          results.push({
            source: 'desidub',
            url: finalUrl,
            quality: normalizeQuality('HD'),
            headers: { Referer: `${base}/`, 'User-Agent': UA },
            subtitles: [],
            audioLanguage: isDub ? 'hi' : 'ja',
            language: isDub ? 'Hindi' : 'Japanese',
            sourceType: finalUrl.includes('.m3u8') ? 'hls' : finalUrl.includes('.mp4') ? 'mp4' : 'custom',
          });
        });

        // Fallback: inline m3u8/mp4
        if (results.length === 0) {
          const m3u8 = watchHtml.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i);
          if (m3u8) {
            results.push({ source: 'desidub', url: m3u8[1], quality: normalizeQuality('HD'), headers: { Referer: `${base}/`, 'User-Agent': UA }, subtitles: [], audioLanguage: 'hi', language: 'Hindi', sourceType: 'hls' });
          }
        }

        if (results.length > 0) return results;
      } catch { continue; }
    }
  }
  return [];
}

const provider: StreamProvider = {
  name: 'desidub',
  sites: [BASE_URL],
  async single(opts: SourceOptions): Promise<SourceResult[]> {
    try {
      return await findSources(opts.titles, opts.episode ?? 1);
    } catch {
      return [];
    }
  },
};

export default provider;
