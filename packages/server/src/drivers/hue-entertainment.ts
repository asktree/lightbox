// Hue Entertainment streaming driver.
//
// Uses DTLS-PSK over UDP 2100 to stream RGB frames to the bridge at ~50Hz.
// Separate from the REST-based HueDriver: the bridge blocks REST writes to
// lights in a streaming group while streaming is active, so this is a
// different mode — you use one or the other, not both.
//
// Frame format (HueStream 2.0):
//   offset  size  content
//   0       9     "HueStream"  (ASCII)
//   9       1     major version  (0x02)
//   10      1     minor version  (0x00)
//   11      1     sequence       (ignored by bridge, 0x00)
//   12      2     reserved       (0x00 0x00)
//   14      1     color space    (0x00 = RGB, 0x01 = XY+brightness)
//   15      1     reserved       (0x00)
//   16      36    entertainment_configuration UUID (ASCII with dashes)
//   52+     7*N   per channel: [channel_id, R_hi,R_lo, G_hi,G_lo, B_hi,B_lo]
//                 (each color is uint16 big-endian, 0-65535)

import { dtls } from 'node-dtls-client';
import https from 'https';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(__dirname, '../../data/hue-config.json');
const STREAM_PORT = 2100;
const DEFAULT_FRAME_HZ = 50;
const CONFIG_NAME_ALL = 'lightbox-stream';
const CONFIG_NAME_SUBSET_PREFIX = 'lightbox-stream-';

interface HueConfig {
  bridgeIp: string;
  username: string;
  clientKey: string; // hex-encoded 16 bytes
}

interface Channel {
  id: number;              // 0-255, bridge-assigned
  lightName: string;
  r: number; g: number; b: number;   // baseline color (uint16 each)
}

// Per-channel effect layered on top of baseline. `flash` is a rectangular
// pulse (full intensity until untilMs); `pulse` has attack + exponential-ish
// decay, so the light hits hard then fades — better feel for onset-driven
// animation than a square flash. `audioPulse` uses the channel's current
// baseline color and scales it by a (floor..peak) envelope — so audio-
// reactive pulses share color with whatever the user set via setChannel/
// setAll and between beats hold at `floor * baseline` instead of reverting.
type Effect =
  | { kind: 'flash'; untilMs: number; r: number; g: number; b: number }
  | { kind: 'pulse'; startMs: number; attackMs: number; decayMs: number; r: number; g: number; b: number }
  | { kind: 'audioPulse'; startMs: number; attackMs: number; decayMs: number; peak: number; floor: number }
  | { kind: 'level'; level: number };  // continuous brightness multiplier against baseline

export class HueEntertainmentDriver {
  private config: HueConfig;
  private socket?: dtls.Socket;
  private entConfigId?: string;
  private configName: string = CONFIG_NAME_ALL;
  private lightNamesFilter: string[] | null = null;
  private groupChannel: boolean = false;
  private channels: Channel[] = [];
  private effects = new Map<number, Effect>();
  private frameTimer?: NodeJS.Timeout;
  private frameHz = DEFAULT_FRAME_HZ;
  private _active = false;
  private connecting = false;

  constructor() {
    if (!existsSync(CONFIG_FILE)) {
      throw new Error(`Hue config not found at ${CONFIG_FILE}. Run the REST driver first to pair.`);
    }
    this.config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    if (!this.config.clientKey) {
      throw new Error('hue-config.json has no clientKey — re-pair the bridge.');
    }
  }

  get active(): boolean { return this._active; }

  getChannels(): Array<{ id: number; lightName: string }> {
    return this.channels.map(c => ({ id: c.id, lightName: c.lightName }));
  }

