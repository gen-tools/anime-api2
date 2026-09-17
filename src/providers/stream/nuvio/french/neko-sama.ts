/**
 * Neko-Sama — French anime catalogue on animes-sama.su, VF and VOSTFR.
 *
 * Ported from temp/French/French/src/neko-sama. A WordPress "animestream" build:
 * seasons live at `/anime/<slug>-saison-N/`, the episode list is an `.eplister`
 * table, and each server button hides its markup in a base64 blob passed to a
 * `loadMi()` call. Decoding that blob yields an intermediate player page, and the
 * real embed is the iframe on *that* page — so every server costs two requests,
 * which is why resolution stops at two embeds per language.
 *
 * Buttons are labelled `VF-1`, `VO-2` and so on; the prefix is the only language
 * signal the page carries, and `VO` here means Japanese audio with French subs.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  siteFetchText,
  toSlug,
  deaccent,
  decodeBase64,
  decodeEntities,
  resolveEmbedsUntil,
  isAborted,
  isBudgetExhausted,
  FR_ACCEPT_LANGUAGE,
} from '../shared.js';

const SITE = 'https://animes-sama.su';
const LABEL = 'NekoSama';
/** Two embeds per language: each one costs a player page plus the resolve. */
const TARGET_PER_LANGUAGE = 2;

interface Episode {
  num: number;
  title: string;
  url: string;
}

interface ServerButton {
  label: string;
  playerUrl: string;
}

/**
 * Comparison form for slug scoring.
 *
 * Distinct from the shared `normalize` in dropping season vocabulary outright:
 * these slugs carry "-saison-2" as part of the identifier, and the season is
 * scored separately below, so leaving the word in would double-count it.
 */
function normalizeSlug(value: string): string {
  if (!value) return '';
  return deaccent(value.toLowerCase())
    .replace(/[':!.,?]/g, '')
    .replace(/-/g, ' ')
    .replace(/\b(the|season|part|cour|saison)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractEpisodes(html: string): Episode[] {
  const episodes: Episode[] = [];
  const epRegex =
    /<a[^>]*href="([^"]+)"[^>]*>\s*<div class="epl-num">(\d+)<\/div>\s*<div class="epl-title">([^<]+)<\/div>/gi;
  let match: RegExpExecArray | null;
  while ((match = epRegex.exec(html)) !== null) {
    episodes.push({
      num: Number.parseInt(match[2], 10),
      title: match[3].trim(),
      url: match[1],
    });
  }
  return episodes;
}

/**
 * Server buttons, each carrying a base64 `<iframe>` snippet.
 *
 * The label is not an attribute — it is the button's own text, which sits within
 * ~800 characters after the `loadMi()` call, so it is recovered by scanning
 * forward from the match rather than by structure.
 */
function extractServerButtons(html: string): ServerButton[] {
  const buttons: ServerButton[] = [];
  const loadMiRegex = /loadMi\(\{\s*value:\s*'([A-Za-z0-9+/=]+)'\s*\}\)/g;
  let loadMatch: RegExpExecArray | null;
  while ((loadMatch = loadMiRegex.exec(html)) !== null) {
    const decoded = decodeBase64(loadMatch[1]);
    if (!decoded) continue;
    const srcMatch = decoded.match(/src="([^"]+)"/);
    if (!srcMatch) continue;
    const afterBtn = html.substring(loadMatch.index, loadMatch.index + 800);
    const labelMatch = afterBtn.match(/;">\s*([A-Z]+-\d+)\s*<\/button>/);
    buttons.push({
      label: labelMatch ? labelMatch[1].trim() : 'VO',
      playerUrl: decodeEntities(srcMatch[1]),
    });
  }
  return buttons;
}

/** The embed behind an intermediate player page. */
async function resolvePlayerUrl(playerUrl: string, ctx: NuvioContext): Promise<string | null> {
  const html = await siteFetchText(playerUrl, {
    headers: { Referer: `${SITE}/` },
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    timeoutMs: 10_000,
    signal: ctx.signal,
  });
  if (!html) return null;

  const iframeMatch =
    html.match(/<iframe[^>]*class="player-iframe"[^>]*src="([^"]+)"/i) ||
    html.match(/<iframe[^>]*src="([^"]+)"/i);
  return iframeMatch ? decodeEntities(iframeMatch[1]) : null;
}

function labelToLanguage(label: string): string {
  const upper = (label || '').toUpperCase();
  if (upper.startsWith('VF')) return 'VF';
  return 'VOSTFR';
}

