import { Router } from 'express';
import {
  calibrateAudio,
  calibrateLight,
  getCalibrationStatus,
  getLatencyRegistry,
  setLatencyCalPaletteAnimator,
  setManualLightLatency,
} from '../services/latency-calibration.js';
import type { PaletteAnimator } from '../lib/palette-animator.js';

// Latency calibration + registry API.
//   GET  /api/latency-cal            → registry + running state
//   POST /api/latency-cal/audio      → mic ground-truth audio latency (~8s)
//   POST /api/latency-cal/light      → {rid} webcam light latency (~18s;
//                                      light must be visible to the webcam)
//   PUT  /api/latency-cal/light/:rid → {latencyMs, name?} manual override

export function createLatencyCalRouter(paletteAnimator?: PaletteAnimator): Router {
  if (paletteAnimator) setLatencyCalPaletteAnimator(paletteAnimator);
  const r = Router();

  r.get('/', (_req, res) => {
    res.json(getCalibrationStatus());
  });

  r.post('/audio', async (_req, res) => {
    const result = await calibrateAudio();
    res.status(result.ok ? 200 : 500).json(result);
  });

  r.post('/light', async (req, res) => {
    const rid = req.body?.rid;
    if (typeof rid !== 'string' || !rid) {
      return res.status(400).json({ ok: false, error: 'body must include rid (CLIP v2 light UUID)' });
    }
    const result = await calibrateLight(rid);
    res.status(result.ok ? 200 : 500).json(result);
  });

  r.put('/light/:rid', (req, res) => {
    const { latencyMs, name } = req.body ?? {};
    if (typeof latencyMs !== 'number') {
      return res.status(400).json({ ok: false, error: 'body must include latencyMs (number)' });
    }
    const existing = getLatencyRegistry().lights[req.params.rid];
    setManualLightLatency(req.params.rid, name ?? existing?.name ?? req.params.rid, latencyMs);
    res.json({ ok: true, registry: getLatencyRegistry() });
  });

  return r;
}
