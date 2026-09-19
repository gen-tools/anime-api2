/**
 * Mugiwara Streaming — French anime catalogue (mugiwara-no-streaming.com)
 * carrying both VF dubs and VOSTFR subs, with a separate page per season.
 *
 * Ported from temp/French/French/src/mugiwarastream. The site is a Next.js App
 * Router app and never puts player URLs in the markup: they ship inside the
 * React Flight payload, split across many `self.__next_f.push([1,"…"])` string
 * literals that have to be concatenated and JS-unescaped before the
 * `"animeServer"` object can be brace-matched out of the result. That decoder is
 * the bulk of this file and there is no shortcut — the DOM is empty.
 *
 * Two site quirks matter. Newer catalogue entries expose `langToShow` instead of
 * `lang`, meaning the URLs are fetched client-side and simply are not in the
 * payload, so those pages are abandoned in favour of the next candidate slug.
 * And season keys are arbitrary strings ("2", "2-1", "kai"), so mapping a TMDB
 * season onto one needs the exact → sub-season → ordinal → cumulative ladder in
 * `matchSaison` rather than an index lookup.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  siteFetchText,
  siteFetchJson,
  normalize,
  toSlug,
  resolveEmbedsUntil,
  isAborted,
  isBudgetExhausted,
  FR_ACCEPT_LANGUAGE,
} from '../shared.js';

const SITE = 'https://www.mugiwara-no-streaming.com';
const LABEL = 'Mugiwara';

/** Max titles pushed through the search API before giving up on slug discovery. */
const MAX_SLUG_SEARCH = 5;

/**
 * Position in each season's source array → host name.
 *
 * The payload stores one array per player slot with no labels, and the slot
 * order is fixed site-wide. `detectHostLabel` still overrides this from the URL
 * when it can, because a slot occasionally carries a different host.
 */
const SOURCE_LABELS = ['Sibnet', 'Vidmoly', 'Sendvid', 'VK', 'Youtube', 'Other'];

/**
 * Hosts this site still links but that stopped serving.
 *
 * Skipped before resolution: each dead host otherwise costs a full request plus
 * timeout, and the site lists them on nearly every episode.
 */
const DEAD_HOSTS = ['sendvid.com', 'uqload.co', 'uqload.bz', 'uqload.to', 'oneupload.to'];

type SourceMatrix = Array<Array<string | null>>;

interface MugiwaraSaison {
  id: string;
  name?: string;
  notASeason?: boolean;
  lang?: Record<string, SourceMatrix>;
  /** Present instead of `lang` on entries whose URLs load client-side. */
  langToShow?: unknown;
}

interface MugiwaraFilmOptions {
  lang?: Record<string, SourceMatrix>;
  names?: Array<{ name?: string }>;
}

interface MugiwaraAnimeServer {
  options?: {
    saisons?: MugiwaraSaison[];
    FILM_OPTIONS?: MugiwaraFilmOptions;
  };
}

interface MugiwaraSearchHit {
  anime?: string;
  matched?: string;
  slug?: string;
}

interface MugiwaraSearchResponse {
  results?: MugiwaraSearchHit[];
}

// ── Flight payload decoding ──────────────────────────────────────────────────

/**
 * Concatenate and unescape every React Flight chunk on the page.
 *
 * The chunks are JS string literals, so the payload is walked character by
 * character: a regex cannot be used because a chunk legitimately contains
 * `"])`-looking sequences inside escaped strings, and the terminator is only
 * real when it is not preceded by a backslash.
 */
function extractPushContent(html: string): string {
  const chunks: string[] = [];
  const marker = 'self.__next_f.push([1,"';
  let pos = 0;

  for (;;) {
    const start = html.indexOf(marker, pos);
    if (start === -1) break;
    const strStart = start + marker.length;

    let i = strStart;
    let chunk = '';
    let escaped = false;
    while (i < html.length) {
      const ch = html[i];
      if (escaped) {
        if (ch === 'n') chunk += '\n';
        else if (ch === 't') chunk += '\t';
        else if (ch === 'r') chunk += '\r';
        else if (ch === '\\') chunk += '\\';
        else if (ch === '"') chunk += '"';
        else if (ch === '/') chunk += '/';
        else if (ch === 'u') {
          const hex = html.substring(i + 1, i + 5);
          chunk += String.fromCharCode(Number.parseInt(hex, 16));
          i += 4;
        } else chunk += ch;
        escaped = false;
        i++;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        i++;
        continue;
      }
      if (ch === '"' && html.substring(i + 1, i + 3) === '])') break;
      chunk += ch;
      i++;
    }

    if (chunk) chunks.push(chunk);
    pos = i + 1;
  }

  return chunks.join('');
}

