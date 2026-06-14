// Twinklybox server. Discovers + drives Twinkly LED arrays.
// Port 3010. Sibling of lightbox/musicbox — no shared imports.

import express from 'express';
import { TwinklyDevice } from './twinkly.js';
import { WledDriver } from './wled.js';
import { SerialDriver } from './serial.js';
import type { LedDriver } from './led-driver.js';
import { FrameLoop } from './frame-loop.js';
import { type Pattern } from './patterns.js';
import { startFollower, setManualPlayback, getFollowerState, setSynth, type SynthParams } from './musicbox-follower.js';
import { audioBus, getSmoothing, setSmoothing } from './audio-bus.js';
import { setMicActive, pushMicFrame, getMicStatus } from './mic-source.js';

const PORT = 3010;

// One active output target at a time. Swapping targets disposes the prior
// driver + frame loop and stands up a new pair. The architecture supports
// running multiple drivers in parallel later — there's just no UI for it.
let driver: LedDriver | null = null;
let loop: FrameLoop | null = null;
let currentPattern: Pattern | null = null;

// Known targets we might auto-connect to. First match wins on boot.
type TargetKind = 'twinkly' | 'wled' | 'serial';
// Tried in order on boot; first reachable wins. `serial` is listed first so
// that once the USB-C cable is plugged in it's preferred (wired = no WiFi
// jitter); if no cable is present its connect() throws and we fall through
// to the same WLED over DDP. host is the WLED's IP either way (serial still
// uses HTTP for LED count + matrix metadata).
const KNOWN_TARGETS: { kind: TargetKind; host: string }[] = [
  { kind: 'serial', host: '192.168.20.243' },
  { kind: 'wled', host: '192.168.20.243' },
  { kind: 'twinkly', host: '192.168.11.253' },
];

async function connectDriver(kind: TargetKind, host: string): Promise<LedDriver> {
  // If we're already on this exact target, return it; otherwise tear the
  // old one down before standing up the new one.
  if (driver && driver.kind === kind && driver.host === host && loop) return driver;
  if (driver) {
    try { await loop?.stop(); } catch { /* ignore */ }
    try { await driver.dispose(); } catch { /* ignore */ }
    driver = null;
    loop = null;
  }
  const d: LedDriver = kind === 'wled'
    ? await WledDriver.connect(host)
    : kind === 'serial'
    ? await SerialDriver.connect(host)
    : await (async () => { const t = new TwinklyDevice(host); await t.connect(); return t; })();
  driver = d;
  loop = new FrameLoop(d);
  const layout = d.getLayout();
  console.log(`[driver] connected ${kind}@${host} — "${d.name}", ${d.numLeds} LEDs (${d.bytesPerLed === 4 ? 'RGBW' : 'RGB'}), layout=${layout ? `${layout.coords.length} pts (${layout.source})` : 'none'}`);
  if (currentPattern) loop.setPattern(currentPattern);
  return d;
}

const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

function describeDriver(d: LedDriver) {
  const layout = d.getLayout();
  return {
    kind: d.kind,
    host: d.host,
    connected: true,
    name: d.name,
    numLeds: d.numLeds,
    bytesPerLed: d.bytesPerLed,
    ledProfile: d.bytesPerLed === 4 ? 'RGBW' : 'RGB',
    hasLayout: !!layout,
    layoutSource: layout?.source ?? null,
    matrix: layout?.matrix ?? null,
  };
}

app.get('/api/devices', async (_req, res) => {
  if (!driver) {
    return res.json({
      devices: KNOWN_TARGETS.map((t) => ({ kind: t.kind, host: t.host, connected: false })),
    });
  }
  res.json({ devices: [describeDriver(driver)] });
});

