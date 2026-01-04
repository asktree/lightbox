import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Light, WSMessage, DebugLogEntry } from '@lightbox/shared';
import { LightManager } from './lib/light-manager.js';
import { createLightsRouter } from './routes/lights.js';
import { createGroupsRouter } from './routes/groups.js';
import { createPalettesRouter } from './routes/palettes.js';
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

// Initialize light manager
const lightManager = new LightManager();

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

// WebSocket connection handling
wss.on('connection', async (ws) => {
  console.log('Client connected');

  // Send current state on connect
  const lights = lightManager.getAllLights();
  ws.send(JSON.stringify({ type: 'lights_sync', lights } satisfies WSMessage));

  // Send diagnostics on connect
  const diagnostics = lightManager.getDiagnostics();
  ws.send(JSON.stringify({ type: 'diagnostics_sync', diagnostics } satisfies WSMessage));

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

// Mount routes
app.use('/api/lights', createLightsRouter(lightManager));
app.use('/api/groups', createGroupsRouter(lightManager));
app.use('/api/palettes', createPalettesRouter(lightManager));
app.use('/api/chat', createChatRouter(lightManager));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', lights: lightManager.getAllLights().length });
});

// Start server
async function start() {
  try {
    await lightManager.initialize();
    console.log(`Discovered ${lightManager.getAllLights().length} lights`);

    server.listen(PORT, () => {
      console.log(`Lightbox server running on http://localhost:${PORT}`);
      console.log(`WebSocket available at ws://localhost:${PORT}/ws`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
