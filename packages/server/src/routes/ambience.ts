// Ambience mode: one switch that moves the room between two looks.
//   'color'  — lights live on the HSV wheel; curtains run their native soap
//   'normal' — temperature-capable lights drop onto the blackbody locus (Hue
//              bulbs render this with their warm-white diodes via ct/mirek);
//              curtains run twinkle
// Toggled by the screenbox panel (POST with its room's light ids); the mode
// itself is just in-memory server state the panels can read back.
import { Router } from 'express';
import { lookup } from 'node:dns/promises';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LightManager } from '../lib/light-manager.js';
import { hsToXy, xyToKelvin, blackbodyXy, xyToHs, xyToLinearRgb } from '@lightbox/shared';

type Mode = 'color' | 'normal';

// 1000K floor: below CT hardware's 2000K limit, into ember/coal territory —
// the LightManager emulates sub-2000K with the color engine (planckian xy).
const KELVIN_MIN = 1000;
const KELVIN_MAX = 6500;

// The two igled curtain boxes. Their native routine is what shows whenever
// twinklybox isn't streaming.
const CURTAIN_HOSTS = ['couch1.local', 'window.local'];
const TWINKLYBOX = 'http://localhost:3010';

// macOS getaddrinfo stalls ~5s on these .local names waiting for an AAAA
// answer the boxes never send — resolve IPv4 explicitly and cache.
const ipCache = new Map<string, { ip: string; at: number }>();
async function resolveIp(host: string): Promise<string> {
  const c = ipCache.get(host);
  if (c && Date.now() - c.at < 10 * 60_000) return c.ip;
  const { address } = await lookup(host, { family: 4 });
  ipCache.set(host, { ip: address, at: Date.now() });
  return address;
}

// Blackbody color as 0-255 RGB bytes for the LED strips. LINEAR light, not
// sRGB: WS2812 PWM is linear in the byte value, so gamma-encoded sRGB bytes
// render the low channels far too bright (2900K came out yellow-white).
// Normalized so the peak channel is 255 (brightest version of that
// chromaticity — the twinkle's own envelope handles brightness).
function kelvinToRgbBytes(k: number): { r: number; g: number; b: number } {
  let { r, g, b } = xyToLinearRgb(blackbodyXy(Math.max(1000, k)));
  r = Math.max(0, r); g = Math.max(0, g); b = Math.max(0, b);
  const m = Math.max(r, g, b, 1e-6);
  return { r: Math.round((r / m) * 255), g: Math.round((g / m) * 255), b: Math.round((b / m) * 255) };
}

async function postRoutine(body: object): Promise<Record<string, boolean>> {
  const results: Record<string, boolean> = {};
  await Promise.all(CURTAIN_HOSTS.map(async (host) => {
    try {
      const ip = await resolveIp(host);
      const r = await fetch(`http://${ip}/api/routine`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(3000),
      });
      results[host] = r.ok;
    } catch {
      results[host] = false;
    }
  }));
  return results;
}

async function setCurtains(mode: Mode, twinkleKelvin: number): Promise<Record<string, boolean>> {
  // An active twinklybox stream would paint over the native routine.
  await fetch(`${TWINKLYBOX}/api/stream/stop`, {
    method: 'POST',
    signal: AbortSignal.timeout(2000),
  }).catch(() => {});

  if (mode === 'normal') {
    return postRoutine({ kind: 'twinkle', rgb: kelvinToRgbBytes(twinkleKelvin) });
  }
  return postRoutine({ kind: 'soap' });
}

// --- per-light position memory ----------------------------------------------
// Toggling modes shouldn't be a lossy conversion round-trip: each light
// remembers its last wheel position (h/s) and its last bar position (kelvin)
// and returns to it. The nearest-blackbody conversion is only the fallback
// for a light that has never been in that mode. Persisted (atomically) so
// tsx-watch restarts don't forget.
interface AmbienceState {
  mode: Mode;
  lastColor: Record<string, { h: number; s: number }>;
  lastKelvin: Record<string, number>;
  curtainsKelvin: number;    // the twinkle dots' blackbody color (normal mode)
}
const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, '../../data/state/ambience.json');

