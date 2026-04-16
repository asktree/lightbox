# music-scraper

Batch downloader + analyzer for the musicbox library.

## Pipeline

For each track:
1. Download OGG Vorbis from Spotify (via librespot)
2. Separate stems with Demucs (drums/bass/vocals/other)
3. Analyze each stem + full mix with librosa + essentia
4. Write `audio.ogg`, `meta.json`, `analysis.json` to the library
5. Discard stems (reproducible from audio)

## Library layout

```
~/music-library/
├── index.db               # SQLite: queue + status
└── tracks/
    └── <spotify-id>/
        ├── audio.ogg
        ├── meta.json      # { id, name, artist, album, duration_ms, ... }
        └── analysis.json  # beats, onsets, stems features, tags
```

## Credentials

Expected at `~/.config/musicbox/credentials.json`:

```json
{
  "spotify": {
    "sp_dc":  "...",           // from open.spotify.com cookie
    "sp_key": "...",           // from open.spotify.com cookie
    "client_id":     "...",    // Spotify dev app
    "client_secret": "..."     // Spotify dev app
  }
}
```

Dev app redirect URI must include `http://127.0.0.1:8888/callback`.

## Setup

```bash
pnpm --filter @lightbox/music-scraper setup
```

## Usage

```bash
.venv/bin/python -m scraper list-liked --limit 200   # enqueue recent liked
.venv/bin/python -m scraper run                      # process queue
.venv/bin/python -m scraper status                   # progress
```
