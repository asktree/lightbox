import { Router } from 'express';
import type { LightManager } from '../lib/light-manager.js';
import type { CreateSceneRequest } from '@lightbox/shared';

export function createScenesRouter(lightManager: LightManager): Router {
  const router = Router();

  // List all scenes
  router.get('/', (req, res) => {
    res.json(lightManager.getScenes());
  });

  // Get single scene
  router.get('/:id', (req, res) => {
    const scene = lightManager.getScene(req.params.id);
    if (!scene) {
      res.status(404).json({ error: 'Scene not found' });
      return;
    }
    res.json(scene);
  });

  // Create scene
  router.post('/', (req, res) => {
    const { name, states } = req.body as CreateSceneRequest;
    const scene = lightManager.createScene(name, states);
    res.status(201).json(scene);
  });

  // Delete scene
  router.delete('/:id', (req, res) => {
    lightManager.deleteScene(req.params.id);
    res.status(204).send();
  });

  // Activate scene
  router.put('/:id/activate', async (req, res) => {
    try {
      const { transition } = req.body as { transition?: number };
      await lightManager.activateScene(req.params.id, transition);
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return router;
}
