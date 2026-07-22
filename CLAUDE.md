# Lightbox

Unified smart light control: React UIs, Node.js services, a Python music
pipeline, and audio-reactive light drives.

## Quick Start

```bash
pnpm install
pnpm dev        # Run all packages in dev mode (see Dev Server Management)
pnpm build      # Build all packages
pnpm kill       # Kill all dev processes
pnpm redev      # Kill and restart dev (named `redev` to avoid pnpm's `restart`
                # lifecycle which implicitly requires `stop`/`start` scripts)
```

## Services & Ports

| Port | What | Package |
|------|------|---------|
| 3001 | Lightbox server — lights/groups/scenes/palettes, autopilot supervisor, stem-sync, audio-sync, latency calibration; WS at `/ws` | `server` |
| 3002 | Music library server — track library, audio + per-stem oggs, queue, local playback state (`/api/playback`), energy envelopes (ENV2), chroma | `musicbox` (server half) |
| 3010 | Twinklybox — WLED/DDP pattern engine (audio bus: mic, syscap, musicbox-follower) | `twinklybox` (server half) |
| 3020 | Curtainbox — Govee curtain direct LAN client | `curtainbox` (server half) |
| 5173 | Main light-control client (wheel, palettes, rooms) | `client` |
| 5174 | Thin local music player (root + `/musicplayer.html`, `src/player/`) | `musicbox` (client half) |
| 5175 | Musicbox2 — Spotify-driven console: now playing, stem viz, drive rail, queue, diagnostics | `musicbox2` |
| 5180 | Twinklybox UI | `twinklybox` |
| 5190 | Curtainbox UI | `curtainbox` |

The old musicbox v1 client (AutopilotPage, waveform/onset timelines) is
**deleted** — the `musicbox` package is now the library server plus a thin
local player. History in GRAVESTONE.md.

```
packages/
├── shared/         # Types & utilities (build first)
├── server/         # Lightbox server (Express + WS + SQLite) :3001
├── client/         # Main light UI :5173
├── musicbox/       # Library server :3002 + thin player :5174
├── musicbox2/      # Spotify console UI :5175
├── music-scraper/  # Python: scraper CLI, ingest (zotify+demucs), autopilot daemon
├── twinklybox/     # WLED/DDP patterns :3010/:5180
└── curtainbox/     # Govee curtain client :3020/:5190
```

## Dev Server Management (for Claude)

**Claude manages the dev server.** Start it with `pnpm dev` via Bash
`run_in_background: true`. It pipes combined output to `/tmp/lightbox.log`
(dev-session log only; all durable state/logs live elsewhere — see below).

**Caveat (July 2026, partially verified):** processes started from a
non-GUI context (ssh, nohup) on macOS Sequoia may be blocked by Local
Network TCC (symptom: server gets EHOSTUNREACH to Hue/Tuya/Govee while
shell curl/ping succeed) and lose `/opt/homebrew/bin` from PATH (ffmpeg →
envelope 500s, demucs rc=1). If either signature appears after a restart
from ssh, have the owner restart `pnpm dev` from a GUI terminal instead.

**Code changes**: picked up automatically (tsx watch + vite HMR) — no
restart needed for .ts/.tsx edits.

**Config/data changes** (e.g. `tuya-devices.json`, routes added while the
server had an import error): run `pnpm redev`.

## State & Log Locations (never /tmp)

macOS purges /tmp after ~3 days — durable state and logs must not live there.

- `packages/server/data/` — SQLite (`lightbox.db`), `hue-config.json`,
  `tuya-devices.json`, `stem-sync.json`, `latency-registry.json`
- `packages/server/data/state/` — `lightbox-autopilot.json` (autopilot
  heartbeat/state; shared contract between `scraper/autopilot.py`,
  `routes/autopilot.ts`, `services/stem-sync.ts`), latency-cal video dumps
- `~/.local/state/lightbox/` — `autopilot.log` (10MB truncate-on-boot),
  `ingest.log`, `zotify.lock`
- `~/.config/musicbox/` — Spotify credentials + `.spotipy_cache` (shared by
  the autopilot daemon and every ingest subprocess; writes are atomic)
- `~/music-library/tracks/<id>/` — audio.ogg, stems/, envelope caches

## Music → Lights Pipeline

1. **Autopilot daemon** (`music-scraper/scraper/autopilot.py`, spawned and
   supervised by the lightbox server via `/api/autopilot/*`): polls Spotify
   for the playhead (drift-corrected anchor), auto-ingests the current track
   and queue prefetch (zotify download → demucs stems). Hardened: bounded
   spotipy calls (no in-call retry sleeps), classified backoff (429 cap
   15min, auth tombstone after 10 consecutive 401s), idle polling decay,
   coasts through poll errors up to 60s before declaring paused, tombstone
   state file on any exit. The server watchdog reaps wedged pids, adopts
   across tsx restarts, has a respawn circuit breaker, and never respawns
   over an auth tombstone. Boot auto-spawn is deliberately OFF.
