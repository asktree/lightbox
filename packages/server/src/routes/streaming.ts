/**
 * Hue Entertainment API streaming test routes.
 *
 * Two modes:
 *   REST  — PUT /lights/{id}/state calls at ~10fps (higher latency)
 *   DTLS  — Hue Entertainment UDP stream at 25fps (low latency)
 *
 * Pulse envelope: configurable attack + decay (ms). Brightness ramps up
 * over attack, then fades over decay, then stays dark until the next
 * interval tick.
 */
import { Router } from 'express';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { dtls } from 'node-dtls-client';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../../data');

interface HueConfig {
  bridgeIp: string;
  username: string;
  clientKey: string;
}

function loadHueConfig(): HueConfig {
  return JSON.parse(readFileSync(join(DATA_DIR, 'hue-config.json'), 'utf-8'));
}

// ---- Envelope math ----

function envelope(t: number, attack: number, decay: number, interval: number): number {
  const phase = t % interval;
  if (phase < attack) return attack > 0 ? phase / attack : 1;
  if (phase < attack + decay) return decay > 0 ? 1 - (phase - attack) / decay : 0;
  return 0;
}

// ---- State ----

let mode: 'idle' | 'rest' | 'dtls' = 'idle';
let pulseTimer: ReturnType<typeof setInterval> | null = null;
let dtlsSocket: ReturnType<typeof dtls.createSocket> | null = null;
let activeLights: number[] = [];
let currentBrightness = 0;
let pulseStartTime = 0;
let pulseParams = { attack: 100, decay: 400, interval: 1000, fps: 25 };

// ---- REST pulsing ----

async function hueRest(lightId: number, state: object): Promise<void> {
  const cfg = loadHueConfig();
  await fetch(`http://${cfg.bridgeIp}/api/${cfg.username}/lights/${lightId}/state`, {
    method: 'PUT',
    body: JSON.stringify(state),
  });
}

function startRestPulse(lights: number[], params: typeof pulseParams): void {
  stopPulse();
  mode = 'rest';
  activeLights = lights;
  pulseParams = params;
  pulseStartTime = Date.now();

  // REST mode: send two commands per cycle — one for the attack (ramp up)
  // and one for the decay (fade down). The bridge's built-in transitiontime
  // handles the smooth interpolation, so we only need to send at pulse
  // boundaries, not every frame.
  const attackTransition = Math.round(params.attack / 100);   // transitiontime is in 100ms units
  const decayTransition = Math.round(params.decay / 100);

  let phase: 'attack' | 'decay' = 'attack';

  const sendPulse = async () => {
    if (phase === 'attack') {
      currentBrightness = 1;
      await Promise.allSettled(
        lights.map(id => hueRest(id, { on: true, bri: 254, transitiontime: attackTransition }))
      );
      phase = 'decay';
      // Schedule decay after attack completes
      pulseTimer = setTimeout(async () => {
        currentBrightness = 0;
        await Promise.allSettled(
          lights.map(id => hueRest(id, { on: true, bri: 1, transitiontime: decayTransition }))
        );
        phase = 'attack';
        // Schedule next pulse after decay + remaining gap
        const gap = Math.max(0, params.interval - params.attack - params.decay);
        pulseTimer = setTimeout(sendPulse, params.decay + gap);
      }, params.attack);
    }
  };
  sendPulse();
}

// ---- DTLS streaming ----

// Build a HueStream v1 frame in XY+Brightness mode (0x01). This is the
// officially recommended color space for the Entertainment API — RGB mode
// (0x00) has spotty support across Hue light models.
//
// For white at varying brightness: X=0.3127, Y=0.3290 (D65 white point),
// brightness varies 0-65535.
function buildHueStreamFrame(lights: Array<{ id: number; brightness: number }>): Buffer {
  const header = Buffer.from([
    0x48, 0x75, 0x65, 0x53, 0x74, 0x72, 0x65, 0x61, 0x6d, // "HueStream"
    0x01, 0x00, // API version 1.0
    0x00,       // sequence number (ignored in v1)
    0x00, 0x00, // reserved
    0x01,       // color space: 0x01 = XY + Brightness
    0x00,       // reserved
  ]);
  const perLight = lights.map(l => {
    const buf = Buffer.alloc(9);
    buf[0] = 0x00; // device type: light
    buf.writeUInt16BE(l.id, 1);
    // D65 white point: x=0.3127 y=0.3290, mapped to 0-65535
    buf.writeUInt16BE(Math.round(0.3127 * 65535), 3);   // X
    buf.writeUInt16BE(Math.round(0.3290 * 65535), 5);   // Y
    buf.writeUInt16BE(Math.round(l.brightness * 65535), 7); // Brightness
    return buf;
  });
  return Buffer.concat([header, ...perLight]);
}

