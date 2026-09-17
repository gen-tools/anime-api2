/**
 * AnimeSama.co — French anime catalogue on the "asn" theme, VF and VOSTFR.
 *
 * Ported from temp/French/French/src/animesama-co. Episode pages carry a single
 * `#videoPlayer` iframe and switch versions with JS tabs, so the language tags on
 * the page are the only signal for what a given embed contains; every detected
 * language is emitted for every player URL rather than guessing which tab was
 * default, which is also what the original does whenever a page exposes more than
 * one iframe.
 *
 * Two site-specific quirks drive the search: it scores spin-offs down hard (a
 * query for "L'Attaque des Titans" otherwise lands on "… Junior High School"),
 * and it retries with short distinctive keywords because the engine returns
 * nothing for long exact titles.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  siteFetchText,
  loadHtml,
  scoreTitleMatch,
  stripSeasonSuffix,
  parseAvailableSeasons,
  resolveEmbedStreams,
  isAborted,
  isBudgetExhausted,
  absoluteUrl,
  FR_ACCEPT_LANGUAGE,
  type MatchScores,
} from '../shared.js';

const SITE = 'https://animesama.co';
const LABEL = 'AnimeSamaCo';
const MAX_SEARCH_TITLES = 6;

const ANIME_ID = /\/anime\/(\d+)-([^/]+)\.html/;
const SEASON_LINK = /\/saison-(\d+)\.html/;

/** The site's own thresholds — its exact matches score far above the default 100. */
const SCORES: MatchScores = { MIN_MATCH: 30, EXACT_MATCH: 150, STRONG_MATCH: 100 };

/**
 * Derivative entries that carry none of the parent series' episodes.
 *
 * Each hit costs 60 points, enough to sink a spin-off below an exact title match
 * even when its name contains the query as a substring.
 */
const SPINOFF_KEYWORDS = [
  'junior high',
  'junior-high',
  'chibi',
  'spin.?off',
  'special',
  'ona',
  'ova',
  'mini',
  'gaiden',
  'side story',
  'side.?story',
];

interface SearchHit {
  url: string;
  animeId: string;
  slug: string;
  title: string;
}

