# igled

From-scratch ESP32 firmware for the two Govee curtain matrices (couch1 /
window: 32×30 WS2812 on GPIO 16, plain ESP32, 4MB flash). Replaces WLED.

Two modes, interleaved automatically:

- **Dumb listener** — twinklybox streams DDP frames. Port **4048** renders
  immediately; port **4049** expects the DDP TIME flag (sender-clock ms
  timecode) and plays each frame on a fixed delay, AirPlay-style, absorbing
  Wi-Fi jitter (same wire format + algorithm family as our old
  `wled-timecode` usermod, reimplemented without WLED).
- **Native routines** — when nothing has streamed for ~2.5s the box renders
  its own effect. `soap` (lifted from WLED v0.15.3, EUPL — attribution in
  `src/fx_soap.h`), `twinkle` (port of the twinklybox pattern), `solid`,
  `off`.

## HTTP API (port 80)

| Route | What |
|---|---|
| `GET /json/info` | WLED-shaped info — twinklybox's driver/health probes work unchanged (incl. the "Timecode Buffer" usermod strings its buffer-mode autodetect looks for) |
| `GET/POST /json/state` | `{"bri":0-255}` master brightness; `{"rb":true}` reboot |
| `GET/POST /api/routine` | `{"kind":"soap"\|"twinkle"\|"solid"\|"off", ...params}` — soap: `speed`, `smoothness`, `palette` (name); twinkle: `hue,sat,val,density,periodMs,hueJitter` |
| `GET /api/stats` | stream buffer depth/delay/drops, heap |
| `POST /update` | firmware OTA: `curl -F "update=@firmware.bin" http://<box>/update` |

Also ArduinoOTA (espota, port 3232): `pnpm --filter @lightbox/igled ota:couch1`
(or `ota:window`). Per-device builds bake in the name — mDNS `couch1.local` /
`window.local` (generic `igled` env falls back to `igled-<mac>.local`).

## Boot safety (the boxes are hard to reach)

Crash counter in RTC memory: three crash-reboots in a row → **safe mode**
(Wi-Fi + OTA + HTTP only, LEDs untouched, `/json/info` reports `"safe":true`)
so a bad build can always be reflashed remotely. Counter clears after 2
minutes of healthy uptime.

## Flashing over a live WLED box (first install)

WLED's own OTA updater accepts any app image (OTA is unlocked on our boxes):

```bash
pnpm igled:build
curl -F "update=@packages/igled/.pio/build/couch1/firmware.bin" http://couch1.local/update
```

The flash partition table stays WLED's (app0/app1 1.5MB each — plenty).
After reboot the box comes up as `couch1.local`. **There is no
automatic rollback** — if the new image crash-loops, safe mode is the net;
if it can't even reach safe mode, it's ladder + USB. Flash the healthier box
first and verify before doing the second.

Secrets: copy `include/secrets.example.h` → `include/secrets.h` (gitignored).
