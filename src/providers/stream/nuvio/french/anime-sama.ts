/**
 * Anime-Sama — large French anime catalogue (anime-sama.to), VOSTFR and VF.
 *
 * Ported from temp/French/French/src/anime-sama. The site has no per-episode
 * pages: every season exposes one `episodes.js` containing a `var` array per
 * player host, where array position N-1 holds the embed for episode N. So an
 * extraction is a script fetch plus an index, and the only genuinely hard part
 * is guessing the catalogue slug — hence the ladder of slug shapes tried below
 * before falling back to the site's search endpoint.
 *
 * Long series are split into `saison3`, `saison3-2`, `saison3-3`… sub-parts that
 * each restart their numbering at 1, so an episode past the end of the main
 * season is looked up by walking the sub-parts and subtracting their lengths.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  siteFetchText,
  loadHtml,
  toSlug,
  stripSeasonSuffix,
  deaccent,
  resolveEmbedsUntil,
  isAborted,
  isBudgetExhausted,
  FR_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
} from '../shared.js';

const SITE = 'https://anime-sama.to';
const LABEL = 'Anime-Sama';
const MAX_FALLBACK_TITLES = 5;
const MAX_FALLBACK_SLUGS = 2;
const MIN_SEARCH_SCORE = 15;

/** URL segment the site uses for a version, and the tag the adapter expects. */
const LANGUAGES: Array<{ path: string; tag: string }> = [
  { path: 'vostfr', tag: 'VOSTFR' },
  { path: 'vf', tag: 'VF' },
];

interface PlayerList {
  varName: string;
  urls: string[];
}

/**
 * Every `var name = [ 'url', … ];` block in an `episodes.js`.
 *
 * One block per player host, so the blocks are parallel lists over the same
 * episodes — index N-1 in each is episode N on a different server.
 */
function parseUrls(jsContent: string): PlayerList[] {
  const varRegex = /var\s+([a-z0-9]+)\s*=\s*\[([\s\S]*?)\s*\];/gm;
  const results: PlayerList[] = [];
  let match: RegExpExecArray | null;
  while ((match = varRegex.exec(jsContent)) !== null) {
    const urls = match[2].match(/['"]([^'"]+)['"]/g)?.map((u) => u.slice(1, -1)) || [];
    results.push({ varName: match[1], urls });
  }
  return results;
}

/**
 * Rank one search hit against the query.
 *
 * The word-count clamps at the end are the point of this function: the site's
 * search is a substring match, so querying "No Longer Allowed in Another World"
 * returns the unrelated single-word series "Another". A one-word title can never
 * be a credible answer to a multi-word query, so its score is capped rather than
 * merely reduced.
 */
function scoreSearchResult(resultTitle: string, resultSubtitle: string, query: string): number {
  const q = deaccent(query.toLowerCase());
  const t = deaccent(resultTitle.toLowerCase());
  const s = deaccent(resultSubtitle.toLowerCase());

  let score = 0;
  if (t === q) return 100;
  if (t.includes(q)) score += 60;
  else if (q.includes(t)) {
    const qWordCount = q.split(/[^a-z0-9]+/).filter((w) => w.length > 2).length;
    const tWordCount = t.split(/[^a-z0-9]+/).filter((w) => w.length > 2).length;
    if (qWordCount > 1 && tWordCount <= 1) score += 10;
    else score += 50;
  }

  const qWords = q.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const tWords = t.split(/[^a-z0-9]+/).filter((w) => w.length > 2);

  for (const w of qWords) {
    if (tWords.includes(w)) score += 15;
  }
  for (const w of qWords) {
    if (s.includes(w) && !t.includes(w)) score += 3;
  }

  if (qWords.length >= 3 && tWords.length <= 1) score = Math.min(score, 5);
  else if (qWords.length >= 2 && tWords.length <= 1) score = Math.min(score, 10);

  return score;
}

/** Catalogue slugs the site's own search returns for `query`, best-scoring first. */
async function searchSlugsScored(query: string, ctx: NuvioContext): Promise<string[]> {
  const html = await siteFetchText(`${SITE}/template-php/defaut/fetch.php`, {
    form: { query },
    headers: { Referer: SITE },
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    timeoutMs: 8_000,
    signal: ctx.signal,
  });
  if (!html) return [];

  const $ = loadHtml(html);
  const results: Array<{ slug: string; score: number }> = [];

  $('a[href*="/catalogue/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const match = href.match(/\/catalogue\/([^/]+)\/?/);
    if (!match) return;
    const slug = match[1];
    if (results.some((r) => r.slug === slug)) return;
    const title = $(el).find('.asn-search-result-title').text().trim();
    const subtitle = $(el).find('.asn-search-result-subtitle').text().trim();
    results.push({ slug, score: scoreSearchResult(title, subtitle, query) });
  });

  results.sort((a, b) => b.score - a.score);
  return results.filter((r) => r.score >= MIN_SEARCH_SCORE).map((r) => r.slug);
}

async function fetchJs(
  slug: string,
  seasonPath: string,
  langPath: string,
  ctx: NuvioContext
): Promise<string | null> {
  const url = `${SITE}/catalogue/${slug}${seasonPath ? `/${seasonPath}` : ''}/${langPath}/episodes.js`;
  return siteFetchText(url, {
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    timeoutMs: 8_000,
    signal: ctx.signal,
    // A missing season is the normal outcome of slug probing, not a wall.
    noBypass: true,
  });
}

