import { Router } from 'express';
import type { LightManager } from '../lib/light-manager.js';
import type { PaletteAnimator } from '../lib/palette-animator.js';
import type { SetLightStateRequest } from '@lightbox/shared';

export function createLightsRouter(lightManager: LightManager, paletteAnimator?: PaletteAnimator): Router {
  const router = Router();

  // List all lights
  router.get('/', (req, res) => {
    res.json(lightManager.getAllLights());
  });

  // Get single light
  router.get('/:id', (req, res) => {
    const light = lightManager.getLight(req.params.id);
    if (!light) {
      res.status(404).json({ error: 'Light not found' });
      return;
    }
    res.json(light);
  });

  // Set light state
  router.put('/:id', async (req, res) => {
    try {
      const { on, brightness, color, temperature, transition } = req.body as SetLightStateRequest;

      // Only include defined values (don't overwrite with undefined)
      const state: Partial<SetLightStateRequest> = {};
      if (on !== undefined) state.on = on;
      if (brightness !== undefined) state.brightness = brightness;
      if (color !== undefined) state.color = color;
      if (temperature !== undefined) state.temperature = temperature;

      // Mark light as user-controlled to pause palette animation temporarily
      if (paletteAnimator) {
        paletteAnimator.markUserControlled(req.params.id);
      }

      await lightManager.setLightState(req.params.id, state, transition);
      const light = lightManager.getLight(req.params.id);
      res.json(light);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Set raw Tuya DPS values (for custom device controls)
  router.put('/:id/dps', async (req, res) => {
    try {
      const { dps } = req.body as { dps: Record<string, any> };
      if (!dps || typeof dps !== 'object') {
        res.status(400).json({ error: 'dps object required' });
        return;
      }

      await lightManager.setTuyaRawDps(req.params.id, dps);
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Get muted RGB channels for a Tuya device
  router.get('/:id/muted-channels', (req, res) => {
    try {
      const channels = lightManager.getTuyaMutedChannels(req.params.id);
      res.json(channels);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Set muted RGB channels for a Tuya device
  router.put('/:id/muted-channels', (req, res) => {
    try {
      const { r, g, b } = req.body as { r?: boolean; g?: boolean; b?: boolean };
      const current = lightManager.getTuyaMutedChannels(req.params.id);
      const channels = {
        r: r ?? current.r,
        g: g ?? current.g,
        b: b ?? current.b,
      };
      lightManager.setTuyaMutedChannels(req.params.id, channels);
      res.json(channels);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return router;
}
