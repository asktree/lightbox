// Curtainbox server — test harness for the Govee Curtain Lights Pro (H70B6)
// razer/DreamView per-segment streaming protocol. Port 3020. Isolated from
// lightbox/musicbox/twinklybox.

import express from 'express';
import { GoveeLan, rainbow, solid, ruler, blePacket, encodeSceneCommand, type HeaderMode } from './govee.js';

const PORT = 3020;
// Single-byte segment count in the documented razer packet caps here.
const MAX_SEGMENTS_SINGLE_BYTE = 255;

const govee = new GoveeLan();
let devices: Awaited<ReturnType<GoveeLan['discover']>> = [];
let selectedIp: string | null = null;

// Animation loop state.
let animTimer: NodeJS.Timeout | null = null;
let animPhase = 0;
let animCfg = { segments: 20, hz: 10, mode: 'dreams' as HeaderMode, stretch: false, pattern: 'rainbow' as Pattern };

type Pattern = 'rainbow' | 'ruler' | 'solid';

function buildPattern(p: Pattern, n: number, phase: number, rgb: [number, number, number]): Uint8Array {
  switch (p) {
    case 'rainbow': return rainbow(n, phase);
    case 'ruler': return ruler(n);
    case 'solid': return solid(n, rgb[0], rgb[1], rgb[2]);
  }
}

