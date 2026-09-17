/**
 * VoirAnime — large French anime catalogue (voir-anime.to), VF and VOSTFR.
 *
 * Ported from temp/French/French/src/voiranime. A WordPress/Madara build where VF
 * and VOSTFR are two separate catalogue entries (`/anime/<slug>/` and
 * `/anime/<slug>-vf/`), so both are probed and both are emitted. Finding the entry
 * is the whole difficulty: the site's slugs drift from the canonical titles, so a
 * ladder of slug shapes is tried before falling back to the WordPress search.
 *
 * Each episode page hides its players behind `<option value="LECTEUR …">` entries;
 * re-requesting the page with `?host=<label>` renders the matching iframe. The
 * labels do not correspond to the real hosts (the one called "FHD1" is Mail.ru,
 * "myTV" is a VidMoly wrapper), so classification is done on the resolved embed
 * URL and never on the label.
 *
 * When its anti-bot kicks in the site still serves an episode page, but with a
 * YouTube or Facebook iframe in place of the player. Those are filtered out —
 * emitting them produced sources that never started.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  siteFetchText,
  loadHtml,
  toSlug,
  absoluteUrl,
  resolveEmbedsUntil,
  isAborted,
  isBudgetExhausted,
  FR_ACCEPT_LANGUAGE,
} from '../shared.js';

const SITE = 'https://voir-anime.to';
const LABEL = 'VoirAnime';

/** Sequential probing is cheap per URL but adds up; these caps keep it bounded. */
const MAX_PROBE_URLS = 8;
const PROBE_BUDGET_MS = 9_000;
const MAX_DIRECT_STREAMS = 4;
const MAX_SEARCH_TITLES = 8;

/**
 * Embeds that need a real browser to give up a media URL.
 *
 * These are attempted last rather than skipped: Toko's resolver library covers
 * voe, streamtape and dood, and `resolveEmbedsUntil` stops as soon as it has
 * enough streams, so the cheap hosts are still tried first.
 *
 * The trailing dot on `voe.` matters — `voe` alone also matches `voembed.net`,
 * which is a VidMoly wrapper that resolves cleanly to HLS.
 */
const SLOW_EMBEDS = ['voe.', 'streamhide.', 'gn1r5n.', 'parklogic', 'ds2play', 'dood.', 'bigwar5'];

/** Anti-bot filler served in place of a player. Never video. */
const PLACEHOLDER_IFRAMES = [
  'youtube.com/embed',
  'youtu.be/',
  'facebook.com/plugins',
  'twitter.com/i/videos',
  'ok.ru/videoembed',
];

/** Player labels known to be permanently dead — not worth a request. */
const DEAD_HOSTS = ['LECTEUR SB'];

const SPINOFF_KEYWORDS = [
  'fan letter',
  'log:',
  'memories',
  'vigilante',
  'illegals',
  'film',
  'movie',
  'special',
  'oav',
  'ona',
  'x ut',
  'collab',
];

interface Match {
  title: string;
  url: string;
}

/** Cached page bodies, so a probed slug is not fetched twice in one run. */
type PageCache = Map<string, string | null>;

/**
 * Double macron vowels: "Shippūden" → "Shippuuden".
 *
 * French anime sites usually spell Japanese long vowels as doubled letters while
 * the canonical titles use macrons, so the slug built from a title never matches.
 */
function expandMacrons(value: string): string {
  if (!value) return value;
  let out = '';
  for (const ch of value) {
    const decomposed = ch.normalize('NFD');
    if (
      decomposed.length > 1 &&
      decomposed.includes('̄') &&
      'aeiouAEIOU'.includes(decomposed[0])
    ) {
      out += decomposed[0] + decomposed[0];
    } else {
      out += ch;
    }
  }
  return out;
}

function isSpinoff(title: string): boolean {
  const lower = title.toLowerCase();
  return SPINOFF_KEYWORDS.some((k) => lower.includes(k));
}

