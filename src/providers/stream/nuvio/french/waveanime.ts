/**
 * WaveAnime — small French VOSTFR catalogue (waveanime.fr) with a public REST
 * API and DASH playback, no embed hosts involved.
 *
 * Ported from temp/French/French/src/waveanime. Three things make this provider
 * unlike the other French ports:
 *
 *   Playback is a DASH manifest (`/playback/:id/manifest.mpd`), not HLS or a
 *   progressive file, so the quality label has to come from the manifest's
 *   Representation heights rather than a page label.
 *
 *   Subtitles are only published as ASS. ASS is not renderable by every player
 *   Toko targets, so each track is fetched, converted to WebVTT here, and handed
 *   over as a `data:` URI. When conversion fails the original .ass URL is kept so
 *   a player that does understand ASS still gets something.
 *
 *   Long series are catalogued in "kai" form — every episode flattened into
 *   season 1 and numbered 1..N — so a TMDB season 2 lookup only resolves via the
 *   absolute episode number, and only when the site's numbering is provably a
 *   gapless 1..N run.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  siteFetchText,
  siteFetchJson,
  normalize,
  isAborted,
  isBudgetExhausted,
  FR_ACCEPT_LANGUAGE,
} from '../shared.js';

const SITE = 'https://waveanime.fr';
const LABEL = 'WaveAnime';

/** Titles pushed through the search endpoint before falling back to the catalogue. */
const MAX_SEARCH_TITLES = 3;

/** Below this the search hit is too weak to trust; matches upstream's cut-off. */
const MIN_SEARCH_SCORE = 40;

/**
 * Episodes created at or after this timestamp use the 3-letter language code in
 * their subtitle filenames; older ones use the 2-letter form. The site's own
 * player bundle switches on exactly this value.
 */
const SUBTITLE_LANG_THRESHOLD = 1777804042435;

interface WaveSeries {
  id?: number | string;
  title?: string;
  format?: string;
}

interface WaveEpisode {
  id?: number | string;
  number?: number;
  season_number?: number;
}

interface WaveSeriesDetail {
  episodes?: WaveEpisode[];
}

interface WaveEpisodeMeta {
  created_timestamp?: number;
  subtitles?: Record<string, unknown>;
}

// ── Search ───────────────────────────────────────────────────────────────────

function scoreSearchResult(result: WaveSeries, query: string): number {
  const q = normalize(query);
  const t = normalize(result.title || '');
  if (!q || !t) return 0;
  let score = 0;
  if (t === q) score += 100;
  else if (t.includes(q) || q.includes(t)) score += 60;

  const qWords = q.split(/\s+/).filter((w) => w.length > 2);
  const tWords = t.split(/\s+/);
  for (const w of qWords) {
    if (tWords.includes(w)) score += 12;
  }
  return score;
}

async function fetchSeriesList(url: string, signal: AbortSignal): Promise<WaveSeries[]> {
  const data = await siteFetchJson<WaveSeries[]>(url, {
    signal,
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    headers: { Referer: `${SITE}/` },
  });
  return Array.isArray(data) ? data : [];
}

// ── Episode resolution ───────────────────────────────────────────────────────

function findEpisode(
  detail: WaveSeriesDetail | null,
  type: 'movie' | 'tv',
  season: number,
  episode: number
): WaveEpisode | null {
  if (!detail || !Array.isArray(detail.episodes)) return null;
  const eps = detail.episodes;
  if (type === 'movie') {
    return eps.find((e) => e.number === 1) || eps[0] || null;
  }
  return eps.find((ep) => ep.season_number === season && ep.number === episode) || null;
}

/**
 * Resolve a "kai" entry by absolute episode number.
 *
 * Guarded hard, because a wrong hit here silently plays the wrong episode: every
 * entry must sit in season 1 and the numbers must form a gapless 1..N run with no
 * duplicates. Catalogue entries that carry duplicate uploads (a [DEV] and a
 * [STABLE] cut of the same episode) fail that test and are rejected rather than
 * guessed at.
 */
function findEpisodeAbsolute(
  detail: WaveSeriesDetail | null,
  absoluteEpisode: number | undefined
): WaveEpisode | null {
  if (!detail || !Array.isArray(detail.episodes) || !absoluteEpisode) return null;
  const eps = detail.episodes;

  const numbers: number[] = [];
  for (const ep of eps) {
    if (
      ep.season_number !== 1 ||
      typeof ep.number !== 'number' ||
      !Number.isInteger(ep.number) ||
      ep.number < 1
    ) {
      return null;
    }
    numbers.push(ep.number);
  }
  numbers.sort((a, b) => a - b);
  for (let i = 0; i < numbers.length; i++) {
    if (numbers[i] !== i + 1) return null;
  }
  if (numbers.length < 1) return null;
  if (absoluteEpisode < 1 || absoluteEpisode > numbers.length) return null;

  return eps.find((ep) => ep.number === absoluteEpisode) || null;
}

