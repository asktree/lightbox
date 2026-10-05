import { useEffect, useRef, useState } from 'react';
import type { PalettePositions } from '@lightbox/shared';

// The server ticks palette positions every 360ms. Pins that only move on
// each tick look jerky. This hook extrapolates each position between ticks
// at the known track speed, so the pins move at the display frame rate.
//
// Each server snapshot re-anchors the prediction. A small difference
// between the prediction and the snapshot (WS jitter, timer drift) becomes
// a residual that decays, so the pin does not jump. A large difference (a
// drag, a palette change, an override) snaps at once.

const RESIDUAL_TAU_MS = 200;
const SNAP_THRESHOLD = 0.05; // fraction of the full track

interface Anchor {
  pos: number;      // server position at `at`
  at: number;       // performance.now() when the snapshot arrived
  residual: number; // displayed − predicted, decays to 0
}

// Signed shortest distance a − b on a 0-1 loop, in [-0.5, 0.5).
function wrapDiff(a: number, b: number): number {
  return ((((a - b) % 1) + 1.5) % 1) - 0.5;
}

function wrap01(x: number): number {
  return ((x % 1) + 1) % 1;
}

function predict(a: Anchor, now: number, rate: number): number {
  const dt = now - a.at;
  const residual = a.residual * Math.exp(-dt / RESIDUAL_TAU_MS);
  return wrap01(a.pos + (dt / 1000) * rate + residual);
}

/**
 * @param positions server positions (0-1 per light)
 * @param rate      track fraction per second while playing (0 = paused)
 * @param holdId    a light to pass through unchanged (being dragged)
 */
export function useAnimatedPositions(
  positions: PalettePositions,
  rate: number,
  holdId?: string | null,
): PalettePositions {
  const anchors = useRef<Map<string, Anchor>>(new Map());
  const rateRef = useRef(rate);
  // null until the loop draws its first frame, so a resume never shows a
  // stale frame from the last play.
  const [frame, setFrame] = useState<PalettePositions | null>(null);

  // Re-anchor on each server snapshot.
  useEffect(() => {
    const now = performance.now();
    const prevRate = rateRef.current;
    const next = new Map<string, Anchor>();
    for (const [id, pos] of Object.entries(positions)) {
      const old = anchors.current.get(id);
      let residual = 0;
      if (old && rate > 0) {
        const shown = predict(old, now, prevRate);
        const d = wrapDiff(shown, pos);
        if (Math.abs(d) < SNAP_THRESHOLD) residual = d;
      }
      next.set(id, { pos, at: now, residual });
    }
    anchors.current = next;
    rateRef.current = rate;
  }, [positions, rate]);

  // Frame loop, only while playing.
  useEffect(() => {
    if (rate <= 0) return;
    let raf = 0;
    const step = () => {
      const now = performance.now();
      const out: PalettePositions = {};
      for (const [id, a] of anchors.current) {
        out[id] = predict(a, now, rateRef.current);
      }
      setFrame(out);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      setFrame(null);
    };
  }, [rate]);

  if (rate <= 0 || !frame) return positions;
  if (holdId && holdId in positions) {
    return { ...frame, [holdId]: positions[holdId] };
  }
  return frame;
}
