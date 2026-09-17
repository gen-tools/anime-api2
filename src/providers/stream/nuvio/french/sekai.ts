/**
 * Sekai — French VOSTFR streaming site (sekai.one) built around long-running
 * shonen series, split into "saga" pages rather than seasons.
 *
 * Ported from temp/French/French/src/sekai. Sekai is unusual among these sites
 * in serving progressive MP4s from its own CDN instead of third-party embeds, so
 * nothing here needs an embed resolver. The URLs are assembled in inline JS:
 * a handful of `var xx = atob("…")` constants hold the CDN origins, and
 * `episodeHD[n] = xx + "path.mp4"` lines hold the paths. Decoding the constants
 * and re-joining them is the whole extraction.
 *
 * Episode numbers on the site are absolute across the series (One Piece runs to
 * 1100+ in one namespace), so `ctx.absoluteEpisode` is the lookup key rather
 * than the per-season number.
 *
 * The 5000-character page-length test is the site's own failure signal: a
 * missing series returns a short soft-404 page with HTTP 200, so status codes
 * cannot be used to tell a hit from a miss.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  siteFetchText,
  toSlug,
  toStream,
  deaccent,
  decodeBase64,
  isAborted,
  isBudgetExhausted,
  FR_ACCEPT_LANGUAGE,
} from '../shared.js';

const SITE = 'https://sekai.one';
const LABEL = 'Sekai';

/** Below this, the response is the site's soft-404 rather than a series page. */
const MIN_PAGE_LENGTH = 5000;

/** Saga pages fetched per lookup before the budget matters more than coverage. */
const MAX_SAGAS = 6;

/**
 * Series whose Sekai slug is not derivable from the title.
 *
 * Sekai shortens or abbreviates its URLs ("piece" for One Piece, "jojo" for the
 * whole JoJo run), so slugifying the title alone never reaches these entries.
 */
const SLUG_OVERRIDES: Record<string, string> = {
  'one-piece': 'piece',
  'one piece': 'piece',
  'dr-stone': 'drstone',
  'dr stone': 'drstone',
  're-zero': 'rezero',
  're zero': 'rezero',
  're:zero': 'rezero',
  're:zero kara hajimeru isekai seikatsu': 'rezero',
  'jojos-bizarre-adventure': 'jojo',
  'jojo no kimyou na bouken': 'jojo',
  jojos: 'jojo',
  'ghost in the shell': 'ghost',
  'black clover': 'black',
  black: 'black',
};

interface EpisodeSources {
  episodeHD?: string;
  episode?: string;
  episodeLow?: string;
}

function toSekaiSlug(title: string): string {
  if (!title) return '';
  const slug = toSlug(title);
  return SLUG_OVERRIDES[slug] ?? slug;
}

