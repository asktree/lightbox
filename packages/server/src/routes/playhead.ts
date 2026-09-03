// The playhead server: one ear-corrected playhead for every light consumer.
// See readEarPlayhead in services/stem-sync.ts for the contract.
import { Router } from 'express';
import { readEarPlayhead } from '../services/stem-sync.js';

export function createPlayheadRouter(): Router {
  const r = Router();
  r.get('/', (_req, res) => res.json(readEarPlayhead()));
  return r;
}
