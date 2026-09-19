/**
 * Streamzo — French film and series catalogue with no search endpoint: content
 * is reachable only by guessing its permalink, so the work is in slug building.
 *
 * Ported from temp/French/French/src/streamzo. Films live at `/<slug>` and
 * series at `/series/<slug>`, and the same slug can exist under both, which is
 * why the probe order flips with the requested media type and why a film page
 * found while looking for a series is skipped rather than returned.
 *
 * Episodes are not separate pages. The series page carries every episode as a
 * `<button class="sd-ep">` with `data-season`/`data-ep`/`data-lang`/`data-src`,
 * so one fetch exposes both the VF and the VOSTFR embed for the target episode —
 * upstream returned only the first of those two; both are emitted here.
 *
 * Upstream kept the requested media type in a module-level `_mediaType`
 * variable that its search function read back. With providers running
 * concurrently that is a race, so the type is threaded through as an argument.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  siteFetchText,
  toSlug,
  toStream,
  resolveEmbedStreams,
  absoluteUrl,
  isAborted,
  isBudgetExhausted,
  FR_ACCEPT_LANGUAGE,
} from '../shared.js';

const SITE = 'https://streamzo.fr';
const LABEL = 'Streamzo';

/** Slug variants generated, and the subset actually fetched. */
const MAX_GENERATED_SLUGS = 10;
const MAX_SLUGS = 6;

interface ContentPage {
  type: 'movie' | 'series';
  url: string;
  html: string;
  embedUrl: string | null;
  quality: string;
}

interface EpisodeButton {
  season: number;
  episode: number;
  lang: string;
  embedUrl: string;
}

// ── Page parsing ─────────────────────────────────────────────────────────────

/**
 * The film player's embed path.
 *
 * Four shapes because the site has been rebuilt twice: a click-to-load facade
 * button, a named iframe, any `/embed/` iframe, and an iframe nested in
 * `#player`. All four still appear depending on which template serves the page.
 */
