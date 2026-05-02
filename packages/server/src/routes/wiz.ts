import { Router } from 'express';
import type { WizDriver } from '../drivers/wiz.js';

// Test-harness routes for the WiZ UDP driver. Mirrors hue-stream.ts in spirit
// but for WiZ: low-rate JSON-over-UDP rather than DTLS streaming. Used by the
// WiZTest page to feel out pulse latency, strobe rate, and floor/peak.

// Driver is resolved lazily because routes are mounted before
// LightManager finishes async discovery — at module load the driver
// list is empty.
export function createWizRouter(getDriver: () => WizDriver | undefined): Router {
  const r = Router();

  const requireDriver = (res: any): WizDriver | null => {
    const d = getDriver();
    if (!d) { res.status(503).json({ error: 'wiz driver not initialized' }); return null; }
    return d;
  };

  r.get('/lights', (_req, res) => {
    const d = requireDriver(res); if (!d) return;
    res.json({ lights: d.listDevices() });
  });

  // Server-side pulse: snap to peak, ramp dimming → floor over decayMs.
  // Body: { deviceId, r, g, b, peakDim, floorDim, decayMs, fps? }
  r.post('/pulse', (req, res) => {
    const d = requireDriver(res); if (!d) return;
    const { deviceId, r: R, g: G, b: B, peakDim, floorDim, decayMs, fps } = req.body ?? {};
    if (typeof deviceId !== 'string') return res.status(400).json({ error: 'deviceId required' });
    if (typeof R !== 'number' || typeof G !== 'number' || typeof B !== 'number') {
      return res.status(400).json({ error: 'r,g,b required' });
    }
    d.pulse(deviceId, {
      r: R, g: G, b: B,
      peakDim: typeof peakDim === 'number' ? peakDim : 100,
      floorDim: typeof floorDim === 'number' ? floorDim : 10,
      decayMs: typeof decayMs === 'number' ? decayMs : 400,
      fps: typeof fps === 'number' ? fps : undefined,
    }).catch((err) => console.error('[wiz] pulse failed:', err));
    res.json({ ok: true });
  });

  // Fire-and-forget setPilot. Use for high-rate client-driven streaming
  // (strobe, level tracking). Body: { deviceId, ...wizParams }
  r.post('/set', (req, res) => {
    const d = requireDriver(res); if (!d) return;
    const { deviceId, ...params } = req.body ?? {};
    if (typeof deviceId !== 'string') return res.status(400).json({ error: 'deviceId required' });
    d.fastSet(deviceId, params);
    res.json({ ok: true });
  });

  return r;
}
