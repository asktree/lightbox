import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Light, WSMessage, DebugLogEntry, RoomState, PalettePositions } from '@lightbox/shared';
import { Database } from './lib/database.js';
import { LightManager } from './lib/light-manager.js';
import { PaletteAnimator } from './lib/palette-animator.js';
import { createLightsRouter } from './routes/lights.js';
import { createGroupsRouter } from './routes/groups.js';
import { createPalettesRouter } from './routes/palettes.js';
import { createRoomsRouter } from './routes/rooms.js';
import { createChatRouter } from './routes/chat.js';

const PORT = process.env.PORT || 3001;

const app = express();
app.use(express.json());

// CORS for development
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Initialize shared database
const db = new Database();
db.initialize();

// Initialize light manager and palette animator (share database)
const lightManager = new LightManager(db);
const paletteAnimator = new PaletteAnimator(db, lightManager);

// Broadcast to all connected clients
function broadcast(message: WSMessage) {
  const data = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// Subscribe to light updates
lightManager.on('update', (light: Light) => {
  broadcast({ type: 'light_update', light });
});

// Subscribe to debug logs
lightManager.on('debug', (entry: DebugLogEntry) => {
  broadcast({ type: 'debug_log', entry });
});

lightManager.on('debug_update', ({ id, message }: { id: string; message: string }) => {
  broadcast({ type: 'debug_log_update', id, message });
});

// Subscribe to diagnostics changes (connection state, etc.)
lightManager.on('diagnostics', (diagnostics) => {
  broadcast({ type: 'diagnostics_sync', diagnostics });
});

// Subscribe to palette animator events
paletteAnimator.on('room_state', (state: RoomState) => {
  broadcast({ type: 'room_state', ...state } as WSMessage);
});

paletteAnimator.on('palette_positions', (data: { roomId: string; paletteId: string; positions: PalettePositions }) => {
  broadcast({ type: 'palette_positions', ...data } as WSMessage);
});

paletteAnimator.on('position_update', (data: { roomId: string; paletteId: string; lightId: string; position: number }) => {
  broadcast({ type: 'position_update', ...data } as WSMessage);
});

// WebSocket connection handling
wss.on('connection', async (ws) => {
  console.log('Client connected');

  // Send current state on connect
  const lights = lightManager.getAllLights();
  ws.send(JSON.stringify({ type: 'lights_sync', lights } satisfies WSMessage));

  // Send diagnostics on connect
  const diagnostics = lightManager.getDiagnostics();
  ws.send(JSON.stringify({ type: 'diagnostics_sync', diagnostics } satisfies WSMessage));

  // Send room states on connect
  const roomStates = paletteAnimator.getAllRoomStates();
  ws.send(JSON.stringify({ type: 'room_states_sync', roomStates }));

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

// Mount routes
app.use('/api/lights', createLightsRouter(lightManager));
app.use('/api/groups', createGroupsRouter(lightManager));
app.use('/api/palettes', createPalettesRouter(lightManager));
app.use('/api/rooms', createRoomsRouter(paletteAnimator));
app.use('/api/chat', createChatRouter(lightManager));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', lights: lightManager.getAllLights().length });
});

// Start server
async function start() {
  // Start HTTP server early so clients can connect while drivers initialize
  server.listen(PORT, () => {
    console.log(`Lightbox server running on http://localhost:${PORT}`);
    console.log(`WebSocket available at ws://localhost:${PORT}/ws`);
  });

  // Initialize drivers and palette animator in background
  try {
    await lightManager.initialize();
    console.log(`Discovered ${lightManager.getAllLights().length} lights`);

    await paletteAnimator.initialize();
    console.log('Palette animator initialized');

    // Broadcast updated state to all connected clients now that initialization is complete
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        const lights = lightManager.getAllLights();
        client.send(JSON.stringify({ type: 'lights_sync', lights } satisfies WSMessage));
        const diagnostics = lightManager.getDiagnostics();
        client.send(JSON.stringify({ type: 'diagnostics_sync', diagnostics } satisfies WSMessage));
        const roomStates = paletteAnimator.getAllRoomStates();
        client.send(JSON.stringify({ type: 'room_states_sync', roomStates }));
      }
    });
  } catch (err) {
    console.error('Failed to initialize:', err);
    // Don't exit - server is running, just drivers failed
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  paletteAnimator.dispose();
  lightManager.dispose().then(() => {
    db.close();
    process.exit(0);
  });
});

start();
