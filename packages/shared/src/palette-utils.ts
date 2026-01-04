/**
 * Palette utility functions - shared between client and server
 */

import type { Palette, PaletteNode } from './index.js';

/**
 * Catmull-Rom spline interpolation with tension
 * tension: 0 = linear, 1 = full Catmull-Rom smoothness
 */
export function catmullRom(
  p0: PaletteNode,
  p1: PaletteNode,
  p2: PaletteNode,
  p3: PaletteNode,
  t: number,
  tension: number
): PaletteNode {
  const s = tension;

  // Linear interpolation
  const linearX = p1.x + t * (p2.x - p1.x);
  const linearY = p1.y + t * (p2.y - p1.y);

  // Catmull-Rom interpolation
  const t2 = t * t;
  const t3 = t2 * t;
  const crX =
    0.5 *
    ((2 * p1.x) +
      (-p0.x + p2.x) * t +
      (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
      (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
  const crY =
    0.5 *
    ((2 * p1.y) +
      (-p0.y + p2.y) * t +
      (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
      (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);

  return {
    x: linearX * (1 - s) + crX * s,
    y: linearY * (1 - s) + crY * s,
  };
}

/**
 * Get point on palette track at position t (0-1)
 * The track loops, so t wraps around
 */
export function getPointOnPalette(palette: Palette, t: number): PaletteNode {
  const nodes = palette.nodes;
  if (nodes.length === 0) return { x: 0.5, y: 0.5 };
  if (nodes.length === 1) return nodes[0];

  const n = nodes.length;
  const totalT = t * n;
  const segment = Math.floor(totalT) % n;
  const localT = totalT - Math.floor(totalT);

  const p0 = nodes[(segment - 1 + n) % n];
  const p1 = nodes[segment];
  const p2 = nodes[(segment + 1) % n];
  const p3 = nodes[(segment + 2) % n];

  // Always use full Catmull-Rom smoothness (tension=1)
  return catmullRom(p0, p1, p2, p3, localT, 1);
}

/**
 * Convert palette track position (0-1 normalized coords, center at 0.5)
 * to H/S color values
 */
export function positionToColor(point: PaletteNode): { h: number; s: number } {
  // Convert from 0-1 centered coords to angle/distance
  const dx = point.x - 0.5;
  const dy = point.y - 0.5;
  const distance = Math.sqrt(dx * dx + dy * dy) * 2; // 0-1 range
  const angle = Math.atan2(dy, dx) * 180 / Math.PI + 90;

  return {
    h: Math.round(((angle % 360) + 360) % 360),
    s: Math.round(Math.min(100, distance * 100)),
  };
}

/**
 * Find closest point on track to given x,y coordinates
 * Returns the t value (0-1) of the closest point
 */
export function findClosestPointOnTrack(
  palette: Palette,
  targetX: number,
  targetY: number,
  samples: number = 100
): number {
  let closestT = 0;
  let closestDist = Infinity;

  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const point = getPointOnPalette(palette, t);
    const dx = point.x - targetX;
    const dy = point.y - targetY;
    const dist = dx * dx + dy * dy;

    if (dist < closestDist) {
      closestDist = dist;
      closestT = t;
    }
  }

  return closestT;
}
