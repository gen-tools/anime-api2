/**
 * AnimoFlix — French anime catalogue carrying VF and VOSTFR on the same series.
 *
 * Ported from temp/French/French/src/animoflix. Two site traits shape this port.
 * It rate-limits hard: requests closer together than about a second earn a 429
 * and then a multi-minute block, so every call is paced at 1.2s and candidates
 * are verified one at a time rather than in parallel. And its episode pages have
 * cycled through several player implementations without the old ones ever being
 * rewritten, so the embed hunt walks ten markup shapes in order of reliability —
 * from the current `#epLecteurSelect` dropdown down to scanning inline scripts
 * for a bare .m3u8 — each running only when the previous found nothing.
 *
 * Seasons are published as parts (`saison-4-partie-1`, `-2`, …) whose episode
 * numbering restarts at 1, so every part matching the target season is tried
 * while a running offset lets an absolute episode number land in the right one.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  siteFetchText,
  siteFetchJson,
  loadHtml,
  toSlug,
  deaccent,
  absoluteUrl,
  decodeBase64,
  resolveEmbedsUntil,
  isAborted,
  isBudgetExhausted,
  PROVIDER_BUDGET_MS,
  FR_ACCEPT_LANGUAGE,
  type TokoCheerio,
} from '../shared.js';

const SITE = 'https://animoflix.to';
const LABEL = 'AnimoFlix';
const SEARCH_URL = `${SITE}/search-autocomplete.php`;

/** The site answers 429 below roughly a second between requests. */
const MIN_INTERVAL_MS = 1_200;

const MAX_TITLE_SEARCHES = 3;
const MAX_TITLE_SEARCHES_MOVIE = 2;

/** Slugs for side content that would otherwise outrank the main entry. */
const SPECIAL_SLUG_RE =
  /(?:ona|oav|film|movie|special|scan|chapitre|volume|dub|uncut)(?:-|$)/i;

const LANGS = ['vostfr', 'vf'] as const;

const EPISODE_NUM = /episode-(\d+)\/?$/;

const SEARCH_SELECTORS = [
  '.post-title a[href*="/anime/"]',
  '.TPost a[href*="/anime/"]',
  'a[href*="/anime/"]',
  '.result-item a',
  '.search-item a',
  '.card a[href*="/anime/"]',
  'article a[href*="/anime/"]',
];

/** Card wrappers whose poster `alt` holds a cleaner title than the link text. */
const ALT_SCOPE = '.TPost, .TPostMv, article, li, .card, .result-item, .search-item';

interface SearchHit {
  title: string;
  title2: string;
  slug: string;
  url: string;
}

interface RankedHit extends SearchHit {
  score: number;
}

interface SeasonCard {
  href: string;
  title: string;
  seasonNum: number | null;
}

interface EpisodeLink {
  num: number;
  /** `num` offset by the episode counts of the earlier parts of this season. */
  cumulative: number;
  href: string;
}

function fetchPage(
  url: string,
  ctx: NuvioContext,
  timeoutMs = 12_000,
  noBypass = false
): Promise<string | null> {
  return siteFetchText(url, {
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    timeoutMs,
    signal: ctx.signal,
    minIntervalMs: MIN_INTERVAL_MS,
    noBypass,
  });
}

/**
 * The site's own comparison form, which differs from the shared `normalize`.
 *
 * Hyphens become spaces so a slug compares against a title, and the leading
 * noise words this catalogue prefixes entries with are dropped — matching the
 * site's own indexing, which is what the scores below are calibrated against.
 */
