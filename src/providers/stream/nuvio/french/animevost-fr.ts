/**
 * AnimeVost FR — French anime catalogue (animevost.fr) exposing a small JSON API
 * rather than scrapable markup.
 *
 * Ported from temp/French/French/src/animevost-fr. Three endpoints cover
 * everything: `/api/animes/search?q=` for lookup, `/api/animes/{slug}` for a
 * season/episode tree, and per-episode `streams[]` entries that already carry a
 * playable URL, a quality label and a language tag. Because the API hands over
 * finished URLs there is no page to scrape and no player to unpack — the work
 * here is matching the right series and the right episode.
 *
 * The catalogue is subtitled, but some entries carry a French dub as an extra
 * `streams[]` row, so each row's own language tag is used rather than a
 * provider-wide assumption.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  siteFetchJson,
  toStream,
  resolveEmbedsUntil,
  serverNameFor,
  normalizeLangTag,
  pickBestMatch,
  isAborted,
  isBudgetExhausted,
  FR_ACCEPT_LANGUAGE,
} from '../shared.js';

const SITE = 'https://animevost.fr';
const LABEL = 'AnimeVOST';

/** URLs matching this are media files; anything else is treated as an embed page. */
const DIRECT_MEDIA = /\.(m3u8|mpd|mp4|m4v|mkv|webm)(\?|#|$)/i;

interface AvStream {
  video_url?: string;
  quality?: string;
  language?: string;
  server?: string;
}

interface AvEpisode {
  episode_number?: number;
  streams?: AvStream[];
}

interface AvSeason {
  season_number?: number;
  episodes?: AvEpisode[];
}

interface AvDetails {
  seasons?: AvSeason[];
}

interface AvSearchHit {
  slug?: string;
  title?: string;
  name?: string;
}

interface AvSearchResponse {
  results?: AvSearchHit[];
}

function apiUrl(path: string): string {
  return `${SITE}${path}`;
}

/**
 * Look a series up and keep the hit only if its title actually matches.
 *
 * The endpoint is a fuzzy search that always answers with something, so taking
 * the first row unconditionally is how a lookup for one series ends up streaming
 * another. The score gate is what makes a miss look like a miss.
 */
async function searchAnime(query: string, signal: AbortSignal): Promise<AvSearchHit | null> {
  const data = await siteFetchJson<AvSearchResponse>(
    apiUrl(`/api/animes/search?q=${encodeURIComponent(query)}`),
    { signal, acceptLanguage: FR_ACCEPT_LANGUAGE, headers: { Referer: `${SITE}/` } }
  );
  const results = Array.isArray(data?.results) ? data.results : [];
  if (results.length === 0) return null;

  const best = pickBestMatch(
    results,
    query,
    (hit) => hit.title || hit.name || (hit.slug || '').replace(/-/g, ' ')
  );
  return best && best.slug ? best : null;
}

/** Season and episode markers in a search query only narrow it wrongly here. */
function cleanQuery(title: string): string {
  return title
    .replace(/\s*(saison|season|s)\s*\d+/gi, '')
    .replace(/\s*(episode|ep|e)\s*\d+/gi, '')
    .trim();
}

/**
 * Pick the season a lookup refers to.
 *
 * An exact `season_number` hit is the only confident answer. A catalogue entry
 * with a single season is also usable, because such entries list a multi-cour
 * show as one flat run and the episode match below then resolves it by absolute
 * number. Anything else is a miss: guessing at the first season would serve
 * season 1 episode 5 to someone asking for season 3 episode 5.
 */
function pickSeason(details: AvDetails | null, season: number): AvSeason | null {
  const seasons = Array.isArray(details?.seasons) ? details.seasons : [];
  if (seasons.length === 0) return null;
  const exact = seasons.find((s) => s.season_number === season);
  if (exact) return exact;
  return seasons.length === 1 ? seasons[0] : null;
}

function pickEpisode(season: AvSeason, wanted: number[]): AvEpisode | null {
  const episodes = Array.isArray(season.episodes) ? season.episodes : [];
  for (const num of wanted) {
    const hit = episodes.find((e) => e.episode_number === num);
    if (hit) return hit;
  }
  return null;
}

async function collectStreams(
  episode: AvEpisode,
  ctx: NuvioContext,
  startTime: number
): Promise<NuvioStream[]> {
  const rows = Array.isArray(episode.streams) ? episode.streams : [];
  if (rows.length === 0) return [];

  const out: NuvioStream[] = [];
  const embeds: Array<{ url: string; language: string; quality: string; server: string }> = [];

  for (const row of rows) {
    const url = typeof row.video_url === 'string' ? row.video_url.trim() : '';
    if (!url || !/^https?:\/\//i.test(url)) continue;

    // The API's tag is site vocabulary ("VOSTFR", "VF"); the adapter turns it
    // into an audio language, so it must not be flattened to 'fr' here.
    const language = normalizeLangTag(row.language);
    const quality = row.quality || '1080p';
    const server = row.server || serverNameFor(url);

    if (DIRECT_MEDIA.test(url)) {
      out.push(
        toStream(url, language, LABEL, SITE, {
          quality,
          server,
          type: url.includes('.m3u8') ? 'hls' : undefined,
          // The CDN authorises on the catalogue's origin, not its own.
          headers: { Referer: `${SITE}/`, Origin: SITE },
        })
      );
    } else {
      embeds.push({ url, language, quality, server });
    }
  }

  if (embeds.length > 0 && !isAborted(ctx.signal) && !isBudgetExhausted(startTime)) {
    out.push(
      ...(await resolveEmbedsUntil(embeds, {
        language: 'VOSTFR',
        providerLabel: LABEL,
        siteUrl: SITE,
        signal: ctx.signal,
        target: 3,
      }))
    );
  }

  return out;
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal)) return [];
  const startTime = Date.now();

  const titles = ctx.titles.filter((t) => Boolean(t));
  if (titles.length === 0) return [];

  const season = ctx.season ?? 1;
  const wanted: number[] = [];
  for (const candidate of [ctx.episode, ctx.absoluteEpisode]) {
    if (typeof candidate === 'number' && candidate > 0 && !wanted.includes(candidate)) {
      wanted.push(candidate);
    }
  }
  if (wanted.length === 0) return [];

  const triedQueries = new Set<string>();
  for (const title of titles) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;

    const query = cleanQuery(title);
    if (!query || triedQueries.has(query.toLowerCase())) continue;
    triedQueries.add(query.toLowerCase());

    const hit = await searchAnime(query, ctx.signal);
    if (!hit?.slug) continue;

    const details = await siteFetchJson<AvDetails>(apiUrl(`/api/animes/${hit.slug}`), {
      signal: ctx.signal,
      acceptLanguage: FR_ACCEPT_LANGUAGE,
      headers: { Referer: `${SITE}/` },
    });

    const seasonData = pickSeason(details, season);
    if (!seasonData) continue;

    const episode = pickEpisode(seasonData, wanted);
    if (!episode) continue;

    const streams = await collectStreams(episode, ctx, startTime);
    if (streams.length > 0) return streams;
  }

  return [];
}

export const animevostfr = createNuvioProvider({
  name: 'animevostfr',
  sites: [SITE],
  language: 'fr',
  extract,
  defaultAudioLanguage: 'ja',
});
