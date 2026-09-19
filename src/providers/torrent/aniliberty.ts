/**
 * AniLiberty — torrent provider (Russian anime dubs).
 *
 * Rewritten 2026-08 onto the real JSON API after the HTML-scrape approach
 * started 404ing (`/search?q=…` no longer exists). Endpoints verified live:
 *
 *   GET /api/v1/app/search/releases?query={q}&include=id,name.main,name.english
 *     → [{ id, name: { main, english } }]
 *   GET /api/v1/anime/torrents/release/{id}?include=id,filename,magnet,size,seeders,leechers
 *     → [{ id, filename, magnet, size, seeders, leechers }]
 *
 * `aniliberty.top` and upstream `anilibria.top` both serve the API; quality
 * metadata is parsed from the torrent filename ("[WEBRip 1080p][HEVC][1-28]").
 * Magnets carry the AniLiberty tracker (`tr.libria.fun`).
 */
import { normalizeQuality } from '../../utils/scraping/quality.js';
import type { TorrentProvider, SourceOptions, SourceResult } from '../../types/index.js';
import { fetchJson } from '../../utils/http/fetch.js';
import { buildMagnet, inferTorrentFileFormat } from '../../utils/torrent/matcher.js';
import { scoreEpisodeMatch, isBatchTitle, scoreTitleMatch } from '../../utils/torrent/matcher.js';

const BASES = ['https://aniliberty.top', 'https://anilibria.top'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

interface SearchRelease {
  id?: number;
  name?: { main?: string; english?: string };
}

interface ApiTorrent {
  id?: number;
  filename?: string;
  magnet?: string;
  hash?: string;
  size?: number;
  seeders?: number;
  leechers?: number;
}

function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${Math.round(bytes / 1_000)} KB`;
}

async function searchReleases(title: string): Promise<SearchRelease[]> {
  for (const base of BASES) {
    const data = await fetchJson<SearchRelease[]>(
      `${base}/api/v1/app/search/releases?query=${encodeURIComponent(title)}&include=id,name.main,name.english`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' }, timeoutMs: 7000 },
    );
    if (Array.isArray(data) && data.length > 0) return data;
  }
  return [];
}

async function fetchTorrents(releaseId: number): Promise<ApiTorrent[]> {
  for (const base of BASES) {
    const data = await fetchJson<ApiTorrent[]>(
      `${base}/api/v1/anime/torrents/release/${releaseId}` +
        `?include=id,hash,filename,magnet,size,seeders,leechers`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' }, timeoutMs: 7000 },
    );
    if (Array.isArray(data) && data.length > 0) return data;
  }
  return [];
}

const provider: TorrentProvider = {
  name: 'aniliberty',
  sites: BASES,
  async batch(opts: SourceOptions): Promise<SourceResult[]> {
    const title = opts.titles[0] ?? '';
    const ep = opts.episode ?? 0;
    if (!title) return [];

    // 1. Search — AniLiberty names are Russian; the English field is what we
    //    match the query against, but a query with no match still returns the
    //    site's own candidates, so score every field and take the best.
    const releases = await searchReleases(title);
    if (releases.length === 0) return [];

    let best: { id: number; label: string; score: number } | null = null;
    for (const release of releases) {
      const id = Number(release?.id);
      if (!Number.isFinite(id) || id <= 0) continue;
      const names = [release.name?.english, release.name?.main].filter((v): v is string => Boolean(v?.trim()));
      if (names.length === 0) continue;
      const score = Math.max(...names.map((n) => scoreTitleMatch(title, n)));
      const label = names.join(' / ');
      if (!best || score > best.score) best = { id, label, score };
    }
    if (!best) return [];

    // 2. Torrents for the release
    const torrents = await fetchTorrents(best.id);
    const results: SourceResult[] = [];

    for (const torrent of torrents) {
      const filename = String(torrent?.filename || `AniLiberty ${best.label}`).trim();
      const isBatch = isBatchTitle(filename);
      if (ep > 0 && !isBatch && scoreEpisodeMatch(filename, ep) === 0) continue;

      const magnet = String(torrent?.magnet || '').trim();
      const url = magnet || (torrent?.hash ? buildMagnet(torrent.hash, filename) : '');
      if (!url) continue;

      const seeders = Number(torrent?.seeders);
      const leechers = Number(torrent?.leechers);

      results.push({
        source: 'aniliberty',
        url,
        quality: normalizeQuality(filename),
        headers: {},
        subtitles: [],
        audioLanguage: 'ru',
        language: 'Russian',
        sourceType: 'torrent',
        providerName: 'AniLiberty',
        providerKey: 'aniliberty',
        torrentTitle: filename,
        fileSize: Number(torrent?.size) > 0 ? humanSize(Number(torrent.size)) : undefined,
        magnetLink: url.startsWith('magnet:') ? url : undefined,
        seeders: Number.isFinite(seeders) ? seeders : undefined,
        leechers: Number.isFinite(leechers) ? leechers : undefined,
        peers: (Number.isFinite(seeders) ? seeders : 0) + (Number.isFinite(leechers) ? leechers : 0),
        fileFormat: inferTorrentFileFormat(filename),
      });
    }

    return results;
  },
};

export default provider;
