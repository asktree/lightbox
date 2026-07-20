// Stem-sync service — Spotify playhead → per-stem energy envelopes → Hue
// Entertainment stream levels.
//
// The preprocessed cousin of audio-sync: instead of live-capturing system
// audio, it follows the autopilot's interpolated Spotify playhead
// (/tmp/lightbox-autopilot.json, written at 2Hz) and samples the demucs-stem
// RMS envelopes that musicbox computes from stems on disk
// (GET :3002/api/library/:id/envelope, ENV2 binary). Envelopes are
// normalized per-stem against the whole track's max at load time — the
// "library-wide bounds" approach — so no rolling-window normalization is
// needed and quiet intros stay quiet.
//
// Each binding maps a SET of stems onto one light: value = mean of the
// selected stems' normalized envelopes at the playhead, shaped by gamma and
// attack/decay smoothing, then driver.setLevel(channel, level) against the
// channel's palette-synced baseline color. Transport is the shared
// entertainment stream (DTLS/UDP 50Hz) — no REST in the hot path.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  getRestLights,
  getLightSnapshot,
  restoreLightSnapshot,
  type LightSnapshot,
} from '../drivers/hue-rest-pulse.js';
import { getSharedEntertainmentDriver } from '../drivers/hue-entertainment.js';
import { getPlayheadOffsetMs } from './latency-calibration.js';
import type { PaletteAnimator } from '../lib/palette-animator.js';

const AUTOPILOT_STATE = '/tmp/lightbox-autopilot.json';
const MUSICBOX_URL = 'http://localhost:3002';
const ENVELOPE_RETRY_MS = 3000; // stems may still be ingesting — poll until they appear
const STATE_FRESH_S = 3;        // autopilot state older than this = not playing

export const STEMS = ['drums', 'bass', 'vocals', 'other'] as const;
export type Stem = (typeof STEMS)[number];

export interface StemBinding {
  rid: string;        // CLIP v2 light UUID
  stems: Stem[];      // which stem envelopes feed this light (mean of set)
  minLevel: number;   // baseline multiplier at value 0
  maxLevel: number;   // baseline multiplier at value 1
}

export interface StemSyncConfig {
  offsetMs: number;   // delay light events to match audio-output latency
  tickMs: number;
  gamma: number;      // level = value^gamma
  attack: number;     // smoothing α when rising (0 = instant)
  decay: number;      // smoothing α when falling
}

const config: StemSyncConfig = {
  offsetMs: 300,
  tickMs: 33,
  gamma: 1,
  attack: 0,
  decay: 0.5,
};
let bindings: StemBinding[] = [];

// ---- Persistence ----
// tsx-watch restarts the server on every source edit; without disk-backed
// config + auto-resume, each restart silently kills the light show.
const __dirname = dirname(fileURLToPath(import.meta.url));
const PERSIST_FILE = join(__dirname, '../../data/stem-sync.json');

function persist(activeFlag: boolean): void {
  try {
    writeFileSync(PERSIST_FILE, JSON.stringify({ config, bindings, active: activeFlag }, null, 2));
  } catch (e) {
    console.log('[stem-sync] persist failed:', e);
  }
}

function loadPersisted(): { active: boolean } {
  try {
    if (!existsSync(PERSIST_FILE)) return { active: false };
    const raw = JSON.parse(readFileSync(PERSIST_FILE, 'utf-8'));
    if (raw.config && typeof raw.config === 'object') Object.assign(config, raw.config);
    if (Array.isArray(raw.bindings)) bindings = raw.bindings;
    return { active: !!raw.active };
  } catch {
    return { active: false };
  }
}

// Called once at server boot (after the Hue driver has had a moment to
// connect). If the service was active when the previous process died,
// bring it back with the same bindings. Retries with backoff: the bridge
// holds the previous process's orphaned DTLS session for ~10s, so the
// first attempt after a restart usually fails with "stream already active".
export function resumeStemSync(): void {
  const { active: wasActive } = loadPersisted();
  if (!wasActive || bindings.length === 0) return;
  console.log('[stem-sync] resuming after restart…');
  let attempts = 0;
  const tryStart = () => {
    attempts++;
    startStemSync().then((r) => {
      if (r.ok) return;
      if (attempts < 6) {
        console.log(`[stem-sync] resume attempt ${attempts} failed (${r.error}) — retrying in 5s`);
        setTimeout(tryStart, 5000);
      } else {
        console.log('[stem-sync] resume gave up:', r.error);
      }
    }).catch((e) => console.log('[stem-sync] resume failed:', e));
  };
  tryStart();
}