async function activateEntertainmentGroup(groupId: number): Promise<void> {
  const cfg = loadHueConfig();
  const res = await fetch(`http://${cfg.bridgeIp}/api/${cfg.username}/groups/${groupId}`, {
    method: 'PUT',
    body: JSON.stringify({ stream: { active: true } }),
  });
  const body = await res.json();
  console.log('[streaming] activate group:', JSON.stringify(body));
}

async function deactivateEntertainmentGroup(groupId: number): Promise<void> {
  const cfg = loadHueConfig();
  try {
    await fetch(`http://${cfg.bridgeIp}/api/${cfg.username}/groups/${groupId}`, {
      method: 'PUT',
      body: JSON.stringify({ stream: { active: false } }),
    });
  } catch {}
}

function connectDtls(): Promise<typeof dtlsSocket> {
  const cfg = loadHueConfig();
  return new Promise((resolve, reject) => {
    const socket = dtls.createSocket({
      type: 'udp4',
      address: cfg.bridgeIp,
      port: 2100,
      psk: { [cfg.username]: Buffer.from(cfg.clientKey, 'hex') },
      timeout: 5000,
    });
    socket.on('connected', () => {
      console.log('[streaming] DTLS connected');
      resolve(socket);
    });
    socket.on('error', (err: Error) => {
      console.error('[streaming] DTLS error:', err.message);
      reject(err);
    });
    socket.on('close', () => {
      console.log('[streaming] DTLS closed');
      if (dtlsSocket === socket) dtlsSocket = null;
    });
  });
}

async function startDtlsPulse(lights: number[], params: typeof pulseParams, groupId: number): Promise<void> {
  stopPulse();
  mode = 'dtls';
  activeLights = lights;
  pulseParams = params;
  pulseStartTime = Date.now();

  await activateEntertainmentGroup(groupId);
  dtlsSocket = await connectDtls();

  const frameMs = Math.max(20, Math.round(1000 / params.fps));
  pulseTimer = setInterval(() => {
    if (!dtlsSocket) return;
    const t = Date.now() - pulseStartTime;
    const v = envelope(t, params.attack, params.decay, params.interval);
    currentBrightness = v;
    const frame = buildHueStreamFrame(
      lights.map(id => ({ id, brightness: v }))
    );
    try {
      dtlsSocket.send(frame);
    } catch (err) {
      console.error('[streaming] send error:', err);
    }
  }, frameMs);
}

// ---- Stop ----

function stopPulse(): void {
  if (pulseTimer) {
    clearInterval(pulseTimer as ReturnType<typeof setInterval>);
    clearTimeout(pulseTimer as ReturnType<typeof setTimeout>);
    pulseTimer = null;
  }
  if (dtlsSocket) {
    try { dtlsSocket.close(); } catch {}
    dtlsSocket = null;
  }
  if (mode === 'dtls') {
    deactivateEntertainmentGroup(200).catch(() => {});
  }
  mode = 'idle';
  activeLights = [];
  currentBrightness = 0;
}

// ---- Router ----

