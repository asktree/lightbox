// Stem-sync service — Spotify playhead → per-stem energy envelopes → Hue
// Entertainment stream levels.
//
// The preprocessed cousin of audio-sync: instead of live-capturing system
// audio, it follows the autopilot's interpolated Spotify playhead
// (data/state/lightbox-autopilot.json, written at 2Hz) and samples the demucs-stem
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
import { getPlayheadOffsetMs, getLatencyRegistry } from './latency-calibration.js';
import { STEMS, parseEnvelope, type Stem, type Envelope } from './envelope-parse.js';
import type { PaletteAnimator } from '../lib/palette-animator.js';

// Shared contract with scraper/autopilot.py and routes/autopilot.ts —
// state lives under the repo, not /tmp (macOS purges /tmp after ~3 days).
const AUTOPILOT_STATE = join(dirname(fileURLToPath(import.meta.url)),
  '../../data/state/lightbox-autopilot.json');
const MUSICBOX_URL = 'http://localhost:3002';
const ENVELOPE_RETRY_MS = 3000; // stems may still be ingesting — poll until they appear
const STATE_FRESH_S = 3;        // autopilot state older than this = not playing

// ENV2 parsing + stem list live in envelope-parse.ts (pure, unit-tested);
// re-export so existing importers keep working.
export { STEMS } from './envelope-parse.js';
export type { Stem } from './envelope-parse.js';

export interface StemBinding {
  rid: string;        // CLIP v2 light UUID
  stems: Stem[];      // which stem envelopes feed this light (mean of set)
  minLevel: number;   // baseline multiplier at value 0
  maxLevel: number;   // baseline multiplier at value 1
  // 'palette' (default): color follows the palette animator's baseline.
  // 'chroma': color follows the music — the energy-weighted chroma proxy
  // of the bound stems maps onto the binding's hue arc.
  colorMode?: 'palette' | 'chroma';
  // Chroma hue arc: chromaValue 0 lands on hueStart, 1 on hueEnd,
  // traversing in hueDir ('up' = incrementing hue, 'down' = decrementing),
  // wrapping through 360 as needed.
  hueStart?: number; // degrees 0-360
  hueEnd?: number;
  hueDir?: 'up' | 'down';
}

export interface StemSyncConfig {
  offsetMs: number;   // delay light events to match audio-output latency
  tickMs: number;
  gamma: number;      // level = value^gamma
  attack: number;     // smoothing α when rising (0 = instant)
  decay: number;      // smoothing α when falling
  minLevel: number;   // global brightness floor (baseline multiplier at value 0)
  maxLevel: number;   // global brightness ceiling (at value 1)
  // Where the playhead comes from: 'spotify' = autopilot state file,
  // 'local' = the thin local player pushing to musicbox's /api/playback.
  playheadSource: 'spotify' | 'local';
}