function loadState(): AmbienceState {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as AmbienceState;
    if (s.mode === 'color' || s.mode === 'normal') {
      return { mode: s.mode, lastColor: s.lastColor ?? {}, lastKelvin: s.lastKelvin ?? {}, curtainsKelvin: s.curtainsKelvin ?? 2900 };
    }
  } catch { /* first run / unreadable — start fresh */ }
  return { mode: 'color', lastColor: {}, lastKelvin: {}, curtainsKelvin: 2900 };
}

function saveState(s: AmbienceState): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE + '.tmp', JSON.stringify(s, null, 2));
    renameSync(STATE_FILE + '.tmp', STATE_FILE);
  } catch (e) {
    console.error('[ambience] state save failed:', (e as Error).message);
  }
}

const state = loadState();

export function createAmbienceRouter(lightManager: LightManager): Router {
  const router = Router();

  router.get('/', (_req, res) => res.json({ mode: state.mode, curtainsKelvin: state.curtainsKelvin }));

  // Slide the twinkle dots along the blackbody locus (screenbox drags the
  // curtains pin on the kelvin bar). Applies live; save is debounced so a
  // drag doesn't hammer the disk.
  let saveTimer: NodeJS.Timeout | null = null;
  router.post('/twinkle', async (req, res) => {
    const k = Number(req.body?.kelvin);
    if (!Number.isFinite(k)) {
      res.status(400).json({ error: 'kelvin required' });
      return;
    }
    state.curtainsKelvin = Math.max(KELVIN_MIN, Math.min(KELVIN_MAX, Math.round(k)));
    if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; saveState(state); }, 1000);
    const curtains = await postRoutine({ kind: 'twinkle', rgb: kelvinToRgbBytes(state.curtainsKelvin) });
    res.json({ kelvin: state.curtainsKelvin, curtains });
  });

  router.post('/', async (req, res) => {
    const m = req.body?.mode as Mode;
    if (m !== 'color' && m !== 'normal') {
      res.status(400).json({ error: "mode must be 'color' or 'normal'" });
      return;
    }
    const ids: string[] = Array.isArray(req.body?.ids)
      ? req.body.ids
      : lightManager.getAllLights().map((l) => l.id);

    const changed: string[] = [];
    for (const id of ids) {
      const light = lightManager.getLight(id);
      if (!light || !light.state.on) continue;   // never wake a light just to re-mode it
      try {
        if (m === 'normal') {
          if (!light.capabilities.includes('temperature')) continue;
          // Remember where this light sat on the wheel, then return it to its
          // last bar position (fall back: nearest blackbody to current color).
          if (light.state.color) state.lastColor[id] = { h: light.state.color.h, s: light.state.color.s };
          let k = state.lastKelvin[id];
          if (k === undefined) {
            k = light.state.temperature
              ?? (light.state.color ? xyToKelvin(hsToXy(light.state.color.h, light.state.color.s)) : 2700);
          }
          k = Math.max(KELVIN_MIN, Math.min(KELVIN_MAX, Math.round(k)));
          await lightManager.setLightState(id, { temperature: k }, 400);
        } else {
          if (!light.capabilities.includes('color')) continue;
          // Remember the bar position, then return to the last wheel position
          // (fall back: chromaticity of the current color temperature).
          if (light.state.temperature !== undefined) state.lastKelvin[id] = light.state.temperature;
          let c = state.lastColor[id];
          if (!c) {
            if (light.state.temperature === undefined) continue;   // already in color mode, nothing remembered
            c = xyToHs(blackbodyXy(light.state.temperature));
          }
          await lightManager.setLightState(id, { color: c }, 400);
        }
        changed.push(id);
      } catch { /* one flaky light shouldn't block the mode switch */ }
    }

    state.mode = m;
    saveState(state);
    const curtains = await setCurtains(m, state.curtainsKelvin);
    res.json({ mode: state.mode, changed, curtains });
  });

  return router;
}
