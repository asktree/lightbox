// Audio-sync service — live system-audio → Hue Entertainment stream levels.
//
// Spawns the same native ScreenCaptureKit helper twinklybox uses
// (packages/twinklybox/native/syscap/syscap), which taps the Mac's audio
// OUTPUT mix and streams 12-band FFT frames (40 Hz..16 kHz, log-spaced) as
// JSON lines. Each band is normalized against its OWN 30s rolling window
// (percentile rank + robust p2..p98 min-max — the exact scheme from
// twinklybox's syscap-source), then the halves are averaged:
//
//   low  = mean of normalized bands 0..5  (~40 Hz .. ~800 Hz)  → "spaceship floor"
//   high = mean of normalized bands 6..11 (~800 Hz .. 16 kHz)  → "cockpit"
//
// Per-band-then-average matters: raw dB bands differ wildly in absolute
// level, so averaging first lets the loudest band drown the rest and the
// aggregate barely moves. Normalizing each band first gives hats the same
// vote as the kick.
//
// Transport is the Hue Entertainment stream (DTLS/UDP, 50Hz) — the same
// path musicbox's energy bindings use. We call driver.setLevel(channel,
// level) in-process each tick; the frame pump multiplies it against the
// channel's baseline color, which the hue-stream router keeps synced to the
// palette. No REST writes in the hot path.

import { spawn, type ChildProcess } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  getRestLights,
  getLightSnapshot,
  restoreLightSnapshot,
  type LightSnapshot,
} from '../drivers/hue-rest-pulse.js';
import { getSharedEntertainmentDriver, type HueEntertainmentDriver } from '../drivers/hue-entertainment.js';
import { getPlayheadOffsetMs } from './latency-calibration.js';
import type { PaletteAnimator } from '../lib/palette-animator.js';

// Optional palette-animator hookup: while sync is active we exclude the
// target lights from palette writes (per-room, not via the pulse-claim set,
// so we don't clobber musicbox's claims). The bridge would ignore palette
// REST writes to streamed lights anyway — this just stops the wasted
// bridge traffic. The palette still advances their positions, and the
// hue-stream baseline loop copies the intended color into our channels.
let paletteAnimator: PaletteAnimator | null = null;
export function setAudioSyncPaletteAnimator(pa: PaletteAnimator): void {
  paletteAnimator = pa;
}
function setPaletteExcluded(lmId: string, excluded: boolean): void {
  if (!paletteAnimator) return;
  for (const rs of paletteAnimator.getAllRoomStates()) {
    paletteAnimator.setLightExcluded(rs.roomId, lmId, excluded);
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/services (or dist/services) → ../../../ lands on packages/.
const SYSCAP_BIN = join(__dirname, '../../../twinklybox/native/syscap/syscap');

const NUM_BANDS = 12;
const WINDOW_MS = 30_000; // rolling normalization window
const FRESH_MS = 1_000;   // "live" if a released frame arrived this recently
const MAX_QUEUE = 600;    // ~20s of 30Hz frames — safety cap

export type ChannelName = 'low' | 'high';
const CHANNELS: ChannelName[] = ['low', 'high'];
const BAND_RANGE: Record<ChannelName, [number, number]> = {
  low: [0, 6],   // bands 0..5
  high: [6, 12], // bands 6..11
};

export interface ChannelConfig {
  lightName: string; // matched against Hue device names, trim+lowercase
  minLevel: number;  // baseline multiplier at value 0 (0-1)
  maxLevel: number;  // baseline multiplier at value 1 (0-1)
}

export interface AudioSyncConfig {
  delayMs: number;   // playout delay compensating speaker latency (AirPlay ≈ 1500-2000, BT ≈ 0-150)
  tickMs: number;    // setLevel update interval (syscap frames arrive at ~30Hz)
  // pct    — empirical-CDF percentile rank against the rolling window
  // minmax — robust p2..p98 min-max against the rolling window (adaptive)
  // frozen — robust min-max against FIXED per-band bounds captured by
  //          freezeAudioSyncNorm(). Stops the window from re-normalizing
  //          quiet sections up to full scale.
  normMode: 'pct' | 'minmax' | 'frozen';
  attack: number;    // per-tick smoothing α when value rises (0 = instant)
  decay: number;     // per-tick smoothing α when value falls (0.85 = long tail)
  gamma: number;     // level = value^gamma; >1 tames the top end / darkens mids
}

const config: AudioSyncConfig & { channels: Record<ChannelName, ChannelConfig> } = {
  delayMs: 0,
  tickMs: 33,
  normMode: 'minmax',
  attack: 0,
  decay: 0.85,
  gamma: 1,
  channels: {
    low: { lightName: 'spaceship floor', minLevel: 0.02, maxLevel: 1 },
    high: { lightName: 'cockpit', minLevel: 0.02, maxLevel: 1 },
  },
};

interface ChannelRuntime {
  lmId: string | null;
  rid: string | null;
  resolvedName: string | null;
  streamChannelId: number | null;
  snapshot: LightSnapshot | null;
  value: number;  // smoothed normalized value 0..1
  level: number;  // last level written to the stream
  lastError: string | null;
}

function freshRuntime(): ChannelRuntime {
  return {
    lmId: null, rid: null, resolvedName: null, streamChannelId: null,
    snapshot: null, value: 0, level: 0, lastError: null,
  };
}

let proc: ChildProcess | null = null;
let tickTimer: NodeJS.Timeout | null = null;
let active = false;
let startedStream = false; // whether WE started the entertainment stream (vs joined an active one)
let lastReleaseAt = 0;
let lastError: string | null = null;
const runtime: Record<ChannelName, ChannelRuntime> = { low: freshRuntime(), high: freshRuntime() };

// History of already-normalized frames. Each light samples this at its own
// playout delay (now − perLightDelay), so lights with different measured
// latencies each line up with the ear independently. Normalization happens
// at arrival — the rolling window describes the signal, not the playout.
interface NormFrame { t: number; pct: number[]; minmax: number[]; frozen: number[] }
const history: NormFrame[] = [];

// --- per-band rolling-window normalizer (mirrors twinklybox syscap-source.ts) ---
const tsBuf: number[] = [];
const bandBuf: number[][] = Array.from({ length: NUM_BANDS }, () => []);
const normPct = new Array(NUM_BANDS).fill(0);
const normMinMax = new Array(NUM_BANDS).fill(0);
const normFrozen = new Array(NUM_BANDS).fill(0);
// Fixed per-band lo/hi bounds for 'frozen' mode. Captured from the live
// window via freezeAudioSyncNorm(); survives stop/start but not restarts.
let frozenBounds: { lo: number[]; hi: number[] } | null = null;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

function lowerBound(sorted: ArrayLike<number>, v: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
  return lo;
}

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
    if (frozenBounds) {
      const fspan = frozenBounds.hi[b] - frozenBounds.lo[b];
      normFrozen[b] = fspan > 1e-9 ? clamp01((cur - frozenBounds.lo[b]) / fspan) : 0;
    }
  }
}

