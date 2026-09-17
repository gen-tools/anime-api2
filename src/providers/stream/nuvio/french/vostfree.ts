/**
 * Vostfree — French anime and drama catalogue on a DLE build, VF and VOSTFR.
 *
 * Ported from temp/French/French/src/vostfree. Reached through its IPv4 mirror
 * because the apex domain resolves to an address that frequently refuses plain
 * clients. An anime page lists every episode in a `<select>`; picking one reveals
 * a `#buttons_N` block whose `player_*` divs each pair a host name with a bare
 * video id, so the embed URL has to be rebuilt per host family — that mapping is
 * the substance of this port.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  siteFetchText,
  loadHtml,
  deaccent,
  absoluteUrl,
  resolveEmbedsUntil,
  isAborted,
  isBudgetExhausted,
  FR_ACCEPT_LANGUAGE,
} from '../shared.js';

const SITE = 'https://ipv4.vostfree.ws';
const LABEL = 'Vostfree';
const MAX_SEARCH_TITLES = 9;
const MIN_QUERY_LENGTH = 5;
const MAX_MATCHES_TO_PROCESS = 2;

/** Player divs whose host is not one of these are navigation, not video. */
const KNOWN_HOSTS = [
  'sibnet',
  'uqload',
  'oneupload',
  'sendvid',
  'voe',
  'dood',
  'stape',
  'streamtape',
  'myvi',
  'mytv',
  'vidmoly',
  'fsvid',
  'vidzy',
];

/**
 * Hosts that need a browser to give up a direct URL.
 *
 * The original skipped them outright. Toko's resolver library covers voe,
 * streamtape and dood, so they are attempted here — just after the cheap hosts,
 * since they are still the ones most likely to burn the budget.
 */
const SLOW_HOSTS = ['voe', 'streamtape', 'stape', 'dood', 'ds2play', 'bigwar5'];

interface SearchHit {
  title: string;
  url: string;
  genre?: string;
}

