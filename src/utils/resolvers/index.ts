/**
 * Embed resolution entry point.
 *
 * `resolveStream` is the dispatcher the ported providers call: it routes a
 * candidate URL to the right host resolver, and when no resolver claims it (or
 * the claim fails) it falls back to peeling the page's best video iframe and
 * scanning for a media URL directly.
 *
 * Ordering inside the fallback is deliberate. Iframe peeling runs *before* the
 * regex scan because a scraped page usually contains several plausible-looking
 * .mp4/.m3u8 strings belonging to ads, analytics pixels or unrelated JSON
 * configs, and the nested player iframe is far more likely to be the real
 * source. Only if peeling yields nothing do the strict (`file:`, `sources:`,
 * `hls:`) patterns run, and only then the loose "any .m3u8 anywhere" ones.
 */

import {
  correctDeformedVideoUrl,
  fetchEmbedPage,
  findBestVideoIframe,
  inferMediaType,
  isDeadEmbed,
  isKnownFakeDirectUrl,
  isPlayableMediaUrl,
  resolveDood,
  resolveDownParadise,
  resolveFsvidVidzy,
  resolveHGCloud,
  resolveLecteurVideo,
  resolveLuluvid,
  resolveMailRu,
  resolveMoon,
  resolveMyTV,
  resolvePackedPlayer,
  resolveSendvid,
  resolveSibnet,
  resolveStreamtape,
  resolveUp4fun,
  resolveUqload,
  resolveVidmoly,
  resolveVidoza,
  resolveVoe,
  resolveYounetu,
  type ResolvedStream,
} from './hosts.js';
import { unpack } from './unpack.js';

export * from './hosts.js';
export * from './unpack.js';

/** The stream shape providers hand in — everything but `url` is passed through. */
export interface StreamCandidate {
  url: string;
  headers?: Record<string, string>;
  quality?: string;
  language?: string;
  title?: string;
  name?: string;
  server?: string;
}

/** A candidate whose `url` is now directly playable. */
export interface ResolvedStreamResult extends StreamCandidate {
  /** 'hls' | 'mp4' | 'mkv' | 'dash' | 'webm', when inferable from the URL. */
  type?: string;
}

type HostResolver = (url: string) => Promise<ResolvedStream | null>;

/**
 * Hostname → resolver, in priority order.
 *
 * Order is load-bearing and matches the upstream if/else chain: `voembed.` also
 * contains `voe`, and `lulustream`/`luluvdo` also contain `lulu.`, so the more
 * specific families must be tested first or they get sent to the wrong player.
 */
const HOST_ROUTES: Array<{ hosts: string[]; resolve: HostResolver }> = [
  { hosts: ['sibnet.ru'], resolve: resolveSibnet },
  { hosts: ['vidmoly.', 'voembed.'], resolve: resolveVidmoly },
  { hosts: ['.mail.ru'], resolve: resolveMailRu },
  { hosts: ['uqload.', 'oneupload.'], resolve: resolveUqload },
  {
    hosts: [
      'voe',
      'weneverbeenfree',
      'maryspecialwatch',
      'charlestoughrace',
      'sandratableother',
    ],
    resolve: resolveVoe,
  },
  { hosts: ['streamtape.com', 'stape'], resolve: resolveStreamtape },
  { hosts: ['dood', 'ds2play', 'bigwar5'], resolve: resolveDood },
  { hosts: ['moonplayer', 'filemoon'], resolve: resolveMoon },
  { hosts: ['younetu.', 'netu.'], resolve: resolveYounetu },
  { hosts: ['vidoza.'], resolve: resolveVidoza },
  { hosts: ['sendvid.', 'daisukianime'], resolve: resolveSendvid },
  { hosts: ['myvi.', 'mytv.'], resolve: resolveMyTV },
  { hosts: ['fsvid.', 'vidzy.'], resolve: resolveFsvidVidzy },
  {
    hosts: ['vidstream.pro', 'vidcdn.', 'kakaflix.', 'vidhsareup.'],
    resolve: resolvePackedPlayer,
  },
  {
    hosts: ['luluvid.', 'lulustream.', 'luluvdo.', 'wishonly.', 'veev.'],
    resolve: resolvePackedPlayer,
  },
  { hosts: ['lulu.'], resolve: resolveLuluvid },
  { hosts: ['lecteurvideo.'], resolve: resolveLecteurVideo },
  { hosts: ['hgcloud.', 'savefiles.'], resolve: resolveHGCloud },
  { hosts: ['down-paradise.', 'ww1.down-paradise.'], resolve: resolveDownParadise },
  { hosts: ['up4fun.'], resolve: resolveUp4fun },
];