// Capture the rolling window's current p2/p98 per band as fixed bounds and
// switch to 'frozen' mode. Call while representative music is playing.
export function freezeAudioSyncNorm(): { ok: boolean; error?: string; bounds?: { lo: number[]; hi: number[] } } {
  const n = tsBuf.length;
  if (n < 100) return { ok: false, error: `window too small to freeze (${n} samples; play music for a few seconds first)` };
  const lo: number[] = [], hi: number[] = [];
  for (let b = 0; b < NUM_BANDS; b++) {
    const sorted = Float64Array.from(bandBuf[b]).sort();
    lo.push(sorted[Math.floor(0.02 * n)]);
    hi.push(sorted[Math.min(n - 1, Math.floor(0.98 * n))]);
  }
  frozenBounds = { lo, hi };
  config.normMode = 'frozen';
  console.log('[audio-sync] normalization frozen:', lo.map((v, i) => `${v.toFixed(2)}..${hi[i].toFixed(2)}`).join(' '));
  return { ok: true, bounds: frozenBounds };
}

function reset(): void {
  history.length = 0;
  tsBuf.length = 0;
  for (const a of bandBuf) a.length = 0;
  normPct.fill(0);
  normMinMax.fill(0);
  normFrozen.fill(0); // frozenBounds intentionally survives stop/start
  lastReleaseAt = 0;
  runtime.low = freshRuntime();
  runtime.high = freshRuntime();
}

// Newest frame at or before the target playout time (linear scan from the
// tail — the target is always near the end at ~30Hz).
function frameAt(playoutT: number): NormFrame | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].t <= playoutT) return history[i];
  }
  return null;
}

// A light's playout delay: measured audio-out latency minus its measured
// command→photon latency (live capture can only delay, never anticipate, so
// negative corrections clamp to 0). Falls back to the manual config.delayMs
// for unmeasured lights.
function perLightDelayMs(rt: ChannelRuntime): number {
  const measured = rt.rid ? getPlayheadOffsetMs(rt.rid) : null;
  return Math.max(0, measured ?? config.delayMs);
}

