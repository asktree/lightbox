// Latency calibration — active measurement of the real sync offsets using
// the machine's mic and webcam as an external observer.
//
// Two measurements, one registry:
//   audio: schedule->ear latency of the default output device, measured by
//     playing a click train and mic-detecting the true arrivals (ground
//     truth; the CoreAudio self-report is captured alongside for comparison).
//   light: command->photon latency per light, measured by flashing the light
//     over the entertainment stream at randomized times while the webcam
//     watches. Rising-edge times minus send times, median over ~10 pulses.
//
// Results persist in data/latency-registry.json. This registry is the data
// source for the upcoming per-light playhead service: effective playhead for
// a light = pos + lightLatency − audioLatency.

import { spawn, type ChildProcess } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getRestLights } from '../drivers/hue-rest-pulse.js';
import { getSharedEntertainmentDriver } from '../drivers/hue-entertainment.js';
import { resumeStemSync, setStemSyncSuspended, stopStemSync } from './stem-sync.js';
import type { PaletteAnimator } from '../lib/palette-animator.js';

// Palette animation REST-writes to lights it owns; the measured light must
// sit still (dark) between flashes, so it's excluded for the duration.
let paletteAnimator: PaletteAnimator | null = null;
export function setLatencyCalPaletteAnimator(pa: PaletteAnimator): void {
  paletteAnimator = pa;
}
function setPaletteExcluded(lmId: string, excluded: boolean): void {
  if (!paletteAnimator) return;
  for (const rs of paletteAnimator.getAllRoomStates()) {
    paletteAnimator.setLightExcluded(rs.roomId, lmId, excluded);
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../../..');
const SCRAPER_DIR = join(REPO_ROOT, 'packages/music-scraper');
const VENV_PYTHON = join(SCRAPER_DIR, '.venv/bin/python');
const REGISTRY_FILE = join(__dirname, '../../data/latency-registry.json');

const PULSES = 10;
const PULSE_ON_MS = 250;
const VIDEO_DURATION_S = 16;

export interface LightLatencyEntry {
  name: string;
  latencyMs: number;
  jitterMs: number;       // IQR across pulses
  samples: number[];      // per-pulse ms, for eyeballing distribution
  measuredAt: number;
  source: 'measured' | 'manual';
}

export interface LatencyRegistry {
  audio: {
    latencyMs: number;
    jitterMs: number;
    coreAudioReportedMs: number | null;
    outputDeviceName: string | null;
    measuredAt: number;
  } | null;
  lights: Record<string, LightLatencyEntry>;  // keyed by CLIP v2 rid
}

let registry: LatencyRegistry = { audio: null, lights: {} };
try {
  if (existsSync(REGISTRY_FILE)) {
    const raw = JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'));
    if (raw && typeof raw === 'object') registry = { audio: raw.audio ?? null, lights: raw.lights ?? {} };
  }
} catch (e) {
  console.log('[latency-cal] registry load failed:', e);
}

function persist(): void {
  try {
    writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
  } catch (e) {
    console.log('[latency-cal] persist failed:', e);
  }
}

export function getLatencyRegistry(): LatencyRegistry {
  return registry;
}

// The per-light playhead correction, in ms of playhead to subtract: a light
// rendering pos − offset shows photons that coincide with what the ear hears.
// Positive when audio is slower than the light (the usual case). Null until
// both sides have been measured — callers fall back to their own default.
export function getPlayheadOffsetMs(rid: string): number | null {
  const a = registry.audio;
  const l = registry.lights[rid];
  if (!a || !l) return null;
  return Math.round(a.latencyMs - l.latencyMs);
}

export function setManualLightLatency(rid: string, name: string, latencyMs: number): void {
  registry.lights[rid] = {
    name, latencyMs, jitterMs: 0, samples: [], measuredAt: Date.now(), source: 'manual',
  };
  persist();
}

// ---- probe daemon (preferred) ----
// The dev server usually runs over SSH, where macOS TCC silently denies mic
// and camera. The probe daemon is a LaunchAgent in the GUI session
// (scraper/probe_daemon.py) that has the actual permission; we call it over
// localhost and fall back to direct spawn only if it isn't running.

const PROBE_DAEMON = 'http://127.0.0.1:3009';

async function daemonFetch(path: string, init: RequestInit = {}, timeoutMs = 30000): Promise<Record<string, unknown>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${PROBE_DAEMON}${path}`, { ...init, signal: ctl.signal });
    return (await res.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

async function daemonAvailable(): Promise<boolean> {
  try {
    const h = await daemonFetch('/health', {}, 1500);
    return h.ok === true;
  } catch {
    return false;
  }
}

// ---- probe process plumbing (fallback when the daemon is down) ----

interface ProbeHandle {
  child: ChildProcess;
  ready: Promise<void>;       // resolves when the probe prints READY (video mode)
  result: Promise<Record<string, unknown>>;  // resolves with the final JSON line
}

function spawnProbe(args: string[]): ProbeHandle {
  const child = spawn(VENV_PYTHON, ['-m', 'scraper.latency_probe', ...args], { cwd: SCRAPER_DIR });
  let stdout = '';
  let stderr = '';
  let readyResolve: () => void;
  const ready = new Promise<void>((res) => { readyResolve = res; });
  child.stdout!.on('data', (b: Buffer) => {
    stdout += b.toString();
    if (stdout.includes('READY')) readyResolve();
  });
  child.stderr!.on('data', (b: Buffer) => { stderr += b.toString(); });
  const result = new Promise<Record<string, unknown>>((resolve) => {
    child.on('close', () => {
      const lines = stdout.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try { resolve(JSON.parse(lines[i])); return; } catch { /* not the JSON line */ }
      }
      resolve({ ok: false, error: `probe produced no JSON. stderr: ${stderr.trim().slice(-400)}` });
    });
    child.on('error', (err) => resolve({ ok: false, error: `probe spawn failed: ${err.message}` }));
  });
  return { child, ready, result };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const iqr = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length * 0.75)] - s[Math.floor(s.length * 0.25)];
};

// ---- audio calibration ----

let audioRunning = false;

export async function calibrateAudio(): Promise<Record<string, unknown>> {
  if (audioRunning) return { ok: false, error: 'audio calibration already running' };
  audioRunning = true;
  try {
    let res: Record<string, unknown>;
    if (await daemonAvailable()) {
      res = await daemonFetch('/audio', { method: 'POST' }, 40000)
        .catch((e) => ({ ok: false, error: `probe daemon: ${e}` }));
    } else {
      res = await spawnProbe(['audio']).result;
    }
    if (res.ok) {
      registry.audio = {
        latencyMs: res.audio_latency_ms as number,
        jitterMs: (res.jitter_ms as number) ?? 0,
        coreAudioReportedMs: (res.coreaudio_reported_ms as number | null) ?? null,
        outputDeviceName: (res.output_device_name as string | null) ?? null,
        measuredAt: Date.now(),
      };
      persist();
    }
    return res;
  } finally {
    audioRunning = false;
  }
}

// ---- passive audio calibration ----
// Measures the playhead→ear latency of the actual Spotify chain by GCC-PHAT
// correlating a room-mic capture against the pre-ingested track audio at the
// autopilot's reported position. No test tones — runs while music plays, and
// measures the exact reference the light engines sync against.

const AUTOPILOT_STATE = join(__dirname, '../../data/state/lightbox-autopilot.json');
const LIBRARY_TRACKS = join(process.env.HOME ?? '', 'music-library/tracks');

export async function calibrateAudioPassive(): Promise<Record<string, unknown>> {
  if (audioRunning) return { ok: false, error: 'audio calibration already running' };
  audioRunning = true;
  try {
    let state: { track_id?: string; position_s?: number; updated_at?: number; playing?: boolean };
    try {
      state = JSON.parse(readFileSync(AUTOPILOT_STATE, 'utf-8'));
    } catch {
      return { ok: false, error: 'no autopilot state — is music playing via autopilot?' };
    }
    const age = Date.now() / 1000 - (state.updated_at ?? 0);
    if (!state.track_id || !state.playing || age > 5) {
      return { ok: false, error: `autopilot not playing (age ${age.toFixed(1)}s)` };
    }
    const audioPath = join(LIBRARY_TRACKS, state.track_id, 'audio.ogg');
    if (!existsSync(audioPath)) {
      return { ok: false, error: `track audio not on disk yet: ${audioPath}` };
    }
    if (!(await daemonAvailable())) {
      return { ok: false, error: 'probe daemon not reachable — passive mode needs it (mic access)' };
    }
    const res = await daemonFetch('/passive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audio_path: audioPath,
        ref_pos_s: state.position_s,
        ref_wall_t: state.updated_at,
        record_s: 10,
      }),
    }, 40000).catch((e) => ({ ok: false, error: `probe daemon: ${e}` } as Record<string, unknown>));
    if (res.ok) {
      registry.audio = {
        latencyMs: res.audio_latency_ms as number,
        jitterMs: registry.audio?.jitterMs ?? 0,
        coreAudioReportedMs: (res.coreaudio_reported_ms as number | null) ?? null,
        outputDeviceName: (res.output_device_name as string | null) ?? registry.audio?.outputDeviceName ?? null,
        measuredAt: Date.now(),
      };
      persist();
    }
    return res;
  } finally {
    audioRunning = false;
  }
}

// ---- light calibration ----

let lightRunning: string | null = null;

export function getCalibrationStatus() {
  return { audioRunning, lightRunning, registry };
}

export async function calibrateLight(rid: string): Promise<Record<string, unknown>> {
  if (lightRunning) return { ok: false, error: `light calibration already running for ${lightRunning}` };
  lightRunning = rid;
  // stem-sync's tick overwrites stream effects on its bound channels every
  // 33ms, and its boot-time resume loop can race a calibration started
  // right after a server restart. Suspend blocks every start attempt for
  // the duration; resumeStemSync afterwards re-reads the persisted active
  // flag (kept true by persistOff:false) and brings it back with retries.
  setStemSyncSuspended(true);
  try {
    await stopStemSync({ persistOff: false });
    return await calibrateLightInner(rid);
  } finally {
    lightRunning = null;
    setStemSyncSuspended(false);
    resumeStemSync();
  }
}

async function calibrateLightInner(rid: string): Promise<Record<string, unknown>> {
  const lights = await getRestLights();
  const light = lights.find((l) => l.rid === rid);
  if (!light) return { ok: false, error: `no Hue light with rid ${rid}` };

  setPaletteExcluded(light.lmId, true);
  try {
    return await runLightMeasurement(light);
  } finally {
    setPaletteExcluded(light.lmId, false);
  }
}

async function runLightMeasurement(light: { rid: string; lmId: string; name: string }): Promise<Record<string, unknown>> {
  const rid = light.rid;
  const driver = getSharedEntertainmentDriver();
  let startedStream = false;
  if (!driver.active) {
    try {
      await driver.start({ lightNames: [light.name] });
      startedStream = true;
    } catch (e) {
      return { ok: false, error: `entertainment stream start failed: ${e}` };
    }
  }
  const ch = driver.getChannels().find(
    (c) => c.lightName.trim().toLowerCase() === light.name.trim().toLowerCase(),
  );
  if (ch === undefined) {
    if (startedStream) await driver.stop().catch(() => { /* best effort */ });
    return { ok: false, error: `"${light.name}" not in the active entertainment stream — stop stem-sync or calibrate a streamed light` };
  }

  // Start the camera and wait until frames are flowing before flashing.
  let probeResult: () => Promise<Record<string, unknown>>;
  if (await daemonAvailable()) {
    try {
      const started = await daemonFetch('/video/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration: VIDEO_DURATION_S }),
      }, 20000);
      if (!started.ok) {
        if (startedStream) await driver.stop().catch(() => { /* best effort */ });
        return started;
      }
    } catch (e) {
      if (startedStream) await driver.stop().catch(() => { /* best effort */ });
      return { ok: false, error: `probe daemon: ${e}` };
    }
    probeResult = () => daemonFetch('/video/result', {}, VIDEO_DURATION_S * 1000 + 20000)
      .catch((e) => ({ ok: false, error: `probe daemon: ${e}` }));
  } else {
    const probe = spawnProbe(['video', '--duration', String(VIDEO_DURATION_S)]);
    const readyTimeout = sleep(15000).then(() => { throw new Error('probe never printed READY (camera permission?)'); });
    try {
      await Promise.race([probe.ready, readyTimeout]);
    } catch (e) {
      probe.child.kill();
      if (startedStream) await driver.stop().catch(() => { /* best effort */ });
      return { ok: false, error: String(e instanceof Error ? e.message : e) };
    }
    probeResult = () => probe.result;
  }

  // Dark baseline so pulses have contrast regardless of the light's prior
  // state, and a beat of settling time for camera auto-exposure.
  driver.flash(ch.id, 0, 0, 0, 60000);
  await sleep(1500);

  const sendTimes: number[] = [];
  for (let i = 0; i < PULSES; i++) {
    sendTimes.push(Date.now());
    driver.flash(ch.id, 0xffff, 0xffff, 0xffff, PULSE_ON_MS);
    await sleep(PULSE_ON_MS);
    driver.flash(ch.id, 0, 0, 0, 60000);
    await sleep(500 + Math.random() * 500);
  }

  const res = await probeResult();
  // Raw capture dump for offline debugging of edge detection.
  try {
    writeFileSync(join(__dirname, '../../data/state/latency-cal-last-video.json'),
      JSON.stringify({ sendTimes, ...res }));
  } catch { /* diagnostic only */ }
  driver.clearEffect(ch.id);
  if (startedStream) await driver.stop().catch(() => { /* best effort */ });

  if (!res.ok) return res;
  const edges = ((res.edges as number[]) ?? []).map((t) => t * 1000); // s → ms epoch

  // Consensus-lag match: one true latency shifts every pulse by the same
  // amount, so scan candidate lags and score by how many pulses have an edge
  // within ±120ms of sent+lag. The randomized inter-pulse gaps make the true
  // lag the unique high scorer; stray edges (room light changes, residual
  // AGC) can't form a consistent alignment.
  let bestLag = 0;
  let bestScore = -1;
  for (let lag = 0; lag <= 2000; lag += 10) {
    let score = 0;
    for (const sent of sendTimes) {
      if (edges.some((e) => Math.abs(e - sent - lag) <= 120)) score++;
    }
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  const used = new Set<number>();
  const perPulse: number[] = [];
  for (const sent of sendTimes) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < edges.length; i++) {
      if (used.has(i)) continue;
      const dist = Math.abs(edges[i] - sent - bestLag);
      if (dist <= 120 && dist < bestDist) { bestDist = dist; bestIdx = i; }
    }
    if (bestIdx >= 0) {
      used.add(bestIdx);
      perPulse.push(edges[bestIdx] - sent);
    }
  }

  if (perPulse.length < PULSES * 0.6) {
    return {
      ok: false,
      error: `only ${perPulse.length}/${PULSES} pulses seen on camera (${edges.length} edges detected) — is "${light.name}" in frame?`,
      fps: res.fps,
      brightnessRange: [res.brightness_lo, res.brightness_hi],
    };
  }

  const latencyMs = Math.round(median(perPulse));
  const jitterMs = Math.round(iqr(perPulse));
  registry.lights[rid] = {
    name: light.name,
    latencyMs,
    jitterMs,
    samples: perPulse.map((x) => Math.round(x)),
    measuredAt: Date.now(),
    source: 'measured',
  };
  persist();
  console.log(`[latency-cal] ${light.name}: ${latencyMs}ms (IQR ${jitterMs}ms, ${perPulse.length}/${PULSES} pulses)`);
  return {
    ok: true,
    rid,
    name: light.name,
    latencyMs,
    jitterMs,
    matched: perPulse.length,
    pulses: PULSES,
    samples: perPulse.map((x) => Math.round(x)),
    fps: res.fps,
  };
}
