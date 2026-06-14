// System-audio source for the audio bus — the "live sync" mode.
//
// Spawns the native ScreenCaptureKit helper (native/syscap/syscap), which taps
// the Mac's audio OUTPUT mix and streams 12-band FFT frames as JSON lines. We
// hold each frame in a delay queue and only release it after `delayMs`, so the
// lights lag the captured audio by the playback latency — when you're AirPlaying
// (~2s glass-to-ear), the lights line up with what you actually HEAR instead of
// running ahead. Released frames are normalized against a 30s rolling window
// (same approach as the mic source) and written to the bus by the follower tick.
//
// Total light latency = delayMs (here) + the box's 500ms timecode buffer. So set
// delayMs ≈ audioLatency − 500ms. Default 1500ms targets ~2s AirPlay latency.
// Only the 12-band (eq12) path is populated; run megadrome in eq12 mode.

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NUM_BANDS } from './audio-bus.js';

const BIN = fileURLToPath(new URL('../../native/syscap/syscap', import.meta.url));
const WINDOW_MS = 30_000;   // rolling normalization window
const FRESH_MS = 1_000;     // "live" if a (released) frame arrived this recently
const MAX_QUEUE = 600;      // ~20s of 30Hz frames — safety cap

let proc: ChildProcess | null = null;
let active = false;
let delayMs = 1500;
let lastReleaseAt = 0;
let lastError: string | null = null;

// Delay queue of RAW frames awaiting release (arrival order by capture ts).
const queue: { t: number; bands: number[] }[] = [];

// --- rolling-window normalizer (mirrors mic-source.ts) ---
const tsBuf: number[] = [];
const bandBuf: number[][] = Array.from({ length: NUM_BANDS }, () => []);
const normPct = new Array(NUM_BANDS).fill(0);
const normMinMax = new Array(NUM_BANDS).fill(0);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

function lowerBound(sorted: ArrayLike<number>, v: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
  return lo;
}

// Feed one released frame into the rolling window and recompute the cached
// normalization for it.
function ingest(bands: number[], now: number): void {
  tsBuf.push(now);
  for (let b = 0; b < NUM_BANDS; b++) bandBuf[b].push(clamp01(bands[b] ?? 0));
  const cutoff = now - WINDOW_MS;
  let drop = 0;
  while (drop < tsBuf.length && tsBuf[drop] < cutoff) drop++;
  if (drop > 0) { tsBuf.splice(0, drop); for (let b = 0; b < NUM_BANDS; b++) bandBuf[b].splice(0, drop); }
  for (let b = 0; b < NUM_BANDS; b++) {
    const arr = bandBuf[b];
    const cur = arr[arr.length - 1];
    const sorted = Float64Array.from(arr).sort();
    const n = sorted.length;
    normPct[b] = n > 0 ? lowerBound(sorted, cur) / n : 0;
    const lo = sorted[Math.floor(0.02 * n)];
    const hi = sorted[Math.min(n - 1, Math.floor(0.98 * n))];
    const span = hi - lo;
    normMinMax[b] = span > 1e-9 ? clamp01((cur - lo) / span) : 0;
  }
}

function reset(): void {
  queue.length = 0; tsBuf.length = 0;
  for (const a of bandBuf) a.length = 0;
  normPct.fill(0); normMinMax.fill(0);
  lastReleaseAt = 0;
}

export function isSyscapActive(): boolean { return active; }
export function syscapFresh(now = Date.now()): boolean { return active && now - lastReleaseAt < FRESH_MS; }
export function setSyscapDelay(ms: number): void { delayMs = Math.max(0, Math.min(8000, ms)); }
export function getSyscapDelay(): number { return delayMs; }

export function startSyscap(): { ok: boolean; error?: string } {
  if (proc) return { ok: true };
  reset();
  lastError = null;
  try {
    proc = spawn(BIN, [], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    lastError = String(e);
    return { ok: false, error: lastError };
  }
  active = true;
  let buf = '';
  proc.stdout!.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const f = JSON.parse(line) as { t: number; bands: number[] };
        if (Array.isArray(f.bands) && f.bands.length >= NUM_BANDS) {
          queue.push({ t: typeof f.t === 'number' ? f.t : Date.now(), bands: f.bands });
          if (queue.length > MAX_QUEUE) queue.shift();
        }
      } catch { /* partial/garbage line — skip */ }
    }
  });
  proc.stderr!.on('data', (c: Buffer) => {
    const s = c.toString('utf8').trim();
    if (!s) return;
    console.log('[syscap]', s);
    // The helper logs status (e.g. "capturing system audio") to stderr too;
    // only surface genuine failures as the error field.
    if (/fail|error|denied|stopped|no display/i.test(s)) lastError = s;
  });
  proc.on('exit', (code) => {
    console.log(`[syscap] helper exited (${code})`);
    if (active && code !== 0) lastError = `helper exited ${code}`;
    proc = null; active = false;
  });
  return { ok: true };
}

export function stopSyscap(): void {
  active = false;
  if (proc) { try { proc.kill('SIGTERM'); } catch { /* ignore */ } proc = null; }
  reset();
}

// Release every frame whose playout time (capture ts + delay) has arrived,
// folding each into the rolling window, then return the latest normalization.
// Called from the follower tick while syscap is the active source.
export function getSyscapBands(now = Date.now()): { bands: number[]; bandsMinMax: number[] } {
  const releaseBefore = now - delayMs;
  while (queue.length && queue[0].t <= releaseBefore) {
    const f = queue.shift()!;
    ingest(f.bands, now);
    lastReleaseAt = now;
  }
  return { bands: normPct.slice(), bandsMinMax: normMinMax.slice() };
}

export function getSyscapStatus() {
  return {
    active,
    fresh: syscapFresh(),
    delayMs,
    queued: queue.length,
    windowSamples: tsBuf.length,
    error: lastError,
  };
}