function tick(): void {
  const driver = getSharedEntertainmentDriver();
  if (!driver.active) return;
  const now = Date.now();
  for (const c of CHANNELS) {
    const rt = runtime[c];
    if (rt.streamChannelId === null) continue;
    const playoutT = now - perLightDelayMs(rt);
    const frame = frameAt(playoutT);
    // Average the normalized bands for this half. If audio goes silent or
    // stale, ease down to the floor rather than freeze.
    let target = 0;
    if (frame && playoutT - frame.t < FRESH_MS) {
      const norm = config.normMode === 'minmax' ? frame.minmax
        : config.normMode === 'frozen' ? frame.frozen
        : frame.pct;
      const [b0, b1] = BAND_RANGE[c];
      for (let b = b0; b < b1; b++) target += norm[b];
      target /= b1 - b0;
    }
    const a = target > rt.value ? config.attack : config.decay;
    rt.value = a > 0 ? rt.value * a + target * (1 - a) : target;
    const cc = config.channels[c];
    const shaped = Math.pow(clamp01(rt.value), config.gamma);
    rt.level = cc.minLevel + (cc.maxLevel - cc.minLevel) * shaped;
    driver.setLevel(rt.streamChannelId, rt.level);
  }
}

async function resolveLights(): Promise<void> {
  const lights = await getRestLights();
  for (const c of CHANNELS) {
    const wanted = config.channels[c].lightName.trim().toLowerCase();
    const match = lights.find((l) => l.name.trim().toLowerCase() === wanted);
    const rt = runtime[c];
    if (!match) {
      rt.lastError = `no Hue light named "${config.channels[c].lightName}"`;
      continue;
    }
    rt.rid = match.rid;
    rt.lmId = match.lmId;
    rt.resolvedName = match.name;
    rt.snapshot = await getLightSnapshot(match.rid);
    setPaletteExcluded(match.lmId, true);
  }
}

// Match our lights to the stream's channels by (trimmed, lowercased) name.
function mapStreamChannels(driver: HueEntertainmentDriver): void {
  const byName = new Map(driver.getChannels().map((ch) => [ch.lightName.trim().toLowerCase(), ch.id]));
  for (const c of CHANNELS) {
    const rt = runtime[c];
    if (!rt.resolvedName) continue;
    const id = byName.get(rt.resolvedName.trim().toLowerCase());
    if (id === undefined) {
      rt.lastError = `light "${rt.resolvedName}" has no channel in the active entertainment stream`;
    } else {
      rt.streamChannelId = id;
    }
  }
}

export async function startAudioSync(): Promise<{ ok: boolean; error?: string }> {
  if (active) return { ok: true };
  reset();
  lastError = null;
  await resolveLights();
  const names = CHANNELS.map((c) => runtime[c].resolvedName).filter((n): n is string => !!n);
  if (names.length === 0) {
    return { ok: false, error: `no target lights found (${runtime.low.lastError}; ${runtime.high.lastError})` };
  }

  // Start (or join) the entertainment stream. If a stream is already up —
  // e.g. musicbox has one running — we don't restart it with our subset;
  // we just look for our lights among its channels.
  const driver = getSharedEntertainmentDriver();
  if (!driver.active) {
    try {
      await driver.start({ lightNames: names });
      startedStream = true;
    } catch (e) {
      return { ok: false, error: `entertainment stream start failed: ${e}` };
    }
  } else {
    startedStream = false;
  }
  mapStreamChannels(driver);
  if (runtime.low.streamChannelId === null && runtime.high.streamChannelId === null) {
    if (startedStream) await driver.stop().catch(() => { /* best effort */ });
    return { ok: false, error: `lights not present in stream (${runtime.low.lastError}; ${runtime.high.lastError})` };
  }

  try {
    proc = spawn(SYSCAP_BIN, [], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    lastError = String(e);
    if (startedStream) await driver.stop().catch(() => { /* best effort */ });
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
          const t = typeof f.t === 'number' ? f.t : Date.now();
          ingest(f.bands, t);
          history.push({ t, pct: [...normPct], minmax: [...normMinMax], frozen: [...normFrozen] });
          if (history.length > MAX_QUEUE) history.shift();
          lastReleaseAt = t;
        }
      } catch { /* partial/garbage line — skip */ }
    }
  });
  proc.stderr!.on('data', (c: Buffer) => {
    const s = c.toString('utf8').trim();
    if (!s) return;
    console.log('[audio-sync syscap]', s);
    if (/fail|error|denied|stopped|no display/i.test(s)) lastError = s;
  });
  proc.on('exit', (code) => {
    console.log(`[audio-sync] syscap helper exited (${code})`);
    if (active && code !== 0) lastError = `syscap helper exited ${code}`;
    proc = null;
  });
  tickTimer = setInterval(tick, config.tickMs);
  console.log(`[audio-sync] started — low→"${runtime.low.resolvedName}" (ch ${runtime.low.streamChannelId}) high→"${runtime.high.resolvedName}" (ch ${runtime.high.streamChannelId}) via entertainment stream`);
  return { ok: true };
}

