// REST-based faded pulse for Hue. Two packets per light per pulse:
//   1. PUT on/color/brightness with duration 0  → snap to peak
//   2. PUT on=false with duration=decayMs       → bulb fades itself to off
//
// The bulb firmware handles the fade curve internally, so bridge throughput
// is orders of magnitude lower than entertainment streaming (~2 requests per
// pulse vs ~25-50 frames). Only usable when the entertainment stream is NOT
// active — the bridge ignores REST for lights in an active entertainment
// configuration.

import https from 'https';
import { EventEmitter } from 'events';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { DebugLogEntry } from '@lightbox/shared';

// Emits DebugLogEntry objects so the server can broadcast them over WS,
// just like the REST HueDriver does. Used to instrument timing of the two
// PUTs that make up a REST pulse.
export const hueRestPulseEvents = new EventEmitter();
let logSeq = 0;
function emitLog(device: string, message: string): void {
  const entry: DebugLogEntry = {
    id: `hue-rest-${++logSeq}`,
    timestamp: Date.now(),
    brand: 'hue',
    device,
    message,
    direction: 'out',
  };
  hueRestPulseEvents.emit('debug', entry);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(__dirname, '../../data/hue-config.json');

interface HueConfig { bridgeIp: string; username: string }

let cachedConfig: HueConfig | null = null;
function cfg(): HueConfig {
  if (!cachedConfig) {
    if (!existsSync(CONFIG_FILE)) throw new Error(`Hue config not found at ${CONFIG_FILE}`);
    cachedConfig = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  }
  return cachedConfig!;
}

// Global agent — used for non-target-specific calls (GET lights list,
// POST zone, etc). maxSockets is the slider knob.
const agent = new https.Agent({ keepAlive: true, maxSockets: 1, rejectUnauthorized: false });
export function setRestMaxSockets(n: number): void {
  agent.maxSockets = Math.max(1, Math.min(16, Math.round(n)));
}
export function getRestMaxSockets(): number {
  return agent.maxSockets;
}

// Per-target agents: each target (one light's path, or one group's path)
// gets its own agent with maxSockets:1. This guarantees strict 1:1
// socket↔target pinning — all PUTs to light A travel on socket A, all
// PUTs to light B on socket B. Different from the shared agent LIFO
// policy, which swaps sockets opportunistically.
const agentsByTarget = new Map<string, https.Agent>();

// Running EMA of end-to-end pulse times (attack + decay PUT pair). Captures
// "how long from restFadedPulse() to response" — i.e., bridge RTT as seen
// from our server. Source-agnostic: updated by every caller (musicbox rAF,
// autopilot, manual curl). EMA alpha=0.3 balances responsiveness vs. noise.
let bridgeRttMsEma: number | null = null;
const BRIDGE_RTT_EMA_ALPHA = 0.3;
export function getBridgeRttMs(): number | null {
  return bridgeRttMsEma;
}
function recordBridgeRtt(ms: number): void {
  bridgeRttMsEma = bridgeRttMsEma === null
    ? ms
    : (1 - BRIDGE_RTT_EMA_ALPHA) * bridgeRttMsEma + BRIDGE_RTT_EMA_ALPHA * ms;
}
function getTargetAgent(key: string): https.Agent {
  let a = agentsByTarget.get(key);
  if (!a) {
    a = new https.Agent({ keepAlive: true, maxSockets: 1, rejectUnauthorized: false });
    agentsByTarget.set(key, a);
  }
  return a;
}

// Per-target promise chain. Ensures that two PUTs to the same target (one
// light rid, or one grouped_light rid) are never interleaved, even if the
// agent has spare sockets. Different targets are independent, so they can
// run in parallel up to maxSockets.
const pendingByTarget = new Map<string, Promise<unknown>>();
function runSerially<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = pendingByTarget.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn); // swallow prior rejection so our fn still runs
  pendingByTarget.set(key, next);
  next.finally(() => {
    if (pendingByTarget.get(key) === next) pendingByTarget.delete(key);
  });
  return next;
}

