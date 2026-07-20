import { Router } from 'express';
import {
  startAudioSync,
  stopAudioSync,
  getAudioSyncStatus,
  updateAudioSyncConfig,
  freezeAudioSyncNorm,
  setAudioSyncPaletteAnimator,
} from '../services/audio-sync.js';
import type { PaletteAnimator } from '../lib/palette-animator.js';

// Live system-audio → Hue brightness sync. REST-only control surface:
//   POST /api/audio-sync/start
//   POST /api/audio-sync/stop
//   GET  /api/audio-sync/status
//   POST /api/audio-sync/freeze-norm   capture current p2/p98 as fixed bounds, switch to 'frozen'
//   PUT  /api/audio-sync/config   { delayMs?, tickMs?, normMode?, attack?, decay?, gamma?,
//                                   channels?: { low?/high?: { lightName?, minLevel?, maxLevel? } } }
//   GET  /api/audio-sync/ui       tiny self-contained control panel
export function createAudioSyncRouter(paletteAnimator?: PaletteAnimator): Router {
  const r = Router();
  if (paletteAnimator) setAudioSyncPaletteAnimator(paletteAnimator);

  r.post('/start', async (_req, res) => {
    const result = await startAudioSync();
    if (!result.ok) return res.status(500).json(result);
    res.json(getAudioSyncStatus());
  });

  r.post('/stop', async (_req, res) => {
    await stopAudioSync();
    res.json(getAudioSyncStatus());
  });

  r.get('/status', (_req, res) => {
    res.json(getAudioSyncStatus());
  });

  r.put('/config', (req, res) => {
    const cfg = updateAudioSyncConfig(req.body ?? {});
    res.json({ config: cfg });
  });

  r.post('/freeze-norm', (_req, res) => {
    const result = freezeAudioSyncNorm();
    if (!result.ok) return res.status(400).json(result);
    res.json({ ...result, config: getAudioSyncStatus().config });
  });

  r.get('/ui', (_req, res) => {
    res.type('html').send(UI_HTML);
  });

  return r;
}

// Minimal control panel — no build step, just polls /status and PUTs /config.
const UI_HTML = /* html */ `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>audio-sync</title>
<style>
  body { font: 14px/1.5 -apple-system, sans-serif; background: #111; color: #ddd; max-width: 540px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.1rem; letter-spacing: .05em; }
  .bar { height: 22px; background: #222; border-radius: 4px; overflow: hidden; margin: 2px 0 10px; }
  .bar > div { height: 100%; width: 0%; transition: width 40ms linear; }
  #bar-low > div { background: #e0564f; }
  #bar-high > div { background: #4fa8e0; }
  label { display: flex; align-items: center; gap: .6rem; margin: .35rem 0; }
  label span.name { width: 7.5rem; color: #999; }
  label span.val { width: 3.5rem; text-align: right; font-variant-numeric: tabular-nums; }
  input[type=range] { flex: 1; }
  button, select { background: #2a2a2a; color: #ddd; border: 1px solid #444; border-radius: 5px; padding: .35rem .8rem; font-size: 13px; }
  button:hover { background: #383838; cursor: pointer; }
  #state { color: #7c7; } #state.off { color: #c77; }
  .row { display: flex; gap: .5rem; align-items: center; margin: .8rem 0; }
  .muted { color: #777; font-size: 12px; }
</style>
<h1>audio-sync <span id="state" class="off">…</span></h1>
<div class="muted" id="lights"></div>
<div>low</div><div class="bar" id="bar-low"><div></div></div>
<div>high</div><div class="bar" id="bar-high"><div></div></div>
<div class="row">
  <button id="startstop">start</button>
  <select id="normMode">
    <option value="minmax">minmax (rolling)</option>
    <option value="frozen">frozen bounds</option>
    <option value="pct">percentile</option>
  </select>
  <button id="freeze" title="capture current p2/p98 as fixed bounds">freeze now</button>
  <span class="muted" id="frozen"></span>
</div>
<label><span class="name">gamma</span><input type="range" id="gamma" min="0.2" max="4" step="0.05"><span class="val"></span></label>
<label><span class="name">decay</span><input type="range" id="decay" min="0" max="0.99" step="0.01"><span class="val"></span></label>
<label><span class="name">attack</span><input type="range" id="attack" min="0" max="0.99" step="0.01"><span class="val"></span></label>
<label><span class="name">delay ms</span><input type="range" id="delayMs" min="0" max="3000" step="50"><span class="val"></span></label>
<label><span class="name">low floor</span><input type="range" id="lowMin" min="0" max="1" step="0.01"><span class="val"></span></label>
<label><span class="name">high floor</span><input type="range" id="highMin" min="0" max="1" step="0.01"><span class="val"></span></label>
<script>
const $ = (id) => document.getElementById(id);
const api = (p, opts) => fetch('/api/audio-sync' + p, opts).then(r => r.json());
let cfgDirty = false, active = false;

function putConfig(patch) {
  cfgDirty = true;
  fetch('/api/audio-sync/config', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
  }).finally(() => { cfgDirty = false; });
}

for (const id of ['gamma', 'decay', 'attack', 'delayMs']) {
  $(id).addEventListener('input', (e) => {
    e.target.nextElementSibling.textContent = e.target.value;
    putConfig({ [id]: Number(e.target.value) });
  });
}
$('lowMin').addEventListener('input', (e) => {
  e.target.nextElementSibling.textContent = e.target.value;
  putConfig({ channels: { low: { minLevel: Number(e.target.value) } } });
});
$('highMin').addEventListener('input', (e) => {
  e.target.nextElementSibling.textContent = e.target.value;
  putConfig({ channels: { high: { minLevel: Number(e.target.value) } } });
});
$('normMode').addEventListener('change', (e) => putConfig({ normMode: e.target.value }));
$('freeze').addEventListener('click', async () => {
  const r = await api('/freeze-norm', { method: 'POST' });
  if (!r.ok) alert(r.error);
});
$('startstop').addEventListener('click', () => api(active ? '/stop' : '/start', { method: 'POST' }));

let seededControls = false;
setInterval(async () => {
  try {
    const s = await api('/status');
    active = s.active;
    $('state').textContent = s.active ? (s.fresh ? 'live' : 'active (no audio)') : 'stopped';
    $('state').className = s.active && s.fresh ? '' : 'off';
    $('startstop').textContent = s.active ? 'stop' : 'start';
    $('frozen').textContent = s.frozen ? 'bounds captured' : '';
    $('lights').textContent = 'low → ' + (s.channels.low.light ?? '?') + '   ·   high → ' + (s.channels.high.light ?? '?');
    $('bar-low').firstElementChild.style.width = (s.channels.low.level * 100) + '%';
    $('bar-high').firstElementChild.style.width = (s.channels.high.level * 100) + '%';
    // Seed sliders from server config once (and never while user is dragging).
    if (!seededControls && !cfgDirty) {
      seededControls = true;
      for (const id of ['gamma', 'decay', 'attack', 'delayMs']) {
        $(id).value = s.config[id];
        $(id).nextElementSibling.textContent = s.config[id];
      }
      $('lowMin').value = s.config.channels.low.minLevel;
      $('lowMin').nextElementSibling.textContent = s.config.channels.low.minLevel;
      $('highMin').value = s.config.channels.high.minLevel;
      $('highMin').nextElementSibling.textContent = s.config.channels.high.minLevel;
      $('normMode').value = s.config.normMode;
    }
  } catch { $('state').textContent = 'server?'; $('state').className = 'off'; }
}, 120);
</script>`;
