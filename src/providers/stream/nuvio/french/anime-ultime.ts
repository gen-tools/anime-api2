/**
 * Anime-Ultime — long-running French fansub archive (VOSTFR, some VF).
 *
 * Ported from temp/French/French/src/anime-ultime.
 *
 * The site is unusual in two ways. It numbers episodes absolutely across a whole
 * series — there are no per-season pages for most entries — so `ctx.absoluteEpisode`
 * is tried before `ctx.episode`. And it serves video from its own CDN rather than
 * third-party embeds: two form POSTs (`MenuSearch.html` to search,
 * `VideoPlayer.html` to open a file) return JSON, the second of which carries a
 * direct MP4 URL plus a playlist of every other file in the series.
 *
 * That playlist is why an "anchor" episode exists: opening any episode of a series
 * reveals the ids of all the others, so a requested episode that has no link on
 * the series page can still be reached with a second POST.
 *
 * Licensed series return `{"error": "Série licenciée"}`. That is a definitive "the
 * site has this show but will not serve it", so the lookup stops there instead of
 * drifting onto alternate titles and matching something unrelated.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  normalize,
  toSlug,
  stripSeasonSuffix,
  siteFetchText,
  siteFetchJson,
  toStream,
  isAborted,
  isBudgetExhausted,
  FR_ACCEPT_LANGUAGE,
} from '../shared.js';

const SITE = 'https://v5.anime-ultime.net';
const LABEL = 'Anime-Ultime';

const MAX_SEARCH_TITLES = 6;
const POST_TIMEOUT_MS = 8_000;

interface SearchHit {
  title: string;
  url: string;
  type: string;
  format: string;
  number: string;
}

interface EpisodeLink {
  href: string;
  num: number;
  lang: 'vf' | 'vostfr';
  fansub: string;
}

interface SeriesPage {
  serieId: string | null;
  /** Present on single-file pages (films), where there is no episode list. */
  directFocus: string | null;
  epLinks: EpisodeLink[];
}

interface PlaylistEntry {
  id?: string | number;
  title?: string;
}

interface PlayerResponse {
  error?: string;
  quality?: string;
  title?: string;
  playlist?: PlaylistEntry[];
  [quality: string]: unknown;
}

interface Mp4Source {
  url: string;
  quality: string;
}

/** POST a urlencoded body and parse the JSON reply. */
async function postForm<T>(
  path: string,
  form: Record<string, string>,
  signal: AbortSignal
): Promise<T | null> {
  return siteFetchJson<T>(`${SITE}${path}`, {
    form,
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    timeoutMs: POST_TIMEOUT_MS,
    signal,
  });
}

/**
 * Rank a search hit.
 *
 * The `format` field is the useful part: a TV request that lands on an OST or OAV
 * entry is a false positive (the "One Piece" OST outscores the series on title
 * alone), and a season number in the title is a strong signal because the site
 * splits some long shows into `saison N` entries.
 */
function scoreSearchResult(
  result: SearchHit,
  query: string,
  season: number | undefined
): number {
  const q = normalize(query);
  const t = normalize(result.title);
  if (!q || !t) return 0;

  let score = 0;
  if (t === q) score += 100;
  else if (t.includes(q) || q.includes(t)) score += 60;

  const qWords = q.split(/\s+/).filter((w) => w.length > 2);
  const tWords = t.split(/\s+/);
  for (const w of qWords) {
    if (tWords.includes(w)) score += 12;
  }

  const fmt = (result.format || '').toUpperCase();
  if (fmt === 'OAV' || fmt === 'OST') score -= 25;
  if (fmt === 'FILM') score -= 10;

  if (Number.isFinite(season)) {
    const sm = (result.title || '').match(/saison\s*(\d+)/i);
    if (sm) score += Number.parseInt(sm[1], 10) === season ? 50 : -20;
  }
  return score;
}

