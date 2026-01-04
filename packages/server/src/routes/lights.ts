import { Router } from 'express';
import type { LightManager } from '../lib/light-manager.js';
import type { SetLightStateRequest } from '@lightbox/shared';

export function createLightsRouter(lightManager: LightManager): Router {
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

      await lightManager.setLightState(req.params.id, state, transition);
      const light = lightManager.getLight(req.params.id);
      res.json(light);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return router;
}
