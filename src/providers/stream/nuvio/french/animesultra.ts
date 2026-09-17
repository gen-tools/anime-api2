/**
 * AnimesUltra — French anime catalogue (VF + VOSTFR) on a DataLife Engine install.
 *
 * Ported from temp/French/French/src/animesultra.
 *
 * The entry page ships almost no markup; everything lives behind
 * `engine/ajax/full-story.php?newsId=<id>`, whose JSON `html` field contains both
 * the episode list (`.ep-item`) and a set of `#content_player_*` divs holding raw
 * player ids. Only the divs with a purely numeric id and no letter suffix are
 * Sibnet video ids, and there is exactly one per episode in episode order — so
 * the Nth `.ep-item` maps to the Nth numeric player. That index mapping avoids one
 * page fetch per episode, and the per-episode page (which exposes
 * `.server-item[data-embed]`) is only visited when it fails.
 *
 * The site splits long shows into separate entries per cour, each restarting at
 * episode 1, hence the cumulative-offset pass at the end: it walks the parts in
 * order, subtracting each part's episode count, until the requested number falls
 * inside one of them.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  loadHtml,
  normalize,
  stripSeasonSuffix,
  absoluteUrl,
  siteFetchText,
  siteFetchJson,
  resolveEmbedsUntil,
  isAborted,
  isBudgetExhausted,
  FR_ACCEPT_LANGUAGE,
} from '../shared.js';

const SITE = 'https://ww.animesultra.org';
const LABEL = 'AnimesUltra';

/** Hosts that answer but never serve video: a 502 gateway and a parked domain. */
const DEAD_HOSTS = ['sendvid.com', 'vidstream.pro'];

const MAX_SEARCH_QUERIES = 5;
const MAX_PROCESSED_MATCHES = 8;
const MAX_PROCESSED_SPINOFFS = 6;
/** Two mirrors per language is where the remaining servers stop adding value. */
const TARGET_PER_LANGUAGE = 2;

