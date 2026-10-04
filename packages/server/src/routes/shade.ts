// Shade: the Yoolax blind, through the shadebox board (services/shade.ts).
//   GET  /api/shade                 live state from the board (cached on failure)
//   POST /api/shade/open|close|stop
//   POST /api/shade/go  {open: 0..100}
import { Router } from 'express';
import { fetchShadeState, sendShade, shadeStatus } from '../services/shade.js';

export function createShadeRouter(): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      await fetchShadeState();
      res.json({ online: true, ...shadeStatus() });
    } catch {
      res.json({ online: false, ...shadeStatus() });
    }
  });

  for (const kind of ['open', 'close', 'stop'] as const) {
    router.post(`/${kind}`, (_req, res) => {
      sendShade({ kind });
      res.json({ queued: kind });
    });
  }

  router.post('/go', (req, res) => {
    const open = Number(req.body?.open ?? req.query.open);
    if (!Number.isFinite(open) || open < 0 || open > 100) {
      res.status(400).json({ error: 'open must be 0..100' });
      return;
    }
    sendShade({ kind: 'go', open });
    res.json({ queued: `go ${Math.round(open)}` });
  });

  return router;
}