// Lightweight liveness probe for the hue-stream watchdog — while a
// server-side service owns the stream there are no browser heartbeats,
// and the watchdog must not tear the stream down.
export function isStemSyncActive(): boolean {
  return active;
}

interface BindingRuntime {
  binding: StemBinding;
  lmId: string | null;
  resolvedName: string | null;
  streamChannelId: number | null;
  snapshot: LightSnapshot | null;
  value: number;
  level: number;
  lastError: string | null;
}

interface Envelope {
  trackId: string;
  sr: number;
  numSamples: number;
  stems: Record<Stem, { samples: Float32Array; max: number }>;
}

let paletteAnimator: PaletteAnimator | null = null;
export function setStemSyncPaletteAnimator(pa: PaletteAnimator): void {
  paletteAnimator = pa;
}
function setPaletteExcluded(lmId: string, excluded: boolean): void {
  if (!paletteAnimator) return;
  for (const rs of paletteAnimator.getAllRoomStates()) {
    paletteAnimator.setLightExcluded(rs.roomId, lmId, excluded);
  }
}

let active = false;
let startedStream = false;
let tickTimer: NodeJS.Timeout | null = null;
let runtimes: BindingRuntime[] = [];
let lastError: string | null = null;

let envelope: Envelope | null = null;
let envelopeTrackId: string | null = null;  // track we last tried to load
let envelopeError: string | null = null;
let lastEnvelopeAttempt = 0;
let envelopeLoading = false;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

// ---- ENV2 binary parse (see musicbox envelope.ts serializeEnvelope) ----

function parseEnvelope(trackId: string, buf: Buffer): Envelope {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'ENV2') {
    throw new Error('bad envelope magic');
  }
  const numStems = buf.readUInt8(4);
  const sr = buf.readUInt16LE(6);
  const numSamples = buf.readUInt32LE(8);
  if (numStems !== STEMS.length) throw new Error(`expected ${STEMS.length} stems, got ${numStems}`);
  const stems = {} as Envelope['stems'];
  let off = 12;
  for (const stem of STEMS) {
    const bytes = numSamples * 4;
    if (off + bytes > buf.length) throw new Error('envelope truncated');
    // Copy out — Buffer's backing ArrayBuffer may be pooled/offset.
    const samples = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) samples[i] = buf.readFloatLE(off + i * 4);
    let max = 0;
    for (let i = 0; i < numSamples; i++) if (samples[i] > max) max = samples[i];
    stems[stem] = { samples, max };
    off += bytes;
  }
  return { trackId, sr, numSamples, stems };
}

