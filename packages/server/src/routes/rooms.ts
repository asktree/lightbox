/**
 * Room API routes - control palette animation per room
 */

import { Router } from 'express';
import type { PaletteAnimator } from '../lib/palette-animator.js';

export function createRoomsRouter(animator: PaletteAnimator): Router {
  const router = Router();

  // Get all room states
  router.get('/', (_req, res) => {
    const states = animator.getAllRoomStates();
    res.json(states);
  });

  // Get state for a specific room
  router.get('/:roomId', (req, res) => {
    const state = animator.getRoomState(req.params.roomId);
    const positions = animator.getPositions(req.params.roomId);
    res.json({ ...state, positions });
  });

  // Select a palette for a room
  router.post('/:roomId/palette/:paletteId', async (req, res) => {
    try {
      await animator.selectPalette(req.params.roomId, req.params.paletteId);
      const state = animator.getRoomState(req.params.roomId);
      const positions = animator.getPositions(req.params.roomId);
      res.json({ ...state, positions });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: message });
    }
  });

  // Clear palette selection for a room
  router.delete('/:roomId/palette', async (req, res) => {
    try {
      await animator.selectPalette(req.params.roomId, null);
      const state = animator.getRoomState(req.params.roomId);
      res.json(state);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: message });
    }
  });

  // Play animation
  router.post('/:roomId/play', async (req, res) => {
    try {
      await animator.play(req.params.roomId);
      const state = animator.getRoomState(req.params.roomId);
      res.json(state);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: message });
    }
  });

  // Pause animation
  router.post('/:roomId/pause', async (req, res) => {
    try {
      await animator.pause(req.params.roomId);
      const state = animator.getRoomState(req.params.roomId);
      res.json(state);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: message });
    }
  });

  // Set animation speed
  router.put('/:roomId/speed', async (req, res) => {
    try {
      const { secondsPerNode } = req.body as { secondsPerNode: number };
      if (typeof secondsPerNode !== 'number' || secondsPerNode < 0.1 || secondsPerNode > 60) {
        return res.status(400).json({ error: 'Speed must be between 0.1 and 60 seconds per node' });
      }

      await animator.setSpeed(req.params.roomId, secondsPerNode);
      const state = animator.getRoomState(req.params.roomId);
      res.json(state);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: message });
    }
  });

  // Set light position on track
  router.put('/:roomId/lights/:lightId/position', async (req, res) => {
    try {
      const { position } = req.body as { position: number };
      if (typeof position !== 'number' || position < 0 || position > 1) {
        return res.status(400).json({ error: 'Position must be a number between 0 and 1' });
      }

      await animator.setLightPosition(req.params.roomId, req.params.lightId, position);
      res.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: message });
    }
  });

  return router;
}