/** Comparison form; drops a leading article, which the site omits inconsistently. */
function normalizeTitle(value: string): string {
  if (!value) return '';
  return deaccent(value.toLowerCase())
    .replace(/[':!.,?]/g, '')
    .replace(/\bthe\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Season number stated anywhere in a title or URL.
 *
 * Three shapes because the site is inconsistent: "Saison 3" in titles, "-s3-" in
 * slugs, and a bare number immediately before a language tag ("Overlord 4 VOSTFR").
 */
function getSeasonNumber(text: string): number | null {
  const combined = text.toLowerCase().replace(/-/g, ' ');
  let m = combined.match(/\bsaison\s*(\d+)\b/);
  if (m) return Number.parseInt(m[1], 10);
  m = combined.match(/\bs\s*(\d+)\b/);
  if (m) return Number.parseInt(m[1], 10);
  m = combined.match(/\b(\d+)\s*(?:vostfr|vf|french|ddl|streaming)\b/);
  if (m) return Number.parseInt(m[1], 10);
  return null;
}

/**
 * Whether a search hit is the series that was asked for.
 *
 * The prefix guard is what makes this usable: the catalogue contains "Boruto:
 * Naruto Next Generations", which contains "Naruto" as a substring, so a hit is
 * rejected when significant words appear *before* the query inside it.
 */
function titleMatches(resultTitle: string, searchTitle: string): boolean {
  const nResult = normalizeTitle(resultTitle);
  const nSearch = normalizeTitle(searchTitle);
  if (!nResult || !nSearch) return false;
  if (nResult === nSearch) return true;
  if (nResult.includes(nSearch)) {
    const idx = nResult.indexOf(nSearch);
    const prefix = nResult.slice(0, idx).trim();
    const prefixWords = prefix
      .split(/\s+/)
      .filter(
        (w) =>
          w.length > 2 && !['saison', 'season', 'la', 'le', 'les', 'du', 'de', 'des'].includes(w)
      );
    if (prefixWords.length >= 1) return false;
    return true;
  }
  const searchWords = nSearch.split(/\s+/).filter((w) => w.length > 2);
  if (searchWords.length === 0) return false;
  const matched = searchWords.filter((w) => nResult.includes(w));
  return matched.length >= Math.min(searchWords.length, 2);
}

async function searchAnime(title: string, ctx: NuvioContext): Promise<SearchHit[]> {
  const html = await siteFetchText(`${SITE}/index.php?do=search`, {
    form: { do: 'search', subaction: 'search', story: title },
    headers: { Referer: SITE, Origin: SITE },
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    timeoutMs: 12_000,
    signal: ctx.signal,
  });
  if (!html) return [];

  const $ = loadHtml(html);
  const results: SearchHit[] = [];
  const seen = new Set<string>();

  $('.search-result').each((_, block) => {
    const link = $(block).find('.title a');
    const href = link.attr('href') || '';
    const text = link.text().trim() || link.attr('title') || '';
    const genre = $(block).find('.genre').text().trim().toUpperCase();
    if (!href || href.length <= 10 || !text || text.length <= 2) return;
    if (!href.includes(SITE) && !href.startsWith('/')) return;
    if (seen.has(href)) return;
    seen.add(href);
    const hit: SearchHit = { title: text, url: absoluteUrl(href, SITE) };
    if (genre) hit.genre = genre;
    results.push(hit);
  });

  return results.filter((r) => titleMatches(r.title, title));
}

interface PlayerEntry {
  url: string;
  server: string;
  slow: boolean;
}

/**
 * Rebuild an embed URL from a host name and the bare id the site stores.
 *
 * Only ids are in the markup — the page's JS knows the URL shape for each host —
 * so this table is the difference between a playable source and a number.
 */
function buildEmbedUrl(content: string, elClass: string, playerName: string): string {
  if (content.startsWith('http')) return content;
  const hint = `${elClass} ${playerName.toLowerCase()}`;

  if (hint.includes('sibnet')) return `https://video.sibnet.ru/shell.php?videoid=${content}`;
  if (hint.includes('vidmoly')) return `https://vidmoly.to/embed-${content}.html`;
  if (hint.includes('uqload') || hint.includes('oneupload')) {
    return `https://uqload.com/embed-${content}.html`;
  }
  if (hint.includes('sendvid')) return `https://sendvid.com/embed/${content}`;
  if (hint.includes('voe')) return `https://voe.sx/e/${content}`;
  if (hint.includes('dood')) return `https://dood.to/e/${content}`;
  if (hint.includes('stape') || hint.includes('streamtape')) {
    return `https://streamtape.com/e/${content}`;
  }
  if (hint.includes('myvi') || hint.includes('mytv')) {
    return `https://www.myvi.ru/embed/${content}`;
  }
  // The "vip" slot holds a full URL for some hosts and an opaque token for
  // others; only the recognisable ones are usable.
  if (elClass.includes('vip') && (content.includes('voe.sx') || content.includes('vudeo'))) {
    return content;
  }
  return '';
}

/** Every usable player on one anime page, cheap hosts first. */
function collectPlayers(html: string, episodes: number[], isMovie: boolean): PlayerEntry[] {
  const $ = loadHtml(html);
  let buttonsId: string | null = null;

  if (isMovie) {
    buttonsId = 'buttons_1';
  } else {
    $('select.new_player_selector option').each((_, el) => {
      if (buttonsId) return;
      const text = $(el).text().trim();
      const numMatch = text.match(/[Ee]pisode\s*(0*)(\d+)/i);
      if (!numMatch) return;
      const parsedEp = Number.parseInt(numMatch[1] + numMatch[2], 10);
      if (episodes.includes(parsedEp)) buttonsId = String($(el).attr('value') || '');
    });

    // A page with a selector that does not list the episode is the wrong entry;
    // a page with no selector at all is a single-episode page, so fall through.
    if (!buttonsId && $('select.new_player_selector').length > 0) return [];
  }

  if (!buttonsId) buttonsId = 'buttons_1';

  const players: PlayerEntry[] = [];
  $(`#${buttonsId} div[id^="player_"]`).each((_, el) => {
    const elClass = ($(el).attr('class') || '').toLowerCase();
    const playerName = $(el).text().trim() || 'Player';
    const combined = `${elClass} ${playerName.toLowerCase()}`;
    if (!KNOWN_HOSTS.some((h) => combined.includes(h))) return;

    const playerId = ($(el).attr('id') || '').replace('player_', '');
    const content = $(`#content_player_${playerId}`).text().trim();
    if (!content) return;

    const url = buildEmbedUrl(content, elClass, playerName);
    if (!url.startsWith('http')) return;

    const lower = url.toLowerCase();
    players.push({
      url,
      server: playerName,
      slow: SLOW_HOSTS.some((h) => lower.includes(h)),
    });
  });

  return [...players.filter((p) => !p.slow), ...players.filter((p) => p.slow)];
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];

  const startTime = Date.now();
  const effectiveSeason = ctx.season;
  const episodes = [ctx.episode, ctx.absoluteEpisode].filter(
    (value, index, all): value is number =>
      typeof value === 'number' && value > 0 && all.indexOf(value) === index
  );

  // French titles first: this is a French catalogue, and its index rarely carries
  // the romaji form.
  const isFrenchTitle = (t: string) => /[àâéèêëîïôùûüçœæ']/i.test(t);
  const titlesOrdered = [
    ...ctx.titles.filter(isFrenchTitle),
    ...ctx.titles.filter((t) => !isFrenchTitle(t)),
  ];

  const searchables = titlesOrdered
    .slice(0, MAX_SEARCH_TITLES)
    .filter((t) => t.length <= 60 && t.length >= MIN_QUERY_LENGTH && normalizeTitle(t));

  let allMatches: SearchHit[] = [];
  const seenUrls = new Set<string>();

  for (const title of searchables) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    for (const hit of await searchAnime(title, ctx)) {
      if (seenUrls.has(hit.url)) continue;
      seenUrls.add(hit.url);
      allMatches.push(hit);
    }
    if (allMatches.length > 0) break;
  }

  // One targeted "<title> Saison N" query when nothing found so far names the
  // requested season — cheaper than re-searching every title.
  if (
    ctx.type === 'tv' &&
    effectiveSeason != null &&
    !isAborted(ctx.signal) &&
    !isBudgetExhausted(startTime) &&
    !allMatches.some((m) => getSeasonNumber(`${m.title} ${m.url}`) === effectiveSeason)
  ) {
    const mainTitle =
      titlesOrdered.find((t) => !/[^\x00-\x7F]/.test(t) && t.length >= MIN_QUERY_LENGTH) ||
      titlesOrdered.find((t) => t.length >= MIN_QUERY_LENGTH) ||
      titlesOrdered[0];
    if (mainTitle && mainTitle.length >= MIN_QUERY_LENGTH) {
      for (const hit of await searchAnime(`${mainTitle} Saison ${effectiveSeason}`, ctx)) {
        if (seenUrls.has(hit.url)) continue;
        seenUrls.add(hit.url);
        const hitSeason = getSeasonNumber(`${hit.title} ${hit.url}`);
        if (hitSeason === null || hitSeason === effectiveSeason) allMatches.push(hit);
      }
    }
  }

  if (allMatches.length === 0) return [];

  if (ctx.type === 'tv' && effectiveSeason != null) {
    allMatches = allMatches.sort((a, b) => {
      const hasA = getSeasonNumber(`${a.title} ${a.url}`) === effectiveSeason;
      const hasB = getSeasonNumber(`${b.title} ${b.url}`) === effectiveSeason;
      if (hasA && !hasB) return -1;
      if (!hasA && hasB) return 1;
      return 0;
    });
  }

  const hasCorrectSeason = allMatches.some((m) => {
    const sn = getSeasonNumber(`${m.title} ${m.url}`);
    return sn !== null && sn === effectiveSeason;
  });

  const streams: NuvioStream[] = [];
  const checkedUrls = new Set<string>();
  let processed = 0;

  for (const match of allMatches) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    if (checkedUrls.has(match.url)) continue;
    checkedUrls.add(match.url);
    if (processed >= MAX_MATCHES_TO_PROCESS) break;

    if (ctx.type === 'tv') {
      const skipKeywords = /\b(oav|ova|film|movie)\b/;
      if (
        match.genre === 'FILM' ||
        match.genre === 'OAV' ||
        skipKeywords.test(match.title.toLowerCase()) ||
        skipKeywords.test(match.url.toLowerCase())
      ) {
        continue;
      }

      // A hit that names another season is only worth trying when nothing names
      // the right one.
      const matchSeason = getSeasonNumber(`${match.title} ${match.url}`);
      if (matchSeason !== null && matchSeason !== effectiveSeason && hasCorrectSeason) continue;
    }

    processed++;

    const html = await siteFetchText(match.url, {
      acceptLanguage: FR_ACCEPT_LANGUAGE,
      timeoutMs: 15_000,
      signal: ctx.signal,
    });
    if (!html) continue;

    const players = collectPlayers(html, episodes, ctx.type === 'movie');
    if (players.length === 0) continue;

    // The language is a property of the catalogue entry, not of the player: the
    // site publishes VF and VOSTFR as separate pages.
    const language =
      match.title.toUpperCase().includes(' VF') || match.url.includes('/vf/') ? 'VF' : 'VOSTFR';

    streams.push(
      ...(await resolveEmbedsUntil(
        players.map((p) => ({ url: p.url, server: p.server })),
        {
          language,
          providerLabel: LABEL,
          siteUrl: SITE,
          target: 2,
          signal: ctx.signal,
          budgetMs: 10_000,
        }
      ))
    );

    if (streams.length > 0) break;
  }

  return streams;
}

export const vostfree = createNuvioProvider({
  name: 'vostfree',
  sites: [SITE],
  language: 'fr',
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'ja',
});
