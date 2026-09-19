/**
 * Voiranime.rip — French anime catalogue, VF and VOSTFR on the same episode page.
 *
 * Ported from temp/French/French/src/voiranime-rip. Episode URLs are fully
 * predictable (`/<slug>/saison-N/episode-M/`), so the only real work is finding
 * the slug, and the site's search engine is unusually strict: it answers short
 * distinctive keywords but returns nothing for long exact titles. Hence the three
 * search passes — full titles, then keywords with a word-overlap guard against
 * false positives, then direct probing of slugs that glue short Japanese words to
 * the next one ("san shimai" → "sanshimai"), which is how this site spells them.
 *
 * Each page carries an inline script mapping `vostfr` and `vf` to their player
 * URLs. Those labels are authoritative; the default iframe's language has to be
 * guessed from the page text, so an explicit label always wins over the guess.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  siteFetchText,
  loadHtml,
  normalize,
  scoreTitleMatch,
  stripSeasonSuffix,
  parseAvailableSeasons,
  resolveEmbedStreams,
  isAborted,
  isBudgetExhausted,
  FR_ACCEPT_LANGUAGE,
  type MatchScores,
} from '../shared.js';

const SITE = 'https://voiranime.rip';
const LABEL = 'Voiranime-Rip';
const MAX_SEARCH_TITLES = 6;

/** Hrefs in search results are site-relative and always a bare slug. */
const SLUG = /^\/([^/]+)\/$/;
const SEASON_LINK = /\/saison-(\d+)\//;

/** The site's own thresholds — a full-title query must match exactly to be used. */
const SCORES: MatchScores = { MIN_MATCH: 30, EXACT_MATCH: 150, STRONG_MATCH: 100 };

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
  'junior high',
  'chibi',
  'super deformed',
];

interface SearchHit {
  url: string;
  slug: string;
  title: string;
}

interface VideoUrl {
  url: string;
  lang: string | null;
  /** True when the language was inferred from the page rather than declared. */
  fromIframe?: boolean;
}

function spinoffPenalty(title: string): number {
  const lower = (title || '').toLowerCase();
  return SPINOFF_KEYWORDS.some((k) => lower.includes(k)) ? -50 : 0;
}

/**
 * Guard against a keyword query landing on an unrelated series.
 *
 * "Slime" as a query genuinely identifies one show, but "Reincarnation" matches
 * several, so a hit must share two significant words with a real title — or one,
 * when the title itself is only one or two words long.
 */
function validateFallbackMatch(resultTitle: string, originalTitles: string[]): boolean {
  const resultWords = new Set(
    normalize(resultTitle)
      .split(/\s+/)
      .filter((w) => w.length > 3)
  );

  for (const title of originalTitles) {
    const titleWords = normalize(stripSeasonSuffix(title))
      .split(/\s+/)
      .filter((w) => w.length > 3);

    let overlap = 0;
    for (const w of titleWords) {
      if (resultWords.has(w)) overlap++;
    }
    if (overlap >= 2) return true;
    if (titleWords.length <= 2 && overlap >= 1) return true;
  }

  return false;
}

function parseSearchResults(html: string): SearchHit[] {
  if (!html) return [];
  const $ = loadHtml(html);
  const results: SearchHit[] = [];

  for (const el of $('a.va-search-result').toArray()) {
    const href = $(el).attr('href') || '';
    const title = $(el).find('.va-search-result-title').first().text().trim();
    if (!href || !title) continue;
    const slugMatch = href.match(SLUG);
    if (!slugMatch) continue;
    results.push({ url: `${SITE}${href}`, slug: slugMatch[1], title });
  }

  return results;
}

/** Language of a whole page, when no per-player label is available. */
function detectLanguage(html: string): string | null {
  const $ = loadHtml(html);

  const title = $('title').text().toLowerCase();
  if (/\bvostfr\b/.test(title)) return 'VOSTFR';
  if (/\bvf\b/.test(title) && !/\bvostfr\b/.test(title)) return 'VF';

  const body = $('body').text().toLowerCase().slice(0, 5000);
  const hasVostfr = /\bvostfr\b/.test(body);
  const hasVf = /\bvf\b/.test(body);
  if (hasVostfr && !hasVf) return 'VOSTFR';
  if (hasVf && !hasVostfr) return 'VF';

  return null;
}