  // lightNames: optional filter — when provided, uses a dedicated entertainment
  // config containing only lights whose names match (case-insensitive).
  // groupIntoSingleChannel: if true, all selected lights are wired as members
  // of ONE channel, so a single RGB triplet in the UDP frame drives them all
  // via a Zigbee group command (analogous to REST grouped_light but within
  // the streaming protocol). Channel count = 1.
  async start(opts?: { lightNames?: string[] | null; groupIntoSingleChannel?: boolean }): Promise<void> {
    if (this._active || this.connecting) return;
    this.connecting = true;
    this.lightNamesFilter = opts?.lightNames && opts.lightNames.length > 0 ? opts.lightNames : null;
    this.groupChannel = !!opts?.groupIntoSingleChannel;
    // Hue bridge caps metadata.name at 32 chars. Use a short deterministic
    // hash of the (sorted, lowercased) light names + grouping flag so each
    // distinct configuration coexists on the bridge.
    const hashInput = (this.lightNamesFilter?.map(n => n.toLowerCase()).sort().join('|') ?? 'all')
      + (this.groupChannel ? '|grp' : '');
    this.configName = (this.lightNamesFilter || this.groupChannel)
      ? CONFIG_NAME_SUBSET_PREFIX + shortHash(hashInput)
      : CONFIG_NAME_ALL;
    let activated = false;
    try {
      this.entConfigId = await this.ensureEntertainmentConfig();
      await this.clipV2('PUT', `/clip/v2/resource/entertainment_configuration/${this.entConfigId}`, { action: 'start' });
      activated = true;

      // Bridge needs a moment to flip into streaming mode before accepting DTLS.
      await delay(200);

      await this.connectDtls();

      this._active = true;
      this.frameTimer = setInterval(() => this.sendFrame(), Math.round(1000 / this.frameHz));
    } catch (err) {
      // If we got as far as activating the entertainment config but then
      // failed (typically on the DTLS handshake), deactivate on the bridge
      // so subsequent start() attempts aren't blocked by a stuck config.
      if (activated && this.entConfigId) {
        await this.clipV2('PUT', `/clip/v2/resource/entertainment_configuration/${this.entConfigId}`, { action: 'stop' })
          .catch(() => { /* best effort */ });
      }
      if (this.socket) {
        try { this.socket.close(() => {}); } catch { /* ignore */ }
        this.socket = undefined;
      }
      throw err;
    } finally {
      this.connecting = false;
    }
  }

  async stop(): Promise<void> {
    if (!this._active) return;
    this._active = false;
    if (this.frameTimer) { clearInterval(this.frameTimer); this.frameTimer = undefined; }
    this.effects.clear();

    if (this.socket) {
      await new Promise<void>((resolve) => {
        try { this.socket!.close(() => resolve()); } catch { resolve(); }
      });
      this.socket = undefined;
    }

    if (this.entConfigId) {
      await this.clipV2('PUT', `/clip/v2/resource/entertainment_configuration/${this.entConfigId}`, { action: 'stop' })
        .catch(() => { /* bridge often 207s this; ignore */ });
    }
  }

  setChannel(channelId: number, r: number, g: number, b: number): void {
    const ch = this.channels.find(c => c.id === channelId);
    if (!ch) return;
    ch.r = clamp16(r); ch.g = clamp16(g); ch.b = clamp16(b);
  }

  setAll(r: number, g: number, b: number): void {
    const R = clamp16(r), G = clamp16(g), B = clamp16(b);
    for (const ch of this.channels) { ch.r = R; ch.g = G; ch.b = B; }
  }

  flash(channelId: number, r: number, g: number, b: number, durationMs: number): void {
    this.effects.set(channelId, { kind: 'flash', untilMs: Date.now() + durationMs, r: clamp16(r), g: clamp16(g), b: clamp16(b) });
  }

  flashAll(r: number, g: number, b: number, durationMs: number): void {
    const until = Date.now() + durationMs;
    const R = clamp16(r), G = clamp16(g), B = clamp16(b);
    for (const ch of this.channels) this.effects.set(ch.id, { kind: 'flash', untilMs: until, r: R, g: G, b: B });
  }