/** Strip punctuation the site's search engine treats as a literal. */
function sanitizeQuery(query: string): string {
  return (query || '')
    .replace(/[–—]/g, ' ')
    .replace(/[‘’`]/g, "'")
    .replace(/[()[\]{}:;,!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function spinoffPenalty(title: string): number {
  if (!title) return 0;
  const lower = title.toLowerCase();
  let penalty = 0;
  for (const keyword of SPINOFF_KEYWORDS) {
    if (new RegExp(keyword, 'i').test(lower)) penalty += 60;
  }
  return penalty;
}

/**
 * Short, distinctive queries for the search engine's second pass.
 *
 * The last word of a title is usually the identifying one ("Slime", "Titan"),
 * and the first is usually specific enough to be worth a try; anything shorter
 * than four characters matches too much to be useful.
 */
function generateFallbackQueries(titles: string[]): string[] {
  const seen = new Set<string>();
  const fallbacks: string[] = [];

  for (const title of titles) {
    const words = stripSeasonSuffix(title).split(/\s+/).filter((w) => w.length > 3);

    if (words.length >= 2) {
      const lastWord = words[words.length - 1];
      if (!seen.has(lastWord) && lastWord.length >= 4) {
        seen.add(lastWord);
        fallbacks.push(lastWord);
      }
    }
    if (words.length >= 1) {
      const firstWord = words[0];
      if (!seen.has(firstWord) && firstWord.length >= 4 && firstWord.length <= 10) {
        seen.add(firstWord);
        fallbacks.push(firstWord);
      }
    }
    if (fallbacks.length >= 4) break;
  }

  return fallbacks;
}

async function postSearch(query: string, ctx: NuvioContext): Promise<SearchHit[]> {
  const html = await siteFetchText(`${SITE}/template-php/defaut/fetch.php`, {
    form: { query: sanitizeQuery(query) },
    headers: { Referer: `${SITE}/`, 'X-Requested-With': 'XMLHttpRequest' },
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    timeoutMs: 10_000,
    signal: ctx.signal,
  });
  if (!html) return [];

  const $ = loadHtml(html);
  const results: SearchHit[] = [];

  $('a.asn-search-result').each((_, el) => {
    const href = $(el).attr('href') || '';
    const title = $(el).find('.asn-search-result-title').first().text().trim();
    if (!href || !title) return;
    const idMatch = href.match(ANIME_ID);
    if (!idMatch) return;
    results.push({
      url: absoluteUrl(href, SITE),
      animeId: idMatch[1],
      slug: idMatch[2],
      title,
    });
  });

  return results;
}

async function searchAnime(ctx: NuvioContext, startTime: number): Promise<SearchHit | null> {
  const titles = ctx.titles.slice(0, MAX_SEARCH_TITLES);

  for (const title of titles) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return null;
    const results = await postSearch(stripSeasonSuffix(title), ctx);
    if (results.length === 0) continue;

    let best: SearchHit | null = null;
    let bestScore = 0;
    for (const result of results) {
      const score = scoreTitleMatch(result.title, title, SCORES) - spinoffPenalty(result.title);
      if (score > bestScore) {
        bestScore = score;
        best = result;
      }
    }
    if (best && bestScore >= SCORES.MIN_MATCH) return best;
  }

  // Second pass: every keyword query's results are pooled before choosing, so a
  // query like "Titan" cannot return its first hit ahead of a better later one.
  const candidates: Array<{ hit: SearchHit; score: number }> = [];
  for (const query of generateFallbackQueries(titles)) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    for (const result of await postSearch(query, ctx)) {
      for (const title of titles) {
        const score =
          scoreTitleMatch(result.title, stripSeasonSuffix(title), SCORES) -
          spinoffPenalty(result.title);
        candidates.push({ hit: result, score });
      }
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score);
    if (candidates[0].score >= SCORES.MIN_MATCH) return candidates[0].hit;
  }

  return null;
}

/** Player iframes on an episode page. */
function parseEpisodeIframes(html: string): string[] {
  const $ = loadHtml(html);
  const urls: string[] = [];
  const seen = new Set<string>();

  $('#videoPlayer').each((_, el) => {
    const src = $(el).attr('src');
    if (src && !seen.has(src)) {
      seen.add(src);
      urls.push(src);
    }
  });

  if (urls.length === 0) {
    $('iframe[src*="sibnet"]').each((_, el) => {
      const src = $(el).attr('src');
      if (src && !seen.has(src)) {
        seen.add(src);
        urls.push(src);
      }
    });
  }

  return urls;
}

function detectLanguages(html: string): string[] {
  const langs: string[] = [];
  const $ = loadHtml(html);

  $('[data-lang]').each((_, el) => {
    const lang = $(el).attr('data-lang');
    if (lang === 'vf' && !langs.includes('VF')) langs.push('VF');
    if (lang === 'vostfr' && !langs.includes('VOSTFR')) langs.push('VOSTFR');
  });

  if (langs.length === 0) {
    const text = $('body').text().toLowerCase();
    if (/vostfr|version originale/i.test(text)) langs.push('VOSTFR');
    if (/vf\b|version fran[cç]aise/i.test(text)) langs.push('VF');
  }

  if (langs.length === 0) langs.push('VF');
  return langs;
}

async function extractEpisodeStreams(
  match: SearchHit,
  season: number,
  episode: number,
  ctx: NuvioContext
): Promise<NuvioStream[]> {
  const base = `${SITE}/anime/${match.animeId}-${match.slug}`;
  const options = {
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    timeoutMs: 15_000,
    signal: ctx.signal,
    noBypass: true,
  };

  let html = await siteFetchText(`${base}/saison-${season}/episode-${episode}.html`, options);

  // Films live beside seasons under the same anime id; a season page with no
  // player markup usually means the entry is catalogued as one.
  if (!html || !html.includes('videoPlayer')) {
    const filmHtml = await siteFetchText(`${base}/film/episode-${episode}.html`, options);
    if (filmHtml && filmHtml.includes('videoPlayer')) html = filmHtml;
  }
  if (!html) return [];

  const iframeUrls = parseEpisodeIframes(html);
  if (iframeUrls.length === 0) return [];
  const languages = detectLanguages(html);

  const streams: NuvioStream[] = [];
  const seen = new Set<string>();

  for (const language of languages) {
    for (const url of iframeUrls) {
      if (isAborted(ctx.signal)) return streams;
      const key = `${url}|${language}`;
      if (seen.has(key)) continue;
      seen.add(key);

      streams.push(
        ...(await resolveEmbedStreams(absoluteUrl(url, SITE), {
          language,
          providerLabel: LABEL,
          siteUrl: SITE,
        }))
      );
    }
  }

  return streams;
}

/**
 * A spin-off page usually links back to the series it derives from.
 *
 * Only links whose slug shares a significant word with the spin-off's own title
 * are considered, so this follows "…-junior-high-school" to "lattaque-des-titans"
 * without wandering into the sidebar's unrelated recommendations.
 */
async function findParentSeries(match: SearchHit, ctx: NuvioContext): Promise<SearchHit | null> {
  const html = await siteFetchText(match.url, {
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    timeoutMs: 15_000,
    signal: ctx.signal,
  });
  if (!html) return null;

  const $ = loadHtml(html);
  const significantWords = match.title.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  let parentHref = '';

  $('a[href*="/anime/"][href$=".html"]').each((_, el) => {
    if (parentHref) return;
    const href = $(el).attr('href') || '';
    if (href === match.url || href.includes(match.animeId)) return;
    const slug = (href.split('/').pop() || '').replace('.html', '').replace(/\d+-/, '');
    if (significantWords.some((w) => slug.includes(w))) parentHref = href;
  });

  if (!parentHref) return null;
  const parentUrl = absoluteUrl(parentHref, SITE);
  const idMatch = parentUrl.match(/\/anime\/(\d+)-/);
  if (!idMatch || idMatch[1] === match.animeId) return null;
  const slugMatch = parentUrl.match(/\/anime\/\d+-([^/]+)\.html/);

  return {
    url: parentUrl,
    animeId: idMatch[1],
    slug: slugMatch ? slugMatch[1] : match.slug,
    title: match.title,
  };
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];

  const startTime = Date.now();
  const match = await searchAnime(ctx, startTime);
  if (!match) return [];

  if (ctx.type === 'movie') {
    return extractEpisodeStreams(match, 1, 1, ctx);
  }

  const season = ctx.season ?? 1;
  const episode = ctx.episode ?? 1;

  const direct = await extractEpisodeStreams(match, season, episode, ctx);
  if (direct.length > 0) return direct;

  if (spinoffPenalty(match.title) > 0 && !isBudgetExhausted(startTime)) {
    const parent = await findParentSeries(match, ctx);
    if (parent) {
      const parentStreams = await extractEpisodeStreams(parent, season, episode, ctx);
      if (parentStreams.length > 0) return parentStreams;
    }
  }

  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  // The site's season numbering rarely matches TMDB's for long-running shows, so
  // read the seasons it actually publishes and try the absolute episode in each.
  const seriesHtml = await siteFetchText(`${SITE}/anime/${match.animeId}-${match.slug}.html`, {
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    timeoutMs: 15_000,
    signal: ctx.signal,
  });
  if (!seriesHtml) return [];

  const availableSeasons = parseAvailableSeasons(seriesHtml, SEASON_LINK);
  if (availableSeasons.length === 0) return [];

  const attempts: Array<{ season: number; episode: number }> = [];
  // Absolute first: TMDB episode 1 would match site S1E1 for almost any anime,
  // which is a false positive dressed as a success.
  if (ctx.absoluteEpisode != null && ctx.absoluteEpisode !== episode) {
    for (const siteSeason of availableSeasons) {
      attempts.push({ season: siteSeason, episode: ctx.absoluteEpisode });
    }
  }
  const lastSeason = availableSeasons[availableSeasons.length - 1];
  if (lastSeason !== season) attempts.push({ season: lastSeason, episode });

  for (const attempt of attempts) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    const streams = await extractEpisodeStreams(match, attempt.season, attempt.episode, ctx);
    if (streams.length > 0) return streams;
  }

  return [];
}

export const animesamaco = createNuvioProvider({
  name: 'animesamaco',
  sites: [SITE],
  language: 'fr',
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'ja',
});