function normalizeForSearch(value: string): string {
  return (value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[':!.,?()[\]]/g, ' ')
    .replace(/\b(the|vostfr|vost|vf|french|streaming|anime)\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Title similarity, plus a season bonus read off the URL and a spin-off penalty. */
function scoreSearchResult(
  resultTitle: string,
  resultUrl: string,
  searchTitle: string,
  searchSeason: number
): number {
  const nr = normalizeForSearch(resultTitle);
  const ns = normalizeForSearch(searchTitle);
  if (!nr || !ns) return 0;

  let score = 0;

  if (nr === ns) score = 100;
  else if (nr.includes(ns) || ns.includes(nr)) score = 80;
  else {
    const rWords = new Set(nr.split(/\s+/).filter((w) => w.length > 2));
    const sWords = new Set(ns.split(/\s+/).filter((w) => w.length > 2));
    if (rWords.size > 0 && sWords.size > 0) {
      let overlap = 0;
      for (const w of sWords) {
        if (rWords.has(w)) overlap++;
      }
      const maxLen = Math.max(rWords.size, sWords.size);
      score = Math.round((overlap / maxLen) * 50);
    }
  }

  if (isSpinoff(resultTitle) || isSpinoff(resultUrl)) score -= 50;
  if (resultTitle.toLowerCase().includes('x ut')) score -= 30;

  const seasonMatch = resultUrl.match(/[-](\d+)(?:-vf|-vostfr)?\/?$/);
  const saisonMatch = resultUrl.match(/saison[_-](\d+)/i);
  const urlSeason = seasonMatch
    ? Number.parseInt(seasonMatch[1], 10)
    : saisonMatch
      ? Number.parseInt(saisonMatch[1], 10)
      : null;

  if (urlSeason !== null) {
    // A slug that names the wrong season is worse than one that names none.
    if (urlSeason === searchSeason) score += 20;
    else score -= 40;
  } else if (searchSeason === 1) {
    score += 10;
  }

  return Math.max(score, 0);
}

/** Season stated by an episode link, used to reject links from other seasons. */
function extractSeasonFromEpisodeLink(text: string, url: string): number | null {
  const combined = `${text || ''} ${url || ''}`;
  const match =
    combined.match(/S(?:aison|eason)\s*[:\\(\\s-]*\s*(\d+)/i) ||
    combined.match(/saison[_-](\d+)/i) ||
    combined.match(/S(\d+)\s*(?:E|V|VF|VOSTFR|\b)/i);
  if (match) return Number.parseInt(match[1], 10);
  return null;
}

function generateFallbackSlugs(baseSlug: string, season: number): string[] {
  return [`${baseSlug}-${season}`, `${baseSlug}-${season}-vf`, `${baseSlug}-saison-${season}`];
}

/** Drop a trailing season/part marker so the base entry can be probed. */
function cleanSlug(slug: string): string {
  return slug
    .replace(/-(?:1st|2nd|3rd|4th|5th)-season$/, '')
    .replace(/-(?:season|saison)-?\d+$/, '')
    .replace(/-s\d+$/, '')
    .replace(/-(?:part|cour|arc|volume)-?\d+$/, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Reject a page the site redirected away from.
 *
 * A missing entry sometimes 302s to a related one (`/anime/X/` →
 * `/anime/X-some-arc/`) which would otherwise read as a successful probe. The
 * final URL is not observable through the fetch helpers, so the page's own
 * canonical link is compared against the path that was requested instead.
 */
function isRedirectedPage(html: string, url: string): boolean {
  const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
  if (!canonical) return false;
  const pathOf = (value: string) =>
    value
      .replace(/^https?:\/\/[^/]+/, '')
      .replace(/\/+$/, '')
      .toLowerCase();
  return pathOf(canonical[1]) !== pathOf(url);
}

/**
 * Fetch a catalogue page, or null when the slug does not exist.
 *
 * Doubles as the slug probe: the body is kept so a successful guess costs one
 * request rather than a probe plus a fetch. Only the first request of a run is
 * allowed to escalate through the challenge solver — after that the session is
 * cached, and slug guesses 404 far more often than they succeed.
 */
async function fetchPage(url: string, ctx: NuvioContext, cache: PageCache): Promise<string | null> {
  const cached = cache.get(url);
  if (cached !== undefined) return cached;

  const html = await siteFetchText(url, {
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    timeoutMs: 8_000,
    signal: ctx.signal,
    noBypass: cache.size > 0,
  });

  const usable = html && html.length > 500 && !isRedirectedPage(html, url) ? html : null;
  cache.set(url, usable);
  return usable;
}

/** Probe URLs in order, stopping at the first that exists. */
async function probeFirst(
  urls: string[],
  ctx: NuvioContext,
  cache: PageCache,
  probeStart: number
): Promise<string | null> {
  for (const url of urls.slice(0, MAX_PROBE_URLS)) {
    if (isAborted(ctx.signal) || isBudgetExhausted(probeStart, PROBE_BUDGET_MS)) return null;
    if (await fetchPage(url, ctx, cache)) return url;
  }
  return null;
}

async function wordpressSearch(
  query: string,
  season: number,
  ctx: NuvioContext
): Promise<Match[]> {
  const html = await siteFetchText(`${SITE}/?s=${encodeURIComponent(query)}`, {
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    timeoutMs: 10_000,
    signal: ctx.signal,
  });
  if (!html) return [];

  const $ = loadHtml(html);
  const results: Array<Match & { score: number }> = [];

  const selector =
    'article a[href*="/anime/"], .post-title a[href*="/anime/"], .entry-title a[href*="/anime/"], .result-item a[href*="/anime/"]';
  for (const el of $(selector).toArray()) {
    const href = $(el).attr('href') || '';
    const title = $(el).text().trim();
    if (!title || !href) continue;
    if (results.some((r) => r.url === href)) continue;
    results.push({ title, url: href, score: scoreSearchResult(title, href, query, season) });
  }

  // Themes vary; when none of the known result containers matched, take every
  // catalogue link on the page and let the score sort it out.
  if (results.length === 0) {
    const animeRegex = /<a[^>]+href="([^"]*\/anime\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = animeRegex.exec(html)) !== null) {
      const href = absoluteUrl(m[1], SITE);
      const title = m[2].trim();
      if (!title || results.some((r) => r.url === href)) continue;
      results.push({ title, url: href, score: scoreSearchResult(title, href, query, season) });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results
    .filter((r) => r.score >= 30)
    .slice(0, 4)
    .map((r) => ({ title: r.title, url: r.url }));
}

/**
 * Locate one title's catalogue entries: season slugs, then the plain slug, then
 * the site's search.
 */
async function searchAnime(
  title: string,
  season: number,
  ctx: NuvioContext,
  cache: PageCache,
  probeStart: number
): Promise<Match[]> {
  const baseSlug = toSlug(title);
  const results: Match[] = [];

  if (season > 1 && baseSlug.length > 3) {
    const slugSets = [generateFallbackSlugs(baseSlug, season)];
    const cleaned = cleanSlug(baseSlug);
    if (cleaned !== baseSlug && cleaned.length > 3) {
      slugSets.push(generateFallbackSlugs(cleaned, season));
    }
    for (const slugs of slugSets) {
      const found = await probeFirst(
        slugs.map((s) => `${SITE}/anime/${s}/`),
        ctx,
        cache,
        probeStart
      );
      if (found) {
        const lang = found.includes('-vf') ? 'VF' : 'VOSTFR';
        return [{ title: `${title} S${season} ${lang}`, url: found }];
      }
    }
  }

  if (baseSlug.length > 3 && !isBudgetExhausted(probeStart, PROBE_BUDGET_MS)) {
    const exactUrl = `${SITE}/anime/${baseSlug}/`;
    const exactVfUrl = `${SITE}/anime/${baseSlug}-vf/`;
    if (await fetchPage(exactUrl, ctx, cache)) results.push({ title, url: exactUrl });
    if (!isAborted(ctx.signal) && (await fetchPage(exactVfUrl, ctx, cache))) {
      results.push({ title: `${title} VF`, url: exactVfUrl });
    }
    if (results.length > 0) return results;
  }

  // Some entries are catalogued under a shortened or recombined slug. The first
  // two variants drop generic leading words; the last covers Japanese compounds
  // the site writes as one word ("san shimai" → "sanshimai").
  if (!isAborted(ctx.signal) && !isBudgetExhausted(probeStart, PROBE_BUDGET_MS)) {
    const words = title.split(/\s+/).filter((w) => w.length > 2);
    const altSlugs: string[] = [];

    const skipPrefixes = [
      'dealing',
      'with',
      'the',
      'my',
      'that',
      'this',
      'dans',
      'and',
      'of',
      'a',
      'an',
    ];
    const filtered = words.filter((w) => !skipPrefixes.includes(w.toLowerCase()));
    if (filtered.length >= 2 && filtered.length < words.length) altSlugs.push(filtered.join('-'));

    const longWords = words.filter((w) => w.length >= 4);
    if (longWords.length >= 2) {
      altSlugs.push(longWords.slice(0, 3).join('-'));
      altSlugs.push(longWords.slice(-2).join('-'));
    }

    const compactWords = title
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[':!.,?()[\]]/g, '')
      .replace(/[^a-z0-9\s]/g, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    if (compactWords.length >= 3) {
      const shortPos: number[] = [];
      for (let i = 0; i < compactWords.length - 1; i++) {
        if (compactWords[i].length <= 3) shortPos.push(i);
      }

      if (shortPos.length > 0) {
        const compactVariants: string[] = [];
        for (const pos of shortPos) {
          const parts = [...compactWords];
          parts[pos] = parts[pos] + parts[pos + 1];
          parts.splice(pos + 1, 1);
          compactVariants.push(parts.join('-'));
        }
        if (shortPos.length > 1) {
          const parts = [...compactWords];
          let offset = 0;
          for (const pos of shortPos) {
            const actualPos = pos - offset;
            parts[actualPos] = parts[actualPos] + parts[actualPos + 1];
            parts.splice(actualPos + 1, 1);
            offset++;
          }
          compactVariants.push(parts.join('-'));
        }
        const uniqueCompact = [...new Set(compactVariants)].filter(
          (v) => v !== baseSlug && v.length > 5
        );
        for (const v of uniqueCompact.slice(0, 2)) {
          altSlugs.push(v);
          altSlugs.push(`${v}-vf`);
        }
      }
    }

    const uniqueAltSlugs = [...new Set(altSlugs.filter((s) => s && s.length > 3))];
    if (uniqueAltSlugs.length > 0) {
      const found = await probeFirst(
        uniqueAltSlugs.map((s) => `${SITE}/anime/${s}/`),
        ctx,
        cache,
        probeStart
      );
      if (found) {
        return [{ title: `${title} [alt]`, url: found }];
      }
    }
  }

  if (isAborted(ctx.signal) || isBudgetExhausted(probeStart, PROBE_BUDGET_MS)) return [];

  const searchResults = await wordpressSearch(title, season, ctx);
  if (searchResults.length > 0) return searchResults;

  // The WordPress engine often does better on two distinctive words than on a
  // full title.
  if (isAborted(ctx.signal) || isBudgetExhausted(probeStart, PROBE_BUDGET_MS)) return [];
  const longWords = title.split(/\s+/).filter((w) => w.length > 2);
  const keywordQueries = [
    longWords.slice(-2).join(' '),
    longWords.slice(0, 2).join(' '),
    longWords.filter((w) => w.length >= 4).slice(0, 2).join(' '),
  ];
  const seenQueries = new Set<string>();
  for (const query of keywordQueries) {
    if (!query || seenQueries.has(query.toLowerCase())) continue;
    seenQueries.add(query.toLowerCase());
    if (isAborted(ctx.signal) || isBudgetExhausted(probeStart, PROBE_BUDGET_MS)) break;
    for (const result of await wordpressSearch(query, season, ctx)) {
      if (!results.some((r) => r.url === result.url)) results.push(result);
    }
    if (results.length > 0) break;
  }

  return results;
}

/** Player labels offered by an episode page. */
function extractHosts(html: string): string[] {
  const urls: string[] = [];
  const regex = /<option[^>]*value="([^"]+)"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    const val = m[1];
    // Other options hold episode slugs for navigation, not players.
    if (val && val.startsWith('LECTEUR ')) urls.push(val);
  }
  return [...new Set(urls)];
}

/** The embed URL one player label renders. */
async function fetchHostEmbed(
  host: string,
  episodeUrl: string,
  ctx: NuvioContext
): Promise<string | null> {
  const hostUrl = `${episodeUrl}${episodeUrl.includes('?') ? '&' : '?'}host=${encodeURIComponent(host)}`;
  const hostHtml = await siteFetchText(hostUrl, {
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    timeoutMs: 8_000,
    signal: ctx.signal,
  });
  if (!hostHtml) return null;

  const iframeMatch = hostHtml.match(/<iframe[^>]+src=["'](https?:\/\/[^"']+)["']/i);
  if (iframeMatch) return iframeMatch[1];

  const scriptMatch = hostHtml.match(
    /https?:\/\/[^"'\s<>]+\/(?:embed|e|v|player)\/[^"'\s<>]+/
  );
  if (scriptMatch && !scriptMatch[0].includes('voiranime.com')) return scriptMatch[0];
  return null;
}

function isPlaceholder(url: string): boolean {
  const lower = (url || '').toLowerCase();
  return PLACEHOLDER_IFRAMES.some((p) => lower.includes(p));
}

function isSlow(url: string): boolean {
  const lower = (url || '').toLowerCase();
  return SLOW_EMBEDS.some((p) => lower.includes(p));
}

/**
 * Build an episode URL from the shape of the first episode link on the page.
 *
 * Used when no link matches the wanted number, which happens on entries whose
 * list is paginated or lazy-loaded. Both zero-padded and bare numbering are
 * tried because the site is inconsistent between entries.
 */
async function generateEpisodeUrl(
  html: string,
  targetEp: number,
  ctx: NuvioContext,
  cache: PageCache,
  probeStart: number
): Promise<string | null> {
  const $ = loadHtml(html);
  const firstLink = $('.wp-manga-chapter a').first();
  if (firstLink.length === 0) return null;

  const href = firstLink.attr('href') || '';
  const match = href.match(/\/anime\/([^/]+)\/(.+?-)(\d+)(-v(?:ostfr|f))?\//);
  if (!match) return null;

  const slugName = match[1];
  const prefix = match[2];
  const suffix = match[4] || '';

  for (const pad of ['0', '']) {
    if (isAborted(ctx.signal) || isBudgetExhausted(probeStart, PROBE_BUDGET_MS)) return null;
    const url = `${SITE}/anime/${slugName}/${prefix}${pad}${targetEp}${suffix}/`;
    if (await fetchPage(url, ctx, cache)) return url;
  }
  return null;
}

/**
 * Find the episode link on a catalogue page.
 *
 * Three passes: match the episode number in the link text (rejecting links that
 * name a different season), then match the number inside the href, then fall
 * back to positional indexing into the chapter list.
 */
function findEpisodeUrl(html: string, episodes: number[], season: number | undefined): string | null {
  const $ = loadHtml(html);

  const epPatterns: string[] = [];
  for (const ep of episodes) {
    for (const pad of ['0', '']) epPatterns.push(pad + String(ep));
  }

  const isExtra = (href: string) =>
    href.includes('/special') ||
    href.includes('/oav') ||
    href.includes('/film') ||
    href.includes('/ova');

  const epSelectors = [
    '.listing-chapters a',
    '.list-chapter a',
    '.wp-manga-chapter a',
    '.episodes a',
    'ul.episodes li a',
    '.episode-list a',
    'ul.main.version-chap.no-volumn li.wp-manga-chapter a',
    'a[href*="/episode/"]',
    'a[href*="/ep/"]',
  ];

  for (const sel of epSelectors) {
    for (const el of $(sel).toArray()) {
      const text = $(el).text().trim();
      const href = $(el).attr('href') || '';
      if (isExtra(href)) continue;

      const linkSeason = extractSeasonFromEpisodeLink(text, href);
      if (linkSeason !== null && season !== undefined && linkSeason !== season) continue;

      // The season marker is stripped so "Saison 2" cannot be read as episode 2.
      const cleanText = text.replace(/S(?:aison|eason)\s*\d+/gi, '').trim();
      for (const pattern of epPatterns) {
        if (new RegExp(`(?:^|[^0-9])${pattern}(?:$|[^0-9])`, 'i').test(cleanText)) {
          return href;
        }
      }
    }
  }

  const chapterLinks: Array<{ href: string; text: string }> = [];
  for (const el of $(
    '.wp-manga-chapter a, ul.main.version-chap.no-volumn li.wp-manga-chapter a'
  ).toArray()) {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    if (!href || isExtra(href)) continue;
    const linkSeason = extractSeasonFromEpisodeLink(text, href);
    if (linkSeason === null || season === undefined || linkSeason === season) {
      chapterLinks.push({ href, text });
    }
  }

  for (const ep of episodes) {
    for (const link of chapterLinks) {
      const epFromHref = link.href.match(/[-/]0*(\d+)(?:-v(?:ostfr|f))?(?:\/|$)/i);
      if (epFromHref && Number.parseInt(epFromHref[1], 10) === ep) return link.href;
    }
  }

  if (chapterLinks.length > 0) {
    for (const ep of episodes) {
      const idx = ep - 1;
      if (idx >= 0 && idx < chapterLinks.length) return chapterLinks[idx].href;
    }
  }

  return null;
}

/**
 * Collect every player on an episode page and resolve them, cheap hosts first.
 *
 * Unresolvable embeds are dropped rather than emitted as sources — a source that
 * appears in the list and then fails to start is worse than one fewer entry.
 */
async function resolveEpisodeStreams(
  episodeUrl: string,
  language: string,
  ctx: NuvioContext,
  startTime: number
): Promise<NuvioStream[]> {
  const epHtml = await siteFetchText(episodeUrl, {
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    timeoutMs: 10_000,
    signal: ctx.signal,
  });
  if (!epHtml) return [];

  const hosts = extractHosts(epHtml).filter((h) => !DEAD_HOSTS.includes(h));
  const embedUrls: string[] = [];

  if (hosts.length === 0) {
    // No player options at all: either the anti-bot degraded the page or the
    // episode is not out yet. The page's own iframe is the only chance left.
    const $ = loadHtml(epHtml);
    for (const el of $('iframe').toArray()) {
      const src = $(el).attr('src') || '';
      if (src.startsWith('http') && !src.includes('voiranime.com') && !isPlaceholder(src)) {
        embedUrls.push(src);
        break;
      }
    }
  } else {
    for (const host of hosts) {
      if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
      const embed = await fetchHostEmbed(host, episodeUrl, ctx);
      if (embed && !embedUrls.includes(embed)) embedUrls.push(embed);
    }

    if (embedUrls.length === 0) {
      const $ = loadHtml(epHtml);
      const defaultIframe = $(
        'iframe[src*="vidmoly"], iframe[src*="voembed"], iframe[src*="mail.ru"]'
      )
        .first()
        .attr('src');
      if (defaultIframe && !isPlaceholder(defaultIframe)) embedUrls.push(defaultIframe);
    }
  }

  const candidates = embedUrls.filter((url) => !isPlaceholder(url));
  if (candidates.length === 0) return [];

  const ordered = [...candidates.filter((u) => !isSlow(u)), ...candidates.filter(isSlow)];

  return resolveEmbedsUntil(
    ordered.map((url) => ({ url })),
    {
      language,
      providerLabel: LABEL,
      siteUrl: SITE,
      target: MAX_DIRECT_STREAMS,
      signal: ctx.signal,
      budgetMs: 10_000,
    }
  );
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];

  const startTime = Date.now();
  const season = ctx.season ?? 1;
  const cache: PageCache = new Map();

  // The site numbers long-running series absolutely, so the absolute number is
  // the more likely match and is tried first; the per-season number is kept as a
  // fallback for entries that are split by season.
  const episodes = [ctx.absoluteEpisode, ctx.episode].filter(
    (value, index, all): value is number =>
      typeof value === 'number' && value > 0 && all.indexOf(value) === index
  );
  if (ctx.type === 'tv' && episodes.length === 0) return [];

  const searchTitles = ctx.titles.slice(0, MAX_SEARCH_TITLES);
  // Titles carrying an explicit season are tried last: the plain title usually
  // matches the catalogue slug, and a "Season 2" suffix rarely appears in it.
  const orderedTitles = [
    ...searchTitles.filter((t) => !/\bS(?:eason|aison)?\s*\d/i.test(t)),
    ...searchTitles.filter((t) => /\bS(?:eason|aison)?\s*\d/i.test(t)),
  ];

  const matches: Match[] = [];

  // Pass one: probe every title's plain slug, plus a macron-expanded variant,
  // for both language entries. This avoids the search entirely in the common case.
  const uniqueSlugs: string[] = [];
  for (const title of orderedTitles) {
    for (const slug of [toSlug(title), toSlug(expandMacrons(title))]) {
      if (slug && slug.length > 3 && !uniqueSlugs.includes(slug)) uniqueSlugs.push(slug);
    }
  }

  const probeUrls: string[] = [];
  for (const slug of uniqueSlugs) {
    probeUrls.push(`${SITE}/anime/${slug}/`, `${SITE}/anime/${slug}-vf/`);
  }

  for (const url of probeUrls.slice(0, MAX_PROBE_URLS)) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime, PROBE_BUDGET_MS)) break;
    if (!(await fetchPage(url, ctx, cache))) continue;
    const urlSlug = url.match(/\/anime\/([^/]+)\/$/)?.[1]?.replace(/-vf$/, '');
    const matchingTitle = orderedTitles.find((t) => toSlug(t) === urlSlug);
    const isVf = url.includes('-vf');
    const baseName = matchingTitle || `[slug:${urlSlug ?? ''}]`;
    matches.push({ title: isVf ? `${baseName} VF` : baseName, url });
  }

  if (matches.length === 0) {
    for (const title of orderedTitles) {
      if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
      const found = await searchAnime(title, season, ctx, cache, startTime);
      if (found.length > 0) {
        matches.push(...found);
        break;
      }
    }
  }

  if (matches.length === 0) return [];

  const streams: NuvioStream[] = [];
  const checkedUrls = new Set<string>();

  for (const match of matches) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    if (checkedUrls.has(match.url)) continue;
    checkedUrls.add(match.url);

    const language =
      match.title.toUpperCase().includes('VF') || match.url.includes('-vf') ? 'VF' : 'VOSTFR';

    const html = await fetchPage(match.url, ctx, cache);
    if (!html) continue;

    let episodeUrl = findEpisodeUrl(html, episodes, ctx.type === 'tv' ? season : undefined);

    if (!episodeUrl) {
      for (const ep of episodes) {
        if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
        const generated = await generateEpisodeUrl(html, ep, ctx, cache, startTime);
        if (generated) {
          episodeUrl = generated;
          break;
        }
      }
    }

    // Films carry the player on the catalogue page itself.
    if (!episodeUrl && ctx.type === 'movie') episodeUrl = match.url;
    if (!episodeUrl) continue;

    streams.push(...(await resolveEpisodeStreams(episodeUrl, language, ctx, startTime)));
  }

  return streams;
}

export const voiranime = createNuvioProvider({
  name: 'voiranime',
  sites: [SITE],
  language: 'fr',
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'ja',
});