function extractEmbedUrl(html: string): string | null {
  if (!html) return null;

  const facadeMatch = html.match(
    /id=["']player-facade["'][^>]*data-embed=["']([^"']+)["']/i
  );
  if (facadeMatch) return facadeMatch[1];

  const iframeMatch = html.match(
    /<iframe[^>]*id=["']video-frame["'][^>]*src=["']([^"']+)["']/i
  );
  if (iframeMatch) return iframeMatch[1];

  const embedMatch = html.match(/<iframe[^>]*src=["']([^"']*\/embed\/[^"']+)["']/i);
  if (embedMatch) return embedMatch[1];

  const playerMatch = html.match(
    /id=["']player["'][^>]*>[\s\S]*?<iframe[^>]*src=["']([^"']+)["']/i
  );
  if (playerMatch) return playerMatch[1];

  return null;
}

function hasSeriesEpisodes(html: string): boolean {
  if (!html) return false;
  return /<button[^>]*class="sd-ep"[^>]*>/i.test(html);
}

/**
 * Every episode button on a series page.
 *
 * Attributes are matched one at a time rather than as a single pattern because
 * the template emits them in inconsistent order.
 */
function parseEpisodeButtons(html: string): EpisodeButton[] {
  if (!html) return [];
  const buttonRegex = /<button[^>]*class="sd-ep"[^>]*>/gi;
  const candidates: EpisodeButton[] = [];
  let match: RegExpExecArray | null;

  while ((match = buttonRegex.exec(html)) !== null) {
    const element = match[0];
    const season = element.match(/data-season="(\d+)"/);
    const episode = element.match(/data-ep="(\d+)"/);
    const lang = element.match(/data-lang="([^"]+)"/);
    const src = element.match(/data-src="([^"]+)"/);
    if (!season || !episode || !lang || !src) continue;

    candidates.push({
      season: Number.parseInt(season[1], 10),
      episode: Number.parseInt(episode[1], 10),
      lang: lang[1],
      embedUrl: src[1],
    });
  }

  return candidates;
}

/** Every language the site offers for one episode, VF first. */
function findSeriesEpisodes(
  buttons: EpisodeButton[],
  season: number,
  episode: number
): Array<{ embedUrl: string; language: string }> {
  const out: Array<{ embedUrl: string; language: string }> = [];
  for (const lang of ['vf', 'vostfr']) {
    const found = buttons.find(
      (button) =>
        button.season === season &&
        button.episode === episode &&
        button.lang === lang
    );
    if (found) {
      out.push({
        embedUrl: found.embedUrl,
        language: lang === 'vf' ? 'VF' : 'VOSTFR',
      });
    }
  }
  return out;
}

/** The playable URL inside an embed page. The player is vidstack-based. */
function extractDirectUrl(embedHtml: string): string | null {
  if (!embedHtml) return null;

  const hlsMatch = embedHtml.match(/https?:[^"'<>]+\.m3u8[^"'<>]*/);
  if (hlsMatch) return hlsMatch[0];

  const mp4Match = embedHtml.match(/https?:[^"'<>]+\.mp4[^"'<>]*/);
  if (mp4Match) return mp4Match[0];

  const iframeMatch = embedHtml.match(/<iframe[^>]*src=["']([^"']+)["']/i);
  if (iframeMatch) return iframeMatch[1];

  return null;
}

function extractQuality(html: string): string {
  if (!html) return 'HD';
  const match = html.match(/q\s*--(?:good|bad)\s*["']?\s*>\s*(\d+p)/i);
  return match ? match[1] : 'HD';
}

function detectLanguage(url: string, html: string): string {
  const value = (url || '').toLowerCase();
  const body = (html || '').toLowerCase();
  if (value.includes('vostfr') || body.includes('vostfr')) return 'VOSTFR';
  if (value.includes('-vf') || body.includes('version fran')) return 'VF';
  // The catalogue is French-dubbed by default.
  return 'VF';
}

// ── Slug generation ──────────────────────────────────────────────────────────

/**
 * Permalink candidates for a set of titles.
 *
 * The variants exist because the site's slugs are hand-written: long Japanese
 * titles get short words glued to their neighbour ("no-kuni" → "nokuni"),
 * leading articles are dropped, and anything past four words is usually
 * truncated. Generating them is far cheaper than the site having no search.
 */
function buildSlugCandidates(titles: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const push = (value: string): void => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };

  for (const title of titles) {
    if (out.length >= MAX_GENERATED_SLUGS) break;
    if (!title) continue;

    const baseSlug = toSlug(title);
    if (!baseSlug || seen.has(baseSlug)) continue;
    push(baseSlug);

    const words = title.split(/\s+/).filter((word) => word.length >= 4);
    if (words.length >= 2) {
      push(toSlug(words.slice(-2).join('-')));
      push(toSlug(words.slice(0, 3).join('-')));
    }

    if (title.length >= 15) {
      const parts = toSlug(title).split('-');
      const compacted = parts
        .reduce<string[]>((acc, word, index, arr) => {
          if (word === '') return acc;
          if (word.length <= 3 && index < arr.length - 1) {
            acc.push(word + arr[index + 1]);
            arr[index + 1] = '';
          } else {
            acc.push(word);
          }
          return acc;
        }, [])
        .filter(Boolean)
        .join('-');
      push(compacted);
    }

    push(baseSlug.replace(/^(the|a|an)-/i, ''));

    const slugParts = baseSlug.split('-');
    if (slugParts.length > 4) {
      const truncated = slugParts.slice(0, 4).join('-');
      push(truncated);
      push(truncated.replace(/^(the|a|an)-/i, ''));
    }
  }

  return out.filter((value) => value.length > 3);
}

// ── Discovery ────────────────────────────────────────────────────────────────

async function findContent(
  ctx: NuvioContext,
  startTime: number
): Promise<ContentPage | null> {
  const slugs = buildSlugCandidates(ctx.titles).slice(0, MAX_SLUGS);

  for (const slug of slugs) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return null;

    const paths =
      ctx.type === 'tv'
        ? [`/series/${slug}`, `/${slug}`]
        : [`/${slug}`, `/series/${slug}`];

    for (const path of paths) {
      if (isAborted(ctx.signal)) return null;

      const pageUrl = `${SITE}${path}`;
      const html = await siteFetchText(pageUrl, {
        acceptLanguage: FR_ACCEPT_LANGUAGE,
        signal: ctx.signal,
        timeoutMs: 5_000,
      });
      // The site answers a miss with a short shell rather than a 404.
      if (!html || html.length <= 5000) continue;

      const embedUrl = extractEmbedUrl(html);
      const hasEpisodes = hasSeriesEpisodes(html);
      if (!embedUrl && !hasEpisodes) continue;

      const detectedType = hasEpisodes ? 'series' : 'movie';
      // A same-slug film is not an acceptable answer for a series request.
      if (detectedType === 'movie' && ctx.type === 'tv') continue;

      return {
        type: detectedType,
        url: pageUrl,
        html,
        embedUrl,
        quality: extractQuality(html),
      };
    }
  }

  return null;
}

// ── Embed resolution ─────────────────────────────────────────────────────────

async function embedToStreams(
  embedPath: string,
  quality: string,
  language: string,
  ctx: NuvioContext
): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal)) return [];

  const embedUrl = embedPath.startsWith('http')
    ? embedPath
    : absoluteUrl(embedPath, `${SITE}/`);
  if (!embedUrl) return [];

  const embedHtml = await siteFetchText(embedUrl, {
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    signal: ctx.signal,
    timeoutMs: 10_000,
    headers: { Referer: `${SITE}/`, Origin: SITE },
  });

  const direct = embedHtml ? extractDirectUrl(embedHtml) : null;
  if (direct) {
    const videoUrl = absoluteUrl(direct, `${SITE}/`);
    if (videoUrl && /\.(?:m3u8|mp4)(?:\?|#|$)/i.test(videoUrl)) {
      return [
        toStream(videoUrl, language, LABEL, SITE, {
          quality,
          title: `[${language}] ${LABEL} - ${quality}`,
          type: videoUrl.includes('.m3u8') ? 'hls' : 'mp4',
          // The site's own CDN checks the catalogue origin, not the media host.
          headers: { Referer: `${SITE}/`, Origin: SITE },
        }),
      ];
    }
    // A nested iframe means the embed delegates to a third-party host.
    if (videoUrl) {
      const nested = await resolveEmbedStreams(videoUrl, {
        language,
        providerLabel: LABEL,
        siteUrl: SITE,
        quality,
      });
      if (nested.length > 0) return nested;
    }
  }

  // Nothing recognisable in the markup: let the host resolvers peel the embed
  // page themselves — they unpack obfuscated players this scan cannot read.
  return resolveEmbedStreams(embedUrl, {
    language,
    providerLabel: LABEL,
    siteUrl: SITE,
    quality,
  });
}

/** `ctx.episode`, then `ctx.absoluteEpisode` — deduped, in that order. */
function episodeCandidates(ctx: NuvioContext): number[] {
  const out: number[] = [];
  for (const value of [ctx.episode, ctx.absoluteEpisode]) {
    if (value === undefined || !Number.isFinite(value)) continue;
    if (!out.includes(value)) out.push(value);
  }
  return out.length > 0 ? out : [1];
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  const startTime = Date.now();
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];

  const content = await findContent(ctx, startTime);
  if (!content) return [];

  if (content.type === 'movie' || ctx.type === 'movie') {
    if (!content.embedUrl) return [];
    const language = detectLanguage(content.url, content.html);
    return embedToStreams(content.embedUrl, content.quality, language, ctx);
  }

  const buttons = parseEpisodeButtons(content.html);
  const season = ctx.season ?? 1;
  const out: NuvioStream[] = [];

  for (const episode of episodeCandidates(ctx)) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    const matches = findSeriesEpisodes(buttons, season, episode);
    for (const entry of matches) {
      if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
      out.push(
        ...(await embedToStreams(
          entry.embedUrl,
          content.quality,
          entry.language,
          ctx
        ))
      );
    }
    if (out.length > 0) break;
  }

  return out;
}

export const streamzo = createNuvioProvider({
  name: 'streamzo',
  sites: [SITE],
  language: 'fr',
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'fr',
});
