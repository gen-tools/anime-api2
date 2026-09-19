/**
 * MoviesDrive — Hindi/multi-audio WordPress scraper on moviesdrives.my
 *
 * Search strategy: keyword search, then WP REST API by tmdbId. Post pages contain
 * mdrive.lol/archive links. Each archive page has hubcloud links which are
 * resolved to FSL/r2.dev direct streams. Quality filter: 720p/1080p/2160p only.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  siteFetchText,
  siteFetchJson,
  siteFetchHtml,
  scoreTitleMatch,
  isAborted,
  isBudgetExhausted,
  absoluteUrl,
  HI_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
  NUVIO_UA,
} from '../shared.js';

const SITE = 'https://moviesdrives.my';
const LABEL = 'MoviesDrive';

const BASE_HEADERS = {
  'User-Agent': NUVIO_UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

// ── Types ────────────────────────────────────────────────────────────────────

interface SearchDoc {
  post_title?: string;
  permalink?: string;
  imdb_id?: string;
}

interface SearchHit {
  document?: SearchDoc;
}

interface SearchResponse {
  hits?: SearchHit[];
}

interface WpPost {
  link?: string;
  title?: { rendered: string };
}

interface ArchiveLink {
  url: string;
  label: string;
  quality: string;
}

interface HubcloudStream {
  url: string;
  label: string;
  quality: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseQuality(text: string): string {
  const t = String(text || '').toUpperCase();
  if (t.includes('2160') || t.includes('4K')) return '2160p';
  if (t.includes('1080')) return '1080p';
  if (t.includes('720')) return '720p';
  if (t.includes('480')) return '480p';
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

function minutesSuffix(): string {
  return String(new Date().getMinutes());
}

// ── Search ───────────────────────────────────────────────────────────────────

async function searchByTmdbId(tmdbId: string, ctx: NuvioContext): Promise<string | null> {
  const apiUrl = `${SITE}/wp-json/wp/v2/posts?search=${encodeURIComponent(tmdbId)}&per_page=3`;
  const posts = await siteFetchJson<WpPost[]>(apiUrl, {
    signal: ctx.signal,
    timeoutMs: 10_000,
  });
  if (posts && posts.length > 0 && posts[0].link) return posts[0].link;
  return null;
}

async function searchByKeyword(
  query: string,
  ctx: NuvioContext
): Promise<Array<{ href: string; title: string }>> {
  // Site-specific search API
  const searchUrl = `${SITE}/search.php?q=${encodeURIComponent(query)}&per_page=10`;
  const data = await siteFetchJson<SearchResponse>(searchUrl, {
    headers: { Referer: `${SITE}/` },
    signal: ctx.signal,
    timeoutMs: 10_000,
  });

  if (data?.hits?.length) {
    return data.hits
      .filter((h) => h.document?.permalink && h.document.post_title)
      .map((h) => ({
        href: h.document!.permalink!,
        title: String(h.document!.post_title || '').replace(/Download\s*/gi, '').trim(),
      }));
  }

  // HTML fallback
  const searchHtml = await siteFetchHtml(`${SITE}/?s=${encodeURIComponent(query)}`, {
    headers: BASE_HEADERS,
    acceptLanguage: HI_ACCEPT_LANGUAGE,
    signal: ctx.signal,
    timeoutMs: 12_000,
  });
  if (!searchHtml) return [];

  const results: Array<{ href: string; title: string }> = [];
  searchHtml('a[href]').each((_, el) => {
    const href = searchHtml(el).attr('href') || '';
    if (!href.startsWith(SITE)) return;
    if (/\/(category|tag|author|page|feed)/i.test(href)) return;
    const title = (searchHtml(el).text() || searchHtml(el).attr('title') || '').trim();
    if (title && title.length > 3) results.push({ href, title });
  });
  return results;
}

// ── Archive link parsing ──────────────────────────────────────────────────────

