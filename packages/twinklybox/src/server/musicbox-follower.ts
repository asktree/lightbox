// Polls musicbox for playback state, fetches per-track envelopes, and
// every frame looks up the current per-stem energy at the current position
// and percentile-maps it into the audio bus.
//
// Cache lifecycle:
//   - Poll /api/playback every POLL_INTERVAL_MS. On trackId change, kick
//     off a fetch of /api/library/:id/envelope (cached in-memory after).
//   - Between heartbeats, interpolate position by elapsed wall time.
//   - On 404 / missing envelope (track without stems, or unknown id),
//     hold zeros so patterns degrade to "no audio" gracefully.

import { writeEnergy, writePlayback, type Stem, STEMS, NUM_BANDS } from './audio-bus.js';
import { isMicActive, micFresh, getMicBands } from './mic-source.js';
import { isSyscapActive, syscapFresh, getSyscapBands } from './syscap-source.js';
import { parseEnvelope, type EnvelopePack } from './envelope-parse.js';

const MUSICBOX_BASE = 'http://localhost:3002';
const POLL_INTERVAL_MS = 100;
const PLAYBACK_STALE_MS = 5000;

interface PlaybackResp { trackId: string | null; trackName?: string | null; position: number; playing: boolean; ts: number }

const envelopeCache = new Map<string, Promise<EnvelopePack>>();
let lastSeenTrackId: string | null = null;
let currentPlayback: PlaybackResp = { trackId: null, position: 0, playing: false, ts: 0 };
let currentPlaybackReceivedAt = 0;
// Manual override: when set, follower ignores musicbox /api/playback and
// uses these values instead. Twinklybox UI exposes this via /api/source.
let manualOverride: PlaybackResp | null = null;

// Synthetic dummy audio source. When active, ignore musicbox entirely
// and generate stem energies from a wave function — useful for testing
// audio-reactive patterns deterministically without playback. The four
// shapes cover the diagnostics that come up in practice.
export type SynthMode = 'sine' | 'pulse' | 'all-on' | 'all-sine';
export interface SynthParams {
  mode: SynthMode;
  hz: number;       // wave frequency
  amplitude: number; // 0..1, peak energy
}
let synth: SynthParams | null = null;
const synthStartMs = Date.now();
export function setSynth(p: SynthParams | null) { synth = p; }
export function getSynth(): SynthParams | null { return synth; }

function computeSynth(p: SynthParams, tSec: number): Record<Stem, number> {
  const a = p.amplitude;
  const phase = (tSec * p.hz) % 1; // 0..1 within one cycle
  switch (p.mode) {
    case 'sine': {
      // Bass-only sine. Others at a low constant so combined energy
      // (which megadrome uses for brightness) is non-zero.
      const v = 0.5 + 0.5 * Math.sin(phase * Math.PI * 2);
      return { drums: 0.1, bass: v * a, vocals: 0.1, other: 0.1 };
    }
    case 'pulse': {
      // Bass spikes briefly each cycle — short attack, fast decay. Best
      // for testing the radial-pulse propagation in megadrome.
      const duty = 0.1;
      const v = phase < duty ? (1 - phase / duty) * a : 0;
      return { drums: 0.05, bass: v, vocals: 0.05, other: 0.05 };
    }
    case 'all-on': {
      // Everything pinned high. Test peak brightness / steady state.
      return { drums: a, bass: a, vocals: a, other: a };
    }
    case 'all-sine': {
      // All four stems together. Tests combined-energy brightness modulation.
      const v = (0.5 + 0.5 * Math.sin(phase * Math.PI * 2)) * a;
      return { drums: v, bass: v, vocals: v, other: v };
    }
  }
}

export function setManualPlayback(p: PlaybackResp | null) {
  manualOverride = p;
  if (p) {
    currentPlayback = p;
    currentPlaybackReceivedAt = Date.now();
    if (p.trackId) {
      // Kick the envelope fetch immediately so subsequent ticks have data.
      // pollOnce normally does this on trackId change, but we bypass it in
      // manual mode.
      lastSeenTrackId = p.trackId;
      getEnvelope(p.trackId).catch(() => {});
    }
  }
}

export function getFollowerState() {
  return {
    musicboxReachable: Date.now() - currentPlaybackReceivedAt < PLAYBACK_STALE_MS || manualOverride !== null,
    manualOverride: !!manualOverride,
    synthActive: !!synth,
    synth,
    micActive: isMicActive(),
    micFresh: micFresh(),
    currentTrackId: currentPlayback.trackId,
    trackName: currentPlayback.trackName ?? null,
    cachedTracks: [...envelopeCache.keys()],
    inferredPosition: inferPosition(),
    playing: currentPlayback.playing,
  };
}