function pickHostResolver(urlLower: string): HostResolver | null {
  for (const route of HOST_ROUTES) {
    if (route.hosts.some((host) => urlLower.includes(host))) return route.resolve;
  }
  return null;
}

/** Matched by analytics/tag-manager URLs that regex scans otherwise pick up. */
const BASE_URL_FORBIDDEN_PATTERN = 'googletagmanager';

/**
 * Iframe URLs already peeled during the current top-level resolution.
 *
 * Ten mirror entries for one episode routinely funnel into the same nested
 * iframe; without this the same page is fetched and unpacked ten times.
 */
const peeledUrls = new Set<string>();

function finalize(
  stream: StreamCandidate,
  url: string,
  headers?: Record<string, string>,
  quality?: string
): ResolvedStreamResult {
  const out: ResolvedStreamResult = { ...stream, url };
  const merged = { ...(stream.headers || {}), ...(headers || {}) };
  if (Object.keys(merged).length > 0) out.headers = merged;
  if (quality) out.quality = quality;
  const type = inferMediaType(url);
  if (type) out.type = type;
  return out;
}

function hasInvalidExtension(url: string): boolean {
  return /\.(css|js|html|php|jpg|png|gif|svg)(\?.*)?$/i.test(url);
}

function acceptable(url: string): boolean {
  return (
    url.startsWith('http') &&
    !url.includes(BASE_URL_FORBIDDEN_PATTERN) &&
    !hasInvalidExtension(url) &&
    !isKnownFakeDirectUrl(url)
  );
}

/**
 * Resolve one stream candidate to a directly playable URL.
 *
 * Returns an empty array when the URL cannot be resolved — an embed page handed
 * to the player is worse than no source at all, since it plays as a broken item
 * rather than falling through to another provider.
 *
 * @param depth Recursion guard for iframe peeling. One nested peel is allowed;
 *              deeper chains are almost always ad redirects and blow the budget.
 */