const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.post('/api/scan', async (_req, res) => {
  try {
    devices = await govee.discover(3000);
    if (!selectedIp && devices.length > 0) selectedIp = devices[0].ip;
    res.json({ devices, selectedIp });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.get('/api/devices', (_req, res) => res.json({ devices, selectedIp }));

app.post('/api/select', (req, res) => {
  const ip = req.body?.ip;
  if (typeof ip !== 'string') return res.status(400).json({ error: 'ip required' });
  selectedIp = ip;
  res.json({ selectedIp });
});

app.get('/api/state', (_req, res) => {
  res.json({
    selectedIp,
    deviceCount: devices.length,
    animating: !!animTimer,
    anim: animCfg,
    maxSingleByteSegments: MAX_SEGMENTS_SINGLE_BYTE,
  });
});

// Standard LAN API sanity check — whole-device on/off/brightness/color.
// Confirms basic reachability before trying the razer stream.
app.post('/api/basic', (req, res) => {
  if (!selectedIp) return res.status(400).json({ error: 'no device selected — scan first' });
  const { on, brightness, color } = req.body ?? {};
  if (typeof on === 'boolean') govee.turn(selectedIp, on);
  if (typeof brightness === 'number') govee.setBrightness(selectedIp, brightness);
  if (color && typeof color.r === 'number') govee.setColor(selectedIp, color.r, color.g, color.b);
  res.json({ ok: true });
});

app.post('/api/stream/activate', (_req, res) => {
  if (!selectedIp) return res.status(400).json({ error: 'no device selected' });
  govee.setBrightness(selectedIp, 100);
  setTimeout(() => govee.activateStream(selectedIp!), 100);
  res.json({ ok: true });
});

app.post('/api/stream/deactivate', (_req, res) => {
  if (!selectedIp) return res.status(400).json({ error: 'no device selected' });
  stopAnim();
  govee.deactivateStream(selectedIp);
  res.json({ ok: true });
});

// Run the activate handshake: brightness(100) → razer-activate. Returns a
// promise that resolves after the handshake delay so frames sent right
// after land in stream mode. Matches LedFx's ordering (the order + delay
// were derived empirically; wrong order flickers).
async function ensureStream(ip: string): Promise<void> {
  govee.setBrightness(ip, 100);
  await new Promise((r) => setTimeout(r, 100));
  govee.activateStream(ip);
  await new Promise((r) => setTimeout(r, 100));
}

// One-shot frame. Self-activates first (brightness → activate → frame) so
// a single press actually shows something — stream mode otherwise lapses
// between a separate activate click and the frame.
app.post('/api/frame', async (req, res) => {
  if (!selectedIp) return res.status(400).json({ error: 'no device selected' });
  const reqN = Math.max(1, Math.floor(Number(req.body?.segments ?? 20)));
  const pattern = (req.body?.pattern ?? 'rainbow') as Pattern;
  const mode = (req.body?.mode ?? 'dreams') as HeaderMode;
  const stretch = !!req.body?.stretch;
  const rgb: [number, number, number] = [
    Number(req.body?.color?.r ?? 255),
    Number(req.body?.color?.g ?? 0),
    Number(req.body?.color?.b ?? 128),
  ];
  const n = Math.min(reqN, MAX_SEGMENTS_SINGLE_BYTE);
  // Send a burst of identical frames over ~400ms. A lone frame is easy for
  // the device to miss right after activate; a short burst is reliable
  // without committing to a continuous loop.
  await ensureStream(selectedIp);
  const colors = buildPattern(pattern, n, 0, rgb);
  for (let i = 0; i < 8; i++) {
    govee.sendFrame(selectedIp, colors, mode, stretch);
    await new Promise((r) => setTimeout(r, 50));
  }
  res.json({
    ok: true,
    requestedSegments: reqN,
    sentSegments: n,
    clamped: n !== reqN,
    note: n !== reqN
      ? `segment count capped at ${MAX_SEGMENTS_SINGLE_BYTE} (single-byte field in the documented razer packet)`
      : undefined,
  });
});

app.post('/api/animate', async (req, res) => {
  if (!selectedIp) return res.status(400).json({ error: 'no device selected' });
  const on = !!req.body?.on;
  if (!on) { stopAnim(); return res.json({ animating: false }); }
  animCfg = {
    segments: Math.min(MAX_SEGMENTS_SINGLE_BYTE, Math.max(1, Math.floor(Number(req.body?.segments ?? 20)))),
    hz: Math.max(1, Math.min(60, Number(req.body?.hz ?? 10))),
    mode: (req.body?.mode ?? 'dreams') as HeaderMode,
    stretch: !!req.body?.stretch,
    pattern: (req.body?.pattern ?? 'rainbow') as Pattern,
  };
  // Activate handshake before the pump, then keep frames flowing — which
  // is what keeps the device in stream mode.
  await ensureStream(selectedIp);
  startAnim();
  res.json({ animating: true, anim: animCfg });
});

function startAnim() {
  stopAnim();
  const periodMs = 1000 / animCfg.hz;
  animTimer = setInterval(() => {
    if (!selectedIp) return;
    animPhase = (animPhase + 0.01) % 1;
    const colors = buildPattern(animCfg.pattern, animCfg.segments, animPhase, [255, 0, 128]);
    govee.sendFrame(selectedIp, colors, animCfg.mode, animCfg.stretch);
  }, periodMs);
}
function stopAnim() {
  if (animTimer) { clearInterval(animTimer); animTimer = null; }
}

// Fuzz sweep — cycles header-mode × stretch, each as a distinct SOLID
// color held ~4s with continuous frames. Color-coded so the user can
// report which variant (if any) produced light without timing anything.
// Legend returned in the response.
const FUZZ_STEPS: { mode: HeaderMode; stretch: boolean; color: [number, number, number]; label: string }[] = [
  { mode: 'dreams', stretch: false, color: [255, 0, 0],   label: 'RED'     },
  { mode: 'dreams', stretch: true,  color: [0, 255, 0],   label: 'GREEN'   },
  { mode: 'chroma', stretch: false, color: [0, 0, 255],   label: 'BLUE'    },
  { mode: 'chroma', stretch: true,  color: [255, 255, 0], label: 'YELLOW'  },
  { mode: 'govee',  stretch: false, color: [0, 255, 255], label: 'CYAN'    },
  { mode: 'govee',  stretch: true,  color: [255, 0, 255], label: 'MAGENTA' },
];
let fuzzing = false;
app.post('/api/fuzz', async (req, res) => {
  if (!selectedIp) return res.status(400).json({ error: 'no device selected' });
  if (fuzzing) return res.status(409).json({ error: 'already fuzzing' });
  const n = Math.min(MAX_SEGMENTS_SINGLE_BYTE, Math.max(1, Math.floor(Number(req.body?.segments ?? 20))));
  const holdMs = Math.max(1500, Number(req.body?.holdMs ?? 4000));
  stopAnim();
  fuzzing = true;
  const ip = selectedIp;
  const legend = FUZZ_STEPS.map((s, i) => `${i + 1}. ${s.label} = mode=${s.mode} stretch=${s.stretch}`);
  // Respond immediately with the legend; run the sweep in the background.
  res.json({ ok: true, segments: n, holdMs, legend });
  (async () => {
    for (const step of FUZZ_STEPS) {
      console.log(`[fuzz] ${step.label}: mode=${step.mode} stretch=${step.stretch} n=${n}`);
      await ensureStream(ip);
      const colors = solid(n, step.color[0], step.color[1], step.color[2]);
      const end = Date.now() + holdMs;
      while (Date.now() < end) {
        govee.sendFrame(ip, colors, step.mode, step.stretch);
        await new Promise((r) => setTimeout(r, 60)); // ~16fps
      }
      // brief blackout between variants so transitions are visible
      govee.sendFrame(ip, solid(n, 0, 0, 0), step.mode, step.stretch);
      await new Promise((r) => setTimeout(r, 500));
    }
    govee.deactivateStream(ip);
    fuzzing = false;
    console.log('[fuzz] done');
  })();
});

// Confirm the ptReal BLE-passthrough channel is alive: blink power via BLE
// packets (33 01 00 = off, 33 01 01 = on), distinct from the native `turn`
// command. If the curtain blinks off→on, the channel works and the scene-
// command path is worth building.
app.post('/api/pt-test', async (_req, res) => {
  if (!selectedIp) return res.status(400).json({ error: 'no device selected' });
  const ip = selectedIp;
  stopAnim();
  const off = blePacket([0x33, 0x01, 0x00]);
  const on = blePacket([0x33, 0x01, 0x01]);
  res.json({ ok: true, note: 'blinking power via ptReal: off → (2s) → on' });
  govee.sendPtReal(ip, [off]);
  await new Promise((r) => setTimeout(r, 2000));
  govee.sendPtReal(ip, [on]);
});

// ---- Scenes (BLE-over-LAN, applies built-in effects) ----

interface SceneEntry { category: string; name: string; sceneCode: number; paramLen: number; scenceParam: string }
let sceneCache: SceneEntry[] = [];

async function loadScenes(sku = 'H70B6'): Promise<SceneEntry[]> {
  const r = await fetch(`https://app2.govee.com/appsku/v1/light-effect-libraries?sku=${sku}`, {
    headers: { AppVersion: '9999999' },
  });
  const j: any = await r.json();
  const out: SceneEntry[] = [];
  for (const c of j?.data?.categories ?? []) {
    for (const s of c.scenes ?? []) {
      for (const le of s.lightEffects ?? []) {
        const param = le.scenceParam ?? '';
        if (!param) continue;
        out.push({
          category: c.categoryName,
          name: s.sceneName + (le.scenceName ? ` (${le.scenceName})` : ''),
          sceneCode: le.sceneCode ?? s.sceneCode ?? 0,
          paramLen: Buffer.from(param, 'base64').length,
          scenceParam: param,
        });
      }
    }
  }
  return out;
}

app.get('/api/scenes', async (_req, res) => {
  try {
    if (sceneCache.length === 0) sceneCache = await loadScenes();
    // Don't ship the (huge) params to the client — just metadata, sorted
    // by upload size so the user can pick small/fast ones first.
    const list = sceneCache
      .map((s, i) => ({ idx: i, category: s.category, name: s.name, sceneCode: s.sceneCode, paramLen: s.paramLen }))
      .sort((a, b) => a.paramLen - b.paramLen);
    res.json({ count: list.length, scenes: list });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// Apply a scene by its index in the cached library. Encodes the scene
// command + sends every packet via ptReal. Large scenes (image GIFs) are
// hundreds of packets → slow; small ones are near-instant.
app.post('/api/scene/apply', async (req, res) => {
  if (!selectedIp) return res.status(400).json({ error: 'no device selected' });
  if (sceneCache.length === 0) sceneCache = await loadScenes();
  const idx = Number(req.body?.idx);
  const scene = sceneCache[idx];
  if (!scene) return res.status(400).json({ error: 'bad scene idx' });
  stopAnim();
  const packets = encodeSceneCommand(scene.sceneCode, scene.scenceParam);
  // Pace packets slightly so the device's BLE stack keeps up. ~3ms gap.
  for (const p of packets) {
    govee.sendPtReal(selectedIp, [p]);
    await new Promise((r) => setTimeout(r, 3));
  }
  res.json({ ok: true, name: scene.name, packets: packets.length, paramBytes: scene.paramLen });
});

app.listen(PORT, () => {
  console.log(`Curtainbox server: http://localhost:${PORT}`);
  console.log('Make sure LAN Control is enabled for the H70B6 in the Govee app.');
});

// Try an initial discovery on boot (best-effort).
govee.discover(3000).then((d) => {
  devices = d;
  if (d.length > 0) { selectedIp = d[0].ip; console.log(`[govee] found ${d.length}: ${d.map((x) => `${x.sku}@${x.ip}`).join(', ')}`); }
  else console.log('[govee] no devices found on initial scan');
}).catch((e) => console.warn('[govee] initial scan failed:', e));
