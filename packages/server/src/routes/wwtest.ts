// WW A/B test: does the Entertainment stream engage the warm-white diodes?
// One bedroom strip shows a kelvin via the normal ct path (REST). The other
// strip shows the SAME blackbody point via the Entertainment stream. Compare
// them by eye. Page: GET /api/wwtest/page
import { Router } from 'express';
import type { LightManager } from '../lib/light-manager.js';
import { getSharedEntertainmentDriver } from '../drivers/hue-entertainment.js';
import { blackbodyXy, xyToRgb, xyToLinearRgb } from '@lightbox/shared';

const LIGHTS = ['hue:3', 'hue:4'];   // spaceship floor, cockpit

interface TestState {
  active: boolean;
  kelvin: number;
  brightness: number;              // 0-100
  encoding: 'srgb' | 'linear';     // how we encode RGB onto the stream
  streamId: string;                // which light gets the stream
}
const state: TestState = { active: false, kelvin: 3000, brightness: 70, encoding: 'srgb', streamId: 'hue:4' };

function streamRgb16(k: number, briPct: number, encoding: 'srgb' | 'linear') {
  const xy = blackbodyXy(k);
  let rgb;
  if (encoding === 'linear') {
    const l = xyToLinearRgb(xy);
    const m = Math.max(l.r, l.g, l.b, 1e-6);
    rgb = { r: Math.max(0, l.r) / m, g: Math.max(0, l.g) / m, b: Math.max(0, l.b) / m };
  } else {
    rgb = xyToRgb(xy);               // gamma-encoded sRGB, peak-normalized
  }
  const s = briPct / 100;
  return {
    r: Math.round(rgb.r * s * 65535),
    g: Math.round(rgb.g * s * 65535),
    b: Math.round(rgb.b * s * 65535),
  };
}