function inferPosition(): number {
  if (!currentPlayback.playing) return currentPlayback.position;
  const elapsedSec = (Date.now() - currentPlaybackReceivedAt) / 1000;
  return currentPlayback.position + elapsedSec;
}

// Empirical-CDF percentile lookup, same algorithm as the musicbox client
// already uses on the rAF side — binary search the sorted samples for the
// raw value's rank.
function valueToPercentile(sorted: Float32Array, v: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo / sorted.length;
}

// ---- Envelope binary parsing ----
// parseEnvelope lives in envelope-parse.ts (pure, unit-tested against the
// musicbox writer and the lightbox-server parser).

async function fetchEnvelope(trackId: string): Promise<EnvelopePack> {
  const r = await fetch(`${MUSICBOX_BASE}/api/library/${trackId}/envelope`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`envelope fetch ${trackId} → ${r.status}`);
  const buf = await r.arrayBuffer();
  return parseEnvelope(buf);
}

function getEnvelope(trackId: string): Promise<EnvelopePack> {
  let p = envelopeCache.get(trackId);
  if (!p) {
    p = fetchEnvelope(trackId);
    envelopeCache.set(trackId, p);
    p.catch((e) => {
      console.warn(`[musicbox-follower] envelope fetch failed for ${trackId}:`, e);
      envelopeCache.delete(trackId);
    });
  }
  return p;
}

// ---- Polling loop ----