  pulse(channelId: number, r: number, g: number, b: number, attackMs: number, decayMs: number): void {
    this.effects.set(channelId, {
      kind: 'pulse', startMs: Date.now(),
      attackMs: Math.max(0, attackMs), decayMs: Math.max(1, decayMs),
      r: clamp16(r), g: clamp16(g), b: clamp16(b),
    });
  }

  pulseAll(r: number, g: number, b: number, attackMs: number, decayMs: number): void {
    const now = Date.now();
    const R = clamp16(r), G = clamp16(g), B = clamp16(b);
    const a = Math.max(0, attackMs), d = Math.max(1, decayMs);
    for (const ch of this.channels) {
      this.effects.set(ch.id, { kind: 'pulse', startMs: now, attackMs: a, decayMs: d, r: R, g: G, b: B });
    }
  }

  // peak/floor are 0-1 multipliers of the channel's baseline color. Between
  // pulses the effect holds at `floor * baseline` (doesn't auto-clear).
  audioPulse(channelId: number, peak: number, floor: number, attackMs: number, decayMs: number): void {
    this.effects.set(channelId, {
      kind: 'audioPulse', startMs: Date.now(),
      attackMs: Math.max(0, attackMs), decayMs: Math.max(1, decayMs),
      peak: Math.max(0, Math.min(1, peak)),
      floor: Math.max(0, Math.min(1, floor)),
    });
  }

  clearEffect(channelId: number): void {
    this.effects.delete(channelId);
  }

  // Adjust the UDP frame rate. Takes effect immediately (restarts the timer).
  // Some people report smoother behavior at 25Hz — depends on network/mesh.
  setFrameHz(hz: number): void {
    this.frameHz = Math.max(5, Math.min(100, Math.round(hz)));
    if (this._active && this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = setInterval(() => this.sendFrame(), Math.round(1000 / this.frameHz));
    }
  }
  getFrameHz(): number { return this.frameHz; }

  // Continuous brightness modulator. Every frame: rgb = baseline × level.
  // Designed to be called at the client's frame rate (~60Hz) for smooth
  // energy-tracking (e.g. bass level modulating a bulb's intensity).
  setLevel(channelId: number, level: number): void {
    this.effects.set(channelId, { kind: 'level', level: Math.max(0, Math.min(1, level)) });
  }

  // ---- internals ----

