# Lightbox

Unified smart light control with React UI, Node.js backend, and MCP server.

## Quick Start

```bash
pnpm install
pnpm dev        # Run all packages in dev mode (Claude runs this in background)
pnpm server     # Run server only
pnpm client     # Run client only
pnpm musicbox   # Run musicbox only
pnpm build      # Build all packages
pnpm screenbox:flash    # Build + flash the ESP32 touch panel over USB-C
pnpm screenbox:ota      # Build + flash the panel over Wi-Fi (screenbox.local)
pnpm screenbox:monitor  # Serial output from the panel
pnpm kill       # Kill all dev processes
pnpm redev      # Kill and restart dev (named `redev` to avoid pnpm's `restart`
                # lifecycle which implicitly requires `stop`/`start` scripts)
```

Server: http://localhost:3001
Client: http://localhost:5173
Musicbox: http://localhost:5174
WebSocket: ws://localhost:3001/ws

## Dev Server Management (for Claude)

**Claude manages the dev server.** Start it with `pnpm dev` via Bash
`run_in_background: true`. It pipes combined output to `/tmp/lightbox.log`.
Three watchers run in parallel:
- `tsx watch` for server (auto-restarts on .ts changes)
- `vite` for client / musicbox (HMR on file changes)
- `tsc --watch` for shared types

**Logs**: read `/tmp/lightbox.log` to debug.

**Code changes**: picked up automatically — no restart needed for .ts/.tsx edits.

**Config/data changes** (e.g., `tuya-devices.json`, new routes added while the
server had an import error, etc.): run `pnpm redev` to fully restart.

To build a single package:
```bash
pnpm --filter @lightbox/client build
pnpm --filter @lightbox/server build
```

## Architecture

```
packages/
├── shared/    # Types & utilities (build first)
├── server/    # Express + WebSocket + SQLite
├── client/    # React + Vite + Tailwind
├── mcp/       # MCP server for Claude
└── screenbox/ # ESP32-S3 touch-panel firmware (PlatformIO/C++, not JS)
```

## Screenbox (physical touch panel)

Firmware for a Wireless-Tag **WT32S3-28S PRO** (internal model `ZX2D80CE02S`,
PanelLan `SC05_X`): ESP32-S3, 8 MB flash / 2 MB PSRAM, 2.8" 240×320 ST7789 on
an 8-bit 8080 bus, FT5x06 touch. Lives in `packages/screenbox/` and is **not**
part of `pnpm dev`/`pnpm build` — it has its own `compile`/`flash`/`monitor`
scripts that wrap PlatformIO (`pip3 install platformio intelhex`).

- Flash over the board's own USB-C port (shows up as `/dev/cu.usbmodem*`,
  Espressif USB JTAG/serial). No BOOT button dance needed. Once online it
  also accepts OTA uploads as `screenbox.local` (`pnpm screenbox:ota`).
- Wi-Fi/server config lives in gitignored `packages/screenbox/include/secrets.h`
  (template: `secrets.example.h`). The panel should point at **hearth**, the
  always-on server Mac (`LIGHTBOX_HOST "hearth.local"`). Setup steps for a
  session on hearth: `packages/screenbox/README.md` → "Running it from hearth".
- Pin map + LovyanGFX display/touch config: `packages/screenbox/src/board.h`.
  Datasheet in `packages/screenbox/docs/`.
- Search the web for "ZX2D80CE02S" or "SC05_X", not "WT32S3-28S PRO".
- Vendor's ZXACC-ESPDB burn tool (plugs into the 7-pin debug header) is only a
  fallback for a bricked USB port.

## Light Integrations

### Hue (via Bridge)
- Local API, no cloud required
- Bridge discovery via mDNS/UPnP
- First connection requires button press
- `packages/server/src/drivers/hue.ts`

### Govee (LAN Protocol)
- UDP multicast discovery on port 4001
- Control commands on port 4003
- Must enable "LAN Control" in Govee app for each device
- `packages/server/src/drivers/govee.ts`

### Tuya (Local Control)
- Requires local key extraction via tinytuya wizard
- Run: `cd packages/server/data && python3 -m tinytuya wizard`
- Keys stored in `packages/server/data/tuya-devices.json`
- Some devices may need "LAN Control" enabled in SmartLife app
- Devices must be on same network as server (check 2.4GHz vs 5GHz)
- `packages/server/src/drivers/tuya.ts`

## API

### Lights
- `GET /api/lights` - List all
- `GET /api/lights/:id` - Get one
- `PUT /api/lights/:id` - Set state

### Groups
- `GET /api/groups` - List all
- `POST /api/groups` - Create
- `PUT /api/groups/:id` - Update
- `DELETE /api/groups/:id` - Delete
- `PUT /api/groups/:id/state` - Control

### Scenes
- `GET /api/scenes` - List all
- `POST /api/scenes` - Create
- `DELETE /api/scenes/:id` - Delete
- `PUT /api/scenes/:id/activate` - Activate