app.post('/api/connect', async (req, res) => {
  const kind = (req.body?.kind ?? 'twinkly') as TargetKind;
  const host = (req.body?.host as string) ?? (req.body?.ip as string) ?? KNOWN_TARGETS.find((t) => t.kind === kind)?.host;
  if (!host) return res.status(400).json({ ok: false, error: 'host required' });
  try {
    const d = await connectDriver(kind, host);
    res.json({ ok: true, device: describeDriver(d) });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

app.post('/api/stream/start', async (_req, res) => {
  if (!loop) return res.status(400).json({ error: 'not connected — POST /api/connect first' });
  await loop.start();
  res.json(loop.getStats());
});

app.post('/api/stream/stop', async (_req, res) => {
  if (!loop) return res.status(400).json({ error: 'not connected' });
  await loop.stop();
  res.json(loop.getStats());
});

app.get('/api/stream/state', (_req, res) => {
  if (!loop) return res.json({ running: false, hz: 0, frameCount: 0, patternKind: null });
  res.json(loop.getStats());
});

// Toggle the WLED timecode buffer mode (jitter absorption via the
// timecode_buffer usermod). No-op for non-WLED drivers. Body: { on, port? }.
app.post('/api/buffer', (req, res) => {
  if (!driver) return res.status(400).json({ error: 'not connected' });
  if (!(driver instanceof WledDriver)) {
    return res.status(400).json({ error: `buffer mode is WLED-only (driver is ${driver.kind})` });
  }
  const on = req.body?.on !== false; // default true
  const port = typeof req.body?.port === 'number' ? req.body.port : undefined;
  driver.setBufferMode(on, port ? { port } : undefined);
  console.log(`[driver] timecode buffer mode ${on ? 'ON' : 'off'}${port ? ` (port ${port})` : ''}`);
  res.json({ buffered: driver.isBuffered });
});

app.post('/api/pattern', (req, res) => {
  // Body is a Pattern union literal — solid/gradient/perlin/strobe with params.
  if (!loop) return res.status(400).json({ error: 'not connected' });
  const p = req.body as Pattern;
  if (!p || !p.kind) return res.status(400).json({ error: 'body.kind required' });
  loop.setPattern(p);
  currentPattern = p;
  res.json({ ok: true, pattern: p });
});

app.get('/api/pattern', (_req, res) => {
  res.json({ pattern: currentPattern });
});

app.post('/api/hz', (req, res) => {
  if (!loop) return res.status(400).json({ error: 'not connected' });
  const hz = Number(req.body?.hz);
  if (!Number.isFinite(hz)) return res.status(400).json({ error: 'hz number required' });
  loop.setHz(hz);
  res.json(loop.getStats());
});

app.get('/api/gamma', (_req, res) => {
  if (!loop) return res.status(400).json({ error: 'not connected' });
  res.json({ gamma: loop.getGamma() });
});
app.post('/api/gamma', (req, res) => {
  if (!loop) return res.status(400).json({ error: 'not connected' });
  const g = Number(req.body?.gamma);
  if (!Number.isFinite(g)) return res.status(400).json({ error: 'gamma number required' });
  loop.setGamma(g);
  res.json({ gamma: loop.getGamma() });
});

// ---- Audio source endpoints ----
//
// /api/audio       — current per-stem energy + playback context.
// /api/source      — what the audio bus is currently following (musicbox
//                    poll vs manual scrub) and the cached envelope list.
// /api/source/manual POST { trackId, position, playing } — override the
//                    follower. Useful for testing before musicbox client
//                    is wired to push state.

app.get('/api/audio', (_req, res) => {
  res.json(audioBus());
});

// Current LED frame data — Uint8Array, RGB(W) bytes per LED matching the
// driver's bytesPerLed. Used by the browser 3D viewer to mirror what's
// going out the wire.
app.get('/api/frame', (_req, res) => {
  if (!loop || !driver) return res.status(503).send('not connected');
  const buf = loop.getFrame();
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Num-Leds', String(driver.numLeds));
  res.setHeader('X-Bytes-Per-Led', String(driver.bytesPerLed));
  res.send(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength));
});

// Device layout (normalized coords + matrix info if applicable) for the
// 3D viewer.
app.get('/api/layout', (_req, res) => {
  if (!driver) return res.status(503).json({ error: 'not connected' });
  const layout = driver.getLayout();
  res.json({
    numLeds: driver.numLeds,
    bytesPerLed: driver.bytesPerLed,
    coords: layout?.coords ?? null,
    matrix: layout?.matrix ?? null,
    source: layout?.source ?? null,
  });
});

app.get('/api/source', (_req, res) => {
  res.json(getFollowerState());
});

// Asymmetric smoothing applied to every audio-bus write. attack = α for
// rising values (snappy near 0, soft attack near 1); decay = α for
// falling values (sharp at 0, long tail near 1).
app.get('/api/source/smoothing', (_req, res) => res.json(getSmoothing()));
app.post('/api/source/smoothing', (req, res) => {
  const body = req.body ?? {};
  setSmoothing({ attack: body.attack, decay: body.decay });
  res.json(getSmoothing());
});

// Synthetic dummy audio source. POST { mode, hz, amplitude } to enable,
// POST { mode: null } (or empty) to clear.
app.post('/api/source/synth', (req, res) => {
  const body = req.body ?? {};
  if (!body.mode || body.mode === null) {
    setSynth(null);
    return res.json({ synthActive: false });
  }
  const allowed: SynthParams['mode'][] = ['sine', 'pulse', 'all-on', 'all-sine'];
  if (!allowed.includes(body.mode)) return res.status(400).json({ error: `mode must be one of ${allowed.join(', ')}` });
  const hz = typeof body.hz === 'number' ? body.hz : 1;
  const amp = typeof body.amplitude === 'number' ? body.amplitude : 1;
  setSynth({ mode: body.mode, hz, amplitude: amp });
  res.json({ synthActive: true, mode: body.mode, hz, amplitude: amp });
});

// Live mic source. The browser client captures the machine's microphone,
// FFTs it, and streams 12-band frames here. Toggle on/off with
// POST /api/source/mic { active }; stream raw band frames to
// POST /api/source/mic/frame { bands: number[12] } while active. Mic
// overrides the musicbox follower (but not synth). Normalization is a 30s
// rolling window — see mic-source.ts.
app.post('/api/source/mic', (req, res) => {
  const active = !!req.body?.active;
  if (active) setSynth(null); // mic + synth are mutually exclusive overrides
  setMicActive(active);
  res.json({ micActive: active, ...getMicStatus() });
});

app.post('/api/source/mic/frame', (req, res) => {
  const bands = req.body?.bands;
  if (!Array.isArray(bands)) return res.status(400).json({ error: 'bands array required' });
  pushMicFrame(bands.map(Number));
  res.json({ ok: true });
});

app.get('/api/source/mic', (_req, res) => res.json(getMicStatus()));

app.post('/api/source/manual', (req, res) => {
  const body = req.body ?? {};
  if (body === null || body.trackId === null) {
    setManualPlayback(null);
    return res.json({ manualOverride: false });
  }
  if (typeof body.trackId !== 'string') return res.status(400).json({ error: 'trackId string or null required' });
  const pos = typeof body.position === 'number' ? body.position : 0;
  const playing = typeof body.playing === 'boolean' ? body.playing : true;
  setManualPlayback({ trackId: body.trackId, position: pos, playing, ts: Date.now() });
  res.json({ manualOverride: true, trackId: body.trackId, position: pos, playing });
});

app.listen(PORT, () => {
  console.log(`Twinklybox server: http://localhost:${PORT}`);
});

// Auto-connect to the known device on boot so the client doesn't have to.
// Auto-connect: try targets in declared order. First success wins; the
// rest can be picked from the UI's target selector.
(async () => {
  for (const t of KNOWN_TARGETS) {
    try {
      await connectDriver(t.kind, t.host);
      console.log(`[driver] auto-connected ${t.kind}@${t.host} on boot`);
      return;
    } catch { /* try next */ }
  }
  console.warn('[driver] no known target reachable on boot');
})();

// Begin polling musicbox for playback state. Silently no-ops while
// musicbox isn't reachable, so we don't crash the server on boot if it's
// not running.
startFollower();