/** Sekai's own matching normalisation: drops structural words, keeps spacing. */
function normalizeTitle(value: string): string {
  if (!value) return '';
  return deaccent(value.toLowerCase())
    .replace(/[':!.,?]/g, '')
    .replace(/\b(the|season|part|cour)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreMatch(searchTerm: string, candidate: string): number {
  if (!searchTerm || !candidate) return 0;
  if (searchTerm === candidate) return 100;
  if (candidate.includes(searchTerm) && searchTerm.length >= 4) return 80;
  if (searchTerm.includes(candidate) && candidate.length >= 4) return 70;
  return 0;
}

/**
 * Decode the CDN constants and rebuild every episode URL on a page.
 *
 * Three quality tiers are stored in three separate arrays; all of them are kept
 * because the HD tier is occasionally missing for older episodes.
 */
function parseEpisodeMapFromHtml(html: string): Record<number, EpisodeSources> {
  const epMap: Record<number, EpisodeSources> = {};

  const b64Regex = /var\s+([a-zA-Z0-9_]+)\s*=\s*atob\("([^"]+)"\)/g;
  const constants: Record<string, string> = {};
  for (const match of html.matchAll(b64Regex)) {
    const decoded = decodeBase64(match[2]);
    if (decoded) constants[match[1]] = decoded;
  }

  const tiers: Array<{ regex: RegExp; key: keyof EpisodeSources }> = [
    {
      regex: /episodeHD\s*\[\s*(\d+)\s*\]\s*=\s*([a-zA-Z0-9_]+)\s*\+\s*"([^"]+\.mp4)"/g,
      key: 'episodeHD',
    },
    {
      regex: /episode\s*\[\s*(\d+)\s*\]\s*=\s*([a-zA-Z0-9_]+)\s*\+\s*"([^"]+\.mp4)"/g,
      key: 'episode',
    },
    {
      regex: /episodeLow\s*\[\s*(\d+)\s*\]\s*=\s*([a-zA-Z0-9_]+)\s*\+\s*"([^"]+\.mp4)"/g,
      key: 'episodeLow',
    },
  ];

  for (const tier of tiers) {
    for (const match of html.matchAll(tier.regex)) {
      const num = Number.parseInt(match[1], 10);
      if (!Number.isFinite(num)) continue;
      const domain = constants[match[2]] || '';
      if (!epMap[num]) epMap[num] = {};
      epMap[num][tier.key] = domain + match[3];
    }
  }

  return epMap;
}