/** Every player URL on a page, with the best language label available for each. */
function parseVideoUrls(html: string): VideoUrl[] {
  const urls: VideoUrl[] = [];
  if (!html) return urls;
  const $ = loadHtml(html);

  // Episode pages use `#videoPlayer`; film pages wrap the iframe instead.
  let iframeSrc = $('#videoPlayer').attr('src');
  if (!iframeSrc) iframeSrc = $('.video-wrapper iframe').first().attr('src');
  if (iframeSrc) {
    urls.push({ url: iframeSrc, lang: detectLanguage(html), fromIframe: true });
  }

  const text = $('script').text();
  const regex = /['"]?(vostfr|vf)['"]?\s*[:=]\s*['"]?(https?:\/\/[^'"\s;,}]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    urls.push({ url: m[2], lang: m[1].toLowerCase() === 'vf' ? 'VF' : 'VOSTFR' });
  }

  // One URL can appear both as the default iframe and in the script map; the
  // script's label is the reliable one.
  const urlMap = new Map<string, VideoUrl>();
  for (const entry of urls) {
    const existing = urlMap.get(entry.url);
    if (!existing) {
      urlMap.set(entry.url, entry);
      continue;
    }
    const existingExplicit = Boolean(existing.lang) && !existing.fromIframe;
    const newExplicit = Boolean(entry.lang) && !entry.fromIframe;
    if (newExplicit && !existingExplicit) urlMap.set(entry.url, entry);
  }

  const deduped = [...urlMap.values()];
  if (deduped.some((u) => !u.lang)) {
    const pageLang = detectLanguage(html);
    if (pageLang) {
      for (const entry of deduped) {
        if (!entry.lang) entry.lang = pageLang;
      }
    }
  }

  return deduped;
}

/**
 * Short queries for the search engine's second pass.
 *
 * The last word of a title carries most of its identity ("Slime", "Titan"), and
 * the last two words give it just enough context to disambiguate.
 */
function generateFallbackQueries(titles: string[]): string[] {
  const seen = new Set<string>();
  const fallbacks: string[] = [];

  for (const title of titles) {
    const words = title.split(/\s+/).filter((w) => w.length > 2);

    if (words.length >= 2) {
      const lastWord = words[words.length - 1];
      if (!seen.has(lastWord) && lastWord.length >= 3) {
        seen.add(lastWord);
        fallbacks.push(lastWord);
      }
      const lastTwo = words.slice(-2).join(' ');
      if (!seen.has(lastTwo) && lastTwo.split(' ').every((w) => w.length >= 3)) {
        seen.add(lastTwo);
        fallbacks.push(lastTwo);
      }
    }
    if (words.length >= 1) {
      const firstWord = words[0];
      if (!seen.has(firstWord) && firstWord.length >= 3 && firstWord.length <= 8) {
        seen.add(firstWord);
        fallbacks.push(firstWord);
      }
    }
    if (fallbacks.length >= 4) break;
  }

  return fallbacks;
}

async function postSearch(query: string, ctx: NuvioContext): Promise<string | null> {
  return siteFetchText(`${SITE}/template-php/defaut/fetch.php`, {
    form: { query },
    headers: { Referer: `${SITE}/`, 'X-Requested-With': 'XMLHttpRequest' },
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    timeoutMs: 10_000,
    signal: ctx.signal,
  });
}

/**
 * Run one query and return its top-scoring slugs.
 *
 * Full-title queries demand an exact match; keyword queries can only ever score
 * partially, so they fall back to the minimum threshold and are checked for word
 * overlap with the real titles instead.
 */
async function trySearchQuery(
  query: string,
  isFallback: boolean,
  originalTitles: string[],
  ctx: NuvioContext
): Promise<SearchHit[] | null> {
  const html = await postSearch(stripSeasonSuffix(query), ctx);
  if (!html) return null;
  const results = parseSearchResults(html);
  if (results.length === 0) return null;

  let scored = results
    .map((r) => ({ ...r, score: scoreTitleMatch(r.title, query, SCORES) + spinoffPenalty(r.title) }))
    .filter((r) => r.score >= SCORES.MIN_MATCH)
    .sort((a, b) => b.score - a.score);

  const threshold = isFallback ? SCORES.MIN_MATCH : SCORES.EXACT_MATCH;
  if (scored.length === 0 || scored[0].score < threshold) return null;

  if (isFallback) {
    const validated = scored.filter((r) => validateFallbackMatch(r.title, originalTitles));
    if (validated.length === 0) return null;
    scored = validated;
  }

  // Keep every near-equal variant: VF and VOSTFR are separate slugs and either
  // may be the one that actually carries the episode.
  const bestScore = scored[0].score;
  const seenSlugs = new Set<string>();
  return scored.filter((r) => {
    if (seenSlugs.has(r.slug)) return false;
    if (r.score < bestScore - 20) return false;
    seenSlugs.add(r.slug);
    return true;
  });
}

/** Slug variants built by gluing short words to the next one. */
function compactedSlugs(titles: string[]): string[] {
  const out: string[] = [];

  for (const title of titles.slice(0, 3)) {
    const normalized = title
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[':!.,?()[\]]/g, '')
      .replace(/[^a-z0-9\s]/g, '')
      .trim();
    if (!normalized) continue;

    const normalSlug = normalized
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    const words = normalized.split(/\s+/).filter(Boolean);
    if (words.length < 3) continue;

    const shortPos: number[] = [];
    for (let i = 0; i < words.length - 1; i++) {
      if (words[i].length <= 3) shortPos.push(i);
    }
    if (shortPos.length === 0) continue;

    const variants: string[] = [];
    for (const pos of shortPos) {
      const parts = [...words];
      parts[pos] = parts[pos] + parts[pos + 1];
      parts.splice(pos + 1, 1);
      variants.push(parts.join('-'));
    }
    if (shortPos.length > 1) {
      const parts = [...words];
      let offset = 0;
      for (const pos of shortPos) {
        const actualPos = pos - offset;
        parts[actualPos] = parts[actualPos] + parts[actualPos + 1];
        parts.splice(actualPos + 1, 1);
        offset++;
      }
      variants.push(parts.join('-'));
    }

    for (const v of new Set(variants)) {
      if (v && v !== normalSlug && v.length > 3 && !out.includes(v)) out.push(v);
    }
  }

  return out;
}

async function searchAnime(ctx: NuvioContext, startTime: number): Promise<SearchHit[]> {
  const titles = ctx.titles;

  for (const title of titles.slice(0, MAX_SEARCH_TITLES)) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];
    const result = await trySearchQuery(title, false, titles, ctx);
    if (result) return result;
  }

  for (const query of generateFallbackQueries(titles)) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];
    const result = await trySearchQuery(query, true, titles, ctx);
    if (result) return result;
  }

  for (const slug of compactedSlugs(titles)) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];
    const url = `${SITE}/${slug}/`;
    const html = await siteFetchText(url, {
      acceptLanguage: FR_ACCEPT_LANGUAGE,
      timeoutMs: 8_000,
      signal: ctx.signal,
      // These are guesses; most will 404.
      noBypass: true,
    });
    if (html && html.length > 200) {
      return [{ url, slug, title: slug.replace(/-/g, ' ') }];
    }
  }

  return [];
}