async function parsePage(
  pageUrl: string,
  season: number | undefined,
  ctx: NuvioContext
): Promise<ArchiveLink[]> {
  const html = await siteFetchHtml(pageUrl, {
    headers: { Referer: `${SITE}/` },
    signal: ctx.signal,
    timeoutMs: 12_000,
  });
  if (!html) return [];

  const links: ArchiveLink[] = [];
  const seen = new Set<string>();
  const isTv = season != null;

  // Look for mdrive.lol/archive links
  html('a').each((_, el) => {
    const href = html(el).attr('href') || '';
    if (!href.includes('mdrive.lol/archive/')) return;
    if (seen.has(href)) return;
    // For TV, try to get season-scoped links
    if (isTv) {
      const parentText = html(el).closest('h5, h4, h3, div').first().text();
      const sm = parentText.match(/Season\s+(\d+)/i);
      if (sm && parseInt(sm[1], 10) !== season) return;
    }
    seen.add(href);
    const label = html(el).text().trim() || 'HD';
    if (isTv && label.toLowerCase().includes('zip')) return;
    links.push({ url: href, label, quality: parseQuality(label) });
  });

  // Fallback: raw HTML scan
  if (links.length === 0) {
    const raw = html.html() || '';
    const matches = raw.match(/https?:\/\/mdrive\.lol\/archive\/(\d+)/g) ?? [];
    const uniq = [...new Set(matches)];
    for (const url of uniq) {
      const m = url.match(/archive\/(\d+)/);
      if (m) links.push({ url, label: `Archive ${m[1]}`, quality: 'HD' });
    }
  }

  return links.filter((l) =>
    l.quality === '720p' || l.quality === '1080p' || l.quality === '2160p'
  );
}

// ── Archive page parsing ──────────────────────────────────────────────────────

async function parseArchive(
  archiveUrl: string,
  episode: number | undefined,
  ctx: NuvioContext
): Promise<Array<{ type: 'hubcloud'; url: string }>> {
  const html = await siteFetchHtml(archiveUrl, {
    headers: { Referer: `${SITE}/` },
    signal: ctx.signal,
    timeoutMs: 12_000,
  });
  if (!html) return [];

  const hosts: Array<{ type: 'hubcloud'; url: string }> = [];
  const seen = new Set<string>();
  const isEp = episode != null;

  html('a').each((_, el) => {
    const href = html(el).attr('href') || '';
    if (!href.includes('hubcloud.')) return;
    if (seen.has(href)) return;

    if (isEp) {
      const blockText = html(el).closest('tr, li, div, p').text() || '';
      const em = blockText.match(/(?:EP|Episode|E)[^a-zA-Z0-9]*0*(\d+)/i);
      if (em && parseInt(em[1], 10) !== episode) return;
    }

    seen.add(href);
    hosts.push({ type: 'hubcloud', url: href });
  });

  return hosts;
}

// ── Hubcloud resolution ──────────────────────────────────────────────────────