async function loadEnvelope(trackId: string): Promise<void> {
  if (envelopeLoading) return;
  envelopeLoading = true;
  lastEnvelopeAttempt = Date.now();
  try {
    const res = await fetch(`${MUSICBOX_URL}/api/library/${trackId}/envelope`);
    if (!res.ok) throw new Error(`envelope ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const env = parseEnvelope(trackId, buf);
    // The endpoint falls back to a bands-only envelope (zeroed stems) when
    // stems aren't on disk yet — treat that as "not ready" and keep retrying.
    const anySignal = STEMS.some((s) => env.stems[s].max > 0);
    if (!anySignal) throw new Error('stems not ready (zeroed envelope)');
    envelope = env;
    envelopeError = null;
    console.log(`[stem-sync] envelope loaded for ${trackId} (${env.numSamples} samples @ ${env.sr}Hz)`);
  } catch (e) {
    envelope = envelope?.trackId === trackId ? envelope : null;
    envelopeError = String(e instanceof Error ? e.message : e);
  } finally {
    envelopeLoading = false;
  }
}

// ---- Autopilot playhead ----

interface Playhead { trackId: string | null; posS: number; playing: boolean }

function readPlayhead(): Playhead {
  try {
    const raw = JSON.parse(readFileSync(AUTOPILOT_STATE, 'utf-8'));
    const nowS = Date.now() / 1000;
    const age = nowS - (raw.updated_at ?? 0);
    const playing = !!raw.playing && age < STATE_FRESH_S;
    // position_s was interpolated at write time; extend by state age.
    const posS = (raw.position_s ?? 0) + (playing ? age : 0);
    return { trackId: raw.track_id ?? null, posS, playing };
  } catch {
    return { trackId: null, posS: 0, playing: false };
  }
}

// ---- Drive loop ----

function tick(): void {
  const driver = getSharedEntertainmentDriver();
  if (!driver.active) return;
  const ph = readPlayhead();

  // Track change (or first sight of a track): load its envelope. Retry on a
  // slow cadence while ingest catches up.
  if (ph.trackId && (ph.trackId !== envelopeTrackId ||
      (envelope?.trackId !== ph.trackId && Date.now() - lastEnvelopeAttempt > ENVELOPE_RETRY_MS))) {
    envelopeTrackId = ph.trackId;
    void loadEnvelope(ph.trackId);
  }

  const env = envelope && envelope.trackId === ph.trackId ? envelope : null;

  for (const rt of runtimes) {
    if (rt.streamChannelId === null) continue;
    // Per-light playhead perspective: render the moment this light's photons
    // will coincide with the sound at the ear. Measured offsets (audio-out
    // latency minus this light's command→photon latency) come from the
    // calibration registry; config.offsetMs is only a fallback for
    // unmeasured lights.
    const offMs = getPlayheadOffsetMs(rt.binding.rid) ?? config.offsetMs;
    const posS = ph.posS - offMs / 1000;
    const idx = env ? Math.max(0, Math.min(env.numSamples - 1, Math.floor(posS * env.sr))) : 0;
    let target = 0;
    if (env && ph.playing && rt.binding.stems.length > 0) {
      for (const s of rt.binding.stems) {
        const st = env.stems[s];
        if (st.max > 0) target += st.samples[idx] / st.max;
      }
      target = clamp01(target / rt.binding.stems.length);
    }
    const a = target > rt.value ? config.attack : config.decay;
    rt.value = a > 0 ? rt.value * a + target * (1 - a) : target;
    const shaped = Math.pow(clamp01(rt.value), config.gamma);
    rt.level = rt.binding.minLevel + (rt.binding.maxLevel - rt.binding.minLevel) * shaped;
    driver.setLevel(rt.streamChannelId, rt.level);
  }
}

// ---- Lifecycle ----

// Latency calibration needs exclusive control of the entertainment stream;
// while suspended, every start attempt (including boot-time resume retries)
// is refused so nothing races the measurement.
let suspended = false;
export function setStemSyncSuspended(s: boolean): void {
  suspended = s;
}

export async function startStemSync(): Promise<{ ok: boolean; error?: string }> {
  if (suspended) return { ok: false, error: 'suspended for latency calibration' };
  if (active) return { ok: true };
  if (bindings.length === 0) return { ok: false, error: 'no bindings — map at least one stem to a light' };
  lastError = null;

  const lights = await getRestLights();
  runtimes = [];
  for (const b of bindings) {
    const match = lights.find((l) => l.rid === b.rid);
    const rt: BindingRuntime = {
      binding: b, lmId: null, resolvedName: null, streamChannelId: null,
      snapshot: null, value: 0, level: 0, lastError: null,
    };
    if (!match) {
      rt.lastError = `no Hue light with rid ${b.rid}`;
    } else {
      rt.lmId = match.lmId;
      rt.resolvedName = match.name;
      rt.snapshot = await getLightSnapshot(match.rid);
    }
    runtimes.push(rt);
  }
  const names = runtimes.map((r) => r.resolvedName).filter((n): n is string => !!n);
  if (names.length === 0) {
    return { ok: false, error: runtimes.map((r) => r.lastError).join('; ') };
  }

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
  const byName = new Map(driver.getChannels().map((ch) => [ch.lightName.trim().toLowerCase(), ch.id]));
  let mapped = 0;
  for (const rt of runtimes) {
    if (!rt.resolvedName) continue;
    const id = byName.get(rt.resolvedName.trim().toLowerCase());
    if (id === undefined) {
      rt.lastError = `"${rt.resolvedName}" not in the active entertainment stream`;
    } else {
      rt.streamChannelId = id;
      mapped++;
      if (rt.lmId) setPaletteExcluded(rt.lmId, true);
    }
  }
  if (mapped === 0) {
    if (startedStream) await driver.stop().catch(() => { /* best effort */ });
    return { ok: false, error: runtimes.map((r) => r.lastError).filter(Boolean).join('; ') };
  }

  active = true;
  persist(true);
  tickTimer = setInterval(tick, config.tickMs);
  console.log(`[stem-sync] started — ${runtimes.filter((r) => r.streamChannelId !== null)
    .map((r) => `${r.resolvedName}←[${r.binding.stems.join('+')}]`).join(' ')}`);
  return { ok: true };
}

export async function stopStemSync(opts?: { persistOff?: boolean }): Promise<void> {
  if (!active) return;
  active = false;
  // Internal bounces (binding-set changes, resume) keep active=true on disk;
  // only a user-initiated stop records the service as off.
  if (opts?.persistOff !== false) persist(false);
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }

  const driver = getSharedEntertainmentDriver();
  for (const rt of runtimes) {
    if (rt.streamChannelId !== null) driver.clearEffect(rt.streamChannelId);
  }
  if (startedStream && driver.active) {
    await driver.stop().catch(() => { /* best effort */ });
  }
  startedStream = false;
  for (const rt of runtimes) {
    if (rt.lmId) setPaletteExcluded(rt.lmId, false);
    if (rt.binding.rid && rt.snapshot) {
      await restoreLightSnapshot(rt.binding.rid, rt.snapshot).catch(() => { /* best effort */ });
    }
  }
  runtimes = [];
  console.log('[stem-sync] stopped');
}

// Returns whether a restart is needed for the change to fully apply (the
// set of bound lights changed while active — stream channels are fixed at
// start time).
export function updateStemSyncConfig(patch: Partial<StemSyncConfig> & { bindings?: StemBinding[] }): { needsRestart: boolean } {
  if (typeof patch.offsetMs === 'number') config.offsetMs = Math.max(-2000, Math.min(8000, Math.round(patch.offsetMs)));
  if (typeof patch.gamma === 'number') config.gamma = Math.max(0.2, Math.min(4, patch.gamma));
  if (typeof patch.attack === 'number') config.attack = Math.max(0, Math.min(0.99, patch.attack));
  if (typeof patch.decay === 'number') config.decay = Math.max(0, Math.min(0.99, patch.decay));
  if (typeof patch.tickMs === 'number') {
    config.tickMs = Math.max(16, Math.min(1000, Math.round(patch.tickMs)));
    if (tickTimer) { clearInterval(tickTimer); tickTimer = setInterval(tick, config.tickMs); }
  }
  let needsRestart = false;
  if (!Array.isArray(patch.bindings)) {
    persist(active);
  } else if (patch.bindings.length === 0 && active && bindings.length > 0) {
    // Refuse to clear every binding of a RUNNING show via config push —
    // that's how a stale browser tab (empty local state on mount) kills
    // the lights. Stopping first expresses real intent to clear.
    console.log('[stem-sync] ignored empty-bindings push while active (stale client?)');
  } else {
    const clean: StemBinding[] = patch.bindings
      .filter((b) => b && typeof b.rid === 'string')
      .map((b) => ({
        rid: b.rid,
        stems: (Array.isArray(b.stems) ? b.stems : []).filter((s): s is Stem => (STEMS as readonly string[]).includes(s)),
        minLevel: clamp01(typeof b.minLevel === 'number' ? b.minLevel : 0.02),
        maxLevel: clamp01(typeof b.maxLevel === 'number' ? b.maxLevel : 1),
      }));
    const oldRids = bindings.map((b) => b.rid).sort().join(',');
    const newRids = clean.map((b) => b.rid).sort().join(',');
    bindings = clean;
    persist(active);
    if (active) {
      if (oldRids !== newRids) {
        needsRestart = true;
      } else {
        // Same lights, new stem sets / levels — apply live.
        for (const rt of runtimes) {
          const nb = bindings.find((b) => b.rid === rt.binding.rid);
          if (nb) rt.binding = nb;
        }
      }
    }
  }
  return { needsRestart };
}

export function getStemSyncStatus() {
  const driver = (() => {
    try { return getSharedEntertainmentDriver(); } catch { return null; }
  })();
  const ph = readPlayhead();
  return {
    active,
    streamActive: driver?.active ?? false,
    startedStream,
    config,
    bindings,
    playhead: ph,
    envelope: envelope ? {
      trackId: envelope.trackId,
      sr: envelope.sr,
      numSamples: envelope.numSamples,
      stemMax: Object.fromEntries(STEMS.map((s) => [s, Number(envelope!.stems[s].max.toFixed(4))])),
    } : null,
    envelopeError,
    channels: runtimes.map((rt) => ({
      rid: rt.binding.rid,
      light: rt.resolvedName,
      stems: rt.binding.stems,
      effectiveOffsetMs: getPlayheadOffsetMs(rt.binding.rid) ?? config.offsetMs,
      streamChannelId: rt.streamChannelId,
      value: Number(rt.value.toFixed(3)),
      level: Number(rt.level.toFixed(3)),
      lastError: rt.lastError,
    })),
    error: lastError,
  };
}
