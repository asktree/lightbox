import { Router } from 'express';
import type { LightManager } from '../lib/light-manager.js';
import type { CreateGroupRequest, SetLightStateRequest } from '@lightbox/shared';

export function createGroupsRouter(lightManager: LightManager): Router {
  const router = Router();

  // List all groups
  router.get('/', (req, res) => {
    res.json(lightManager.getGroups());
  });

  // Get single group
  router.get('/:id', (req, res) => {
    const group = lightManager.getGroup(req.params.id);
    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    res.json(group);
  });

  // Create group
  router.post('/', (req, res) => {
    const { name, lightIds } = req.body as CreateGroupRequest;
    const group = lightManager.createGroup(name, lightIds);
    res.status(201).json(group);
  });

  // Update group
  router.put('/:id', (req, res) => {
    const { name, lightIds } = req.body as CreateGroupRequest;
    try {
      lightManager.updateGroup(req.params.id, name, lightIds);
      res.json(lightManager.getGroup(req.params.id));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Delete group
  router.delete('/:id', (req, res) => {
    lightManager.deleteGroup(req.params.id);
    res.status(204).send();
  });

  // Control group
  router.put('/:id/state', async (req, res) => {
    try {
      const { on, brightness, color, temperature, transition } = req.body as SetLightStateRequest;

      // Only include defined values
      const state: Partial<SetLightStateRequest> = {};
      if (on !== undefined) state.on = on;
      if (brightness !== undefined) state.brightness = brightness;
      if (color !== undefined) state.color = color;
      if (temperature !== undefined) state.temperature = temperature;

      await lightManager.setGroupState(req.params.id, state, transition);
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return router;
}