/** Brace-match the `"animeServer"` value out of the decoded payload. */
function extractAnimeServerData(html: string): MugiwaraAnimeServer | null {
  const allData = extractPushContent(html);

  const marker = '"animeServer":';
  const idx = allData.indexOf(marker);
  if (idx === -1) return null;

  const valueStart = allData.indexOf('{', idx + marker.length);
  if (valueStart === -1) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = valueStart;
  for (let i = valueStart; i < allData.length; i++) {
    const ch = allData[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === '\\' && inStr) {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }

  try {
    return JSON.parse(allData.substring(valueStart, end)) as MugiwaraAnimeServer;
  } catch {
    return null;
  }
}

// ── Season / episode mapping ─────────────────────────────────────────────────

/** Episode count of a season, taken from its longest-populated player slot. */
function getEpisodeCount(saison: MugiwaraSaison | undefined): number {
  if (!saison || !saison.lang) return 0;
  let maxCount = 0;
  for (const langData of Object.values(saison.lang)) {
    if (Array.isArray(langData) && langData.length > 0) {
      const first = langData[0];
      if (Array.isArray(first) && first.length > maxCount) {
        maxCount = first.length;
      }
    }
  }
  return maxCount;
}

interface SaisonMatch {
  saison: MugiwaraSaison;
  episodeIndex: number;
}

/**
 * Map a TMDB season+episode onto one of the site's season entries.
 *
 * Four strategies in descending confidence: an id that equals the season
 * number; sub-seasons sharing that number ("4-1", "4-2") walked cumulatively;
 * ordinal position among real seasons; and finally a whole-catalogue cumulative
 * walk. The last one is gated on `tmdbSeason <= mainSeasons.length` because
 * without it One Piece S20E1 would land in the S1 "East Blue" arc.
 */
function matchSaison(
  saisons: MugiwaraSaison[] | undefined,
  tmdbSeason: number,
  episodeNum: number
): SaisonMatch | null {
  if (!saisons || !Array.isArray(saisons)) return null;

  const seasonStr = String(tmdbSeason);

  for (const s of saisons) {
    if (s.notASeason) continue;
    if (s.id === seasonStr) {
      const count = getEpisodeCount(s);
      if (episodeNum <= count) return { saison: s, episodeIndex: episodeNum - 1 };
      break;
    }
  }

  const subSeasons = saisons
    .filter((s) => {
      if (s.notASeason) return false;
      const numPart = s.id.split('-')[0];
      return numPart === seasonStr;
    })
    .sort((a, b) => {
      const pa = a.id.split('-');
      const pb = b.id.split('-');
      const na = Number.parseInt(pa[0], 10) || 0;
      const nb = Number.parseInt(pb[0], 10) || 0;
      if (na !== nb) return na - nb;
      const sa = pa.length > 1 ? Number.parseInt(pa[1], 10) || 0 : 0;
      const sb = pb.length > 1 ? Number.parseInt(pb[1], 10) || 0 : 0;
      return sa - sb;
    });

  if (subSeasons.length > 0) {
    let cumStart = 0;
    for (const s of subSeasons) {
      const count = getEpisodeCount(s);
      if (episodeNum > cumStart && episodeNum <= cumStart + count) {
        return { saison: s, episodeIndex: episodeNum - cumStart - 1 };
      }
      cumStart += count;
    }
  }

  const ordered = saisons.filter((s) => !s.notASeason);
  const idx = tmdbSeason - 1;
  if (idx >= 0 && idx < ordered.length) {
    const s = ordered[idx];
    const count = getEpisodeCount(s);
    if (episodeNum <= count) {
      return { saison: s, episodeIndex: episodeNum - 1 };
    }
  }

  const mainSeasons = saisons.filter((s) => {
    if (s.notASeason) return false;
    if (!s.lang || Object.keys(s.lang).length === 0) return false;
    if (/[a-zA-Z]/.test(s.id.replace(/-/g, ''))) return false;
    return true;
  });

  if (tmdbSeason > mainSeasons.length) return null;

  let cumulativeStart = 0;
  for (const s of mainSeasons) {
    const count = getEpisodeCount(s);
    if (count > 0 && episodeNum > cumulativeStart && episodeNum <= cumulativeStart + count) {
      return { saison: s, episodeIndex: episodeNum - cumulativeStart - 1 };
    }
    cumulativeStart += count;
  }

  return null;
}

/** Transpose a language's `[slot][episode]` matrix into `[episode][slot]`. */
function extractEpisodeUrls(saison: MugiwaraSaison, lang: string): Array<Array<string | null>> {
  if (!saison || !saison.lang) return [];
  const langData = saison.lang[lang];
  if (!langData || !Array.isArray(langData) || langData.length === 0) return [];

  const urls: Array<Array<string | null>> = [];
  const maxLen = Math.max(...langData.map((arr) => (Array.isArray(arr) ? arr.length : 0)));
  for (let ep = 0; ep < maxLen; ep++) {
    const sources: Array<string | null> = [];
    for (let sourceIdx = 0; sourceIdx < langData.length; sourceIdx++) {
      const arr = langData[sourceIdx];
      if (Array.isArray(arr) && ep < arr.length) {
        sources.push(arr[ep]);
      }
    }
    if (sources.length > 0) urls.push(sources);
  }
  return urls;
}

function isDeadHost(url: string): boolean {
  if (!url) return false;
  return DEAD_HOSTS.some((h) => url.includes(h));
}

function detectHostLabel(url: string): string {
  if (!url) return 'Other';
  const lower = url.toLowerCase();
  if (lower.includes('sibnet')) return 'Sibnet';
  if (lower.includes('vidmoly') || lower.includes('voembed')) return 'Vidmoly';
  if (lower.includes('sendvid')) return 'Sendvid';
  if (lower.includes('vk.com') || lower.includes('vkvideo')) return 'VK';
  if (lower.includes('youtube')) return 'YouTube';
  if (lower.includes('dood')) return 'Dood';
  if (lower.includes('voe') || lower.includes('veev')) return 'Voe';
  if (lower.includes('filemoon')) return 'Filemoon';
  return 'Other';
}

interface Candidate {
  url: string;
  language: string;
  server: string;
}

/** Protocol-relative URLs are common in the payload; normalise and filter. */
function collectSourceUrls(
  episodeSourceUrls: Array<string | null>,
  langLabel: string
): Candidate[] {
  if (!episodeSourceUrls || episodeSourceUrls.length === 0) return [];
  const out: Candidate[] = [];
  for (let i = 0; i < episodeSourceUrls.length; i++) {
    let url = episodeSourceUrls[i];
    if (!url || typeof url !== 'string') continue;
    if (url.startsWith('//')) url = `https:${url}`;
    if (isDeadHost(url)) continue;
    const slotLabel = i < SOURCE_LABELS.length ? SOURCE_LABELS[i] : `Source ${i + 1}`;
    const detected = detectHostLabel(url);
    out.push({ url, language: langLabel, server: detected === 'Other' ? slotLabel : detected });
  }
  return out;
}

function collectStreamsForLang(
  saison: MugiwaraSaison,
  lang: string,
  episodeIndex: number
): Candidate[] {
  const episodeUrls = extractEpisodeUrls(saison, lang);
  if (episodeIndex < 0 || episodeIndex >= episodeUrls.length) return [];
  const langLabel = lang === 'vf' ? 'VF' : 'VOSTFR';
  return collectSourceUrls(episodeUrls[episodeIndex], langLabel);
}

/** Every film entry × language × player slot the catalogue exposes. */
function extractFilmStreams(filmOptions: MugiwaraFilmOptions | undefined): Candidate[] {
  if (!filmOptions || !filmOptions.lang) return [];

  const filmNames = (filmOptions.names || []).map((n) => (n && n.name ? n.name : 'Film'));
  const filmCount = filmNames.length > 0 ? filmNames.length : 1;

  const out: Candidate[] = [];
  for (let filmIdx = 0; filmIdx < filmCount; filmIdx++) {
    for (const [lang, langData] of Object.entries(filmOptions.lang)) {
      if (!Array.isArray(langData)) continue;
      const langLabel = lang === 'vf' ? 'VF' : lang.toUpperCase();
      for (let sourceIdx = 0; sourceIdx < langData.length; sourceIdx++) {
        const arr = langData[sourceIdx];
        if (!Array.isArray(arr) || filmIdx >= arr.length) continue;
        let url = arr[filmIdx];
        if (!url || typeof url !== 'string') continue;
        if (url.startsWith('//')) url = `https:${url}`;
        if (isDeadHost(url)) continue;
        const slotLabel =
          sourceIdx < SOURCE_LABELS.length ? SOURCE_LABELS[sourceIdx] : `Source ${sourceIdx + 1}`;
        const detected = detectHostLabel(url);
        out.push({
          url,
          language: langLabel,
          server: detected === 'Other' ? slotLabel : detected,
        });
      }
    }
  }
  return out;
}

// ── Discovery ────────────────────────────────────────────────────────────────

/**
 * Rank the site's search hits for every usable title, best-first.
 *
 * French titles are queried first because the catalogue indexes French names,
 * and an exact hit short-circuits the remaining titles.
 *
 * The `commonWords >= 2` branch below is dead as written — it splits an already
 * space-normalized title on hyphens, so it always sees one "word". It is kept
 * because repairing it would widen matching for every series at once, which is
 * a behaviour change this port is not in a position to validate.
 */
async function findSlugs(
  titles: string[],
  signal: AbortSignal,
  startTime: number
): Promise<string[]> {
  const seenQueries = new Set<string>();
  const tryQueries: Array<{ title: string; priority: number }> = [];
  for (const t of titles) {
    if (!t || seenQueries.has(t.toLowerCase())) continue;
    seenQueries.add(t.toLowerCase());
    const isFrench = /[À-ÿ]/.test(t) || t.toLowerCase().startsWith("l'");
    tryQueries.push({ title: t, priority: isFrench ? 0 : t === titles[0] ? 1 : 2 });
  }
  tryQueries.sort((a, b) => a.priority - b.priority);

  const candidates: Array<{ slug: string; score: number }> = [];
  const seenSlugs = new Set<string>();

  for (const { title } of tryQueries.slice(0, MAX_SLUG_SEARCH)) {
    if (isAborted(signal) || isBudgetExhausted(startTime)) break;

    const nt = normalize(title);
    if (nt.length < 4) continue;

    const data = await siteFetchJson<MugiwaraSearchResponse>(
      `${SITE}/api/search?q=${encodeURIComponent(title)}`,
      { signal, acceptLanguage: FR_ACCEPT_LANGUAGE, timeoutMs: 10_000 }
    );
    const results = Array.isArray(data?.results) ? data.results : [];
    if (results.length === 0) continue;

    for (const r of results) {
      const nr = normalize(r.anime || '');
      let score = 0;
      if (nr && nr === nt) score = 100;
      else if (nr && (nr.includes(nt) || nt.includes(nr))) score = 80;
      else if (r.matched && normalize(r.matched) === nt) score = 90;
      else if (r.anime) {
        const ra = normalize(r.anime);
        const commonWords = nt.split('-').filter((w) => w.length > 2 && ra.includes(w)).length;
        if (commonWords >= 2) score = 60;
      }

      if (score >= 60 && r.slug && !seenSlugs.has(r.slug)) {
        seenSlugs.add(r.slug);
        candidates.push({ slug: r.slug, score });
      }
    }

    if (candidates.some((c) => c.score === 100)) break;
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.map((c) => c.slug);
}

/**
 * Fetch a catalogue page and pull its payload.
 *
 * Season 1 is tried first because it is the canonical landing page, but split
 * entries occasionally start higher, so higher seasons are probed until one
 * yields a payload or the budget runs out.
 */
async function getAnimeData(
  slug: string,
  type: 'movie' | 'tv',
  signal: AbortSignal,
  startTime: number
): Promise<MugiwaraAnimeServer | null> {
  const pageUrl =
    type === 'movie'
      ? `${SITE}/catalogue/${slug}/films`
      : `${SITE}/catalogue/${slug}/episodes/saison1`;

  const html = await siteFetchText(pageUrl, {
    signal,
    acceptLanguage: FR_ACCEPT_LANGUAGE,
  });
  const data = html ? extractAnimeServerData(html) : null;
  if (data || type === 'movie') return data;

  for (let s = 2; s <= 20; s++) {
    if (isAborted(signal) || isBudgetExhausted(startTime)) break;
    const alt = await siteFetchText(`${SITE}/catalogue/${slug}/episodes/saison${s}`, {
      signal,
      acceptLanguage: FR_ACCEPT_LANGUAGE,
      noBypass: true,
    });
    if (!alt) continue;
    const parsed = extractAnimeServerData(alt);
    if (parsed) return parsed;
  }

  return null;
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal)) return [];
  const startTime = Date.now();

  const titles = ctx.titles.filter((t) => Boolean(t));
  if (titles.length === 0) return [];

  const slugs = await findSlugs(titles, ctx.signal, startTime);

  // Last resort: the catalogue slug is usually just the slugified title, so try
  // it even when search returned nothing.
  const directSlug = toSlug(titles[0]);
  if (directSlug && !slugs.includes(directSlug)) slugs.push(directSlug);
  if (slugs.length === 0) return [];

  const season = ctx.season ?? 1;
  const episodeNum = ctx.episode ?? ctx.absoluteEpisode ?? 1;

  for (const slug of slugs) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;

    const animeData = await getAnimeData(slug, ctx.type, ctx.signal, startTime);
    if (!animeData) continue;

    if (ctx.type === 'movie') {
      const candidates = extractFilmStreams(animeData.options?.FILM_OPTIONS);
      if (candidates.length === 0) continue;
      const streams = await resolveEmbedsUntil(candidates, {
        language: 'VOSTFR',
        providerLabel: LABEL,
        siteUrl: SITE,
        signal: ctx.signal,
        target: 3,
      });
      if (streams.length > 0) return streams;
      continue;
    }

    const saisons = animeData.options?.saisons;
    if (!saisons || saisons.length === 0) continue;

    // Client-side-only entries carry no URLs at all — nothing to salvage here.
    if (!saisons[0].lang && saisons[0].langToShow) continue;

    const matched = matchSaison(saisons, season, episodeNum);
    if (!matched) continue;

    const { saison: matchedSaison, episodeIndex } = matched;
    const candidates: Candidate[] = [];
    // VOSTFR first: when a host URL is listed under both languages the site is
    // reusing one file, and the subbed label is the accurate one.
    const seenUrls = new Set<string>();
    for (const lang of ['vostfr', 'vf']) {
      const langMatrix = matchedSaison.lang?.[lang];
      if (!langMatrix) continue;
      const langEpCount = Math.max(
        ...langMatrix.map((arr) => (Array.isArray(arr) ? arr.length : 0))
      );
      if (episodeIndex >= langEpCount) continue;

      for (const candidate of collectStreamsForLang(matchedSaison, lang, episodeIndex)) {
        const urlKey = candidate.url.replace(/\?.*$/, '');
        if (seenUrls.has(urlKey)) continue;
        seenUrls.add(urlKey);
        candidates.push(candidate);
      }
    }

    if (candidates.length === 0) continue;

    const streams = await resolveEmbedsUntil(candidates, {
      language: 'VOSTFR',
      providerLabel: LABEL,
      siteUrl: SITE,
      signal: ctx.signal,
      target: 3,
    });
    if (streams.length > 0) return streams;
  }

  return [];
}

export const mugiwarastream = createNuvioProvider({
  name: 'mugiwarastream',
  sites: [SITE],
  language: 'fr',
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'ja',
});