### WebSocket
Connect to `ws://localhost:3001/ws` for real-time updates.

Messages:
- `lights_sync` - Full state on connect
- `light_update` - Single light changed

## Data

SQLite database at `packages/server/data/lightbox.db`
- `groups` - Light groups
- `scenes` - Saved scenes

## Feature Ideas

- Disconnected lights on ColorWheel should be faded (50% opacity) - still selectable and draggable, just visually greyed out to indicate attempts to move them probably won't work
- Palette view should display light pins the same way as ColorWheel (reuse component). When dragging in palette view, lights snap to nearest point on the track instead of free movement.

## Future Work

- [x] **Tuya integration** - Local control via tinytuya
- [ ] **Snapshots** - Quick save of current light positions from wheel view (next priority)
- [ ] **Automations** - Time-based triggers with snapshot/palette actions
- [x] **Color accuracy** - Hue driver speaks xy (sRGB-exact, gamut-clipped); shared colour lib
- [ ] **Audio reactive** - Sync to Sonos playback
- [ ] **Agent chat** - Claude-powered assistant for natural language light control

## Snapshots

Quick mood-boarding feature for saving light states:
- One-click save from wheel view
- Shows as list on left side with color swatches (no names required, but optional)
- Easy delete
- Cannot be edited - just delete and remake
- Clicking a snapshot applies it instantly

## Automations

Time/event-based light control:
- Each automation step can reference a **snapshot** or **palette**
- **Snapshots are COPIED** into the automation - deleting the snapshot won't break it
- **Palettes are REFERENCED** - deleting palette breaks the automation
- Triggers: time of day, sunrise/sunset, manual

## Palettes

Animated color paths on the wheel:
- Catmull-Rom spline through nodes on color wheel
- **Tension slider**: 0 = straight lines, 1 = smooth curves
- **Speed slider**: seconds per node
- Lights animate along the path
- Double-click wheel to add node, double-click node to delete
- Stored in SQLite: `packages/server/data/lightbox.db`

**Server-side animation**: Palette animation runs on the server, not the client.
- Closing the browser doesn't stop the palette animation
- Animation state is per-room (activePaletteId, isPlaying, light positions)
- Palette definitions are global (same list for all rooms)
- Light positions persist per-palette in database
- Multiple clients viewing the same room see synchronized state
- WebSocket broadcasts: `room_state`, `palette_positions`, `position_update`
- REST API: `/api/rooms/:roomId/play`, `/api/rooms/:roomId/pause`, etc.

## Color Accuracy

The UI model is HSV `{h, s}` on a wheel (angle = hue, radius = saturation, V=100) and
the wheel renders sRGB. **Accuracy = the bulb shows the sRGB colour you see on the wheel.**

- Colour maths lives in `packages/shared/src/color.ts`: `hsToXy`/`xyToHs` (via sRGB),
  `xyToRgb`/`rgbToXy`, gamut triangles (`GAMUTS.hueC` — every current Hue bulb on the
  bridge is Gamut C — plus `hueA`, `hueB`, `srgb`) with `clipToGamut`, and whites
  (`kelvinToXy`, `xyToKelvin`, `planckianLocus`). Also `spectralLocus()` if a CIE
  diagram view is ever wanted (we tried it; too green-heavy to be a useful UI).
- **Hue driver sends native `xy`** = chromaticity of the sRGB colour, clipped to the bulb's
  reported gamut — *not* Hue's `hue`/`sat`, whose scale is bulb-defined and doesn't match
  the wheel. Inbound (v1 state and v2 EventStream) reads `xy` back through the exact
  inverse, so round trips are the identity and Hue matches WiZ/Tuya, which get the same
  sRGB. (Old code sent a piecewise hue/sat guess and read xy back through a different
  path, so pins twitched after every drag — the client's 1 s echo cooldown hid it.)
- WiZ/Govee: `hsvToRgb` → sRGB bytes. Tuya: HSV natively (its scale is close to sRGB HSV).

## Tuya Transition Behavior

Tuya bulbs have **built-in ~800ms fade** between color/brightness changes - cannot be disabled.
- Hue has `transitiontime` parameter (100ms units) - works great
- Tuya has no equivalent - fade is baked into firmware
- For palette animations: send more frequent updates to Tuya lights to compensate
- The built-in fade actually helps smooth out the animation

Sources:
- https://github.com/jasonacox/tinytuya/issues/29
- https://developer.tuya.com/en/docs/iot-device-dev/light_of_control

## Tuya BLE

BLE-only devices (Sunset Lamp, Galaxy Projector) require separate handling:
- Uses `@abandonware/noble` for BLE communication
- Encrypted protocol with login key (MD5 of local_key[0:6]) and session key
- Packets chunked to 20-byte MTU for BLE transmission
- Devices only accept connections when in pairing mode (flaky)

**TODO:** Move BLE driver to separate service process:
- Avoids noble blocking issues in main server
- Can restart BLE independently
- Could run on separate device (Pi near BLE devices)