/** Latin-1 French letters only: the search endpoint 500s on anything else. */
const SEARCHABLE_TITLE = /^[a-zA-Z0-9\sàâéèêëîïôùûüç'\-:!.,?()ÀÂÉÈÊËÎÏÔÙÛÜÇ]+$/;

/**
 * A colon or spaced dash not followed by a number or season word marks a spin-off
 * ("Naruto: Shippuden" style derivatives), which must lose to the plain entry.
 */
const SPINOFF = /(?:\s*:\s*|\s+-\s+)(?!\d|saison|partie|part)/i;

const SEASON_PATTERNS = [
  /saison\s*(\d+)/i,
  /\bfin[ae]l\s+season\b/i,
  /\bS(\d+)\b/i,
  /\b(\d+)\s*(?:vf|vostfr)\s*$/i,
  /\bCour\s*(\d+)\b/i,
  /\bPart\s*(\d+)\b/i,
];

interface Match {
  title: string;
  url: string;
  score: number;
}

interface Embed {
  url: string;
  language: string;
  server: string;
}

interface EpItem {
  num: number;
  href: string;
}

function isDeadHost(url: string): boolean {
  const value = (url || '').toLowerCase();
  return DEAD_HOSTS.some((host) => value.includes(host));
}

/**
 * Score a catalogue title, penalising breadth.
 *
 * Entries are suffixed with their language ("Bleach VF"), which is stripped before
 * comparison, and each word the result adds beyond the query costs 15 points up to
 * a 60-point cap — enough to demote a spin-off without sinking a legitimate
 * "Saison 2" suffix.
 */
function scoreSearchMatch(resultTitle: string, searchTitle: string): number {
  const nResult = normalize(resultTitle.replace(/ (VF|VOSTFR)$/i, ''));
  const nSearch = normalize(searchTitle);
  if (!nResult || !nSearch) return 0;

  let score = 0;
  if (nResult === nSearch) score += 150;
  else if (nResult.includes(nSearch) || nSearch.includes(nResult)) score += 100;

  const resultWords = new Set(nResult.split(/\s+/).filter(Boolean));
  const searchWords = nSearch.split(/\s+/).filter(Boolean);
  const matched = searchWords.filter((w) => resultWords.has(w)).length;
  if (searchWords.length > 0) score += (matched / searchWords.length) * 50;

  const extra = resultWords.size - searchWords.length;
  if (extra > 0) score -= Math.min(extra * 15, 60);
  return score;
}

/** The site encodes language in the title suffix and in `/anime-vf/` style paths. */
function detectLang(title: string, url = ''): 'vf' | 'vostfr' | null {
  const t = (title || '').trim();
  const u = (url || '').toLowerCase();
  if (/\bVF\b/i.test(t)) return 'vf';
  if (/\bVOSTFR?\b/i.test(t)) return 'vostfr';
  if (/\bFrench\b/i.test(t)) return 'vf';
  if (/\/anime-vf\//i.test(u) || /-vf(?:\/|$|\.)/i.test(u) || /\/vf\//i.test(u)) return 'vf';
  if (/\/anime-vostfr\//i.test(u) || /-vostfr?(?:\/|$|\.)/i.test(u) || /\/vostfr?\//i.test(u)) {
    return 'vostfr';
  }
  return null;
}

function detectSeason(title: string, url = ''): number | 'final' | null {
  for (let i = 0; i < SEASON_PATTERNS.length; i++) {
    const m = title.match(SEASON_PATTERNS[i]);
    if (m) {
      // "Final Season" has no number to capture; treat it as a late season.
      if (i === 1) return 'final';
      return Number.parseInt(m[1], 10);
    }
  }
  const urlSeason =
    url.match(/saison[-\s]*(\d+)/i)?.[1] || url.match(/cour[-\s]*(\d+)/i)?.[1];
  if (urlSeason) return Number.parseInt(urlSeason, 10);

  const numEnd = title.match(/(?:^|\s)(\d{1,2})\s*(?:vf|vostfr)?\s*$/i);
  if (numEnd) {
    const v = Number.parseInt(numEnd[1], 10);
    if (v >= 1 && v <= 30) return v;
  }
  return null;
}

function newsIdOf(url: string): string | null {
  return url.match(/\/(\d+)-/)?.[1] ?? null;
}

async function searchAnime(
  title: string,
  signal: AbortSignal
): Promise<Match[]> {
  const url = `${SITE}/index.php?do=search&subaction=search&story=${encodeURIComponent(title)}`;
  const html = await siteFetchText(url, {
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    timeoutMs: 8_000,
    signal,
  });
  if (!html) return [];

  const $ = loadHtml(html);
  const results: Match[] = [];
  const seen = new Set<string>();

  const add = (href: string, resultTitle: string): void => {
    const key = href || resultTitle;
    if (!href || href.length <= 5 || !resultTitle || seen.has(key)) return;
    const score = scoreSearchMatch(resultTitle, title);
    if (score < 30) return;
    seen.add(key);
    results.push({
      title: resultTitle,
      url: href.startsWith('http') ? href : SITE + href,
      score,
    });
  };

  $('a.film-poster-ahref.item-qtip').each((_i, el) => {
    const t = $(el).attr('title');
    const id = $(el).attr('data-id');
    const href = $(el).attr('href');
    // The page ships the qtip template itself as an element; skip the placeholder.
    if (t && id && id.length > 0 && !t.includes("' + item.name + '")) {
      add(href || t, t);
    }
  });

  if (results.length === 0) {
    $('a[href*="-au.html"]').each((_i, el) => {
      const h = $(el).attr('href');
      const t = $(el).attr('title') || $(el).text().trim();
      if (h && t && !t.includes('Surprenez-moi')) add(h, t);
    });
  }

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Fetch the entry's real markup.
 *
 * `full-story.php` returns `{ html }`; the surrounding page is a shell that loads
 * it over XHR, so the episode list is unreachable without this call.
 */
async function fetchFullStory(
  newsId: string,
  cache: Map<string, string | null>,
  signal: AbortSignal
): Promise<string | null> {
  const hit = cache.get(newsId);
  if (hit !== undefined) return hit;

  const data = await siteFetchJson<{ html?: string }>(
    `${SITE}/engine/ajax/full-story.php?newsId=${newsId}`,
    { acceptLanguage: FR_ACCEPT_LANGUAGE, timeoutMs: 10_000, signal }
  );
  const html = data?.html || null;
  cache.set(newsId, html);
  return html;
}

function parseEpItems(html: string): EpItem[] {
  const $ = loadHtml(html);
  const items: EpItem[] = [];
  $('.ep-item').each((_i, el) => {
    const num = Number.parseInt($(el).attr('data-number') || '', 10);
    const href = absoluteUrl($(el).attr('href') || '', SITE);
    if (Number.isFinite(num)) items.push({ num, href });
  });
  return items;
}

/**
 * Sibnet video ids embedded in the entry markup, in episode order.
 *
 * The suffixed variants (`content_player_123vidc`, `…vo`, `…se`) point at hosts
 * that are dead or unresolvable, so only the bare numeric ids are kept.
 */
function parseSibnetPlayers(html: string): string[] {
  const cpRegex = /<div id="content_player_(\d+)([a-z]*)"[^>]*>([^<]+)<\/div>/gi;
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = cpRegex.exec(html)) !== null) {
    const value = match[3].trim();
    if (!match[2] && /^[0-9]+$/.test(value)) out.push(value);
  }
  return out;
}

/** Read an episode page's servers, newest markup shape first. */
async function fetchEpisodeServers(
  epHref: string,
  language: string,
  signal: AbortSignal
): Promise<Embed[]> {
  const html = await siteFetchText(epHref, {
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    timeoutMs: 10_000,
    signal,
  });
  if (!html) return [];

  const $ = loadHtml(html);
  const servers: Embed[] = [];

  $('.server-item').each((i, el) => {
    const embed = $(el).attr('data-embed');
    const name = $(el).text().trim() || `Server_${i + 1}`;
    if (embed && embed.startsWith('http') && !isDeadHost(embed)) {
      servers.push({ url: embed, language, server: name });
    }
  });
  if (servers.length > 0) return servers;

  $('[id^="content_player_"]').each((_i, el) => {
    const id = $(el).attr('id') || '';
    let url = $(el).text().trim();
    if (!url) return;
    if (/^[0-9]+$/.test(url)) url = `https://video.sibnet.ru/shell.php?videoid=${url}`;
    if (isDeadHost(url) || !url.startsWith('http')) return;
    const suffix = id.replace('content_player_', '').replace(/\d+/, '');
    servers.push({
      url,
      language,
      server: suffix ? suffix.toUpperCase() : 'Sibnet',
    });
  });
  if (servers.length > 0) return servers;

  $('iframe[src]').each((_i, el) => {
    const src = $(el).attr('src') || '';
    if (src.startsWith('http') && !src.includes('google') && !src.includes('disqus')) {
      servers.push({ url: src, language, server: 'iframe' });
    }
  });

  return servers;
}

/** Build the ordered, deduped list of search queries. */
function buildSearchQueries(titles: string[]): string[] {
  const queryKey = (t: string): string =>
    t.toLowerCase().replace(/[^a-z0-9àâéèêëîïôùûüç]/g, '').replace(/[.]+$/, '');

  const dedup = new Set<string>();
  return titles
    .filter((t) => {
      if (!t || t.length > 50 || t.length < 5) return false;
      if (!SEARCHABLE_TITLE.test(t)) return false;
      const key = queryKey(t);
      if (dedup.has(key)) return false;
      dedup.add(key);
      return true;
    })
    .sort((a, b) => {
      // Primary title, then French-looking titles (the site indexes French
      // names), then shortest — broad queries return more usable candidates.
      const isName = (t: string): boolean => t === titles[0];
      const isFr = (t: string): boolean =>
        /[àâéèêëîïôùûüçÀÂÉÈÊËÎÏÔÙÛÜÇ]/.test(t) || t.toLowerCase().startsWith("l'");
      const sa = isName(a) ? 0 : isFr(a) ? 1 : 2;
      const sb = isName(b) ? 0 : isFr(b) ? 1 : 2;
      return sa - sb || a.length - b.length;
    })
    .slice(0, MAX_SEARCH_QUERIES);
}

function seasonDisqualifies(
  match: Match,
  season: number | undefined
): boolean {
  if (!season) return false;
  const detected = detectSeason(match.title, match.url);
  if (detected == null) return false;
  // "Final Season" only makes sense for a long-running show.
  if (detected === 'final') return season < 6;
  return detected !== season;
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  const startTime = Date.now();
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];

  const season = ctx.season;
  const targets = [ctx.episode, ctx.absoluteEpisode].filter(
    (n): n is number => typeof n === 'number' && n > 0
  );
  const targetEpisodes = [...new Set(targets.length > 0 ? targets : [1])];

  const matches: Match[] = [];
  const seenIds = new Set<string>();
  const searched = new Set<string>();

  const trySearchTitle = async (title: string): Promise<void> => {
    if (!title || title.length > 50) return;
    const clean = stripSeasonSuffix(title);
    if (!clean || clean.length < 3 || !SEARCHABLE_TITLE.test(clean)) return;
    if (searched.has(clean)) return;
    searched.add(clean);
    for (const r of await searchAnime(clean, ctx.signal)) {
      const id = newsIdOf(r.url);
      if (id && !seenIds.has(id)) {
        seenIds.add(id);
        matches.push(r);
      }
    }
  };

  // Sequential with early exit: the primary title is the most reliable query, so
  // a hit on it makes the alternates redundant.
  for (const query of buildSearchQueries(ctx.titles)) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    await trySearchTitle(query);
    if (matches.length > 0) break;
  }

  if (matches.length === 0 && season && !isBudgetExhausted(startTime)) {
    const base = ctx.titles.find((t) => t.length > 3);
    if (base) {
      await trySearchTitle(`${base} Saison ${season}`);
      await trySearchTitle(`${base} Season ${season}`);
    }
  }

  // Every candidate being a spin-off means the query matched a derivative rather
  // than the show; one more pass with a non-spin-off alternate title can recover.
  const isSpinoff = (m: Match): boolean =>
    SPINOFF.test(m.title.replace(/ (VF|VOSTFR)$/i, ''));
  if (
    matches.length > 0 &&
    matches.every(isSpinoff) &&
    !isBudgetExhausted(startTime)
  ) {
    for (const t of ctx.titles) {
      if (t.replace(/[^a-z0-9àâéèêëîïôùûüç]/gi, '').length < 4) continue;
      if (!SEARCHABLE_TITLE.test(t)) continue;
      if (SPINOFF.test(t.replace(/ (VF|VOSTFR)$/i, ''))) continue;
      await trySearchTitle(t);
      break;
    }
  }

  if (matches.length === 0) return [];

  matches.sort((a, b) => {
    const aSeason = detectSeason(a.title, a.url);
    const bSeason = detectSeason(b.title, b.url);
    const aMatches = typeof aSeason === 'number' && aSeason === season;
    const bMatches = typeof bSeason === 'number' && bSeason === season;
    if (aMatches !== bMatches) return aMatches ? -1 : 1;
    // A generic entry (no season in the title) covers the whole show, so prefer
    // it over anything that pinned itself to a different season.
    if (aSeason === null && bSeason !== null) return -1;
    if (aSeason !== null && bSeason === null) return 1;
    return (
      a.title.replace(/ (VF|VOSTFR)$/i, '').length -
      b.title.replace(/ (VF|VOSTFR)$/i, '').length
    );
  });

  const fullStoryCache = new Map<string, string | null>();
  const embeds: Embed[] = [];
  const seenEmbeds = new Set<string>();

  const pushEmbed = (rawUrl: string, language: string, server: string): void => {
    let url = rawUrl;
    // Sibnet is stored as a bare video id in several places.
    if (/^[0-9]+$/.test(url)) url = `https://video.sibnet.ru/shell.php?videoid=${url}`;
    const key = `${url}|${language}`;
    if (!url || seenEmbeds.has(key) || isDeadHost(url)) return;
    seenEmbeds.add(key);
    embeds.push({ url, language, server });
  };

  const spinoffCandidates: Match[] = [];
  let processed = 0;

  for (const match of matches) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    if (!match.url || processed >= MAX_PROCESSED_MATCHES) break;
    if (isSpinoff(match)) {
      spinoffCandidates.push(match);
      continue;
    }
    if (seasonDisqualifies(match, season)) continue;

    const language = detectLang(match.title, match.url) === 'vf' ? 'VF' : 'VOSTFR';
    const newsId = newsIdOf(match.url);
    if (!newsId) continue;

    const html = await fetchFullStory(newsId, fullStoryCache, ctx.signal);
    if (!html) continue;

    const epItems = parseEpItems(html);
    const sibnetPlayers = parseSibnetPlayers(html);
    let found = false;

    for (const target of targetEpisodes) {
      if (found) break;
      const idx = epItems.findIndex((e) => e.num === target);
      if (idx < 0 || idx >= sibnetPlayers.length) continue;
      pushEmbed(sibnetPlayers[idx], language, 'Sibnet');
      found = true;
    }

    if (!found) {
      for (const item of epItems) {
        if (found) break;
        if (!item.href || !targetEpisodes.includes(item.num)) continue;
        const servers = await fetchEpisodeServers(item.href, language, ctx.signal);
        if (servers.length === 0) continue;
        found = true;
        for (const s of servers) pushEmbed(s.url, s.language, s.server);
      }
    }

    if (found) processed++;
  }

  // Only fall back to spin-off entries when nothing else produced a candidate.
  if (embeds.length === 0 && spinoffCandidates.length > 0) {
    for (const match of spinoffCandidates) {
      if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
      if (processed >= MAX_PROCESSED_SPINOFFS) break;
      if (seasonDisqualifies(match, season)) continue;

      const language = detectLang(match.title, match.url) === 'vf' ? 'VF' : 'VOSTFR';
      const newsId = newsIdOf(match.url);
      if (!newsId) continue;
      const html = await fetchFullStory(newsId, fullStoryCache, ctx.signal);
      if (!html) continue;

      const hrefs = parseEpItems(html)
        .filter((e) => e.href && targetEpisodes.includes(e.num))
        .map((e) => e.href);
      if (hrefs.length === 0) continue;
      processed++;

      for (const href of hrefs) {
        for (const s of await fetchEpisodeServers(href, language, ctx.signal)) {
          pushEmbed(s.url, s.language, s.server);
        }
      }
    }
  }

  // Split-cour fallback: each part restarts at episode 1, so walk the parts in
  // order and subtract their episode counts until the request lands inside one.
  if (
    embeds.length === 0 &&
    season &&
    matches.length > 1 &&
    !isAborted(ctx.signal) &&
    !isBudgetExhausted(startTime)
  ) {
    interface Part {
      partNum: number;
      language: string;
      html: string;
    }
    const parts: Part[] = [];
    const seenParts = new Set<string>();

    for (const m of matches) {
      if (detectSeason(m.title, m.url) !== season) continue;
      const newsId = newsIdOf(m.url);
      if (!newsId) continue;
      const partNum =
        Number.parseInt(m.title.match(/(?:partie|part)\s*(\d+)/i)?.[1] || '', 10) || 1;
      const language = detectLang(m.title, m.url) === 'vf' ? 'VF' : 'VOSTFR';
      const key = `${partNum}-${language}`;
      if (seenParts.has(key)) continue;
      seenParts.add(key);
      const html = await fetchFullStory(newsId, fullStoryCache, ctx.signal);
      if (html) parts.push({ partNum, language, html });
    }

    parts.sort((a, b) => a.partNum - b.partNum);
    const partNumbers = [...new Set(parts.map((p) => p.partNum))];

    let offset = 0;
    for (const partNum of partNumbers) {
      const group = parts.filter((p) => p.partNum === partNum);
      const epCount = parseEpItems(group[0].html).length;
      const local = targetEpisodes
        .map((t) => t - offset)
        .filter((t) => t >= 1 && t <= epCount);

      if (local.length > 0) {
        for (const part of group) {
          const hrefs = parseEpItems(part.html)
            .filter((e) => e.href && local.includes(e.num))
            .map((e) => e.href);
          for (const href of hrefs) {
            for (const s of await fetchEpisodeServers(href, part.language, ctx.signal)) {
              pushEmbed(s.url, s.language, s.server);
            }
          }
        }
        break;
      }
      offset += epCount;
    }
  }

  if (embeds.length === 0) return [];

  const out: NuvioStream[] = [];
  for (const language of [...new Set(embeds.map((e) => e.language))]) {
    if (isAborted(ctx.signal)) break;
    const resolved = await resolveEmbedsUntil(
      embeds.filter((e) => e.language === language),
      {
        language,
        providerLabel: LABEL,
        siteUrl: SITE,
        target: TARGET_PER_LANGUAGE,
        signal: ctx.signal,
      }
    );
    out.push(...resolved.filter((s) => !isDeadHost(s.url)));
  }
  return out;
}

export const animesultra = createNuvioProvider({
  name: 'animesultra',
  sites: [SITE],
  language: 'fr',
  extract,
  defaultAudioLanguage: 'ja',
});