function afNormalize(value: string): string {
  return deaccent(String(value || '').toLowerCase())
    .replace(/-/g, ' ')
    .replace(/[':!.,?()[\]]/g, '')
    .replace(/\b(the|vostfr|vost|vf|french|streaming|anime)\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Score a search hit, weighted by which field matched.
 *
 * The title is authoritative, the alternate title close behind, and the slug
 * weakest because franchise pages share a slug prefix with every entry under
 * them — "one-piece" matches a query for any One Piece arc. The two penalties
 * exist for that case: a slug shorter than the query, or a result title shorter
 * than it, both indicate a catch-all page rather than the specific season.
 */
function scoreSearchMatch(result: SearchHit, searchTitle: string): number {
  const nt = afNormalize(searchTitle);
  const nTitle = afNormalize(result.title);
  const nTitle2 = afNormalize(result.title2 || '');
  const nSlug = afNormalize(result.slug.replace(/-/g, ' '));
  if (!nt) return 0;

  let fieldScore = 0;
  // Each guard requires a non-empty field: `nt.includes('')` is true, so an entry
  // with no alternate title would otherwise score as a strong match on nothing.
  if (nTitle && (nTitle.includes(nt) || nt.includes(nTitle))) fieldScore = 100;
  if (nTitle2 && (nTitle2.includes(nt) || nt.includes(nTitle2))) {
    fieldScore = Math.max(fieldScore, 80);
  }
  if (nSlug && (nSlug.includes(nt) || nt.includes(nSlug))) {
    fieldScore = Math.max(fieldScore, 60);
  }

  const slugWords = nSlug.split(/\s+/).filter(Boolean);
  const titleWords = nt.split(/\s+/).filter(Boolean);
  if (fieldScore <= 60 && slugWords.length > 0 && titleWords.length > slugWords.length + 1) {
    const missing = titleWords.filter((w) => !nSlug.includes(w)).length;
    if (missing > titleWords.length / 2) fieldScore = Math.max(fieldScore - 40, 0);
  }

  const nTitleWords = nTitle.split(/\s+/).filter(Boolean);
  if (fieldScore > 0 && titleWords.length > 3 && nTitleWords.length < titleWords.length - 1) {
    fieldScore = Math.max(fieldScore - 30, 10);
  }

  let score = fieldScore;

  const matchWords = new Set([
    ...nTitle.split(/\s+/),
    ...nTitle2.split(/\s+/),
    ...nSlug.split(/\s+/),
  ]);
  const matched = titleWords.filter((w) => matchWords.has(w)).length;
  if (titleWords.length > 0) score += (matched / titleWords.length) * 50;

  const extraWords = nTitleWords.length - titleWords.length;
  if (extraWords > 0) score -= Math.min(extraWords * 40, 80);
  if (titleWords.length > nTitleWords.length + 2) {
    score -= Math.min((titleWords.length - nTitleWords.length) * 40, 80);
  }

  return score;
}

function parseAutocomplete(json: unknown): SearchHit[] {
  if (!Array.isArray(json)) return [];
  const out: SearchHit[] = [];

  for (const entry of json) {
    const row = entry as Record<string, unknown>;
    const slug = String(row?.slug || '').trim().replace(/^\/+|\/+$/g, '');
    if (!slug || slug.includes('/')) continue;
    const title = String(row?.title || '').trim() || slug.replace(/-/g, ' ');
    out.push({
      title,
      title2: String(row?.title2 || '').trim() || title,
      slug,
      url: absoluteUrl(String(row?.url || `/anime/${slug}/`), SITE),
    });
  }

  return out;
}

function parseSearchHtml(html: string): SearchHit[] {
  const $ = loadHtml(html);
  const results: SearchHit[] = [];

  for (const selector of SEARCH_SELECTORS) {
    for (const el of $(selector).toArray()) {
      if (results.length >= 15) break;
      const $el = $(el);
      const href = $el.attr('href') || '';
      const text = $el.text().trim().replace(/\s+/g, ' ').trim();
      if (!href.includes('/anime/') || text.length <= 2) continue;

      const slug = href.replace(/.*\/anime\//, '').replace(/\/$/, '');
      if (!slug || slug.includes('/') || results.some((r) => r.slug === slug)) continue;

      // The link text usually carries episode counts and language badges next to
      // the title; the card's poster `alt` is just the title.
      const imgAlt = $el.closest(ALT_SCOPE).find('img').first().attr('alt');
      const title = String(imgAlt || text).replace(/\s+/g, ' ').trim();
      results.push({ title, title2: title, slug, url: absoluteUrl(href, SITE) });
    }
    if (results.length > 0) break;
  }

  return results;
}

/**
 * Find a series three ways, cheapest first.
 *
 * The autocomplete endpoint is the real search and answers most queries, but it
 * misses titles containing punctuation ("Your Name."), for which the slug is
 * usually still the obvious one — hence the direct probe. The HTML search page is
 * the last resort because it costs a full page load under the site's pacing.
 */
async function searchAnime(title: string, ctx: NuvioContext): Promise<SearchHit[]> {
  const json = await siteFetchJson<unknown>(
    `${SEARCH_URL}?q=${encodeURIComponent(title)}`,
    {
      acceptLanguage: FR_ACCEPT_LANGUAGE,
      timeoutMs: 12_000,
      signal: ctx.signal,
      minIntervalMs: MIN_INTERVAL_MS,
      headers: { Referer: `${SITE}/` },
    }
  );
  const fromApi = parseAutocomplete(json);
  if (fromApi.length > 0) return fromApi;

  const slug = toSlug(title);
  if (slug.length > 3) {
    const url = `${SITE}/anime/${slug}/`;
    // A guess, so skip the challenge solve: a 404 here is the expected answer.
    const html = await fetchPage(url, ctx, 8_000, true);
    if (html && html.length > 1000) {
      return [{ title: slug.replace(/-/g, ' '), title2: title, slug, url }];
    }
  }

  const html = await fetchPage(`${SITE}/?s=${encodeURIComponent(title)}`, ctx);
  return html ? parseSearchHtml(html) : [];
}

/**
 * Season number out of a season slug.
 *
 * The site labels cours inconsistently — `saison-2`, `season-2`, `cour-2`,
 * `partie-2`, `part-2` all appear — and "final season" carries no number at all,
 * so it is given 99 to sort last without matching any real season.
 */
function parseSeasonNumber(seasonSlug: string): number | null {
  const m = seasonSlug.match(/saison[-\s]*(\d+)/i);
  if (m) return parseInt(m[1]);
  const sm = seasonSlug.match(/season[-\s]*(\d+)/i);
  if (sm) return parseInt(sm[1]);
  const cm = seasonSlug.match(/cour[-\s]*(\d+)/i);
  if (cm) return parseInt(cm[1]);
  if (/final-season|the-final-season/i.test(seasonSlug)) return 99;
  if (/partie-\d+/i.test(seasonSlug)) {
    const pm = seasonSlug.match(/partie-(\d+)/i);
    if (pm) return parseInt(pm[1]);
  }
  const ptm = seasonSlug.match(/part[-\s]*(\d+)/i);
  if (ptm) return parseInt(ptm[1]);
  return null;
}

function parseSeasons(
  html: string,
  slug: string
): { seasons: SeasonCard[]; filmHref: string | null } {
  const $ = loadHtml(html);
  const seasons: SeasonCard[] = [];
  let filmHref: string | null = null;

  for (const el of $('.season-card').toArray()) {
    const href = $(el).attr('href');
    const title = $(el).find('.season-card-title').text().trim();
    if (!href || !title) continue;
    if (/film|movie/i.test(title)) {
      filmHref = href;
      continue;
    }
    if (/oav|ona/i.test(title)) continue;
    seasons.push({ href, title, seasonNum: parseSeasonNumber(href) });
  }

  // Older entries predate the season cards and list their cours as plain links.
  if (seasons.length === 0 && filmHref === null) {
    for (const el of $('a[href*="saison-"]').toArray()) {
      const href = $(el).attr('href');
      const title = $(el).text().trim();
      if (!href || !title || !href.includes(`/anime/${slug}/`)) continue;
      const seasonNum = parseSeasonNumber(href);
      if (seasonNum) seasons.push({ href, title, seasonNum });
    }
    for (const el of $('a[href*="/film/"], a[href*="/movie/"]').toArray()) {
      const href = $(el).attr('href');
      if (href && href.includes(`/anime/${slug}/`)) {
        filmHref = href;
        break;
      }
    }
  }

  return { seasons, filmHref };
}

/**
 * Episode links for one language on a season page.
 *
 * The anchors carry no class of their own, so the `/{lang}/episode-` segment in
 * the href is the only thing separating a VF listing from a VOSTFR one.
 */
function parseEpisodeLinks($: TokoCheerio, lang: string, offset: number): EpisodeLink[] {
  const out: EpisodeLink[] = [];

  for (const el of $(`a[href*="/${lang}/episode-"]`).toArray()) {
    const href = $(el).attr('href');
    if (!href) continue;
    const match = href.match(EPISODE_NUM);
    if (!match) continue;
    const num = parseInt(match[1]);
    if (!Number.isFinite(num)) continue;
    out.push({ num, cumulative: num + offset, href: absoluteUrl(href, SITE) });
  }

  return out;
}

function optionValues($: TokoCheerio, selector: string): string[] {
  const out: string[] = [];
  for (const el of $(selector).toArray()) {
    // `attr('value')` rather than `val()`: identical for <option> and available
    // on every cheerio build this runs against.
    const value = ($(el).attr('value') || '').trim();
    if (value.startsWith('http')) out.push(value);
  }
  return out;
}

const IFRAME_SELECTORS = [
  '#videoPlayer',
  '.video-wrapper iframe',
  '.player-wrapper iframe',
  '.embed-wrapper iframe',
  'iframe[src*="sibnet"]',
  'iframe[src*="sendvid"]',
  'iframe[src*="dood"]',
  'iframe[src*="voe"]',
  'iframe[src*="uqload"]',
  'iframe[src*="vidmoly"]',
];

/**
 * Every player URL on an episode page.
 *
 * The strategies are ordered by how current the markup they read is, and each
 * runs only when the previous found nothing, so a page from this year costs one
 * selector while a 2023 page falls through to whatever it does expose.
 */
function collectEmbeds(html: string): string[] {
  const $ = loadHtml(html);
  const found: string[] = [];

  const push = (value: string | undefined | null): void => {
    const url = String(value || '').trim();
    if (url.startsWith('http') && !found.includes(url)) found.push(url);
  };

  for (const url of optionValues($, '#epLecteurSelect option')) push(url);

  if (found.length === 0) {
    const legacy = '#lecteurSelect option, select.video-source option, select.player-select option';
    for (const url of optionValues($, legacy)) push(url);
  }

  if (found.length === 0) {
    const single =
      html.match(/"embedUrl"\s*:\s*"(https?:\/\/[^"]+)"/) ||
      html.match(/'embedUrl'\s*:\s*'(https?:\/\/[^']+)'/) ||
      html.match(/embedUrl\s*:\s*["'](https?:\/\/[^"']+)["']/);
    if (single) push(single[1]);
    const all = html.match(/"embedUrl"\s*:\s*"(https?:\/\/[^"]+)"/g);
    for (const entry of all && all.length > 1 ? all : []) {
      const url = entry.match(/"embedUrl"\s*:\s*"([^"]+)"/);
      if (url) push(url[1]);
    }
  }

  if (found.length === 0) {
    for (const selector of IFRAME_SELECTORS) {
      for (const el of $(selector).toArray()) push($(el).attr('src'));
      if (found.length > 0) break;
    }
    if (found.length === 0) {
      for (const el of $('iframe[src^="http"]').toArray()) push($(el).attr('src'));
    }
  }

  if (found.length === 0) {
    for (const el of $('[data-player], [data-src]').toArray()) {
      push($(el).attr('data-player') || $(el).attr('data-src'));
    }
  }

  if (found.length === 0) {
    const player =
      html.match(/playerUrl\s*[=:]\s*['"]?(https?:\/\/[^'"\s]+)['"\s]/i) ||
      html.match(/videoUrl\s*[=:]\s*['"]?(https?:\/\/[^'"\s]+)['"\s]/i) ||
      html.match(/srcUrl\s*[=:]\s*['"]?(https?:\/\/[^'"\s]+)['"\s]/i);
    if (player) push(player[1]);
  }

  if (found.length === 0) {
    for (const el of $('[data-video], [data-embed-url], [data-player-url]').toArray()) {
      push(
        $(el).attr('data-video') ||
          $(el).attr('data-embed-url') ||
          $(el).attr('data-player-url')
      );
    }
  }

  if (found.length === 0) {
    const anchors = 'a[data-href*="http"], a.play-now[href*="http"], a.btn-player[href*="http"]';
    for (const el of $(anchors).toArray()) {
      push($(el).attr('data-href') || $(el).attr('href'));
    }
  }

  if (found.length === 0) {
    for (const entry of html.match(/atob\(['"]([A-Za-z0-9+/=]+)['"]\)/g) || []) {
      const payload = entry.match(/atob\(['"]([A-Za-z0-9+/=]+)['"]\)/);
      if (payload) push(decodeBase64(payload[1]));
    }
  }

  // Last resort: a progressive URL sitting in an inline script, which is what the
  // oldest pages have instead of an embed at all.
  if (found.length === 0) {
    for (const el of $('script').toArray()) {
      const content = $(el).html() || '';
      if (content.length < 20) continue;
      const url = content.match(/"(https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)"/i);
      if (url) {
        push(url[1]);
        break;
      }
    }
  }

  return found;
}

/** Remaining slice of the provider budget, floored so a call is always attempted. */
function remainingBudget(startTime: number): number {
  return Math.max(2_000, PROVIDER_BUDGET_MS - (Date.now() - startTime));
}

async function streamsFromPage(
  html: string,
  pageUrl: string,
  language: string,
  ctx: NuvioContext,
  startTime: number
): Promise<NuvioStream[]> {
  const embeds = collectEmbeds(html);
  if (embeds.length === 0) return [];

  return resolveEmbedsUntil(
    embeds.map((url) => ({ url })),
    {
      language,
      providerLabel: LABEL,
      siteUrl: SITE,
      headers: { Referer: pageUrl },
      signal: ctx.signal,
      // Two per language is enough to give the player a fallback without
      // spending the rest of the budget on a third mirror of the same file.
      target: 2,
      budgetMs: remainingBudget(startTime),
    }
  );
}

/** Episode numbers to try, in order of confidence. */
function targetEpisodes(ctx: NuvioContext): number[] {
  const out: number[] = [];
  for (const value of [ctx.episode, ctx.absoluteEpisode]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

function seasonDistance(part: SeasonCard, season: number): number {
  return part.seasonNum ? Math.abs(part.seasonNum - season) : Number.POSITIVE_INFINITY;
}

async function seriesStreams(
  seasons: SeasonCard[],
  ctx: NuvioContext,
  startTime: number
): Promise<NuvioStream[]> {
  const season = ctx.season ?? 1;
  const targets = targetEpisodes(ctx);
  if (targets.length === 0) return [];

  let parts = seasons.filter((s) => s.seasonNum === season);
  if (parts.length === 0) {
    // No part is labelled with the target season, which happens whenever the site
    // numbers a cour differently from the canonical season. The nearest one is a
    // better bet than giving up, and a wrong episode simply will not be listed.
    parts = [...seasons]
      .sort((a, b) => seasonDistance(a, season) - seasonDistance(b, season))
      .slice(0, 1);
  }

  const streams: NuvioStream[] = [];
  const visited = new Set<string>();
  let offset = 0;

  for (const part of parts) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;

    const html = await fetchPage(absoluteUrl(part.href, SITE), ctx);
    if (!html) continue;
    const $ = loadHtml(html);
    let highest = 0;

    for (const lang of LANGS) {
      const links = parseEpisodeLinks($, lang, offset);
      for (const link of links) highest = Math.max(highest, link.num);
      if (links.length === 0) continue;

      // Each language gets its own pass. Sharing one resolve target across both
      // would let whichever is listed first consume it and hide the other.
      const language = lang === 'vf' ? 'VF' : 'VOSTFR';
      for (const target of targets) {
        if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
        const link = links.find((e) => e.num === target || e.cumulative === target);
        if (!link) continue;
        if (visited.has(link.href)) break;
        visited.add(link.href);

        const page = await fetchPage(link.href, ctx, 15_000);
        if (page) {
          streams.push(...(await streamsFromPage(page, link.href, language, ctx, startTime)));
        }
        // `targets` is ordered by confidence, not a set to union: the second entry
        // points at a different episode, so resolving both would mix in a
        // neighbouring one.
        break;
      }
    }

    offset += highest;
    if (streams.length > 0) break;
  }

  return streams;
}

/**
 * Films have no single URL convention, so the plausible shapes are probed.
 *
 * Some entries put the film under a "Film" season card, some under
 * `/film/<lang>/`, some under `/movie/`, and the oldest directly under the slug.
 * Probing costs one cheap request each; parsing the series page for a link that
 * is frequently absent costs the same and finds less.
 */
async function movieStreams(
  slug: string,
  seasonHref: string | null,
  ctx: NuvioContext,
  startTime: number
): Promise<NuvioStream[]> {
  const streams: NuvioStream[] = [];
  const seen = new Set<string>();

  for (const lang of LANGS) {
    const language = lang === 'vf' ? 'VF' : 'VOSTFR';
    const candidates: string[] = [];

    if (seasonHref) {
      const base = absoluteUrl(seasonHref, SITE).replace(/\/+$/, '');
      candidates.push(`${base}/${lang}/episode-1/`, `${base}/${lang}/`);
    }
    candidates.push(
      `${SITE}/anime/${slug}/film/${lang}/episode-1/`,
      `${SITE}/anime/${slug}/film/${lang}/`,
      `${SITE}/anime/${slug}/movie/${lang}/episode-1/`,
      `${SITE}/anime/${slug}/${lang}/episode-1/`
    );

    for (const url of candidates) {
      if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return streams;
      if (seen.has(url)) continue;
      seen.add(url);

      const html = await fetchPage(url, ctx, 12_000, true);
      // Most guesses 404 or land on a stub; only a page with a player is worth
      // parsing, and this check is what makes probing cheap enough to be sane.
      const hasPlayer =
        html !== null &&
        (html.includes('epLecteurSelect') ||
          html.includes('"embedUrl"') ||
          html.includes('<iframe'));
      if (!hasPlayer) continue;

      const found = await streamsFromPage(html, url, language, ctx, startTime);
      if (found.length > 0) {
        streams.push(...found);
        break;
      }
    }
  }

  return streams;
}

/**
 * Pick the series page, verifying only when the score leaves room for doubt.
 *
 * A verification is a full page load, which under this site's pacing costs more
 * than a second of the budget, so a confident score is trusted directly and only
 * ambiguous candidates are confirmed against the page's own `h1`.
 */
async function findSeries(
  ctx: NuvioContext,
  startTime: number
): Promise<RankedHit | null> {
  const maxSearches =
    ctx.type === 'movie' ? MAX_TITLE_SEARCHES_MOVIE : MAX_TITLE_SEARCHES;
  const scored = new Map<string, RankedHit>();

  for (const searchTitle of ctx.titles.slice(0, maxSearches)) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    if (afNormalize(searchTitle).length < 4) continue;

    let strong = false;
    for (const hit of await searchAnime(searchTitle, ctx)) {
      if (SPECIAL_SLUG_RE.test(hit.slug)) continue;
      const score = scoreSearchMatch(hit, searchTitle);
      if (score >= 100) strong = true;
      const existing = scored.get(hit.slug);
      if (!existing || score > existing.score) scored.set(hit.slug, { ...hit, score });
    }
    if (strong) break;
  }

  const ranked = [...scored.values()].sort((a, b) => b.score - a.score).slice(0, 3);
  if (ranked.length === 0) return null;
  if (ranked[0].score >= 100) return ranked[0];

  const queries = ctx.titles.slice(0, 5).map((t) => afNormalize(t)).filter(Boolean);

  for (const candidate of ranked) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    const html = await fetchPage(`${SITE}/anime/${candidate.slug}/`, ctx, 8_000);
    if (!html) continue;
    const pageTitle = loadHtml(html)('h1.hero-title').first().text().trim();
    if (!pageTitle) continue;

    const nPage = afNormalize(pageTitle);
    if (queries.some((q) => nPage.includes(q) || q.includes(nPage))) return candidate;
  }

  return null;
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];
  const startTime = Date.now();

  const match = await findSeries(ctx, startTime);
  if (!match) return [];
  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  const seriesHtml = await fetchPage(`${SITE}/anime/${match.slug}/`, ctx);
  if (!seriesHtml) return [];
  const { seasons, filmHref } = parseSeasons(seriesHtml, match.slug);

  if (ctx.type === 'movie') {
    // Films are often filed as "Saison 1" with a single episode rather than under
    // a film card, so that is the fallback before probing the bare URL shapes.
    const href = filmHref || seasons.find((s) => s.seasonNum === 1)?.href || null;
    return movieStreams(match.slug, href, ctx, startTime);
  }

  if (seasons.length === 0) {
    return filmHref ? movieStreams(match.slug, filmHref, ctx, startTime) : [];
  }

  return seriesStreams(seasons, ctx, startTime);
}

export const animoflix = createNuvioProvider({
  name: 'animoflix',
  sites: [SITE],
  language: 'fr',
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'ja',
});
