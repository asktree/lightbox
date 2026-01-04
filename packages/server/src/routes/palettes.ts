import { Router } from 'express';
import type { LightManager } from '../lib/light-manager.js';
import type { CreatePaletteRequest, UpdatePaletteRequest, PaletteNode, PaletteNodeInput } from '@lightbox/shared';

// Convert hex color to HSV
function hexToHsv(hex: string): { h: number; s: number; v: number } {
  hex = hex.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }

  return {
    h: h * 360,
    s: max === 0 ? 0 : (d / max) * 100,
    v: max * 100,
  };
}

// Convert HSV to x/y on the color wheel (normalized 0-1)
function hsvToXY(h: number, s: number): { x: number; y: number } {
  const angle = (h - 90) * Math.PI / 180;
  const distance = (s / 100) * 0.45; // 0.45 to stay within wheel
  return {
    x: 0.5 + distance * Math.cos(angle),
    y: 0.5 + distance * Math.sin(angle),
  };
}

// Convert any node input format to x/y
function normalizeNode(node: PaletteNodeInput): PaletteNode {
  if ('x' in node && 'y' in node) {
    return { x: node.x, y: node.y };
  }
  if ('hex' in node) {
    const hsv = hexToHsv(node.hex);
    return hsvToXY(hsv.h, hsv.s);
  }
  if ('h' in node && 's' in node) {
    return hsvToXY(node.h, node.s);
  }
  throw new Error('Invalid node format');
}

export function createPalettesRouter(lightManager: LightManager): Router {
  const router = Router();

  // List all palettes
  router.get('/', (req, res) => {
    res.json(lightManager.getPalettes());
  });

  // Get single palette
  router.get('/:id', (req, res) => {
    const palette = lightManager.getPalette(req.params.id);
    if (!palette) {
      res.status(404).json({ error: 'Palette not found' });
      return;
    }
    res.json(palette);
  });

  // Create palette
  router.post('/', (req, res) => {
    const { name, nodes, tension, secondsPerNode } = req.body as CreatePaletteRequest;
    const normalizedNodes = nodes.map(normalizeNode);
    const palette = lightManager.createPalette(name, normalizedNodes, tension, secondsPerNode);
    res.status(201).json(palette);
  });

  // Update palette
  router.put('/:id', (req, res) => {
    const palette = lightManager.getPalette(req.params.id);
    if (!palette) {
      res.status(404).json({ error: 'Palette not found' });
      return;
    }
    const updates = req.body as UpdatePaletteRequest;
    if (updates.nodes) {
      updates.nodes = updates.nodes.map(normalizeNode);
    }
    lightManager.updatePalette(req.params.id, updates as any);
    res.json(lightManager.getPalette(req.params.id));
  });

  // Delete palette
  router.delete('/:id', (req, res) => {
    lightManager.deletePalette(req.params.id);
    res.status(204).send();
  });

  return router;
}