/** Episode list for a candidate anime page, or [] when the page is not one. */
async function tryAnimePage(url: string, ctx: NuvioContext): Promise<Episode[]> {
  const html = await siteFetchText(url, {
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    timeoutMs: 15_000,
    signal: ctx.signal,
    // Slug guesses 404 far more often than they succeed.
    noBypass: true,
  });
  // Short bodies are the theme's error page, not a season.
  if (!html || html.length <= 1000) return [];
  return extractEpisodes(html);
}

async function searchAnime(query: string, ctx: NuvioContext): Promise<Array<{ url: string; slug: string }>> {
  const html = await siteFetchText(`${SITE}/?s=${encodeURIComponent(query)}`, {
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    timeoutMs: 15_000,
    signal: ctx.signal,
  });
  if (!html || html.length < 1000) return [];

  const results: Array<{ url: string; slug: string }> = [];
  const seen = new Set<string>();
  const linkRegex = /href="(https?:\/\/animes-sama\.su\/anime\/[^"]+)"/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html)) !== null) {
    const url = match[1];
    if (seen.has(url)) continue;
    seen.add(url);
    results.push({ url, slug: url.replace(/\/$/, '').split('/').pop() || '' });
  }
  return results;
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];

  const startTime = Date.now();
  const season = ctx.season;
  let episodes: Episode[] = [];

  for (const title of ctx.titles) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    const slug = toSlug(title);
    if (!slug) continue;

    const candidates = [
      ...(season ? [`${SITE}/anime/${slug}-saison-${season}/`] : []),
      `${SITE}/anime/${slug}/`,
      `${SITE}/anime/${slug}-saison-1/`,
    ];

    for (const url of candidates) {
      episodes = await tryAnimePage(url, ctx);
      if (episodes.length > 0) break;
    }
    if (episodes.length > 0) break;
  }

  if (episodes.length === 0) {
    for (const title of ctx.titles) {
      if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
      const results = await searchAnime(title, ctx);
      if (results.length === 0) continue;

      const queryNorm = normalizeSlug(title);
      const seasonStr = season ? `saison-${season}` : '';
      const scored = results
        .map((result) => {
          const slugNorm = normalizeSlug(result.slug);
          let score = 0;
          if (slugNorm === queryNorm) score += 100;
          else if (slugNorm.includes(queryNorm)) score += 80;
          else if (queryNorm.includes(slugNorm)) score += 60;
          if (seasonStr && result.slug.includes(seasonStr)) score += 50;
          // A slug that names a *different* season is actively wrong, not merely
          // unranked, so it is pushed below unnumbered entries.
          if (seasonStr && !result.slug.includes(seasonStr) && result.slug.includes('saison-')) {
            score -= 30;
          }
          if (result.slug.includes('oav') || result.slug.includes('special')) score -= 20;
          return { ...result, score };
        })
        .sort((a, b) => b.score - a.score);

      for (const result of scored.slice(0, 3)) {
        if (isBudgetExhausted(startTime)) break;
        episodes = await tryAnimePage(result.url, ctx);
        if (episodes.length > 0) break;
      }
      if (episodes.length > 0) break;
    }
  }

  if (episodes.length === 0) return [];

  // The list is flat per season page, so the absolute number is worth a try when
  // the mapped one is absent — some entries index a whole series as one run.
  const wanted = [ctx.episode, ctx.absoluteEpisode].filter(
    (value): value is number => typeof value === 'number' && value > 0
  );
  const targetEp = episodes.find((e) => wanted.includes(e.num));
  if (!targetEp) return [];

  const episodeHtml = await siteFetchText(targetEp.url, {
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    timeoutMs: 15_000,
    signal: ctx.signal,
  });
  if (!episodeHtml || episodeHtml.length <= 1000) return [];

  const buttons = extractServerButtons(episodeHtml);
  if (buttons.length === 0) return [];

  const byLanguage = new Map<string, string[]>();
  for (const button of buttons) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    const language = labelToLanguage(button.label);
    const bucket = byLanguage.get(language) || [];
    if (bucket.length >= TARGET_PER_LANGUAGE) continue;

    const embedUrl = await resolvePlayerUrl(button.playerUrl, ctx);
    if (!embedUrl) continue;
    bucket.push(embedUrl);
    byLanguage.set(language, bucket);
  }

  const streams: NuvioStream[] = [];
  for (const [language, embedUrls] of byLanguage) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    streams.push(
      ...(await resolveEmbedsUntil(
        embedUrls.map((url) => ({ url })),
        {
          language,
          providerLabel: LABEL,
          siteUrl: SITE,
          target: TARGET_PER_LANGUAGE,
          signal: ctx.signal,
          budgetMs: 10_000,
        }
      ))
    );
  }

  return streams;
}

export const nekosama = createNuvioProvider({
  name: 'nekosama',
  sites: [SITE],
  language: 'fr',
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'ja',
});