// Captures the local port that the agent assigned to this request. Used by
// restFadedPulse to log "which socket served this PUT" so we can verify
// whether LIFO keep-alive really pins each target to its own socket.
export const lastPortByTarget = new Map<string, number>();
let currentTarget: string | null = null;
function clipV2(method: 'GET' | 'PUT' | 'POST', path: string, body?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : undefined;
    // Use the per-target agent when a target is set (i.e., inside a pulse),
    // otherwise the shared global agent. Target agents are maxSockets:1 →
    // one TCP connection per light, pinned for this process's lifetime.
    const reqAgent = currentTarget ? getTargetAgent(currentTarget) : agent;
    const req = https.request({
      hostname: cfg().bridgeIp,
      path,
      method,
      agent: reqAgent,
      headers: {
        'hue-application-key': cfg().username,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': payload.length } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`${method} ${path} → ${res.statusCode}: ${data.slice(0, 200)}`));
          } else resolve(json);
        } catch (e) { reject(e); }
      });
    });
    // Fires as soon as the agent assigns a socket. Capture localPort against
    // the caller-provided "target" key (set via withTarget below).
    req.on('socket', (sock: any) => {
      const key = currentTarget;
      const captured = () => {
        if (key && typeof sock.localPort === 'number') lastPortByTarget.set(key, sock.localPort);
      };
      if (sock.localPort) captured();
      else sock.once('connect', captured);
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Run fn with a thread-local-ish target tag so clipV2 can associate the
// assigned socket's localPort with that target. Nested targets aren't
// supported — but our pulses are linear (attack → decay) so it's fine.
async function withTarget<T>(target: string, fn: () => Promise<T>): Promise<T> {
  const prev = currentTarget;
  currentTarget = target;
  try { return await fn(); } finally { currentTarget = prev; }
}

// Find the grouped_light that represents all-lights-on-this-bridge. PUTting
// to this single resource updates every light in one round-trip instead of
// N sequential per-light PUTs (which the bridge rate-limits to ~10/sec).
let cachedBridgeGroupRid: string | null = null;
async function getBridgeGroupRid(): Promise<string> {
  if (cachedBridgeGroupRid) return cachedBridgeGroupRid;
  const res = await clipV2('GET', '/clip/v2/resource/grouped_light') as any;
  const bridgeGroup = (res.data || []).find((g: any) => g?.owner?.rtype === 'bridge_home');
  if (!bridgeGroup) throw new Error('No bridge_home grouped_light found');
  cachedBridgeGroupRid = bridgeGroup.id;
  return cachedBridgeGroupRid!;
}

// Color-capable lights with friendly names. Used for per-light pulse UI.
// - rid: CLIP v2 UUID; what the REST pulse PUT targets
// - lmId: the LightManager-format ID ("hue:<v1>") used everywhere else in
//   lightbox (palette positions, room config, light-manager events). The
//   two ID systems coexist for legacy reasons; translating here avoids
//   leaking the distinction to every caller.
export interface RestLight { rid: string; lmId: string; name: string }
let cachedRestLights: RestLight[] | null = null;
export async function getRestLights(): Promise<RestLight[]> {
  if (cachedRestLights) return cachedRestLights;
  const [lightsRes, devicesRes] = await Promise.all([
    clipV2('GET', '/clip/v2/resource/light') as Promise<any>,
    clipV2('GET', '/clip/v2/resource/device') as Promise<any>,
  ]);
  const deviceName = new Map<string, string>();
  for (const d of devicesRes.data || []) {
    if (d?.id && d?.metadata?.name) deviceName.set(d.id, d.metadata.name);
  }
  cachedRestLights = (lightsRes.data || [])
    .filter((l: any) => l?.color)
    .map((l: any) => {
      // id_v1 looks like "/lights/7" — extract "7".
      const v1 = typeof l.id_v1 === 'string' ? l.id_v1.replace('/lights/', '') : '';
      return {
        rid: l.id,
        lmId: v1 ? `hue:${v1}` : `hue:${l.id}`, // fallback shouldn't normally happen
        name: deviceName.get(l.owner?.rid) || l.metadata?.name || l.id.slice(0, 8),
      };
    });
  return cachedRestLights!;
}

// rid → LightManager id. For translating incoming pulse-claim ids (which
// come from musicbox as raw rids) into the palette-animator's key space.
export async function ridToLmId(rid: string): Promise<string | null> {
  const lights = await getRestLights();
  return lights.find(l => l.rid === rid)?.lmId ?? null;
}

// --- Pre-bind snapshot helpers for "restore on unbind" behavior. ---

export interface LightSnapshot { brightness: number; on: boolean }

export async function getLightSnapshot(rid: string): Promise<LightSnapshot | null> {
  try {
    const res = await clipV2('GET', `/clip/v2/resource/light/${rid}`) as any;
    const l = res?.data?.[0];
    if (!l) return null;
    return {
      brightness: typeof l.dimming?.brightness === 'number' ? l.dimming.brightness : 100,
      on: l.on?.on ?? true,
    };
  } catch {
    return null;
  }
}

export async function restoreLightSnapshot(rid: string, snap: LightSnapshot, durationMs = 400): Promise<void> {
  // Smooth restore over durationMs so it feels natural rather than a hard jump.
  await clipV2('PUT', `/clip/v2/resource/light/${rid}`, {
    on: { on: snap.on },
    dimming: { brightness: snap.brightness },
    dynamics: { duration: Math.max(1, Math.round(durationMs)) },
  });
}

// Pre-defined "music" zone — a bridge zone containing a known subset of
// lights, so we can coalesce same-frame fires for those bulbs into a single
// grouped_light PUT (half the request count, avoids serialization tax).
// Ensures the zone exists on first call, creating it if missing.
const MUSIC_GROUP_NAME = 'lightbox-music';
const MUSIC_GROUP_LIGHT_NAMES = ['couch light actual', 'hue iris 1'];
let cachedMusicGroupRid: string | null = null;
export async function getMusicGroupRid(): Promise<string> {
  if (cachedMusicGroupRid) return cachedMusicGroupRid;
  const zones = await clipV2('GET', '/clip/v2/resource/zone') as any;
  const existing = (zones.data || []).find((z: any) => z?.metadata?.name === MUSIC_GROUP_NAME);
  if (existing) {
    const gl = (existing.services || []).find((s: any) => s.rtype === 'grouped_light');
    if (gl) { cachedMusicGroupRid = gl.rid; return cachedMusicGroupRid!; }
  }
  const lights = await getRestLights();
  const wanted = new Set(MUSIC_GROUP_LIGHT_NAMES.map(n => n.toLowerCase()));
  const members = lights.filter(l => wanted.has(l.name.toLowerCase())).map(l => ({ rid: l.rid, rtype: 'light' }));
  if (members.length === 0) {
    throw new Error(`No lights match music group: ${MUSIC_GROUP_LIGHT_NAMES.join(', ')}`);
  }
  const created = await clipV2('POST', '/clip/v2/resource/zone', {
    type: 'zone',
    metadata: { name: MUSIC_GROUP_NAME, archetype: 'music' },
    children: members,
  }) as any;
  const zoneRid: string | undefined = created.data?.[0]?.rid;
  if (!zoneRid) throw new Error(`Zone create failed: ${JSON.stringify(created).slice(0, 300)}`);
  const fetched = await clipV2('GET', `/clip/v2/resource/zone/${zoneRid}`) as any;
  const gl = (fetched.data?.[0]?.services || []).find((s: any) => s.rtype === 'grouped_light');
  if (!gl) throw new Error('Created zone has no grouped_light service');
  cachedMusicGroupRid = gl.rid;
  return cachedMusicGroupRid!;
}

export function getMusicGroupLightNames(): string[] {
  return [...MUSIC_GROUP_LIGHT_NAMES];
}

// sRGB (0-1 each) → CIE xy. Good enough for testing; proper gamut clipping
// per bulb model would be more accurate but visually very similar.
function rgbToXy(r: number, g: number, b: number): { x: number; y: number } {
  const lin = (c: number) => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const R = lin(r), G = lin(g), B = lin(b);
  const X = R * 0.649926 + G * 0.103455 + B * 0.197109;
  const Y = R * 0.234327 + G * 0.743075 + B * 0.022598;
  const Z = G * 0.053077 + B * 1.035763;
  const sum = X + Y + Z;
  return sum > 0 ? { x: X / sum, y: Y / sum } : { x: 0.3, y: 0.3 };
}

export interface RestPulseOpts {
  // r/g/b in 0-65535. If omitted (undefined), the attack PUT skips color —
  // the bulb flashes at whatever color it already was. Useful for rhythmic
  // pulsing when the user has already picked a color elsewhere.
  r?: number; g?: number; b?: number;
  // attack peak brightness (1-100)
  peak: number;
  // decay target brightness (1-100). Lower = more dramatic pulse. Defaults
  // to 1 which keeps the bulb "on" so the next pulse avoids off→on startup.
  floor?: number;
  decayMs: number;
  lightId?: string;
  // Target a specific grouped_light by rid (e.g. the music zone). Overrides
  // lightId. Without either, falls back to the bridge_home group.
  groupRid?: string;
}

export async function restFadedPulse(opts: RestPulseOpts): Promise<void> {
  const { r, g, b, peak, floor = 1, decayMs, lightId, groupRid } = opts;
  let target: { path: string; label: string };
  if (groupRid) {
    target = { path: `/clip/v2/resource/grouped_light/${groupRid}`, label: 'group' };
  } else if (lightId) {
    target = { path: `/clip/v2/resource/light/${lightId}`, label: lightId.slice(0, 8) };
  } else {
    target = { path: `/clip/v2/resource/grouped_light/${await getBridgeGroupRid()}`, label: 'bridge-home' };
  }
  const bri = Math.max(1, Math.min(100, peak));
  const floorBri = Math.max(1, Math.min(100, floor));
  const dur = Math.max(1, Math.round(decayMs));

  // Resolve friendly name for single-light case if we have it cached.
  let label = target.label;
  if (lightId && cachedRestLights) {
    const l = cachedRestLights.find((x) => x.rid === lightId);
    if (l) label = l.name;
  }

  const attackBody: any = {
    on: { on: true },
    dimming: { brightness: bri },
    dynamics: { duration: 0 },
  };
  if (typeof r === 'number' && typeof g === 'number' && typeof b === 'number') {
    attackBody.color = { xy: rgbToXy(r / 65535, g / 65535, b / 65535) };
  }

  const kind = groupRid ? 'GROUP' : lightId ? 'SINGLE' : 'BRIDGE-HOME';
  const t0 = Date.now();
  // Serialize the attack+decay pair for this target. runSerially guarantees
  // order even if maxSockets > 1 lets different targets run in parallel.
  await runSerially(target.path, async () => {
    try {
      const a0 = Date.now();
      await withTarget(target.path, () => clipV2('PUT', target.path, attackBody));
      const a1 = Date.now();
      await withTarget(target.path, () => clipV2('PUT', target.path, {
        dimming: { brightness: floorBri },
        dynamics: { duration: dur },
      }));
      const a2 = Date.now();
      const port = lastPortByTarget.get(target.path);
      emitLog(label, `pulse: attack ${a1 - a0}ms, decay put ${a2 - a1}ms`);
      console.log(`[hue-rest-pulse] ${kind} ${label}  attack=${a1 - a0}ms decay-put=${a2 - a1}ms total=${a2 - t0}ms localPort=${port ?? '?'}`);
      // Contribute to the global bridge-RTT EMA. All callers (musicbox rAF,
      // autopilot, manual) feed this so the UI's single readout reflects
      // real pulse throughput regardless of source.
      recordBridgeRtt(a2 - t0);
    } catch (e) {
      emitLog(label, `pulse error: ${e}`);
      console.log(`[hue-rest-pulse] ${kind} ${label}  ERROR ${e}`);
    }
  });
  emitLog('REST pulse', `${lightId ? 'single' : 'group'} pulse in ${Date.now() - t0}ms`);
}