export async function stopAudioSync(): Promise<void> {
  if (!active) return;
  active = false;
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (proc) { try { proc.kill('SIGTERM'); } catch { /* ignore */ } proc = null; }

  const driver = getSharedEntertainmentDriver();
  for (const c of CHANNELS) {
    const rt = runtime[c];
    if (rt.streamChannelId !== null) driver.clearEffect(rt.streamChannelId);
  }
  // Only tear down the stream if we're the one who started it.
  if (startedStream && driver.active) {
    await driver.stop().catch(() => { /* best effort */ });
  }
  startedStream = false;

  // Hand lights back to the palette animator and restore pre-sync state
  // (REST works again once the stream is down).
  for (const c of CHANNELS) {
    const rt = runtime[c];
    if (rt.lmId) setPaletteExcluded(rt.lmId, false);
    if (rt.rid && rt.snapshot) {
      await restoreLightSnapshot(rt.rid, rt.snapshot).catch(() => { /* best effort */ });
    }
  }
  reset();
  console.log('[audio-sync] stopped');
}

export function updateAudioSyncConfig(patch: Partial<AudioSyncConfig> & { channels?: Partial<Record<ChannelName, Partial<ChannelConfig>>> }): typeof config {
  if (typeof patch.delayMs === 'number') config.delayMs = Math.max(0, Math.min(8000, patch.delayMs));
  if (typeof patch.normMode === 'string' && (patch.normMode === 'pct' || patch.normMode === 'minmax' || patch.normMode === 'frozen')) {
    // 'frozen' needs captured bounds — ignore the switch until a freeze happens.
    if (patch.normMode !== 'frozen' || frozenBounds) config.normMode = patch.normMode;
  }
  if (typeof patch.attack === 'number') config.attack = Math.max(0, Math.min(0.99, patch.attack));
  if (typeof patch.decay === 'number') config.decay = Math.max(0, Math.min(0.99, patch.decay));
  if (typeof patch.gamma === 'number') config.gamma = Math.max(0.2, Math.min(4, patch.gamma));
  if (typeof patch.tickMs === 'number') {
    config.tickMs = Math.max(16, Math.min(1000, Math.round(patch.tickMs)));
    if (tickTimer) { clearInterval(tickTimer); tickTimer = setInterval(tick, config.tickMs); }
  }
  if (patch.channels) {
    for (const c of CHANNELS) {
      const p = patch.channels[c];
      if (!p) continue;
      const cc = config.channels[c];
      if (typeof p.lightName === 'string' && p.lightName.trim()) cc.lightName = p.lightName;
      if (typeof p.minLevel === 'number') cc.minLevel = clamp01(p.minLevel);
      if (typeof p.maxLevel === 'number') cc.maxLevel = clamp01(p.maxLevel);
    }
  }
  return config;
}

// Lightweight liveness probe for the hue-stream watchdog (see stem-sync).
export function isAudioSyncActive(): boolean {
  return active;
}

export function getAudioSyncStatus() {
  const driver = (() => {
    try { return getSharedEntertainmentDriver(); } catch { return null; }
  })();
  return {
    active,
    streamActive: driver?.active ?? false,
    startedStream,
    fresh: active && Date.now() - lastReleaseAt < FRESH_MS,
    config,
    queued: history.length,
    perLightDelayMs: Object.fromEntries(CHANNELS.map((c) => [c, perLightDelayMs(runtime[c])])),
    windowSamples: tsBuf.length,
    frozen: !!frozenBounds,
    frameHz: driver?.getFrameHz() ?? null,
    error: lastError,
    channels: Object.fromEntries(CHANNELS.map((c) => [c, {
      light: runtime[c].resolvedName,
      streamChannelId: runtime[c].streamChannelId,
      value: Number(runtime[c].value.toFixed(3)),
      level: Number(runtime[c].level.toFixed(3)),
      lastError: runtime[c].lastError,
    }])),
  };
}