export async function resolveStream(
  stream: StreamCandidate,
  depth = 0
): Promise<ResolvedStreamResult[]> {
  if (depth > 1) return [];
  if (depth === 0) peeledUrls.clear();

  // Correct deliberately misspelled host domains before routing, so a deformed
  // iframe still reaches its real resolver.
  const originalUrl = correctDeformedVideoUrl(String(stream?.url || ''));
  if (
    !originalUrl ||
    originalUrl.includes('google-analytics') ||
    originalUrl.includes('doubleclick')
  ) {
    return [];
  }
  const urlLower = originalUrl.toLowerCase();

  // Already a direct media URL — nothing to resolve.
  if (isPlayableMediaUrl(originalUrl)) return [finalize(stream, originalUrl)];

  try {
    let result: ResolvedStream | null = null;

    const hostResolver = pickHostResolver(urlLower);
    if (hostResolver) result = await hostResolver(originalUrl);

    if (result && result.url !== originalUrl && !isKnownFakeDirectUrl(result.url)) {
      // The page itself can serve the video from a deformed CDN domain, so the
      // resolver's output gets the same correction as its input.
      return [
        finalize(stream, correctDeformedVideoUrl(result.url), result.headers, result.quality),
      ];
    }

    // ── Generic fallback ────────────────────────────────────────────────────
    // Hosts that are known-slow or known-dead are not worth a second pass: the
    // specific resolver already tried, and these cost seconds per attempt.
    const knownSlowHost =
      urlLower.includes('up4fun.') ||
      urlLower.includes('down-paradise.') ||
      urlLower.includes('getvid.club') ||
      urlLower.includes('vidhsareup.');
    if (knownSlowHost || isDeadEmbed(originalUrl)) return [];

    // A dedicated resolver already scanned this page for a direct URL, so skip
    // straight to iframe peeling instead of repeating its regex work.
    const skipDirectScan = hostResolver !== null && depth === 0;

    const page = await fetchEmbedPage(originalUrl, stream.headers);
    if (page) {
      let html = page.html;
      if (html.includes('p,a,c,k,e,d')) html = unpack(html);

      if (!skipDirectScan) {
        const jsRedirect = html.match(
          /window\.location\.(?:href|replace)\s*=\s*['"]([^'"]+)['"]/
        );
        if (jsRedirect && jsRedirect[1] !== originalUrl) {
          const hop = await fetchEmbedPage(jsRedirect[1], stream.headers);
          if (hop) {
            html = hop.html;
            if (html.includes('p,a,c,k,e,d')) html = unpack(html);
          }
        }
      }

      // Step 1: peel the most promising nested iframe.
      const iframeUrl = findBestVideoIframe(html, originalUrl);
      if (iframeUrl && !peeledUrls.has(iframeUrl)) {
        peeledUrls.add(iframeUrl);
        const peeled = await resolveStream({ ...stream, url: iframeUrl }, depth + 1);
        if (peeled.length > 0) return peeled;
        // At depth > 0 the peel was the last chance; at depth 0 fall through to
        // the regex scans, which occasionally catch what peeling missed.
        if (depth > 0) return [];
      }

      // Step 2: patterns that only match inside a video context — no false
      // positives from ads or analytics payloads.
      if (!skipDirectScan) {
        const strictUrl =
          html.match(/file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i) ||
          html.match(/sources\s*:\s*\[["']([^"']+\.(?:m3u8|mp4)[^"']*)["']\]/i) ||
          html.match(/'hls'\s*:\s*'([^']+)'/) ||
          html.match(/"hls"\s*:\s*"([^"]+)"/);

        if (strictUrl) {
          let extractedUrl = strictUrl[1] ?? strictUrl[0];
          if (extractedUrl.startsWith('//')) extractedUrl = 'https:' + extractedUrl;
          if (acceptable(extractedUrl)) result = { url: extractedUrl };
        }
      }

      // Step 3: last resort. These match any .m3u8/.mp4 on the page, including
      // ones inside ad payloads, so they run only when everything else failed.
      if (!result && !skipDirectScan) {
        const looseUrl =
          html.match(/https?:\/\/[^"']+\.m3u8[^"']*/) ||
          html.match(/https?:\/\/[^"']+\.mp4[^"']*/);

        if (looseUrl) {
          let extractedUrl = looseUrl[0];
          if (extractedUrl.startsWith('//')) extractedUrl = 'https:' + extractedUrl;
          if (acceptable(extractedUrl)) result = { url: extractedUrl };
        }
      }
    }

    if (result && result.url !== originalUrl && result.url.startsWith('http')) {
      return [
        finalize(stream, correctDeformedVideoUrl(result.url), result.headers, result.quality),
      ];
    }
  } catch {
    /* unresolvable */
  }

  return [];
}

/**
 * Resolve a single embed/player URL to a direct media URL.
 *
 * Thin wrapper over `resolveStream` for callers that only have a URL: it gets
 * the same host routing, iframe peeling and fallback scanning.
 */
export async function resolveEmbed(
  url: string,
  referer?: string
): Promise<ResolvedStream | null> {
  try {
    const candidate: StreamCandidate = { url };
    if (referer) candidate.headers = { Referer: referer };

    const resolved = await resolveStream(candidate);
    const best = resolved[0];
    if (!best) return null;

    const out: ResolvedStream = { url: best.url };
    if (best.headers && Object.keys(best.headers).length > 0) out.headers = best.headers;
    if (best.quality) out.quality = best.quality;
    if (best.type) out.type = best.type;
    return out;
  } catch {
    return null;
  }
}