  private async connectDtls(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = dtls.createSocket({
        type: 'udp4',
        address: this.config.bridgeIp,
        port: STREAM_PORT,
        psk: { [this.config.username]: Buffer.from(this.config.clientKey, 'hex') },
        ciphers: ['TLS_PSK_WITH_AES_128_GCM_SHA256'],
        timeout: 5000,
      });

      socket.once('connected', () => { this.socket = socket; resolve(); });
      socket.once('error', (err) => reject(err));
      socket.on('close', () => { if (this._active) this.onSocketClosed(); });
    });
  }

  private onSocketClosed() {
    // Bridge killed the stream. Stop the pump; caller can re-start if desired.
    this._active = false;
    if (this.frameTimer) { clearInterval(this.frameTimer); this.frameTimer = undefined; }
    this.socket = undefined;
    console.log('Hue stream: DTLS closed by bridge');
  }

  private sendFrame() {
    if (!this.socket || !this.entConfigId) return;
    const buf = this.buildFrame();
    try { this.socket.send(buf); } catch (e) { /* swallow — next frame retries */ }
  }

  private buildFrame(): Buffer {
    const n = this.channels.length;
    const buf = Buffer.alloc(52 + 7 * n);
    buf.write('HueStream', 0, 'ascii');
    buf.writeUInt8(0x02, 9);           // major
    buf.writeUInt8(0x00, 10);          // minor
    buf.writeUInt8(0x00, 11);          // sequence (ignored)
    buf.writeUInt16BE(0, 12);          // reserved
    buf.writeUInt8(0x00, 14);          // RGB color space
    buf.writeUInt8(0x00, 15);          // reserved
    buf.write(this.entConfigId!, 16, 36, 'ascii');

    const now = Date.now();
    let off = 52;
    for (const ch of this.channels) {
      let r = ch.r, g = ch.g, b = ch.b;
      const e = this.effects.get(ch.id);
      if (e) {
        if (e.kind === 'flash') {
          if (now <= e.untilMs) { r = e.r; g = e.g; b = e.b; }
          else this.effects.delete(ch.id);
        } else if (e.kind === 'pulse') {
          const age = now - e.startMs;
          const total = e.attackMs + e.decayMs;
          if (age >= total) {
            this.effects.delete(ch.id);
          } else {
            // Linear attack to 1, then exponential decay through decayMs
            // (exp feels more natural than linear for "fades slowly").
            let env: number;
            if (age < e.attackMs) env = e.attackMs === 0 ? 1 : age / e.attackMs;
            else {
              const t = (age - e.attackMs) / e.decayMs;
              env = Math.exp(-3 * t); // e^-3 ≈ 0.05 at t=1 → visually ~done
            }
            r = Math.round(e.r * env);
            g = Math.round(e.g * env);
            b = Math.round(e.b * env);
          }
        } else if (e.kind === 'audioPulse') {
          // audioPulse: factor = floor + (peak - floor) * envelope, where
          // envelope is 0→1 during attack, then exp decay back to ~0 during
          // decay. After decay completes, hold at floor (factor = floor).
          const age = now - e.startMs;
          let envNorm: number;
          if (age < e.attackMs) {
            envNorm = e.attackMs === 0 ? 1 : age / e.attackMs;
          } else {
            const t = (age - e.attackMs) / e.decayMs;
            envNorm = t >= 1 ? 0 : Math.exp(-3 * t);
          }
          const factor = e.floor + (e.peak - e.floor) * envNorm;
          r = Math.round(ch.r * factor);
          g = Math.round(ch.g * factor);
          b = Math.round(ch.b * factor);
        } else {
          // level: continuous multiplier. Client sends updates at ~60Hz.
          r = Math.round(ch.r * e.level);
          g = Math.round(ch.g * e.level);
          b = Math.round(ch.b * e.level);
        }
      }
      buf.writeUInt8(ch.id, off);
      buf.writeUInt16BE(r, off + 1);
      buf.writeUInt16BE(g, off + 3);
      buf.writeUInt16BE(b, off + 5);
      off += 7;
    }
    return buf;
  }

  // Look up an existing entertainment_configuration by name, or create one
  // spanning (all entertainment-capable lights) or (lights matching the
  // lightNamesFilter).
  private async ensureEntertainmentConfig(): Promise<string> {
    const list = await this.clipV2('GET', '/clip/v2/resource/entertainment_configuration') as any;
    const existing = (list.data || []).find((c: any) => c?.metadata?.name === this.configName);
    if (existing) {
      await this.loadChannels(existing);
      return existing.id;
    }

    const [entRes, devRes] = await Promise.all([
      this.clipV2('GET', '/clip/v2/resource/entertainment'),
      this.clipV2('GET', '/clip/v2/resource/device'),
    ]) as any[];
    const services: any[] = (entRes.data || []).filter((e: any) => e.renderer);
    const deviceName = new Map<string, string>();
    for (const d of devRes.data || []) deviceName.set(d.id, d?.metadata?.name || 'device');

    let picked = services;
    if (this.lightNamesFilter) {
      const wanted = new Set(this.lightNamesFilter.map(n => n.toLowerCase()));
      picked = services.filter((s: any) => {
        const devId = s.owner?.rid;
        const name = devId ? (deviceName.get(devId) ?? '') : '';
        return wanted.has(name.toLowerCase());
      });
    }
    if (picked.length === 0) {
      const want = this.lightNamesFilter ? ` matching ${this.lightNamesFilter.join(', ')}` : '';
      throw new Error(`No entertainment-capable lights found${want}.`);
    }

    const n = picked.length;
    const service_locations = picked.map((s, i) => ({
      service: { rid: s.id, rtype: 'entertainment' },
      positions: [{
        x: this.groupChannel ? 0 : (n === 1 ? 0 : -1 + (2 * i) / (n - 1)),
        y: 0,
        z: 0,
      }],
    }));

    // Bridge auto-generates channels from service_locations on POST — it
    // rejects an explicit channels[] property. For groupChannel we collapse
    // all services onto position (0,0,0); the bridge emits one channel with
    // all services as members.
    const body: any = {
      type: 'entertainment_configuration',
      metadata: { name: this.configName },
      configuration_type: 'other',
      locations: { service_locations },
    };
    const created = await this.clipV2('POST', '/clip/v2/resource/entertainment_configuration', body) as any;
    const id: string = created.data?.[0]?.rid;
    if (!id) throw new Error(`Create failed: ${JSON.stringify(created)}`);

    const fetched = await this.clipV2('GET', `/clip/v2/resource/entertainment_configuration/${id}`) as any;
    await this.loadChannels(fetched.data?.[0]);
    return id;
  }

  private async loadChannels(entConfig: any): Promise<void> {
    const rawChannels: any[] = entConfig?.channels || [];

    // Build entertainment-service rid → light name via device owner.
    const [entRes, devRes] = await Promise.all([
      this.clipV2('GET', '/clip/v2/resource/entertainment'),
      this.clipV2('GET', '/clip/v2/resource/device'),
    ]) as any[];
    const deviceName = new Map<string, string>();
    for (const d of devRes.data || []) deviceName.set(d.id, d?.metadata?.name || 'device');
    const entToDevice = new Map<string, string>();
    for (const e of entRes.data || []) entToDevice.set(e.id, e?.owner?.rid || '');

    // Initialize channels to full white so audio-reactive pulses (which
    // multiply baseline × envelope factor) have a visible color out of the
    // gate. User can override from the Stream test page.
    this.channels = rawChannels.map((ch) => {
      const firstMember = ch.members?.[0]?.service?.rid;
      const devId = firstMember ? entToDevice.get(firstMember) : undefined;
      const name = devId ? (deviceName.get(devId) ?? `Channel ${ch.channel_id}`) : `Channel ${ch.channel_id}`;
      return { id: ch.channel_id, lightName: name, r: 65535, g: 65535, b: 65535 };
    });
  }

  private clipV2(method: 'GET' | 'POST' | 'PUT', path: string, body?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const payload = body ? Buffer.from(JSON.stringify(body)) : undefined;
      const req = https.request({
        hostname: this.config.bridgeIp,
        path,
        method,
        headers: {
          'hue-application-key': this.config.username,
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': payload.length } : {}),
        },
        rejectUnauthorized: false,
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const json = data ? JSON.parse(data) : {};
            if ((res.statusCode ?? 0) >= 400) {
              reject(new Error(`${method} ${path} → ${res.statusCode}: ${data.slice(0, 300)}`));
            } else {
              resolve(json);
            }
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
}

// Shared singleton — the bridge only allows one active entertainment stream,
// so every in-process consumer (hue-stream routes, audio-sync service) must
// drive the same driver instance. Lazily constructed so a missing hue-config
// doesn't break server startup.
let sharedDriver: HueEntertainmentDriver | null = null;
export function getSharedEntertainmentDriver(): HueEntertainmentDriver {
  if (!sharedDriver) sharedDriver = new HueEntertainmentDriver();
  return sharedDriver;
}

function clamp16(v: number): number {
  return Math.max(0, Math.min(65535, Math.round(v)));
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// djb2 hash → 8 hex chars. Stable across runs; short enough to fit the
// bridge's 32-char name limit when prefixed with CONFIG_NAME_SUBSET_PREFIX.
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}
