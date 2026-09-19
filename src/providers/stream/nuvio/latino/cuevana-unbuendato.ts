/**
 * Cuevana UnBuenDato — TMDB-keyed API that returns embed URLs grouped by language.
 *
 * Ported from temp/Latino/Latino/providers/cuevana_unbuendato.js.
 * The API at cuevana.unbuendato.com/?id=TMDBID returns a JSON object whose
 * `languages` map has Spanish-language keys (Latino, Español, Castellano) each
 * containing a map of server-name → embed URL. We iterate every supported
 * language and resolve its embeds in parallel.
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchJson,
  resolveEmbedsUntil,
  isAborted,
  isBudgetExhausted,
  PROVIDER_BUDGET_MS,
  ES_ACCEPT_LANGUAGE,
} from '../shared.js';

const SITE = 'https://cuevana.unbuendato.com';
const LABEL = 'CuevanaUBD';

const BLACKLISTED_SERVERS = ['netu', 'waaw', 'hqq', 'mixdrop'];

function langTag(key: string): string {
  const k = key.toLowerCase();
  if (k.includes('castellano') || k.includes('españa') || k.includes('esp')) return 'CAST';
  if (k.includes('subtitulado') || k.includes('sub')) return 'SUB';
  return 'LAT';
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || !ctx.tmdbId) return [];
  const startTime = Date.now();

  let apiUrl = `${SITE}/?id=${ctx.tmdbId}`;
  if (ctx.type === 'tv' && ctx.season && ctx.episode) {
    apiUrl += `&season=${ctx.season}&episode=${ctx.episode}`;
  }

  const data = await siteFetchJson<{
    success: boolean;
    languages?: Record<string, Record<string, string>>;
  }>(apiUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10; TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    acceptLanguage: ES_ACCEPT_LANGUAGE,
    timeoutMs: 10_000,
    signal: ctx.signal,
  });

  if (!data?.success || !data.languages) return [];
  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  const streams: NuvioStream[] = [];
  const seen = new Set<string>();

  for (const [langKey, servers] of Object.entries(data.languages)) {
    const lk = langKey.toLowerCase();
    const isSupported = lk.includes('latino') || lk.includes('español') || lk.includes('castellano');
    if (!isSupported) continue;

    const tag = langTag(langKey);
    const embeds: Array<{ url: string; language: string }> = [];

    for (const [serverKey, url] of Object.entries(servers)) {
      if (!url) continue;
      const sk = serverKey.toLowerCase();
      if (BLACKLISTED_SERVERS.some(b => sk.includes(b) || url.includes(b))) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      embeds.push({ url, language: tag });
    }

    if (embeds.length === 0) continue;
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;

    const resolved = await resolveEmbedsUntil(embeds, {
      language: tag,
      providerLabel: LABEL,
      siteUrl: SITE,
      signal: ctx.signal,
      budgetMs: 8_000,
    });
    streams.push(...resolved);
  }

  return streams;
}

export const cuevanaUnbuendato = createNuvioProvider({
  name: 'cuevanaUnbuendato',
  sites: [SITE],
  language: 'es',
  extract,
  supportsMovie: true,
});