export function createStreamingRouter(): Router {
  const router = Router();

  router.get('/test', (_req, res) => {
    res.type('html').send(TEST_PAGE_HTML);
  });

  router.get('/status', (_req, res) => {
    res.json({
      mode, activeLights, currentBrightness,
      pulseParams, pulseStartTime,
    });
  });

  router.post('/pulse-rest', (req, res) => {
    const lights: number[] = req.body.lights ?? [6, 7];
    const params = {
      attack: req.body.attack ?? 100,
      decay: req.body.decay ?? 400,
      interval: req.body.intervalMs ?? 1000,
      fps: 0, // not used for REST — bridge handles transitions
    };
    startRestPulse(lights, params);
    res.json({ ok: true, mode: 'rest', lights, attack: params.attack, decay: params.decay, interval: params.interval });
  });

  router.post('/pulse-dtls', async (req, res) => {
    const lights: number[] = req.body.lights ?? [6, 7];
    const groupId: number = req.body.groupId ?? 200;
    const params = {
      attack: req.body.attack ?? 100,
      decay: req.body.decay ?? 400,
      interval: req.body.intervalMs ?? 1000,
      fps: Math.min(50, Math.max(1, req.body.fps ?? 25)),
    };
    try {
      await startDtlsPulse(lights, params, groupId);
      res.json({ ok: true, mode: 'dtls', lights, groupId, ...params });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post('/stop', (_req, res) => {
    stopPulse();
    res.json({ ok: true, mode: 'idle' });
  });

  return router;
}


// ---- Test page HTML ----

const TEST_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Streaming Test</title>
  <style>
    * { margin:0; box-sizing:border-box; }
    body { font-family:system-ui; background:#111; color:#eee; padding:1.5rem; }
    h1 { font-size:1.1rem; margin-bottom:1rem; color:#666; }
    .section { margin-bottom:1.5rem; padding:1rem; background:#1a1a1a; border-radius:8px; }
    .section h2 { font-size:0.8rem; margin-bottom:0.6rem; text-transform:uppercase;
                   letter-spacing:0.05em; color:#555; }
    label { display:block; font-size:0.75rem; color:#888; margin-bottom:0.2rem; }
    input, select { background:#222; color:#eee; border:1px solid #333; padding:0.3rem 0.5rem;
                    border-radius:4px; font-size:0.8rem; width:100%; margin-bottom:0.5rem; }
    .row { display:flex; gap:0.6rem; }
    .row > * { flex:1; }
    button { padding:0.5rem 1rem; border-radius:4px; border:none; font-size:0.8rem;
             cursor:pointer; margin-right:0.5rem; margin-top:0.3rem; font-weight:600; }
    .btn-go { background:#16a34a; color:white; }
    .btn-dtls { background:#2563eb; color:white; }
    .btn-stop { background:#dc2626; color:white; }
    button:hover { filter:brightness(0.85); }
    #status { font-family:monospace; font-size:0.75rem; color:#4ade80; margin:0.8rem 0; }
    canvas { width:100%; height:120px; display:block; border-radius:6px; background:#0a0a0a; }
    #log { font-family:monospace; font-size:0.7rem; color:#555; margin-top:0.5rem;
           max-height:120px; overflow-y:auto; white-space:pre-wrap; }
    .range-row { display:flex; align-items:center; gap:0.5rem; }
    .range-row input[type=range] { flex:1; }
    .range-row .val { font-size:0.75rem; font-family:monospace; color:#888; min-width:4ch; text-align:right; }
  </style>
</head>
<body>
  <h1>Hue Streaming Test</h1>

  <div class="section">
    <h2>Lights</h2>
    <div class="row">
      <div>
        <label>Light IDs (comma-separated)</label>
        <input id="lights" value="6,7">
      </div>
      <div>
        <label>Entertainment Group (DTLS)</label>
        <input id="group" type="number" value="200">
      </div>
    </div>
  </div>

  <div class="section">
    <h2>Envelope</h2>
    <label>Attack (ms)</label>
    <div class="range-row">
      <input id="attack" type="range" min="0" max="2000" value="100" oninput="syncVal(this)">
      <span class="val" id="attack-val">100</span>
    </div>
    <label>Decay (ms)</label>
    <div class="range-row">
      <input id="decay" type="range" min="0" max="2000" value="400" oninput="syncVal(this)">
      <span class="val" id="decay-val">400</span>
    </div>
    <label>Interval (ms)</label>
    <div class="range-row">
      <input id="interval" type="range" min="100" max="5000" value="1000" oninput="syncVal(this)">
      <span class="val" id="interval-val">1000</span>
    </div>
    <label>Frame rate (Hz) — Hue recommends 25 for DTLS</label>
    <div class="range-row">
      <input id="fps" type="range" min="1" max="50" value="25" oninput="syncVal(this)">
      <span class="val" id="fps-val">25</span>
    </div>
  </div>

  <div class="section">
    <h2>Controls</h2>
    <button class="btn-go" onclick="startRest()">Pulse (REST)</button>
    <button class="btn-dtls" onclick="startDtls()">Pulse (DTLS)</button>
    <button class="btn-stop" onclick="stop()">Stop</button>
  </div>

  <div id="status">idle</div>
  <canvas id="graph"></canvas>
  <div id="log"></div>

<script>
const $status = document.getElementById('status');
const $log = document.getElementById('log');
const canvas = document.getElementById('graph');
const ctx = canvas.getContext('2d');

function syncVal(el) {
  document.getElementById(el.id + '-val').textContent = el.value;
}

function getLights() { return document.getElementById('lights').value.split(',').map(Number); }
function getAttack() { return +document.getElementById('attack').value; }
function getDecay() { return +document.getElementById('decay').value; }
function getInterval() { return +document.getElementById('interval').value; }
function getGroup() { return +document.getElementById('group').value; }
function getFps() { return +document.getElementById('fps').value; }

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  $log.textContent = ts + '  ' + msg + '\\n' + $log.textContent;
}

// ---- Envelope (client-side mirror for graph) ----

function envelopeFn(t, attack, decay, interval) {
  const phase = t % interval;
  if (phase < attack) return attack > 0 ? phase / attack : 1;
  if (phase < attack + decay) return decay > 0 ? 1 - (phase - attack) / decay : 0;
  return 0;
}

// ---- Timeline graph ----

let graphMode = null; // 'rest' | 'dtls' | null
let graphStart = 0;
const graphHistory = [];   // ring buffer of {t, v} for the scrolling view
const GRAPH_WINDOW_MS = 8000;

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

function drawGraph() {
  const w = canvas.getBoundingClientRect().width;
  const h = canvas.getBoundingClientRect().height;
  ctx.clearRect(0, 0, w, h);

  if (!graphMode) {
    // Idle — draw a flat line
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h - 10);
    ctx.lineTo(w, h - 10);
    ctx.stroke();
    requestAnimationFrame(drawGraph);
    return;
  }

  const now = Date.now();
  const attack = getAttack();
  const decay = getDecay();
  const interval = getInterval();
  const elapsed = now - graphStart;

  // "Now" is always at the right edge. Only draw history (no future).
  const windowEnd = elapsed;
  const windowSpan = Math.min(GRAPH_WINDOW_MS, elapsed); // grows during first 8s
  const windowStart = windowEnd - windowSpan;

  // Glow layer first (behind the main line)
  for (const [style, lw] of [['rgba(74,222,128,0.15)', 8], ['#4ade80', 2]]) {
    ctx.strokeStyle = style;
    ctx.lineWidth = lw;
    ctx.beginPath();
    for (let px = 0; px < w; px++) {
      const t = windowStart + (px / w) * windowSpan;
      const v = envelopeFn(t, attack, decay, interval);
      const y = h - 8 - v * (h - 16);
      if (px === 0) ctx.moveTo(px, y);
      else ctx.lineTo(px, y);
    }
    ctx.stroke();
  }

  // Current value readout
  const currentV = envelopeFn(elapsed, attack, decay, interval);
  ctx.fillStyle = '#4ade80';
  ctx.font = '11px monospace';
  ctx.fillText((currentV * 100).toFixed(0) + '%', 8, 16);

  requestAnimationFrame(drawGraph);
}
requestAnimationFrame(drawGraph);

// ---- API calls ----

async function api(path, body) {
  try {
    const res = await fetch('/api/streaming/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    log(path + ' → ' + JSON.stringify(data));
    return data;
  } catch (err) {
    log(path + ' ERROR: ' + err.message);
  }
}

async function startRest() {
  graphMode = 'rest';
  graphStart = Date.now();
  await api('pulse-rest', { lights: getLights(), attack: getAttack(), decay: getDecay(), intervalMs: getInterval(), fps: getFps() });
}

async function startDtls() {
  graphMode = 'dtls';
  graphStart = Date.now();
  await api('pulse-dtls', { lights: getLights(), attack: getAttack(), decay: getDecay(), intervalMs: getInterval(), fps: getFps(), groupId: getGroup() });
}

async function stop() {
  graphMode = null;
  await api('stop', {});
}

// Poll status for the status line
setInterval(async () => {
  try {
    const res = await fetch('/api/streaming/status');
    const d = await res.json();
    const bri = (d.currentBrightness * 100).toFixed(0);
    $status.textContent = d.mode +
      (d.activeLights?.length ? ' — lights: ' + d.activeLights.join(',') : '') +
      (d.mode !== 'idle' ? ' — bri: ' + bri + '%' : '');
    if (d.mode === 'idle' && graphMode) graphMode = null;
  } catch {}
}, 500);
</script>
</body>
</html>`;