/** Resolve the embeds sitting at `index` across every player list. */
async function buildStreams(
  parsed: PlayerList[],
  tag: string,
  index: number,
  ctx: NuvioContext
): Promise<NuvioStream[]> {
  const embeds = parsed
    .map((entry) => entry.urls[index])
    .filter((url): url is string => Boolean(url) && url.startsWith('http'))
    .map((url) => ({ url }));
  if (embeds.length === 0) return [];

  return resolveEmbedsUntil(embeds, {
    language: tag,
    providerLabel: LABEL,
    siteUrl: SITE,
    target: 2,
    signal: ctx.signal,
    budgetMs: 12_000,
  });
}

/**
 * Locate one episode for a slug/season/version, following season sub-parts.
 *
 * Tries `saisonN` first, then `saisonN-2`…`saisonN-5` with the running episode
 * count subtracted, then the season-less root path used by single-run entries.
 */
async function tryFetchEpisode(
  slug: string,
  langPath: string,
  tag: string,
  season: number,
  episode: number,
  ctx: NuvioContext
): Promise<NuvioStream[]> {
  const mainJs = await fetchJs(slug, `saison${season}`, langPath, ctx);

  if (mainJs) {
    const parsed = parseUrls(mainJs);
    if (parsed.length > 0) {
      const totalEps = parsed[0].urls.length;
      if (episode >= 1 && episode <= totalEps) {
        return buildStreams(parsed, tag, episode - 1, ctx);
      }

      let cumulativeEps = totalEps;
      for (const subNum of ['2', '3', '4', '5']) {
        if (isAborted(ctx.signal)) return [];
        const subJs = await fetchJs(slug, `saison${season}-${subNum}`, langPath, ctx);
        if (!subJs) continue;
        const subParsed = parseUrls(subJs);
        if (subParsed.length === 0) continue;
        const subTotal = subParsed[0].urls.length;
        const localEp = episode - cumulativeEps;
        if (localEp >= 1 && localEp <= subTotal) {
          return buildStreams(subParsed, tag, localEp - 1, ctx);
        }
        cumulativeEps += subTotal;
      }
    }
  }

  const rootJs = await fetchJs(slug, '', langPath, ctx);
  if (rootJs) {
    const parsed = parseUrls(rootJs);
    if (parsed.length > 0) {
      const index = episode - 1;
      if (index >= 0 && index < parsed[0].urls.length) {
        return buildStreams(parsed, tag, index, ctx);
      }
    }
  }

  return [];
}

/** Every version of one catalogue slug, for the requested episode (or the film). */
async function fetchSlug(
  slug: string,
  season: number,
  episodes: number[],
  ctx: NuvioContext,
  startTime: number
): Promise<NuvioStream[]> {
  const out: NuvioStream[] = [];

  for (const { path, tag } of LANGUAGES) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;

    if (ctx.type === 'movie') {
      const jsContent = await fetchJs(slug, 'film', path, ctx);
      if (!jsContent) continue;
      const parsed = parseUrls(jsContent);
      if (parsed.length === 0) continue;
      out.push(...(await buildStreams(parsed, tag, 0, ctx)));
      continue;
    }

    for (const episode of episodes) {
      if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
      const found = await tryFetchEpisode(slug, path, tag, season, episode, ctx);
      if (found.length > 0) {
        out.push(...found);
        break;
      }
    }
  }

  return out;
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];

  const startTime = Date.now();
  const season = ctx.season ?? 1;
  const episodes = [ctx.episode, ctx.absoluteEpisode].filter(
    (value, index, all): value is number =>
      typeof value === 'number' && value > 0 && all.indexOf(value) === index
  );
  if (ctx.type === 'tv' && episodes.length === 0) return [];

  const baseSlug = toSlug(ctx.titles[0]);
  const streams: NuvioStream[] = [];

  if (baseSlug) {
    streams.push(...(await fetchSlug(baseSlug, season, episodes, ctx, startTime)));
  }

  // Split-cour entries are catalogued under their own slug rather than as a
  // season of the parent, so the base slug misses them entirely.
  if (streams.length === 0 && season > 1) {
    for (const variant of [`${baseSlug}-saison-${season}`, `${baseSlug}-${season}`]) {
      if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
      streams.push(...(await fetchSlug(variant, season, episodes, ctx, startTime)));
      if (streams.length > 0) break;
    }
  }

  if (streams.length === 0 && !isAborted(ctx.signal) && !isBudgetExhausted(startTime)) {
    const foundSlugs: string[] = [];
    // Season suffixes hurt this search: "… Season 1" returns nothing where the
    // bare title returns the right entry.
    const searchTitles = ctx.titles.slice(0, MAX_FALLBACK_TITLES).map(stripSeasonSuffix);

    for (const title of searchTitles) {
      if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
      for (const slug of await searchSlugsScored(title, ctx)) {
        if (!foundSlugs.includes(slug)) foundSlugs.push(slug);
        if (foundSlugs.length >= MAX_FALLBACK_SLUGS) break;
      }
      if (foundSlugs.length >= MAX_FALLBACK_SLUGS) break;
    }

    const checked = new Set([baseSlug]);
    for (const slug of foundSlugs) {
      if (checked.has(slug)) continue;
      checked.add(slug);
      if (isAborted(ctx.signal) || isBudgetExhausted(startTime, PROVIDER_BUDGET_MS)) break;
      streams.push(...(await fetchSlug(slug, season, episodes, ctx, startTime)));
      if (streams.length > 0) break;
    }
  }

  return streams;
}

export const animesama = createNuvioProvider({
  name: 'animesama',
  sites: [SITE],
  language: 'fr',
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'ja',
});
