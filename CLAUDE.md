# Lightbox

Unified smart light control with React UI, Node.js backend, and MCP server.

## Quick Start

```bash
pnpm install
pnpm dev        # Run all packages in dev mode
pnpm server     # Run server only
pnpm client     # Run client only
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

### Tuya (Deferred)
- Requires local key extraction
- Use tinytuya wizard: `python -m tinytuya wizard`
- Keys stored in `tuya_devices.json`

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

- [ ] **Tuya integration** - Need to extract local keys first
- [ ] **Audio reactive** - Sync to Sonos playback
- [ ] **Schedules** - Timer & automation
- [ ] **Scene builder UI** - Color wheel with rotation, gradients, generative patterns

## Scene Builder Concept

The scene builder will have:
1. Color wheel with draggable light pins (like Hue)
2. Wheel rotation - spin the wheel to shift all colors while keeping relative positions
3. Gradient mode - set start/end colors, lights distribute automatically
4. Generative patterns - "warm sunset", "ocean", "forest" presets