async function pollOnce() {
  if (manualOverride) return; // bypass network when in manual scrub mode
  try {
    const r = await fetch(`${MUSICBOX_BASE}/api/playback`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return;
    const j = (await r.json()) as PlaybackResp;
    currentPlayback = j;
    currentPlaybackReceivedAt = Date.now();
    if (j.trackId && j.trackId !== lastSeenTrackId) {
      lastSeenTrackId = j.trackId;
      // Kick a prefetch; consumer (frame-loop) reads from the cache.
      getEnvelope(j.trackId).catch(() => {});
    }
  } catch {
    // Musicbox not running / unreachable — silently leave state alone.
  }
}

let pollTimer: NodeJS.Timeout | null = null;
let tickTimer: NodeJS.Timeout | null = null;
export function startFollower() {
  if (pollTimer) return;
  pollOnce();
  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
  // Also drive a background tick so the audio bus stays current even
  // when the LED frame loop isn't running — keeps the UI energy meters
  // alive while the user is still picking a pattern.
  tickTimer = setInterval(tickFollower, POLL_INTERVAL_MS);
}

// ---- Frame-time hookup ----
//
// Called from the twinklybox frame loop right before pattern render.
// Looks up the current playback position in the cached envelope for the
// current track and writes percentile-mapped per-stem energy into the
// audio bus. If the envelope isn't ready yet, writes zeros and waits for
// the next frame.

const ZEROS = (): Record<Stem, number> => ({ drums: 0, bass: 0, vocals: 0, other: 0 });

export function tickFollower() {
  // System-audio "live sync" source — top priority. Captures the Mac's output
  // mix (ScreenCaptureKit) and drives megadrome on a delay matched to the
  // playback latency (AirPlay ~2s), so lights line up with what's heard. Only
  // the 12 FFT bands are populated (run megadrome in eq12). Already normalized
  // against a 30s rolling window in syscap-source.ts.
  if (isSyscapActive()) {
    const fresh = syscapFresh();
    writePlayback({ trackId: null, trackName: fresh ? 'system audio' : 'system audio (no signal)', position: 0, playing: fresh });
    const { bands, bandsMinMax } = getSyscapBands();
    writeEnergy({ percentile: ZEROS(), minMax: ZEROS(), bands, bandsMinMax });
    return;
  }
  // Synth source takes priority — ignores musicbox + manual entirely.
  // Synth doesn't have a normalization concept; mirror its raw value into
  // both views so megadrome's normMode toggle is a no-op under synth.
  if (synth) {
    const tSec = (Date.now() - synthStartMs) / 1000;
    writePlayback({ trackId: null, trackName: `synth:${synth.mode}@${synth.hz}Hz`, position: tSec, playing: true });
    const v = computeSynth(synth, tSec);
    // Fill all 12 bands with the synth's bass value so eq12 megadrome under
    // synth still gives a recognizable picture (uniform allocation across
    // bands at the synth's instantaneous level).
    const bands = new Array(NUM_BANDS).fill(v.bass);
    writeEnergy({ percentile: v, minMax: v, bands, bandsMinMax: bands });
    return;
  }
  // Live mic source — next priority after synth, overrides musicbox. Only
  // the 12 FFT bands are populated (stems aren't recoverable from raw FFT);
  // megadrome should run in eq12 mode on mic. Values are already normalized
  // against the 30s rolling window in mic-source.ts. When the mic is enabled
  // but no frames are arriving (browser tab backgrounded / permission lost),
  // hold zeros so the show degrades to "no audio" instead of freezing.
  if (isMicActive()) {
    const fresh = micFresh();
    writePlayback({ trackId: null, trackName: fresh ? 'mic input' : 'mic (no signal)', position: 0, playing: fresh });
    if (fresh) {
      const { bands, bandsMinMax } = getMicBands();
      writeEnergy({ percentile: ZEROS(), minMax: ZEROS(), bands, bandsMinMax });
    } else {
      const z = new Array(NUM_BANDS).fill(0);
      writeEnergy({ percentile: ZEROS(), minMax: ZEROS(), bands: z, bandsMinMax: z });
    }
    return;
  }
  const trackId = currentPlayback.trackId;
  if (!trackId) {
    writePlayback({ trackId: null, trackName: null, position: 0, playing: false });
    writeEnergy({ percentile: ZEROS(), minMax: ZEROS() });
    return;
  }
  const pos = inferPosition();
  writePlayback({
    trackId,
    trackName: currentPlayback.trackName ?? null,
    position: pos,
    playing: currentPlayback.playing,
  });
  // Pull from cache without awaiting — if not yet ready, we'll have zeros
  // for a few hundred ms while the binary streams in.
  const cached = envelopeCache.get(trackId);
  if (!cached) {
    writeEnergy({ percentile: ZEROS(), minMax: ZEROS() });
    return;
  }
  // The promise may or may not be settled; we sneak a synchronous read by
  // attaching a flag once it resolves. Cheap: one extra closure per track.
  const peek = (cached as Promise<EnvelopePack> & { _v?: EnvelopePack });
  if (!peek._v) {
    cached.then((v) => { peek._v = v; }).catch(() => {});
    writeEnergy({ percentile: ZEROS(), minMax: ZEROS() });
    return;
  }
  const env = peek._v;
  const idxRaw = Math.floor(pos * env.sr);
  if (idxRaw < 0 || idxRaw >= env.numSamples) {
    writeEnergy({ percentile: ZEROS(), minMax: ZEROS() });
    return;
  }
  // Compute both normalization views at the current playhead.
  const percentile = {} as Record<Stem, number>;
  const minMax = {} as Record<Stem, number>;
  for (const stem of STEMS) {
    const e = env.stems[stem];
    const raw = e.samples[idxRaw];
    percentile[stem] = valueToPercentile(e.sorted, raw);
    // Robust min-max bounded by p2 and p98 of this stem's distribution.
    // Outliers don't blow the range; quiet sections actually read as quiet.
    const n = e.sorted.length;
    const lo = e.sorted[Math.floor(0.02 * n)];
    const hi = e.sorted[Math.min(n - 1, Math.floor(0.98 * n))];
    const span = hi - lo;
    minMax[stem] = span > 1e-9 ? Math.max(0, Math.min(1, (raw - lo) / span)) : 0;
  }
  // Per-band normalization: percentile + robust-minmax, mirroring stems.
  // The sorted array we already keep for percentile lookup also gives us
  // p2 and p98 for free — no extra data needed, no extra storage cost.
  const bands = new Array(NUM_BANDS).fill(0);
  const bandsMinMax = new Array(NUM_BANDS).fill(0);
  for (let b = 0; b < env.numBands && b < NUM_BANDS; b++) {
    const e = env.bands[b];
    const raw = e.samples[idxRaw];
    bands[b] = valueToPercentile(e.sorted, raw);
    const n = e.sorted.length;
    const lo = e.sorted[Math.floor(0.02 * n)];
    const hi = e.sorted[Math.min(n - 1, Math.floor(0.98 * n))];
    const span = hi - lo;
    bandsMinMax[b] = span > 1e-9 ? Math.max(0, Math.min(1, (raw - lo) / span)) : 0;
  }
  writeEnergy({ percentile, minMax, bands, bandsMinMax });
}