// ── ASS → WebVTT ─────────────────────────────────────────────────────────────

/** ASS timestamps carry centiseconds (H:MM:SS.cc); WebVTT wants milliseconds. */
function assTimeToVttTime(value: string): string | null {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})[.](\d{1,2})$/.exec(value);
  if (!m) return null;
  const h = Number.parseInt(m[1], 10);
  const min = Number.parseInt(m[2], 10);
  const s = Number.parseInt(m[3], 10);
  const totalMs = (h * 3600 + min * 60 + s) * 1000 + Number.parseInt(m[4], 10) * 10;
  const hh = String(Math.floor(totalMs / 3600000)).padStart(2, '0');
  const mm = String(Math.floor((totalMs % 3600000) / 60000)).padStart(2, '0');
  const ss = String(Math.floor((totalMs % 60000) / 1000)).padStart(2, '0');
  const mmm = String(totalMs % 1000).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${mmm}`;
}

/**
 * Translate one ASS dialogue body into WebVTT cue text.
 *
 * Only italic/bold/underline survive: they are the only ASS overrides WebVTT can
 * express. Positioning, fades and transforms are dropped rather than approximated.
 * The remaining literal text is HTML-escaped because a bare `<` or `&` in a line
 * of dialogue would otherwise be parsed as markup by the WebVTT reader.
 */
function assTextToVtt(text: string): string {
  if (!text) return '';
  let t = text.replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ');
  t = t.replace(/\{([^}]*)\}/g, (_block, inner: string) => {
    let out = '';
    const re = /\\([ibu])([01])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(inner)) !== null) {
      out += m[2] === '1' ? `<${m[1]}>` : `</${m[1]}>`;
    }
    return out;
  });
  t = t.replace(/[{}]/g, '');
  // A style that is italic by default plus a leading {\i0} yields a closing tag
  // with no opening one; harmless but stripped for cleanliness.
  t = t.replace(/^(<\/[ibu]>)+/, '');
  t = t.replace(/&/g, '&amp;');
  t = t.replace(/<(?!\/?(?:i|b|u)>)/g, '&lt;');
  return t.replace(/\s+$/g, '');
}

/**
 * Convert a whole ASS file to WebVTT.
 *
 * Dialogue lines have nine comma-separated fields before the text, and the text
 * itself routinely contains commas, so the split is done by locating the first
 * nine separators rather than by `split(',')`.
 */
function assToVtt(ass: string | null): string | null {
  if (!ass) return null;
  const lines = ass.split(/\r?\n/);
  const cues: string[] = [];

  for (const line of lines) {
    if (!line.startsWith('Dialogue:')) continue;
    const body = line.slice('Dialogue:'.length).trim();
    const commaIdx: number[] = [];
    let idx = -1;
    for (let i = 0; i < 9; i++) {
      idx = body.indexOf(',', idx + 1);
      if (idx === -1) break;
      commaIdx.push(idx);
    }
    if (commaIdx.length < 9) continue;

    const fields: string[] = [];
    let start = 0;
    for (let i = 0; i < 9; i++) {
      fields.push(body.slice(start, commaIdx[i]));
      start = commaIdx[i] + 1;
    }

    const startVtt = assTimeToVttTime(fields[1]);
    const endVtt = assTimeToVttTime(fields[2]);
    const text = assTextToVtt(body.slice(start));
    if (!startVtt || !endVtt || !text) continue;
    cues.push(`${startVtt} --> ${endVtt}\n${text}`);
  }

  if (cues.length === 0) return null;
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

/**
 * Build the subtitle tracks the site publishes for an episode.
 *
 * The .ass paths are not linked anywhere — they are derived from the episode id
 * and a language code that flips at `SUBTITLE_LANG_THRESHOLD`.
 */
async function buildSubtitles(
  epMeta: WaveEpisodeMeta,
  epId: string,
  signal: AbortSignal
): Promise<NonNullable<NuvioStream['subtitles']>> {
  if (!epMeta.subtitles) return [];
  const lang = (epMeta.created_timestamp || 0) >= SUBTITLE_LANG_THRESHOLD ? 'fra' : 'fr';
  const out: NonNullable<NuvioStream['subtitles']> = [];

  const tracks = [
    { key: 'fra_full', flag: 'full', label: 'Français' },
    { key: 'fra_forced', flag: 'forced', label: 'Français (forced)' },
  ];

  for (const track of tracks) {
    if (!epMeta.subtitles[track.key]) continue;
    if (isAborted(signal)) break;

    const assUrl = `${SITE}/playback/subtitles/${epId}-${lang}-${track.flag}.ass`;
    let url = assUrl;
    const assText = await siteFetchText(assUrl, {
      signal,
      acceptLanguage: FR_ACCEPT_LANGUAGE,
      headers: { Referer: `${SITE}/` },
    });
    const vtt = assToVtt(assText);
    if (vtt) url = `data:text/vtt;charset=utf-8,${encodeURIComponent(vtt)}`;

    out.push({ url, language: 'fra', label: track.label });
  }

  return out;
}

// ── Quality ──────────────────────────────────────────────────────────────────

/** Tallest Representation in the manifest wins; the player adapts downward. */
async function parseMpdQuality(manifestUrl: string, signal: AbortSignal): Promise<string> {
  const text = await siteFetchText(manifestUrl, {
    signal,
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    headers: { Referer: `${SITE}/` },
  });
  if (!text) return 'HD';

  let maxH = 0;
  const re = /height="(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const h = Number.parseInt(m[1], 10);
    if (h > maxH) maxH = h;
  }
  if (maxH >= 2160) return '2160p';
  if (maxH >= 1080) return '1080p';
  if (maxH >= 720) return '720p';
  if (maxH >= 480) return '480p';
  if (maxH > 0) return `${maxH}p`;
  return 'HD';
}

// ── Extraction ───────────────────────────────────────────────────────────────

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal)) return [];
  const startTime = Date.now();

  const titles = ctx.titles.filter((t) => Boolean(t));
  if (titles.length === 0) return [];

  const wantedFormats = ctx.type === 'movie' ? ['movie'] : ['serie', 'kai'];

  let serie: WaveSeries | null = null;
  for (const title of titles.slice(0, MAX_SEARCH_TITLES)) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    if (title.length < 3) continue;

    const results = await fetchSeriesList(
      `${SITE}/api/series?query=${encodeURIComponent(title)}`,
      ctx.signal
    );
    const scored = results
      .filter((r) => wantedFormats.includes(String(r.format)))
      .map((r) => ({ serie: r, score: scoreSearchResult(r, title) }))
      .sort((a, b) => b.score - a.score);

    const best = scored.find((entry) => entry.score >= MIN_SEARCH_SCORE);
    if (best) {
      serie = best.serie;
      break;
    }
  }

  // The catalogue is small enough (~80 entries, hard limit 100) to scan whole
  // when the search endpoint returns nothing usable.
  if (!serie && !isAborted(ctx.signal) && !isBudgetExhausted(startTime)) {
    const catalog = await fetchSeriesList(`${SITE}/api/series?limit=100`, ctx.signal);
    let bestScore = MIN_SEARCH_SCORE;
    for (const r of catalog) {
      if (!wantedFormats.includes(String(r.format))) continue;
      for (const t of titles) {
        const sc = scoreSearchResult(r, t);
        if (sc > bestScore) {
          bestScore = sc;
          serie = r;
        }
      }
    }
  }

  if (!serie || serie.id == null) return [];

  const detail = await siteFetchJson<WaveSeriesDetail>(`${SITE}/api/series/${serie.id}`, {
    signal: ctx.signal,
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    headers: { Referer: `${SITE}/` },
  });

  let ep = findEpisode(detail, ctx.type, ctx.season ?? 1, ctx.episode ?? 1);
  if (!ep && ctx.type === 'tv' && serie.format === 'kai') {
    ep = findEpisodeAbsolute(detail, ctx.absoluteEpisode);
  }
  if (!ep || ep.id == null) return [];

  const epId = String(ep.id);
  const manifestUrl = `${SITE}/playback/${epId}/manifest.mpd`;

  const quality = await parseMpdQuality(manifestUrl, ctx.signal);

  const epMeta =
    !isAborted(ctx.signal) && !isBudgetExhausted(startTime)
      ? await siteFetchJson<WaveEpisodeMeta>(`${SITE}/api/episodes/${epId}`, {
          signal: ctx.signal,
          acceptLanguage: FR_ACCEPT_LANGUAGE,
          headers: { Referer: `${SITE}/` },
        })
      : null;

  const subtitles =
    epMeta && !isAborted(ctx.signal) && !isBudgetExhausted(startTime)
      ? await buildSubtitles(epMeta, epId, ctx.signal)
      : [];

  const stream: NuvioStream = {
    url: manifestUrl,
    name: `${LABEL} (VOSTFR)`,
    title: `[VOSTFR] ${LABEL} · DASH${quality && quality !== 'HD' ? ` [${quality}]` : ''}`,
    quality,
    language: 'VOSTFR',
    server: 'WaveAnime DASH',
    type: 'dash',
    headers: { Referer: `${SITE}/`, Origin: SITE },
  };
  if (subtitles.length > 0) stream.subtitles = subtitles;

  return [stream];
}

export const waveanime = createNuvioProvider({
  name: 'waveanime',
  sites: [SITE],
  language: 'fr',
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'ja',
});
