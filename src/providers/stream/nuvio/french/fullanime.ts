/**
 * FullAnime — French VOSTFR catalogue (fullanime.fr), a server-rendered PHP site
 * with one page per season and a small fixed set of embed hosts per episode.
 *
 * Ported from temp/French/French/src/fullanime. Slugs are predictable enough
 * (`/voir-anime/<title>-vostfr`, `/voir-anime/<title>-saison-N-vostfr`) that
 * guessing the URL from the title is tried before the search page, which saves a
 * request on the common case. The search page is only markup — there is no JSON
 * endpoint — so hits are recovered by scanning it for `/voir-anime/` links and
 * scoring their slugs.
 *
 * Episode pages hold their players in a `var links = [...]` array with
 * backslash-escaped URLs; the visible iframe only ever carries the first of them,
 * hence the array is read first and the iframe is a fallback.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  siteFetchText,
  normalize,
  toSlug,
  resolveEmbedsUntil,
  serverNameFor,
  isAborted,
  isBudgetExhausted,
  FR_ACCEPT_LANGUAGE,
} from '../shared.js';

const SITE = 'https://www.fullanime.fr';
const LABEL = 'FullAnime';

/** Search-result slugs scored per title before moving to the next title. */
const MAX_SCORED_CANDIDATES = 3;

/**
 * Host order the site's own player falls back through, most reliable first.
 *
 * Kept because embed resolution is sequential and stops once enough streams
 * resolve, so the order decides which hosts get tried at all.
 */
const HOST_PRIORITY = ['vidmoly', 'oneupload', 'sendvid'];

interface SearchHit {
  slug: string;
  url: string;
  title: string;
}

interface EpisodeLink {
  num: number;
  url: string;
  title: string;
}

/** Site-flavoured comparison form: structural words carry no identity here. */
function normalizeTitle(value: string): string {
  return normalize(value)
    .replace(/\b(the|season|part|cour|saison)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchPage(url: string, signal: AbortSignal): Promise<string> {
  const html = await siteFetchText(url, { signal, acceptLanguage: FR_ACCEPT_LANGUAGE });
  return html ?? '';
}

/**
 * Scrape the search page for catalogue entries.
 *
 * The cache-buster is the site's own convention; without it the search page is
 * served from an edge cache that can be several hours stale.
 */
async function searchAnime(query: string, signal: AbortSignal): Promise<SearchHit[]> {
  const searchUrl = `${SITE}/search?s=${encodeURIComponent(query)}&_t=${Date.now()}`;
  const html = await fetchPage(searchUrl, signal);
  if (html.length < 500) return [];

  const results: SearchHit[] = [];
  const seen = new Set<string>();
  const linkRegex = /href="(\/voir-anime\/[^"]+)"/gi;
  for (const match of html.matchAll(linkRegex)) {
    const path = match[1];
    if (seen.has(path)) continue;
    seen.add(path);
    const slug = path.replace('/voir-anime/', '');
    // The page shows no plain-text titles next to the links, so the slug is the
    // only title available; strip its language and season markers.
    const title = slug
      .replace(/-vostfr$/, '')
      .replace(/-saison-\d+$/, '')
      .replace(/-/g, ' ');
    results.push({ slug, url: `${SITE}${path}`, title });
  }
  return results;
}

function extractEpisodes(html: string): EpisodeLink[] {
  const episodes: EpisodeLink[] = [];
  const seen = new Set<number>();
  const epRegex = /href="(\/voir-anime\/[^"]*\/episode\/(\d+))"[^>]*title="([^"]*)"/gi;
  for (const match of html.matchAll(epRegex)) {
    const num = Number.parseInt(match[2], 10);
    if (!Number.isFinite(num) || seen.has(num)) continue;
    seen.add(num);
    episodes.push({ num, url: `${SITE}${match[1]}`, title: match[3] });
  }
  return episodes;
}

function extractEmbedUrls(html: string): string[] {
  const urls: string[] = [];

  const linksMatch = html.match(/var\s+links\s*=\s*\[(.*?)\]/s);
  if (linksMatch) {
    const raw = linksMatch[1];
    const urlRegex = /"(https?:[^"]+)"/g;
    for (const m of raw.matchAll(urlRegex)) {
      const url = m[1].replace(/\\\//g, '/').replace(/\\/g, '');
      if (!urls.includes(url)) urls.push(url);
    }
  }

  if (urls.length === 0) {
    const iframeMatch = html.match(/<iframe[^>]*src="(https?:\/\/[^"]+)"/i);
    if (iframeMatch) urls.push(iframeMatch[1]);
  }

  return urls;
}

/**
 * The catalogue is VOSTFR-only in practice, but a handful of dubbed entries exist
 * and are only distinguishable by their slug.
 */
