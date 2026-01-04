import { useEffect, useRef } from 'react';
import { usePalettesStore } from '../stores/palettes';
import { useLightsStore } from '../stores/lights';
import type { Palette, PaletteNode } from '@lightbox/shared';

// Update interval - lights will smoothly transition between these updates
const UPDATE_INTERVAL_MS = 300;

// Catmull-Rom spline interpolation with tension
function catmullRom(
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

// Get point on track at position t (0-1)
function getPointOnPalette(palette: Palette, t: number): PaletteNode {
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

  return catmullRom(p0, p1, p2, p3, localT, palette.tension);
}

// Convert track position (0-1 normalized coords) to H/S color
function positionToColor(point: PaletteNode): { h: number; s: number } {
  // Convert from 0-1 centered coords to angle/distance
  const dx = point.x - 0.5;
  const dy = point.y - 0.5;
  const distance = Math.sqrt(dx * dx + dy * dy) * 2; // 0-1 range
  const angle = Math.atan2(dy, dx) * 180 / Math.PI + 90;

  return {
    h: ((angle % 360) + 360) % 360,
    s: Math.min(100, distance * 100),
  };
}

export function usePaletteAnimation() {
  // Refs to hold mutable state that doesn't trigger re-renders
  const positionsRef = useRef<Record<string, number>>({});
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Subscribe to store values
  const isAnimating = usePalettesStore((s) => s.isAnimating);
  const activePaletteId = usePalettesStore((s) => s.activePaletteId);
  const setLightState = useLightsStore((s) => s.setLightState);

  // Initialize positions from store when animation starts
  useEffect(() => {
    if (isAnimating && activePaletteId) {
      positionsRef.current = { ...usePalettesStore.getState().lightPositions };
    }
  }, [isAnimating, activePaletteId]);

  // Main animation loop - only depends on isAnimating and paletteId
  useEffect(() => {
    // Clear any existing interval
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    if (!isAnimating || !activePaletteId) {
      return;
    }

    // Animation tick function
    const tick = () => {
      // Get latest palette from store (not via dependency)
      const palette = usePalettesStore.getState().palettes.find(p => p.id === activePaletteId);
      if (!palette || palette.nodes.length < 2) return;

      // Check if still animating
      if (!usePalettesStore.getState().isAnimating) return;

      // Calculate position delta for this interval
      const totalTrackTime = palette.secondsPerNode * palette.nodes.length;
      const positionDelta = (UPDATE_INTERVAL_MS / 1000) / totalTrackTime;

      // Update each light
      for (const lightId of Object.keys(positionsRef.current)) {
        const currentPos = positionsRef.current[lightId] ?? 0;
        const newPos = (currentPos + positionDelta) % 1;
        positionsRef.current[lightId] = newPos;

        // Get color at new position and apply with transition
        const point = getPointOnPalette(palette, newPos);
        const { h, s } = positionToColor(point);
        setLightState(lightId, { color: { h: Math.round(h), s: Math.round(s) } }, UPDATE_INTERVAL_MS);
      }

      // Sync positions to store periodically for UI display
      usePalettesStore.getState().syncPositions(positionsRef.current);
    };

    // Run first tick immediately
    tick();

    // Then run on interval
    intervalRef.current = setInterval(tick, UPDATE_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isAnimating, activePaletteId, setLightState]);
}

// Export for use in PaletteTrack rendering
export { getPointOnPalette };