async function resolveHubcloud(
  hubUrl: string,
  label: string,
  ctx: NuvioContext
): Promise<HubcloudStream[]> {
  const html = await siteFetchText(hubUrl, {
    headers: {
      Referer: 'https://hubcloud.foo/',
      Cookie: 'xla=s4t',
    },
    signal: ctx.signal,
    timeoutMs: 12_000,
  });
  if (!html) return [];

  // Find bridge URL
  let bridgeUrl = '';
  const varMatch = html.match(/var\s+url\s*=\s*'([^']+)'/);
  if (varMatch) bridgeUrl = varMatch[1];
  if (!bridgeUrl) {
    const hm = html.match(/<a[^>]*id=["']download["'][^>]*href=["']([^"']+)["']/);
    if (hm) bridgeUrl = hm[1];
  }
  if (!bridgeUrl) return [];

  const bridgeHtml = await siteFetchText(bridgeUrl, {
    headers: { Referer: hubUrl, Cookie: 'xla=s4t' },
    signal: ctx.signal,
    timeoutMs: 15_000,
  });
  if (!bridgeHtml) return [];

  const streams: HubcloudStream[] = [];
  const quality = parseQuality(label);

  // FSL token URL
  const tokenMatch = bridgeHtml.match(/https?:\/\/[^\s"'<>]+\?token=\d+/);
  if (tokenMatch) {
    const base = tokenMatch[0].replace(/["'].*$/, '').replace(/[<>].*$/, '');
    if (!base.includes('hubcloud.php')) {
      const fslUrl = base + '1' + minutesSuffix();
      streams.push({
        url: fslUrl,
        label: label + ' [FSL]',
        quality,
      });
    }
  }

  // R2 CDN
  if (streams.length === 0) {
    const r2Match = bridgeHtml.match(/https?:\/\/pub-[a-zA-Z0-9\-]+\.r2\.dev[^\s"'<>]*/);
    if (r2Match) {
      streams.push({
        url: r2Match[0].replace(/["'].*$/, '').replace(/[<>].*$/, ''),
        label: label + ' [R2]',
        quality,
      });
    }
  }

  return streams;
}

// ── Main extractor ───────────────────────────────────────────────────────────

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];
  const startTime = Date.now();

  const isTv = ctx.type === 'tv';

  // Find post URL
  let postUrl: string | null = null;

  if (ctx.tmdbId) {
    postUrl = await searchByTmdbId(ctx.tmdbId, ctx.signal ? ctx : ctx);
  }

  if (!postUrl) {
    for (const title of ctx.titles) {
      if (isAborted(ctx.signal) || isBudgetExhausted(startTime, PROVIDER_BUDGET_MS)) break;
      const results = await searchByKeyword(title, ctx);
      if (results.length === 0) continue;

      let best = results[0];
      let bestScore = -1;
      for (const r of results) {
        const score = scoreTitleMatch(r.title, title);
        if (score > bestScore) { bestScore = score; best = r; }
      }
      postUrl = best.href;
      break;
    }
  }

  if (!postUrl || isAborted(ctx.signal) || isBudgetExhausted(startTime, PROVIDER_BUDGET_MS)) return [];

  // Get archive links from post page
  const archiveLinks = await parsePage(postUrl, isTv ? ctx.season : undefined, ctx);
  if (archiveLinks.length === 0) return [];

  const pad2 = (n: number | undefined) => n != null && n < 10 ? `0${n}` : String(n ?? '');
  const epLabel = isTv ? ` S${pad2(ctx.season)}E${pad2(ctx.episode)}` : '';

  const streams: NuvioStream[] = [];

  for (const archLink of archiveLinks) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime, PROVIDER_BUDGET_MS)) break;

    const hosts = await parseArchive(archLink.url, isTv ? ctx.episode : undefined, ctx);
    const hubHosts = hosts.filter((h) => h.type === 'hubcloud');

    for (const host of hubHosts) {
      if (isAborted(ctx.signal) || isBudgetExhausted(startTime, PROVIDER_BUDGET_MS)) break;

      const fullLabel = (ctx.titles[0] || '') + epLabel + ' ' + archLink.quality;
      const resolved = await resolveHubcloud(host.url, fullLabel, ctx);

      for (const s of resolved) {
        const language = inferLanguage(s.label + ' ' + archLink.label);
        streams.push({
          url: s.url,
          name: `${LABEL} | FSL | ${s.quality}`,
          title: `[${language}] ${LABEL} · ${s.quality}`,
          quality: s.quality,
          language,
          headers: {
            Referer: 'https://gamerxyt.com/',
            Origin: 'https://gamerxyt.com/',
            'User-Agent': NUVIO_UA,
          },
        });
      }
    }

    if (streams.length >= 4) break;
  }

  // Deduplicate by URL
  const seen = new Set<string>();
  return streams.filter((s) => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}

export const moviesdrive = createNuvioProvider({
  name: 'moviesdrive',
  sites: [SITE],
  language: 'hi',
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'hi',
});