function inferLanguage(slug: string, title: string): string {
  const combined = `${slug} ${title}`.toLowerCase();
  if (combined.includes('-vf') || combined.includes(' vf') || combined.includes('french')) {
    return 'VF';
  }
  return 'VOSTFR';
}

function hostPriority(url: string): number {
  const lower = url.toLowerCase();
  const idx = HOST_PRIORITY.findIndex((p) => lower.includes(p));
  return idx === -1 ? 99 : idx;
}

interface AnimePage {
  animeUrl: string;
  episodes: EpisodeLink[];
}

/** Try the two slug shapes the site uses, per title, cheapest first. */
async function findByDirectUrl(
  titles: string[],
  season: number,
  signal: AbortSignal,
  startTime: number
): Promise<AnimePage | null> {
  for (const title of titles) {
    if (isAborted(signal) || isBudgetExhausted(startTime)) break;
    const slug = toSlug(title);
    if (!slug) continue;

    const attempts =
      season > 1
        ? [`${SITE}/voir-anime/${slug}-saison-${season}-vostfr`, `${SITE}/voir-anime/${slug}-vostfr`]
        : [`${SITE}/voir-anime/${slug}-vostfr`];

    for (const url of attempts) {
      if (isAborted(signal) || isBudgetExhausted(startTime)) break;
      const html = await fetchPage(url, signal);
      if (html.length <= 1000) continue;
      const episodes = extractEpisodes(html);
      if (episodes.length > 0) return { animeUrl: url, episodes };
    }
  }
  return null;
}

async function findBySearch(
  titles: string[],
  season: number,
  signal: AbortSignal,
  startTime: number
): Promise<AnimePage | null> {
  for (const title of titles) {
    if (isAborted(signal) || isBudgetExhausted(startTime)) break;

    const results = await searchAnime(title, signal);
    if (results.length === 0) continue;

    const queryNorm = normalizeTitle(title);
    const seasonSlug = season ? `saison-${season}` : '';
    const scored = results
      .map((r) => {
        const slugNorm = normalizeTitle(r.slug);
        let score = 0;
        if (slugNorm === queryNorm) score += 100;
        else if (slugNorm.includes(queryNorm)) score += 80;
        else if (queryNorm.includes(slugNorm)) score += 60;
        if (seasonSlug && r.slug.includes(seasonSlug)) score += 50;
        // A season-2 lookup landing on a slug with no season marker is almost
        // always the season-1 page, which would serve the wrong episode.
        if (season > 1 && !r.slug.includes('saison')) score -= 30;
        return { hit: r, score };
      })
      .sort((a, b) => b.score - a.score);

    for (const { hit } of scored.slice(0, MAX_SCORED_CANDIDATES)) {
      if (isAborted(signal) || isBudgetExhausted(startTime)) break;
      const html = await fetchPage(hit.url, signal);
      if (html.length <= 1000) continue;
      const episodes = extractEpisodes(html);
      if (episodes.length > 0) return { animeUrl: hit.url, episodes };
    }
  }
  return null;
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal)) return [];
  const startTime = Date.now();

  const titles = ctx.titles.filter((t) => Boolean(t));
  if (titles.length === 0) return [];

  const season = ctx.season ?? 1;

  let page = await findByDirectUrl(titles, season, ctx.signal, startTime);
  if (!page && !isAborted(ctx.signal) && !isBudgetExhausted(startTime)) {
    page = await findBySearch(titles, season, ctx.signal, startTime);
  }
  if (!page) return [];

  // Season pages restart their numbering at 1, but a page found without a season
  // marker may be the whole run in one list, so the absolute number is the
  // second key to try.
  const wanted: number[] = [];
  for (const candidate of [ctx.episode, ctx.absoluteEpisode]) {
    if (typeof candidate === 'number' && candidate > 0 && !wanted.includes(candidate)) {
      wanted.push(candidate);
    }
  }
  if (wanted.length === 0) return [];

  let targetEp: EpisodeLink | undefined;
  for (const num of wanted) {
    targetEp = page.episodes.find((e) => e.num === num);
    if (targetEp) break;
  }
  if (!targetEp) return [];

  const html = await fetchPage(targetEp.url, ctx.signal);
  if (html.length < 500) return [];

  const embedUrls = extractEmbedUrls(html);
  if (embedUrls.length === 0) return [];

  const language = inferLanguage(page.animeUrl, targetEp.title);
  const ordered = [...embedUrls].sort((a, b) => hostPriority(a) - hostPriority(b));

  return resolveEmbedsUntil(
    ordered.map((url) => ({ url, language, server: serverNameFor(url) })),
    {
      language,
      providerLabel: LABEL,
      siteUrl: SITE,
      signal: ctx.signal,
      target: 3,
    }
  );
}

export const fullanime = createNuvioProvider({
  name: 'fullanime',
  sites: [SITE],
  language: 'fr',
  extract,
  defaultAudioLanguage: 'ja',
});