const config: StemSyncConfig = {
  offsetMs: 300,
  tickMs: 33,
  gamma: 1,
  attack: 0,
  decay: 0.5,
  minLevel: 0.02,
  maxLevel: 1,
  playheadSource: 'spotify',
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
export function resumeStemSync(opts?: { resumeActuation?: boolean }): void {
  const resumeActuation = opts?.resumeActuation !== false;
  const { active: wasActive } = loadPersisted(); // always: bindings/config feed the UI
  if (!wasActive || bindings.length === 0) return;
  if (!resumeActuation) {
    // Cold boot: design state is loaded, but the drive stays off. Persist
    // the demotion so a later warm restart can't resurrect stale intent.
    persist(false);
    console.log('[stem-sync] cold boot — drive was active before shutdown; loaded idle (start it from the UI)');
    return;
  }
  wantActive = true; // supervisor keeps trying even if this loop gives up
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
  chromaValue: number; // EMA-smoothed 0..1 chroma driving the hue
  lastError: string | null;
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
// Operator intent, reconciled by the supervisor below. Set true by a
// successful start (or resume intent), cleared only by a user stop —
// internal teardowns (stream death, calibration) keep it true so the
// drive comes back by itself once the bridge is reachable again.
let wantActive = false;

let envelope: Envelope | null = null;
let envelopeTrackId: string | null = null;  // track we last tried to load
let envelopeError: string | null = null;
let lastEnvelopeAttempt = 0;
let envelopeLoading = false;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

// ---- Chroma → hue ----
// Low chroma (dark timbre) = warm amber, high (bright timbre) = cyan-blue —
// the same warm→cool reading as v1's spectrum gradient.
const CHROMA_HUE_LO = 30;
const CHROMA_HUE_HI = 210;
const CHROMA_EMA = 0.85; // slow-ish hue drift; hue flicker looks broken

function hsvToRgb16(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return {
    r: Math.round((r + m) * 65535),
    g: Math.round((g + m) * 65535),
    b: Math.round((b + m) * 65535),
  };
}

// Channels whose color stem-sync owns (chroma mode). The hue-stream
// palette-baseline loop must skip these or it would overwrite the hue at
// 45Hz.
const chromaChannels = new Set<number>();
export function isChromaOwnedChannel(channelId: number): boolean {
  return chromaChannels.has(channelId);
}

async function loadEnvelope(trackId: string): Promise<void> {
  if (envelopeLoading) return;
  envelopeLoading = true;
  lastEnvelopeAttempt = Date.now();
  try {
    const res = await fetch(`${MUSICBOX_URL}/api/library/${trackId}/envelope`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`envelope ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const env = parseEnvelope(trackId, buf);
    // The endpoint falls back to a bands-only envelope (zeroed stems) when
    // stems aren't on disk yet — treat that as "not ready" and keep retrying.
    const anySignal = STEMS.some((s) => env.stems[s].max > 0);
    if (!anySignal) throw new Error('stems not ready (zeroed envelope)');
    // Chroma rides along; failure is non-fatal (hue falls back to mid-ramp).
    try {
      const cr = await fetch(`${MUSICBOX_URL}/api/library/${trackId}/chroma`, { signal: AbortSignal.timeout(5000) });
      if (cr.ok) {
        const cj = await cr.json() as { stems: Record<string, { samples: number[]; max: number }> };
        const chroma = {} as NonNullable<Envelope['chroma']>;
        for (const s of STEMS) {
          const c = cj.stems?.[s];
          chroma[s] = c
            ? { samples: Float32Array.from(c.samples), max: c.max }
            : { samples: new Float32Array(env.numSamples), max: 0 };
        }
        env.chroma = chroma;
      }
    } catch { /* energy-only */ }
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

// ---- Playhead sources ----

interface Playhead { trackId: string | null; posS: number; playing: boolean }

// Local player: musicbox's /api/playback holds the last push from the thin
// player (position inferred server-side at read time). Polled at 2Hz while
// the service is active and the source is 'local'; extrapolated between
// polls, and staled out when the poll stops succeeding.
const LOCAL_POLL_MS = 500;
const LOCAL_STALE_S = 3;
interface LocalPlayback { trackId: string | null; position: number; playing: boolean; playSpeed: number; fetchedAtMs: number }
let localPlayback: LocalPlayback | null = null;
let localPollInFlight = false;

async function pollLocalPlayback(): Promise<void> {
  if (config.playheadSource !== 'local' || localPollInFlight) return;
  localPollInFlight = true;
  try {
    const res = await fetch(`${MUSICBOX_URL}/api/playback`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`playback ${res.status}`);
    const j = await res.json() as { trackId: string | null; position: number; playing: boolean; playSpeed: number };
    localPlayback = {
      trackId: j.trackId ?? null,
      position: typeof j.position === 'number' ? j.position : 0,
      playing: !!j.playing,
      playSpeed: typeof j.playSpeed === 'number' ? j.playSpeed : 1,
      fetchedAtMs: Date.now(),
    };
  } catch { /* readLocalPlayhead stales out below */ }
  finally { localPollInFlight = false; }
}

// Always ticking (no-op unless source is 'local') so the status playhead
// is truthful even before the drive starts. unref'd: never holds the
// process open.
setInterval(pollLocalPlayback, LOCAL_POLL_MS).unref();

function readLocalPlayhead(): Playhead {
  const lp = localPlayback;
  if (!lp) return { trackId: null, posS: 0, playing: false };
  const ageS = (Date.now() - lp.fetchedAtMs) / 1000;
  if (ageS > LOCAL_STALE_S) return { trackId: lp.trackId, posS: lp.position, playing: false };
  return {
    trackId: lp.trackId,
    posS: lp.position + (lp.playing ? ageS * lp.playSpeed : 0),
    playing: lp.playing,
  };
}

function readPlayhead(): Playhead {
  if (config.playheadSource === 'local') return readLocalPlayhead();
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

// The public playhead contract (GET /api/playhead): the ear-time playhead.
// earPosS = source position minus the audio-output latency of the *current*
// output device, so consumers (twinklybox, future fixtures) never need to
// know about speakers — they just add their own command→photon latency.
// A measured registry value beats the CoreAudio-reported one, but only when
// it was measured on the device that's playing right now; a measurement
// taken on other speakers doesn't transfer.
export function readEarPlayhead() {
  const ph = readPlayhead();
  let device: string | null = null;
  let reportedMs: number | null = null;
  try {
    const raw = JSON.parse(readFileSync(AUTOPILOT_STATE, 'utf-8'));
    device = typeof raw.output_device_name === 'string' ? raw.output_device_name : null;
    reportedMs = typeof raw.output_latency_ms === 'number' ? raw.output_latency_ms : null;
  } catch { /* no autopilot state — no device info */ }
  const measured = getLatencyRegistry().audio;
  const measuredApplies = !!measured && !!device && measured.outputDeviceName === device;
  const latencyMs = measuredApplies ? measured!.latencyMs : reportedMs ?? 0;
  return {
    trackId: ph.trackId,
    posS: ph.posS,
    earPosS: ph.posS - latencyMs / 1000,
    playing: ph.playing,
    source: config.playheadSource,
    audio: {
      latencyMs,
      latencySource: measuredApplies ? 'measured' : reportedMs != null ? 'reported' : 'none',
      device,
    },
  };
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
    const lo = Math.min(config.minLevel, config.maxLevel);
    const hi = Math.max(config.minLevel, config.maxLevel);
    rt.level = lo + (hi - lo) * shaped;
    driver.setLevel(rt.streamChannelId, rt.level);

    // Chroma → hue: energy-weighted mean of the bound stems' chroma at the
    // playhead (weighting stops a silent stem from dragging the hue), then
    // EMA-smoothed and mapped onto the warm→cool ramp. We own the channel's
    // baseline color in this mode; the palette loop skips it.
    if (rt.binding.colorMode === 'chroma') {
      chromaChannels.add(rt.streamChannelId);
      const ch = env?.chroma;
      if (ch && env && ph.playing) {
        let wsum = 0, csum = 0;
        for (const s of rt.binding.stems) {
          const ce = ch[s];
          const ee = env.stems[s];
          if (!ce || ce.max <= 0 || ee.max <= 0) continue;
          const w = ee.samples[idx] / ee.max;
          csum += (ce.samples[idx] / ce.max) * w;
          wsum += w;
        }
        const inst = wsum > 1e-4 ? clamp01(csum / wsum) : rt.chromaValue;
        rt.chromaValue = rt.chromaValue * CHROMA_EMA + inst * (1 - CHROMA_EMA);
      }
      // Traverse the binding's hue arc: 0 → hueStart, 1 → hueEnd, moving
      // in hueDir and wrapping through 360.
      const hs = rt.binding.hueStart ?? CHROMA_HUE_LO;
      const he = rt.binding.hueEnd ?? CHROMA_HUE_HI;
      const span = (rt.binding.hueDir ?? 'up') === 'up'
        ? (((he - hs) % 360) + 360) % 360
        : -((((hs - he) % 360) + 360) % 360);
      const hue = (((hs + span * rt.chromaValue) % 360) + 360) % 360;
      const { r, g, b } = hsvToRgb16(hue, 1, 1);
      driver.setChannel(rt.streamChannelId, r, g, b);
    } else {
      chromaChannels.delete(rt.streamChannelId);
    }
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
  // Asking to start IS the intent — latch it even if this attempt fails,
  // so the supervisor keeps retrying through bridge flaps unattended.
  wantActive = true;
  lastError = null;

  const lights = await getRestLights();
  runtimes = [];
  for (const b of bindings) {
    const match = lights.find((l) => l.rid === b.rid);
    const rt: BindingRuntime = {
      binding: b, lmId: null, resolvedName: null, streamChannelId: null,
      snapshot: null, value: 0, level: 0, chromaValue: 0.5, lastError: null,
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
  wantActive = true;
  persist(true);
  tickTimer = setInterval(tick, config.tickMs);
  console.log(`[stem-sync] started — ${runtimes.filter((r) => r.streamChannelId !== null)
    .map((r) => `${r.resolvedName}←[${r.binding.stems.join('+')}]`).join(' ')}`);
  return { ok: true };
}

export async function stopStemSync(opts?: { persistOff?: boolean }): Promise<void> {
  if (opts?.persistOff !== false) wantActive = false; // user stop = real intent
  if (!active) return;
  active = false;
  // Internal bounces (binding-set changes, resume) keep active=true on disk;
  // only a user-initiated stop records the service as off.
  if (opts?.persistOff !== false) persist(false);
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }

  const driver = getSharedEntertainmentDriver();
  for (const rt of runtimes) {
    if (rt.streamChannelId !== null) driver.clearEffect(rt.streamChannelId);
    if (rt.streamChannelId !== null) chromaChannels.delete(rt.streamChannelId);
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

// Stream supervisor. A mid-show bridge flap kills the DTLS stream while the
// service stays 'active' with a dead driver — frozen lights, no recovery
// (the July 22 failure). Every 5s, reconcile toward wantActive: tear down a
// dead stream, then keep retrying the start until the bridge is back.
// Unlike the boot-time resume loop, this never gives up — bridge flaps end.
let supervisorBusy = false;
let supervisorFails = 0;
setInterval(async () => {
  if (supervisorBusy || suspended) return;
  supervisorBusy = true;
  try {
    if (active) {
      let driverActive = false;
      try { driverActive = getSharedEntertainmentDriver().active; } catch {}
      if (!driverActive) {
        console.log('[stem-sync] stream died — tearing down for rebuild');
        await stopStemSync({ persistOff: false });
      } else {
        supervisorFails = 0;
      }
    } else if (wantActive) {
      const r = await startStemSync();
      if (r.ok) {
        supervisorFails = 0;
        console.log('[stem-sync] supervisor restarted the drive');
      } else {
        // First failure logs; then once a minute — a long outage shouldn't spam.
        supervisorFails++;
        if (supervisorFails === 1 || supervisorFails % 12 === 0) {
          console.log(`[stem-sync] supervisor start failed (${supervisorFails}x): ${r.error}`);
        }
      }
    }
  } catch (e) {
    console.log('[stem-sync] supervisor error:', e);
  } finally {
    supervisorBusy = false;
  }
}, 5000).unref();

// Returns whether a restart is needed for the change to fully apply (the
// set of bound lights changed while active — stream channels are fixed at
// start time).
export function updateStemSyncConfig(patch: Partial<StemSyncConfig> & { bindings?: StemBinding[] }): { needsRestart: boolean } {
  if (patch.playheadSource === 'spotify' || patch.playheadSource === 'local') {
    if (config.playheadSource !== patch.playheadSource) {
      config.playheadSource = patch.playheadSource;
      localPlayback = null; // don't drive from the other source's stale echo
      console.log(`[stem-sync] playhead source → ${config.playheadSource}`);
    }
  }
  if (typeof patch.offsetMs === 'number') config.offsetMs = Math.max(-2000, Math.min(8000, Math.round(patch.offsetMs)));
  if (typeof patch.gamma === 'number') config.gamma = Math.max(0.2, Math.min(4, patch.gamma));
  if (typeof patch.attack === 'number') config.attack = Math.max(0, Math.min(0.99, patch.attack));
  if (typeof patch.decay === 'number') config.decay = Math.max(0, Math.min(0.99, patch.decay));
  if (typeof patch.minLevel === 'number') config.minLevel = clamp01(patch.minLevel);
  if (typeof patch.maxLevel === 'number') config.maxLevel = clamp01(patch.maxLevel);
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
        colorMode: (b.colorMode === 'chroma' ? 'chroma' : 'palette') as 'palette' | 'chroma',
        hueStart: typeof b.hueStart === 'number' ? ((b.hueStart % 360) + 360) % 360 : undefined,
        hueEnd: typeof b.hueEnd === 'number' ? ((b.hueEnd % 360) + 360) % 360 : undefined,
        hueDir: (b.hueDir === 'down' ? 'down' : b.hueDir === 'up' ? 'up' : undefined) as 'up' | 'down' | undefined,
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
    wantActive, // false+wantActive=true reads as "reconnecting" in the UI
    streamActive: driver?.active ?? false,
    startedStream,
    config,
    bindings,
    playhead: { ...ph, source: config.playheadSource },
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
      colorMode: rt.binding.colorMode ?? 'palette',
      effectiveOffsetMs: getPlayheadOffsetMs(rt.binding.rid) ?? config.offsetMs,
      streamChannelId: rt.streamChannelId,
      value: Number(rt.value.toFixed(3)),
      level: Number(rt.level.toFixed(3)),
      chromaValue: Number(rt.chromaValue.toFixed(3)),
      lastError: rt.lastError,
    })),
    error: lastError,
  };
}