export function createWwTestRouter(lightManager: LightManager): Router {
  const router = Router();
  const driver = () => getSharedEntertainmentDriver();

  const refId = () => LIGHTS.find((id) => id !== state.streamId)!;

  async function applyRef(): Promise<void> {
    await lightManager.setLightState(refId(), {
      on: true, temperature: state.kelvin, brightness: state.brightness,
    }, 300).catch(() => {});
  }

  function applyStream(): void {
    const d = driver();
    const { r, g, b } = streamRgb16(state.kelvin, state.brightness, state.encoding);
    for (const ch of d.getChannels()) d.setChannel(ch.id, r, g, b);
  }

  async function startStream(): Promise<void> {
    const d = driver();
    const name = lightManager.getLight(state.streamId)?.name;
    if (!name) throw new Error(`unknown light ${state.streamId}`);
    if (d.active) await d.stop();
    await lightManager.setLightState(state.streamId, { on: true }, 0).catch(() => {});
    await d.start({ lightNames: [name] });
    applyStream();
  }

  router.get('/', (_req, res) => {
    const names = Object.fromEntries(LIGHTS.map((id) => [id, lightManager.getLight(id)?.name?.trim() ?? id]));
    res.json({ ...state, refId: refId(), names });
  });

  router.post('/start', async (req, res) => {
    try {
      if (typeof req.body?.kelvin === 'number') state.kelvin = Math.max(2000, Math.min(6500, Math.round(req.body.kelvin)));
      if (typeof req.body?.brightness === 'number') state.brightness = Math.max(1, Math.min(100, Math.round(req.body.brightness)));
      if (req.body?.encoding === 'srgb' || req.body?.encoding === 'linear') state.encoding = req.body.encoding;
      await startStream();
      await applyRef();
      state.active = true;
      res.json({ ok: true, ...state });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  // Live updates while running (kelvin slider, encoding toggle, brightness)
  router.post('/update', async (req, res) => {
    if (typeof req.body?.kelvin === 'number') state.kelvin = Math.max(2000, Math.min(6500, Math.round(req.body.kelvin)));
    if (typeof req.body?.brightness === 'number') state.brightness = Math.max(1, Math.min(100, Math.round(req.body.brightness)));
    if (req.body?.encoding === 'srgb' || req.body?.encoding === 'linear') state.encoding = req.body.encoding;
    if (state.active) { applyStream(); await applyRef(); }
    res.json({ ok: true, ...state });
  });

  router.post('/swap', async (_req, res) => {
    try {
      state.streamId = refId();
      if (state.active) { await startStream(); await applyRef(); }
      res.json({ ok: true, ...state });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  router.post('/stop', async (_req, res) => {
    state.active = false;
    try { await driver().stop(); } catch { /* already stopped */ }
    // Land both strips on the same ct so the test ends symmetric.
    for (const id of LIGHTS) {
      await lightManager.setLightState(id, { temperature: state.kelvin, brightness: state.brightness }, 300).catch(() => {});
    }
    res.json({ ok: true });
  });

  router.get('/page', (_req, res) => {
    res.type('html').send(PAGE);
  });

  return router;
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WW stream test</title>
<style>
  body { background:#09090b; color:#e4e4e7; font:14px ui-monospace,monospace; margin:0; padding:24px; }
  .card { background:#18181b; border-radius:10px; padding:16px 18px; max-width:430px; margin:0 auto 14px; }
  h1 { font-size:15px; margin:0 0 6px; } p { color:#a1a1aa; font-size:12px; margin:6px 0; }
  .roles { display:flex; gap:10px; margin:10px 0; }
  .role { flex:1; border-radius:8px; padding:10px; text-align:center; border:1px solid #3f3f46; }
  .role b { display:block; font-size:13px; } .role span { font-size:11px; color:#a1a1aa; }
  .ct { border-color:#f59e0b55; } .stream { border-color:#8b5cf655; }
  label { display:flex; align-items:center; gap:10px; margin:12px 0; font-size:12px; color:#a1a1aa; }
  input[type=range] { flex:1; }
  .val { width:52px; text-align:right; color:#e4e4e7; }
  button { background:#27272a; color:#e4e4e7; border:0; border-radius:7px; padding:9px 14px; font:inherit; cursor:pointer; }
  button.primary { background:#7c3aed; } button:disabled { opacity:.4; }
  .row { display:flex; gap:8px; margin-top:12px; }
  .enc { display:flex; gap:6px; } .enc button.on { background:#3f3f46; outline:1px solid #8b5cf6; }
  #status { font-size:12px; color:#71717a; margin-top:10px; min-height:16px; }
</style></head><body>
<div class="card">
  <h1>Entertainment-stream white test</h1>
  <p>One strip shows the kelvin through the normal <b>ct path</b> (warm-white
  diodes guaranteed). The other shows the same blackbody point through the
  <b>Entertainment stream</b>. If you cannot tell them apart, the stream
  engages the whites and "stream everything" is safe.</p>
  <div class="roles">
    <div class="role ct"><b id="refName">…</b><span>ct / REST (reference)</span></div>
    <div class="role stream"><b id="streamName">…</b><span>Entertainment stream</span></div>
  </div>
  <label>kelvin <input id="k" type="range" min="2000" max="6500" step="50" value="3000"><span class="val" id="kv">3000K</span></label>
  <label>brightness <input id="b" type="range" min="10" max="100" step="5" value="70"><span class="val" id="bv">70%</span></label>
  <label>stream encoding
    <span class="enc">
      <button id="encS" class="on">sRGB</button>
      <button id="encL">linear</button>
    </span>
  </label>
  <p>Try both encodings — it is not documented which one the bridge expects,
  and the wrong one will look visibly off from the reference.</p>
  <div class="row">
    <button class="primary" id="start">start</button>
    <button id="swap">swap strips</button>
    <button id="stop">stop</button>
  </div>
  <div id="status"></div>
</div>
<script>
const $ = (id) => document.getElementById(id);
let enc = 'srgb', active = false;
async function api(path, body) {
  const r = await fetch('/api/wwtest' + path, body ? { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) } : {});
  return r.json();
}
function paint(s) {
  active = !!s.active;
  if (s.names) { $('streamName').textContent = s.names[s.streamId]; $('refName').textContent = s.names[s.refId]; }
  $('status').textContent = active ? 'running — compare the strips' : 'stopped';
}
function params() { return { kelvin:+$('k').value, brightness:+$('b').value, encoding:enc }; }
let t=null;
function pushUpdate(){ clearTimeout(t); t=setTimeout(async()=>{ paint(await api('/update', params())); }, 120); }
$('k').oninput = () => { $('kv').textContent = $('k').value + 'K'; pushUpdate(); };
$('b').oninput = () => { $('bv').textContent = $('b').value + '%'; pushUpdate(); };
$('encS').onclick = () => { enc='srgb'; $('encS').classList.add('on'); $('encL').classList.remove('on'); pushUpdate(); };
$('encL').onclick = () => { enc='linear'; $('encL').classList.add('on'); $('encS').classList.remove('on'); pushUpdate(); };
$('start').onclick = async () => { $('status').textContent='starting stream…'; const r = await api('/start', params()); paint(r); if(!r.ok) $('status').textContent = 'error: ' + r.error; else refresh(); };
$('swap').onclick = async () => { paint(await api('/swap', {})); refresh(); };
$('stop').onclick = async () => { await api('/stop', {}); refresh(); };
async function refresh(){ paint(await api('', null)); }
refresh();
</script></body></html>`;