2. **Library server** (:3002) computes per-stem RMS envelopes + 12-band FFT
   (ENV2 binary) and chroma, cached with a ~50-track LRU.
3. **Stem-sync** (`server/src/services/stem-sync.ts`) maps stem energy at
   the playhead onto Hue Entertainment channels at 50Hz. Playhead source is
   configurable: `'spotify'` (autopilot state file) or `'local'` (thin
   player pushing to :3002/api/playback). A supervisor reconciles
   `wantActive` every 5s and rebuilds dead DTLS streams.
4. **Twinklybox** follows :3002 playback + envelopes (or mic/syscap live
   audio) into WLED/DDP patterns.

**Audio-reactive control must use the Hue Entertainment stream — never
REST** (REST pulse-firing is dead; see GRAVESTONE.md). `audio-sync.ts` is
the live system-audio fallback drive (no stems/playhead needed); it has no
UI entry point, curl its routes.

Latency: per-light offsets come from mic/webcam ground-truth measurement
(`latency-calibration.ts`, registry in `data/latency-registry.json`) — never
from eyeballed sliders. Mic/camera probes must run from a GUI-session
process (TCC silently zeroes them over ssh).

## Light Integrations

### Hue (via Bridge)
- Local API; bridge discovery via mDNS/UPnP; first connect needs button press
- `drivers/hue.ts` (REST + EventStream), `drivers/hue-entertainment.ts`
  (DTLS stream; creates `lightbox-stream[-<hash>]` entertainment configs on
  the bridge on demand), `drivers/hue-rest-pulse.ts` (REST helpers:
  getRestLights, snapshots — used by stem-sync/audio-sync/calibration)
- All clipV2 requests carry 10s timeouts; every outbound fetch in the
  codebase must be bounded (AbortSignal.timeout) — unbounded calls caused
  the July 2026 incident night

### Govee (LAN)
- UDP discovery :4001, control :4003; enable "LAN Control" per device in app
- `drivers/govee.ts`; curtain lights also driven via twinklybox (WLED/DDP)
  and curtainbox (direct) — different transports, both used

### Tuya (Local)
- Keys via `cd packages/server/data && python3 -m tinytuya wizard`
- Bulbs have a built-in ~800ms fade (firmware, can't disable); Hue has
  `transitiontime` — for animations send Tuya more frequent updates
- BLE-only devices (`tuya-ble.ts` + `tuya-ble-proxy.ts`) use
  @abandonware/noble, encrypted, flaky; TODO: separate service process

### WiZ
- `drivers/wiz.ts`, registered and live

## Lightbox Server API (:3001)

- Lights/groups/scenes/rooms/palettes CRUD as before (`routes/`)
- `/api/autopilot/*` — start/stop/state/debug/self-test (supervisor)
- `/api/stem-sync/*` — start/stop/config/bindings/status
- `/api/audio-sync/*` — live system-audio drive
- `/api/latency-calibration/*`, `/api/audio-latency/*` — measurement stack
- WS `ws://localhost:3001/ws` — `lights_sync`, `light_update`, room/palette
  broadcasts

Palette animation runs **server-side** (survives browser close, per-room
state, synchronized clients).

## Spotify / Rate Limits

App "Bongo" is our own client_id. Limits are per-endpoint; sustained 24/7
polling once earned a 13.5h extended 429 — hence idle polling decay and
retries=0 (urllib3's in-call Retry-After sleep is what wedged the daemon).
Token cache is shared across processes; writes are atomic (temp+rename).

## Color Accuracy Notes

- Hue's proprietary hs scale (Red=0, Green=25500, Blue=46920), not standard
  HSV; color/temperature mutually exclusive modes
- SUNVIE Tuya and Hue are on different color spaces; close enough for now
- Future: CIE xy with per-bulb gamut handling (Hue gamuts A/B/C)

## Open Threads

- 401 "Access token missing" bursts despite valid cached token — atomic
  cache writes deployed as suspected fix; watch whether bursts recur
- Bridge flaps: devbox↔Hue LAN segment intermittently drops (EHOSTUNREACH
  bursts, ping RTT 3→85ms) — software now survives it; the link itself is
  a hardware/network question
- Supervision: autopilot + stem-sync self-heal; BLE child, twinklybox,
  envelope pipeline don't yet (extract the wantActive-reconcile pattern)
- launchd user agents for always-on services; rename `musicbox` package →
  `library`; error-surfacing pass over the UIs' silent `.catch(() => {})`
