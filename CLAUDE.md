# Lightbox

Unified smart light control with React UI, Node.js backend, and MCP server.

## Quick Start

```bash
pnpm install
pnpm dev        # Run all packages in dev mode
pnpm server     # Run server only
pnpm client     # Run client only
pnpm build      # Build all packages
```

To build a single package:
```bash
cd packages/client && pnpm build
cd packages/server && pnpm build
# Or use filter: pnpm --filter @lightbox/client build
```

Server: http://localhost:3001
Client: http://localhost:5173 (when implemented)
WebSocket: ws://localhost:3001/ws

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

## Future Work

- [x] **Tuya integration** - Local control via tinytuya
- [ ] **Scene light selection** - In grid view, ability to include/exclude lights from scene. Excluded lights go to bottom of grid, faded out, ignored in wheel/animation views
- [ ] **Audio reactive** - Sync to Sonos playback
- [ ] **Schedules** - Timer & automation
- [ ] **Agent chat** - Claude-powered assistant for natural language light control

## Scene System

Scenes save light states + optional animation tracks:
- **SceneTrack**: Bezier path on color wheel, lights animate along it
- **Tension slider**: 0 = straight lines, 1 = smooth Catmull-Rom curves
- **Speed slider**: Log scale, seconds per track node
- Stores: `packages/server/data/lightbox.db` (scenes table)
- Client: `packages/client/src/stores/scenes.ts`

## Scene Builder Concept

The scene builder will have:
1. Color wheel with draggable light pins (like Hue)
2. Bezier track drawing - click to add nodes, drag to move, double-click to delete
3. Wheel rotation - spin the wheel to shift all colors while keeping relative positions
4. Gradient mode - set start/end colors, lights distribute automatically
5. Generative patterns - "warm sunset", "ocean", "forest" presets
