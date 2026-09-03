// Ambience mode: one switch that moves the room between two looks.
//   'color'  — lights live on the HSV wheel; curtains run their native soap
//   'normal' — temperature-capable lights drop onto the blackbody locus (Hue
//              bulbs render this with their warm-white diodes via ct/mirek);
//              curtains run twinkle
// Toggled by the screenbox panel (POST with its room's light ids); the mode
// itself is just in-memory server state the panels can read back.
import { Router } from 'express';
import { lookup } from 'node:dns/promises';
import type { LightManager } from '../lib/light-manager.js';
import { hsToXy, xyToKelvin, kelvinToXy, xyToHs } from '@lightbox/shared';

type Mode = 'color' | 'normal';

const KELVIN_MIN = 2000;
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

async function setCurtains(mode: Mode): Promise<Record<string, boolean>> {
  // An active twinklybox stream would paint over the native routine.
  await fetch(`${TWINKLYBOX}/api/stream/stop`, {
    method: 'POST',
    signal: AbortSignal.timeout(2000),
  }).catch(() => {});

  const kind = mode === 'normal' ? 'twinkle' : 'soap';
  const results: Record<string, boolean> = {};
  await Promise.all(CURTAIN_HOSTS.map(async (host) => {
    try {
      const ip = await resolveIp(host);
      const r = await fetch(`http://${ip}/api/routine`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind }),
        signal: AbortSignal.timeout(3000),
      });
      results[host] = r.ok;
    } catch {
      results[host] = false;
    }
  }));
  return results;
}

let mode: Mode = 'color';

export function createAmbienceRouter(lightManager: LightManager): Router {
  const router = Router();

  router.get('/', (_req, res) => res.json({ mode }));

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
          // Land at the blackbody point nearest the light's current color.
          let k = light.state.temperature;
          if (k === undefined && light.state.color) {
            k = xyToKelvin(hsToXy(light.state.color.h, light.state.color.s));
          }
          k = Math.max(KELVIN_MIN, Math.min(KELVIN_MAX, Math.round(k ?? 2700)));
          await lightManager.setLightState(id, { temperature: k }, 400);
        } else {
          // Only lights currently in CT mode need converting back.
          if (light.state.temperature === undefined || !light.capabilities.includes('color')) continue;
          const { h, s } = xyToHs(kelvinToXy(light.state.temperature));
          await lightManager.setLightState(id, { color: { h: Math.round(h), s: Math.round(s) } }, 400);
        }
        changed.push(id);
      } catch { /* one flaky light shouldn't block the mode switch */ }
    }

    mode = m;
    const curtains = await setCurtains(m);
    res.json({ mode, changed, curtains });
  });

  return router;
}
