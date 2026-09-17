# Toko — Unified Tatakai Extension

<p align="center">
  <img src="./icon.png" width="120" alt="Toko logo">
</p>

<p align="center">
  <strong>One extension for all your Tatakai providers.</strong><br>
  A unified <code>.kai</code> extension for anime streaming, torrent indexing, and manga providers.
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#building">Building</a> •
  <a href="#development">Development</a> •
  <a href="#provider-architecture">Architecture</a>
</p>

---

## Features

Toko is the official unified extension for the [Tatakai](https://github.com/snozxyx/tatakai) platform. It consolidates multiple providers into a single installable `.kai` package.

| Category | Providers | Capabilities |
|:--|:--:|:--|
| **Stream** | 16 | Direct-stream sources (15 anime + MovieBox movies/TV) |
| **Torrent** | 6 | Magnet links and torrent files |
| **Manga** | 5 | Chapters, pages, and scanlator metadata |

### Streaming

- 15 anime direct-stream providers
- MovieBox for movies & TV (direct MP4/HLS + captions)
- Support for single episodes
- Optional movie support
- Optional language information

#### Provider health audit (2026-08)

Every provider was checked against its live origin and repaired, kept, or removed:

| Verdict | Providers | Notes |
|:--|:--|:--|
| ✅ Working | nebula, animepahe, animeya, animelok, aniworld, reanime, fouranime, anikoto, animeheaven, anizone, animeblkom, desidub | Domain rot repaired where sites moved (animesalt → .cx, toonstream → toon-stream.site, anikoto → .cz, animepahe → .pw) |
| 🔧 Repaired | toonstream, anizone, animesalt | New live mirrors; ToonStream download-table extraction; AniZone plain-HTML search fallback |
| ➕ Added | moviebox | Ported from [walterwhite-69/Moviebox-API](https://github.com/walterwhite-69/Moviebox-API) — guest-JWT auth, search, direct MP4/HLS streams, captions, embed fallback |
| ♻️ Restored | watchanimeworld | Rebuilt for the successor domain watchanimeworld.one (Cloudflare-aware, player1 server-list extraction) |
| ❌ Removed | senshi, mkissa, acgrip | Backend 500s (senshi), reCAPTCHA-gated for non-browser clients (mkissa), dead RSS + dead tracker (acgrip) |

### Torrent

- 6 torrent indexers
- Magnet link support
- Torrent file support
- Batch searching through a unified provider interface

### Manga

- 5 manga providers
- Chapter listing and retrieval
- Page fetching
- Scanlator metadata

---

## Building

Build Toko using pnpm:

```bash
pnpm run build:toko
