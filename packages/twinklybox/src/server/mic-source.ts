// Live mic source for the audio bus. The browser client captures the
// machine's microphone, does the FFT, folds it into 12 log-spaced bands,
// and POSTs raw band values here (see client/useMicSource.ts + the
// /api/source/mic/frame endpoint).
//
// Unlike the musicbox follower — which normalizes each value against a
// precomputed whole-track distribution — live mic has no track to compare
// against. So we keep a 30-second rolling window of recent raw band values
// and normalize against THAT: percentile = rank within the window,
// robust-minmax = (v − p2) / (p98 − p2) over the window. The window slides,
// so the show auto-adapts to the room's loudness over the last half-minute.
//
// Only the 12-band (eq12) path is populated; stems aren't recoverable from
// raw FFT live, so megadrome should run in eq12 band mode on mic input.

import { NUM_BANDS } from './audio-bus.js';

const WINDOW_MS = 30_000;   // rolling normalization window
const FRESH_MS = 1_000;     // mic considered "live" if a frame arrived this recently

let active = false;
let lastFrameAt = 0;

// Parallel arrays in arrival order: tsBuf[i] is frame i's timestamp,
// bandBuf[b][i] is band b's raw value for frame i. Pruned from the front
// once older than WINDOW_MS.
const tsBuf: number[] = [];
const bandBuf: number[][] = Array.from({ length: NUM_BANDS }, () => []);

// Cached normalization of the most recent frame against the current window.
// Recomputed on each push (data only changes when a frame arrives), so the
// per-render tick just reads these.
const normPct = new Array(NUM_BANDS).fill(0);
const normMinMax = new Array(NUM_BANDS).fill(0);

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

// Lower-bound binary search → rank of v among sorted values.
function lowerBound(sorted: ArrayLike<number>, v: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function isMicActive(): boolean { return active; }

export function micFresh(now = Date.now()): boolean {
  return active && now - lastFrameAt < FRESH_MS;
}

export function setMicActive(b: boolean): void {
  active = b;
  if (!b) {
    tsBuf.length = 0;
    for (const arr of bandBuf) arr.length = 0;
    normPct.fill(0);
    normMinMax.fill(0);
    lastFrameAt = 0;
  }
}

// Append one frame of raw band values (each ~0..1), prune the window, and
// recompute the cached normalization for this latest frame.
export function pushMicFrame(bands: number[], now = Date.now()): void {
  if (!active) return;
  if (!Array.isArray(bands) || bands.length < NUM_BANDS) return;

  tsBuf.push(now);
  for (let b = 0; b < NUM_BANDS; b++) bandBuf[b].push(clamp01(bands[b]));
  lastFrameAt = now;

  // Drop frames older than the window (arrival order → prune from front).
  const cutoff = now - WINDOW_MS;
  let drop = 0;
  while (drop < tsBuf.length && tsBuf[drop] < cutoff) drop++;
  if (drop > 0) {
    tsBuf.splice(0, drop);
    for (let b = 0; b < NUM_BANDS; b++) bandBuf[b].splice(0, drop);
  }

  // Normalize the just-pushed value of each band against its window.
  for (let b = 0; b < NUM_BANDS; b++) {
    const arr = bandBuf[b];
    const cur = arr[arr.length - 1];
    const sorted = Float64Array.from(arr).sort();
    const n = sorted.length;
    normPct[b] = n > 0 ? lowerBound(sorted, cur) / n : 0;
    // Robust min-max bounded by p2..p98 so a single spike doesn't blow the
    // range and quiet stretches actually read as quiet.
    const lo = sorted[Math.floor(0.02 * n)];
    const hi = sorted[Math.min(n - 1, Math.floor(0.98 * n))];
    const span = hi - lo;
    normMinMax[b] = span > 1e-9 ? clamp01((cur - lo) / span) : 0;
  }
}

// Latest normalized bands for the audio bus. Returns copies so callers
// can't mutate the cache.
export function getMicBands(): { bands: number[]; bandsMinMax: number[] } {
  return { bands: normPct.slice(), bandsMinMax: normMinMax.slice() };
}

export function getMicStatus() {
  const span = tsBuf.length ? (tsBuf[tsBuf.length - 1] - tsBuf[0]) / 1000 : 0;
  return { active, fresh: micFresh(), windowSamples: tsBuf.length, windowSec: span };
}
