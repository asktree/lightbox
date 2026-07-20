import { Router } from 'express';
import {
  startStemSync,
  stopStemSync,
  getStemSyncStatus,
  updateStemSyncConfig,
  setStemSyncPaletteAnimator,
} from '../services/stem-sync.js';
import type { PaletteAnimator } from '../lib/palette-animator.js';

// Spotify playhead → stem energy envelopes → Hue entertainment levels.
//   POST /api/stem-sync/start
//   POST /api/stem-sync/stop
//   GET  /api/stem-sync/status
//   PUT  /api/stem-sync/config  { offsetMs?, gamma?, attack?, decay?, tickMs?,
//                                 bindings?: [{ rid, stems: ['drums',...], minLevel?, maxLevel? }] }
//        Binding changes apply live when the light set is unchanged;
//        otherwise the service is bounced (stop+start) transparently.
export function createStemSyncRouter(paletteAnimator?: PaletteAnimator): Router {
  const r = Router();
  if (paletteAnimator) setStemSyncPaletteAnimator(paletteAnimator);

  r.post('/start', async (_req, res) => {
    const result = await startStemSync();
    if (!result.ok) return res.status(500).json(result);
    res.json(getStemSyncStatus());
  });

  r.post('/stop', async (_req, res) => {
    await stopStemSync();
    res.json(getStemSyncStatus());
  });

  r.get('/status', (_req, res) => res.json(getStemSyncStatus()));

  r.put('/config', async (req, res) => {
    const { needsRestart } = updateStemSyncConfig(req.body ?? {});
    if (needsRestart) {
      await stopStemSync({ persistOff: false });
      const result = await startStemSync();
      if (!result.ok) return res.status(500).json({ ...result, restarted: true });
    }
    res.json(getStemSyncStatus());
  });

  return r;
}