async function searchSite(query: string, signal: AbortSignal): Promise<SearchHit[]> {
  const data = await postForm<unknown>('/MenuSearch.html', { search: query }, signal);
  if (!Array.isArray(data)) return [];
  return (data as Array<Record<string, unknown>>)
    .map((r) => ({
      title: String(r.title || '')
        .replace(/&amp;/g, '&')
        .replace(/&#\d+;/g, '')
        .trim(),
      url: String(r.url || ''),
      type: String(r.type || ''),
      format: String(r.format || ''),
      number: String(r.number || ''),
    }))
    .filter((r) => r.url && r.title);
}

async function fetchSeriesPage(
  url: string,
  signal: AbortSignal
): Promise<SeriesPage | null> {
  const html = await siteFetchText(url, {
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    signal,
  });
  if (!html) return null;

  const serieId = html.match(/data-serie="(\d+)"/)?.[1] ?? null;
  const directFocus = html.match(/data-focus="(\d+)"/)?.[1] ?? null;

  // Episode hrefs are relative and self-describing:
  // "Titre-streaming-Episode-07-vostfr-par-Fansub.html".
  const epLinks: EpisodeLink[] = [];
  const seen = new Set<string>();
  const hrefRegex = /href="([^"]+)"/gi;
  let hrefMatch: RegExpExecArray | null;
  while ((hrefMatch = hrefRegex.exec(html)) !== null) {
    const href = hrefMatch[1];
    const m = href.match(/Episode-(\d+)-(vostfr|vf)-par-([^".]+)\.html/i);
    if (!m) continue;
    const num = Number.parseInt(m[1], 10);
    const lang = m[2].toLowerCase() as 'vf' | 'vostfr';
    const key = `${num}-${lang}`;
    if (seen.has(key)) continue;
    seen.add(key);
    epLinks.push({ href, num, lang, fansub: m[3] });
  }

  return { serieId, directFocus, epLinks };
}

async function fetchEpisodeFocus(
  url: string,
  signal: AbortSignal
): Promise<string | null> {
  const html = await siteFetchText(url, {
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    signal,
  });
  return html?.match(/data-focus="(\d+)"/)?.[1] ?? null;
}

/** Distinguishes "site refuses this show" from "request failed". */
const LICENSED = Symbol('licensed');

async function fetchPlayer(
  serieId: string,
  focusFile: string,
  signal: AbortSignal
): Promise<PlayerResponse | typeof LICENSED | null> {
  const data = await postForm<PlayerResponse>(
    '/VideoPlayer.html',
    { idserie: serieId, focusFile },
    signal
  );
  if (data?.error) {
    return typeof data.error === 'string' && data.error.toLowerCase().includes('licenci')
      ? LICENSED
      : null;
  }
  return data;
}

/** The MP4 lives under a resolution-named key ("1080p"), not a fixed field. */
function extractMp4Url(data: PlayerResponse | null): Mp4Source | null {
  if (!data || typeof data !== 'object') return null;
  const q = data.quality || Object.keys(data).find((k) => /^\d+p$/.test(k));
  if (!q) return null;
  const bucket = data[q] as { mp4?: { url?: string } } | undefined;
  const url = bucket?.mp4?.url;
  if (!url) return null;
  return { url, quality: q };
}

function findPlaylistEntry(
  playlist: PlaylistEntry[],
  targetNums: number[]
): PlaylistEntry | null {
  for (const num of targetNums) {
    const byTitle = playlist.find((p) => {
      const m = String(p.title || '').match(/(\d+)/);
      return m ? Number.parseInt(m[1], 10) === num : false;
    });
    if (byTitle) return byTitle;
  }
  return null;
}

/**
 * Build the stream for one MP4 source.
 *
 * The CDN URL has no file extension (`strhq-fr.anime-ultime.net/TOKEN/…`), which
 * makes every downstream consumer guess wrong about the content type. Appending
 * `v=.mp4` — a parameter the CDN ignores — makes it self-describing, and no host
 * resolver is needed because the URL is already the media.
 */
function buildStream(
  player: PlayerResponse,
  mp4: Mp4Source,
  lang: string
): NuvioStream {
  const url = (mp4.url.includes('?') ? `${mp4.url}&` : `${mp4.url}?`) + 'v=.mp4';
  const tag = lang.toUpperCase();
  return toStream(url, tag, LABEL, SITE, {
    quality: mp4.quality || player.quality || 'HD',
    title: player.title ? `${player.title} - ${tag}` : `${LABEL} ${tag}`,
    server: 'Anime-Ultime CDN',
    type: 'mp4',
    // The CDN validates against the catalogue origin, not its own.
    headers: { Referer: `${SITE}/`, Origin: SITE },
  });
}

interface ResolveOutcome {
  streams: NuvioStream[];
  licensed: boolean;
}

/**
 * Resolve one series page for one language.
 *
 * The anchor is the requested episode's own link when it exists; otherwise any
 * link at all, purely to obtain the series' playlist. When the anchor is not the
 * target its language may differ from the requested one, so the stream is labelled
 * with the anchor's actual language rather than the language being searched for.
 */
async function resolveSeries(
  page: SeriesPage,
  type: 'movie' | 'tv',
  episodeNums: number[],
  lang: 'vf' | 'vostfr',
  signal: AbortSignal
): Promise<ResolveOutcome> {
  const empty: ResolveOutcome = { streams: [], licensed: false };
  if (!page.serieId) return empty;

  if (type === 'movie') {
    const focus =
      page.directFocus ||
      (page.epLinks.length > 0
        ? await fetchEpisodeFocus(`${SITE}/${page.epLinks[0].href}`, signal)
        : null);
    if (!focus) return empty;

    const player = await fetchPlayer(page.serieId, focus, signal);
    if (player === LICENSED) return { streams: [], licensed: true };
    const mp4 = extractMp4Url(player);
    if (!player || !mp4) return empty;
    const filmLang = page.epLinks.length > 0 ? page.epLinks[0].lang : 'vf';
    return { streams: [buildStream(player, mp4, filmLang)], licensed: false };
  }

  const anchor =
    page.epLinks.find((l) => episodeNums.includes(l.num) && l.lang === lang) ||
    page.epLinks.find((l) => episodeNums.includes(l.num)) ||
    page.epLinks.find((l) => l.lang === lang) ||
    page.epLinks[0];
  if (!anchor) return empty;

  const focus = await fetchEpisodeFocus(`${SITE}/${anchor.href}`, signal);
  if (!focus) return empty;

  const player = await fetchPlayer(page.serieId, focus, signal);
  if (player === LICENSED) return { streams: [], licensed: true };
  if (!player) return empty;

  const streams: NuvioStream[] = [];
  const isAnchorTarget = episodeNums.includes(anchor.num);
  if (isAnchorTarget) {
    const mp4 = extractMp4Url(player);
    if (mp4) streams.push(buildStream(player, mp4, anchor.lang));
  }

  if (episodeNums.length > 0 && (!isAnchorTarget || streams.length === 0)) {
    const playlist = Array.isArray(player.playlist) ? player.playlist : [];
    const entry = findPlaylistEntry(playlist, episodeNums);
    if (entry?.id != null) {
      const targetPlayer = await fetchPlayer(page.serieId, String(entry.id), signal);
      if (targetPlayer === LICENSED) return { streams: [], licensed: true };
      const mp4 = extractMp4Url(targetPlayer);
      if (targetPlayer && mp4) streams.push(buildStream(targetPlayer, mp4, lang));
    }
  }

  return { streams, licensed: false };
}

/**
 * Locate a series page for one title.
 *
 * The generated-slug probes exist because `MenuSearch` does not index everything;
 * the season variants cover the entries the site publishes as separate pages.
 */
async function findSeriesForTitle(
  title: string,
  type: 'movie' | 'tv',
  season: number | undefined,
  signal: AbortSignal,
  startTime: number
): Promise<SeriesPage | null> {
  const results = await searchSite(title, signal);
  const scored = results
    .map((r) => ({ ...r, score: scoreSearchResult(r, title, season) }))
    .sort((a, b) => b.score - a.score);

  for (const r of scored) {
    if (r.score < 40) continue;
    const fmt = (r.format || '').toUpperCase();
    if (type === 'tv' && (fmt === 'OST' || fmt === 'OAV' || fmt === 'FILM')) continue;
    if (type === 'movie' && fmt !== 'FILM' && fmt !== 'EPISODE') continue;
    if (isAborted(signal) || isBudgetExhausted(startTime)) break;

    const pageUrl = r.url.startsWith('http') ? r.url : SITE + r.url;
    const page = await fetchSeriesPage(pageUrl, signal);
    if (page?.serieId) return page;
  }

  if (isAborted(signal) || isBudgetExhausted(startTime)) return null;

  const slug = toSlug(title);
  if (!slug) return null;
  const candidates = [`${slug}-streaming.html`, `${slug}-saison-1-streaming.html`];
  if (season && season > 1) {
    candidates.push(`${slug}-saison-${season}-streaming.html`);
    candidates.push(`${slug}-${season}-streaming.html`);
  }
  for (const candidate of candidates) {
    if (isAborted(signal) || isBudgetExhausted(startTime)) break;
    const page = await fetchSeriesPage(`${SITE}/${candidate}`, signal);
    if (page?.serieId) return page;
  }

  return null;
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  const startTime = Date.now();
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];

  // Absolute first: the site's episode numbers run across the whole series, so a
  // season-2 episode 3 is listed as (say) episode 15.
  const targets = [ctx.absoluteEpisode, ctx.episode].filter(
    (n): n is number => typeof n === 'number' && n > 0
  );
  const episodeNums = [...new Set(targets)];

  const langOrder: Array<'vf' | 'vostfr'> =
    ctx.type === 'movie' ? ['vf'] : ['vostfr', 'vf'];

  // Collapse "Titre Season 1" / "Titre S1" variants of one name so the top N
  // search titles include the real alternates (romaji, French) rather than four
  // spellings of the same English title.
  const seenBase = new Set<string>();
  const titlePool: string[] = [];
  for (const t of ctx.titles) {
    const base = stripSeasonSuffix(t).toLowerCase();
    if (seenBase.has(base)) continue;
    seenBase.add(base);
    titlePool.push(t);
  }

  const streams: NuvioStream[] = [];
  const seenUrls = new Set<string>();

  for (const title of (titlePool.length > 0 ? titlePool : ctx.titles).slice(
    0,
    MAX_SEARCH_TITLES
  )) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    if (streams.length > 0) break;

    const page = await findSeriesForTitle(
      title,
      ctx.type,
      ctx.season,
      ctx.signal,
      startTime
    );
    if (!page) continue;

    // Both languages are collected rather than stopping at the first that works:
    // VF and VOSTFR are different audio, and the Watch page offers them as
    // separate tabs.
    for (const lang of langOrder) {
      if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
      const outcome = await resolveSeries(page, ctx.type, episodeNums, lang, ctx.signal);
      if (outcome.licensed) return [];
      for (const s of outcome.streams) {
        if (s.url && !seenUrls.has(s.url)) {
          seenUrls.add(s.url);
          streams.push(s);
        }
      }
    }
  }

  return streams;
}

export const animeultime = createNuvioProvider({
  name: 'animeultime',
  sites: [SITE],
  language: 'fr',
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'ja',
});