/** Resolve every player on one page, one stream per URL and language. */
async function streamsFromPage(html: string, ctx: NuvioContext): Promise<NuvioStream[]> {
  const videoUrls = parseVideoUrls(html);
  if (videoUrls.length === 0) return [];

  const streams: NuvioStream[] = [];
  const seen = new Set<string>();

  for (const video of videoUrls) {
    if (isAborted(ctx.signal)) break;
    // VF is the site's default when nothing on the page says otherwise.
    const language = video.lang || 'VF';
    const key = `${video.url}|${language}`;
    if (seen.has(key)) continue;
    seen.add(key);

    streams.push(
      ...(await resolveEmbedStreams(video.url, {
        language,
        providerLabel: LABEL,
        siteUrl: SITE,
      }))
    );
  }

  return streams;
}

async function extractEpisodeStreams(
  slug: string,
  season: number,
  episode: number,
  ctx: NuvioContext
): Promise<NuvioStream[]> {
  const html = await siteFetchText(`${SITE}/${slug}/saison-${season}/episode-${episode}/`, {
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    timeoutMs: 12_000,
    signal: ctx.signal,
    // A season/episode combination the site does not have is expected here.
    noBypass: true,
  });
  if (!html) return [];
  return streamsFromPage(html, ctx);
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];

  const startTime = Date.now();
  const matches = await searchAnime(ctx, startTime);
  if (matches.length === 0) return [];

  if (ctx.type === 'movie') {
    for (const match of matches) {
      if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
      const html = await siteFetchText(match.url, {
        acceptLanguage: FR_ACCEPT_LANGUAGE,
        timeoutMs: 12_000,
        signal: ctx.signal,
      });
      if (!html) continue;
      const streams = await streamsFromPage(html, ctx);
      if (streams.length > 0) return streams;
    }
    return [];
  }

  const season = ctx.season ?? 1;
  const episode = ctx.episode ?? 1;

  for (const match of matches) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    const streams = await extractEpisodeStreams(match.slug, season, episode, ctx);
    if (streams.length > 0) return streams;
  }

  // The site's season numbering diverges from the canonical one for long-running
  // shows, so read the seasons it actually publishes and try each of them, with
  // the absolute episode number as a second pass for entries numbered that way.
  for (const match of matches) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;

    const seriesHtml = await siteFetchText(match.url, {
      acceptLanguage: FR_ACCEPT_LANGUAGE,
      timeoutMs: 12_000,
      signal: ctx.signal,
    });
    if (!seriesHtml) continue;

    const availableSeasons = parseAvailableSeasons(seriesHtml, SEASON_LINK);
    if (availableSeasons.length === 0) continue;

    const attempts: Array<{ season: number; episode: number }> = [];
    for (const siteSeason of availableSeasons) {
      if (siteSeason !== season) attempts.push({ season: siteSeason, episode });
    }
    if (ctx.absoluteEpisode != null && ctx.absoluteEpisode !== episode) {
      for (const siteSeason of availableSeasons) {
        attempts.push({ season: siteSeason, episode: ctx.absoluteEpisode });
      }
    }

    for (const attempt of attempts) {
      if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
      const streams = await extractEpisodeStreams(
        match.slug,
        attempt.season,
        attempt.episode,
        ctx
      );
      if (streams.length > 0) return streams;
    }
  }

  return [];
}

export const voiranimerip = createNuvioProvider({
  name: 'voiranimerip',
  sites: [SITE],
  language: 'fr',
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'ja',
});
