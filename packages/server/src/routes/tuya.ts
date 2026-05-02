import { Router } from 'express';
import type { TuyaDriver } from '../drivers/tuya.js';

// Test-harness routes for fast brightness modulation against Tuya bulbs.
// Tuya's persistent-connection driver already coalesces (1 in-flight +
// 1 pending per device), so calling setState at any rate auto-throttles
// to the device's RTT. The route here is fire-and-forget so the rAF caller
// never blocks. The bulb firmware adds an unavoidable ~800ms internal fade
// (see CLAUDE.md), so brightness modulation will look smoothed even with
// no client-side smoothing applied.

export function createTuyaRouter(getDriver: () => TuyaDriver | undefined): Router {
  const r = Router();
  const requireDriver = (res: any): TuyaDriver | null => {
    const d = getDriver();
    if (!d) { res.status(503).json({ error: 'tuya driver not initialized' }); return null; }
    return d;
  };

  r.get('/lights', (_req, res) => {
    const d = requireDriver(res); if (!d) return;
    res.json({ lights: d.listDevices() });
  });

  // Fire-and-forget partial setState. Body: { deviceId, brightness?, on?, color?, temperature? }
  r.post('/set', (req, res) => {
    const d = requireDriver(res); if (!d) return;
    const { deviceId, ...state } = req.body ?? {};
    if (typeof deviceId !== 'string') return res.status(400).json({ error: 'deviceId required' });
    d.setState(deviceId, state).catch((err) => console.error('[tuya] /set failed:', err));
    res.json({ ok: true });
  });

  return r;
}