/** Saga page URLs linked from a series page, ascending. */
function extractSagaUrls(html: string, slug: string): string[] {
  const sagas = new Set<string>();

  const hrefRegex = new RegExp(`href=["']${slug}/saga-(\\d+)["']`, 'gi');
  for (const match of html.matchAll(hrefRegex)) {
    sagas.add(`${SITE}/${slug}/saga-${match[1]}`);
  }

  // Some templates wire the navigation through onclick instead of href. Scoped
  // to attributes so CSS class names containing "saga-" are not picked up.
  const attrRegex = /(?:href|onclick)=["'][^"']*saga-(\d+)/gi;
  for (const match of html.matchAll(attrRegex)) {
    sagas.add(`${SITE}/${slug}/saga-${match[1]}`);
  }

  return [...sagas].sort((a, b) => {
    const na = Number.parseInt(a.match(/saga-(\d+)/)?.[1] || '0', 10);
    const nb = Number.parseInt(b.match(/saga-(\d+)/)?.[1] || '0', 10);
    return na - nb;
  });
}

/**
 * Every series slug the site currently publishes.
 *
 * `episodesData.js` is a plain JS object literal keyed by internal slug, which
 * is the only catalogue listing Sekai exposes — there is no search endpoint.
 * "op" is the internal key for One Piece but its pages live under /piece.
 */
async function getSeriesSlugs(signal: AbortSignal): Promise<string[]> {
  const js = await siteFetchText(`${SITE}/episodesData.js`, {
    signal,
    acceptLanguage: FR_ACCEPT_LANGUAGE,
  });
  if (!js) return [];

  const slugKeys: string[] = [];
  const slugRegex = /^\s*([a-zA-Z0-9_]+)\s*:\s*\{/gm;
  for (const match of js.matchAll(slugRegex)) {
    const key = match[1] === 'op' ? 'piece' : match[1];
    if (!slugKeys.includes(key)) slugKeys.push(key);
  }
  return slugKeys;
}

function formatStreams(sources: EpisodeSources): NuvioStream[] {
  const out: NuvioStream[] = [];
  const tiers: Array<{ url: string | undefined; quality: string; server: string }> = [
    { url: sources.episodeHD, quality: '1080p', server: 'Sekai HD' },
    { url: sources.episode, quality: '720p', server: 'Sekai SD' },
    { url: sources.episodeLow, quality: '360p', server: 'Sekai LOW' },
  ];
  for (const tier of tiers) {
    if (!tier.url) continue;
    out.push(
      toStream(tier.url, 'VOSTFR', LABEL, SITE, {
        quality: tier.quality,
        server: tier.server,
        type: 'mp4',
        // The CDN checks the catalogue origin, not its own, for these files.
        headers: { Referer: `${SITE}/`, Origin: SITE },
      })
    );
  }
  return out;
}

async function fetchSeriesPage(url: string, signal: AbortSignal): Promise<string> {
  const html = await siteFetchText(url, { signal, acceptLanguage: FR_ACCEPT_LANGUAGE });
  return html ?? '';
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal)) return [];
  const startTime = Date.now();

  const titles = ctx.titles.filter((t) => Boolean(t));
  if (titles.length === 0) return [];

  const absEp = ctx.absoluteEpisode ?? ctx.episode;
  if (!absEp) return [];

  const slug = toSekaiSlug(titles[0]);
  let seriesUrl = `${SITE}/${slug}`;
  let mainHtml = await fetchSeriesPage(seriesUrl, ctx.signal);

  if (mainHtml.length < MIN_PAGE_LENGTH) {
    for (const altTitle of titles.slice(1)) {
      if (!altTitle || isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
      const altSlug = toSekaiSlug(altTitle);
      if (!altSlug || altSlug === slug) continue;

      const altUrl = `${SITE}/${altSlug}`;
      const altHtml = await fetchSeriesPage(altUrl, ctx.signal);
      if (altHtml.length >= MIN_PAGE_LENGTH) {
        mainHtml = altHtml;
        seriesUrl = altUrl;
        break;
      }
    }
  }

  // Neither the primary nor any alternate title slugified into a live page, so
  // fall back to matching against the published slug list.
  if (mainHtml.length < MIN_PAGE_LENGTH && !isAborted(ctx.signal)) {
    const knownSlugs = await getSeriesSlugs(ctx.signal);
    for (const known of knownSlugs) {
      if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
      const ns = normalizeTitle(known);
      const hit = titles.some((t) => scoreMatch(normalizeTitle(t), ns) >= 70);
      if (!hit) continue;
      const html = await fetchSeriesPage(`${SITE}/${known}`, ctx.signal);
      if (html.length >= MIN_PAGE_LENGTH) {
        mainHtml = html;
        seriesUrl = `${SITE}/${known}`;
        break;
      }
    }
  }

  if (mainHtml.length < MIN_PAGE_LENGTH) return [];

  const effectiveSlug = seriesUrl.split('/').pop()?.replace(/\?.*$/, '') || slug;
  if (!effectiveSlug) return [];

  const epMap: Record<number, EpisodeSources> = {};
  const sagaUrls = extractSagaUrls(mainHtml, effectiveSlug).slice(0, MAX_SAGAS);

  for (const sagaUrl of sagaUrls) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    if (epMap[absEp] && Object.keys(epMap[absEp]).length > 0) break;

    const html = await siteFetchText(sagaUrl, {
      signal: ctx.signal,
      acceptLanguage: FR_ACCEPT_LANGUAGE,
    });
    if (!html || html.length < 1000) continue;
    for (const [num, sources] of Object.entries(parseEpisodeMapFromHtml(html))) {
      const key = Number(num);
      epMap[key] = { ...(epMap[key] || {}), ...sources };
    }
  }

  // Shorter series (Jujutsu Kaisen, Demon Slayer) have no saga split at all and
  // declare their episode arrays straight on the series page.
  if (Object.keys(epMap).length === 0) {
    for (const [num, sources] of Object.entries(parseEpisodeMapFromHtml(mainHtml))) {
      const key = Number(num);
      epMap[key] = { ...(epMap[key] || {}), ...sources };
    }
  }

  const found = epMap[absEp];
  if (!found || Object.keys(found).length === 0) return [];
  return formatStreams(found);
}

export const sekai = createNuvioProvider({
  name: 'sekai',
  sites: [SITE],
  language: 'fr',
  extract,
  defaultAudioLanguage: 'ja',
});
