# Lightbox

Unified smart light control with React UI, Node.js backend, and MCP server.

## Quick Start

```bash
pnpm install
pnpm dev        # Run all packages in dev mode (user runs this in terminal)
pnpm server     # Run server only
pnpm client     # Run client only
pnpm build      # Build all packages
pnpm kill       # Kill all dev processes
pnpm restart    # Kill and restart dev
```

Server: http://localhost:3001
Client: http://localhost:5173
WebSocket: ws://localhost:3001/ws

## Dev Server Management (for Claude)

Claude runs `pnpm dev` in a background task. This starts 3 watch processes:
- `tsx watch` for server (auto-restarts on .ts changes)
- `vite` for client (HMR on file changes)
- `tsc --watch` for shared types

**Code changes**: Automatic - just edit files, watch mode handles restart.

**Config/data changes** (e.g., `tuya-devices.json`): Need server restart.

**To restart the server**, ALWAYS kill first to avoid port conflicts:
```bash
pnpm kill && sleep 1 && pnpm dev
```

The dev server output is written to a task output file - read it to monitor logs.

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
└── mcp/       # MCP server for Claude
```

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
- [ ] **Color accuracy** - Switch to xy color space with gamut handling per bulb type
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

## Color Accuracy Notes

Current: Using Hue's proprietary hs scale (Red=0, Green=25500, Blue=46920)
- Not standard HSV - requires piecewise conversion
- Color/temperature are mutually exclusive modes

**Known Issues:**
- SUNVIE Tuya lights and Hue lights are on different color spaces
- Hue colors don't map perfectly to our UI but close enough to be usable
- Need to investigate proper color space conversion per-brand

Future improvement: Use CIE xy color space with per-bulb gamut handling
- Different Hue bulbs have Gamut A, B, or C (different color triangles)
- Colors outside gamut get clipped to nearest point
- More accurate but more complex

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
