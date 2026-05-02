import { createSocket, Socket, RemoteInfo } from 'dgram';
import type { Light, LightState, LightDriver, Brand, Capability } from '@lightbox/shared';

// Philips WiZ LAN driver. JSON over UDP on port 38899.
//   discovery: broadcast {"method":"registration",...}; bulbs reply with mac.
//   set:       {"method":"setPilot","params":{state,dimming,r,g,b,temp}}
//   get:       {"method":"getPilot","params":{}}
// No app/cloud required after the bulb is paired to wifi.

const WIZ_PORT = 38899;
const BROADCAST_ADDR = '255.255.255.255';
const DISCOVERY_WINDOW_MS = 2500;
const COMMAND_TIMEOUT_MS = 1500;
// WiZ rejects dimming < 10. Clamp on send.
const MIN_DIMMING = 10;

// MAC → friendly name. Mirrors the name set in the WiZ phone app.
const NAME_OVERRIDES: Record<string, string> = {
  '9877d5b2867e': 'GU10 Kitchen',
};

interface WizDevice {
  mac: string;
  ip: string;
  state: LightState;
  reachable: boolean;
}

interface WizPilotResult {
  mac?: string;
  state?: boolean;
  dimming?: number;
  temp?: number;
  r?: number;
  g?: number;
  b?: number;
  sceneId?: number;
}

export class WizDriver implements LightDriver {
  readonly brand: Brand = 'wiz';

  private socket?: Socket;
  private devices: Map<string, WizDevice> = new Map();

  onUpdate?: (deviceId: string, state: LightState) => void;

  async initialize(): Promise<void> {
    this.socket = createSocket('udp4');
    this.socket.on('error', (err) => {
      console.error('WiZ UDP error:', err);
    });
    // Allow many concurrent in-flight requests (one per command, transient).
    this.socket.setMaxListeners(64);
    await new Promise<void>((resolve) => {
      this.socket!.bind(() => {
        this.socket!.setBroadcast(true);
        resolve();
      });
    });
  }

  async discover(): Promise<Light[]> {
    if (!this.socket) return [];
    const found = new Map<string, WizDevice>();

    // Capture replies during the discovery window. WiZ sends only one
    // registration reply per bulb per broadcast; multiple broadcasts give
    // the bulb a few chances to respond if a packet is lost.
    const onMessage = (msg: Buffer, rinfo: RemoteInfo) => {
      let data: any;
      try { data = JSON.parse(msg.toString()); } catch { return; }
      if (data?.method !== 'registration') return;
      const mac = data?.result?.mac as string | undefined;
      if (!mac || found.has(mac)) return;
      found.set(mac, { mac, ip: rinfo.address, state: { on: false }, reachable: true });
    };
    this.socket.on('message', onMessage);

    const payload = JSON.stringify({
      method: 'registration',
      params: { phoneMac: 'AAAAAAAAAAAA', register: false, phoneIp: '0.0.0.0' },
    });
    this.socket.send(payload, WIZ_PORT, BROADCAST_ADDR);

    await new Promise((r) => setTimeout(r, DISCOVERY_WINDOW_MS));
    this.socket.removeListener('message', onMessage);

    // Pull initial pilot for each bulb.
    const lights: Light[] = [];
    for (const dev of found.values()) {
      this.devices.set(dev.mac, dev);
      try {
        dev.state = this.parsePilot(await this.getPilot(dev.ip));
      } catch {
        dev.reachable = false;
      }
      lights.push({
        id: `wiz:${dev.mac}`,
        name: NAME_OVERRIDES[dev.mac] ?? `WiZ ${dev.mac.slice(-6)}`,
        brand: 'wiz',
        capabilities: ['on_off', 'brightness', 'color', 'temperature'],
        state: dev.state,
        reachable: dev.reachable,
      });
    }
    return lights;
  }

  async getState(deviceId: string): Promise<LightState> {
    const dev = this.devices.get(deviceId);
    if (!dev) return { on: false };
    try {
      const pilot = await this.getPilot(dev.ip);
      dev.state = this.parsePilot(pilot);
      dev.reachable = true;
      return dev.state;
    } catch {
      dev.reachable = false;
      return dev.state;
    }
  }

  async setState(deviceId: string, state: Partial<LightState>): Promise<void> {
    const dev = this.devices.get(deviceId);
    if (!dev) throw new Error(`WiZ device not found: ${deviceId}`);

    // Build a single setPilot params object. r/g/b and temp are mutually
    // exclusive — sending one switches the bulb's mode. Dimming and state
    // ride along.
    const params: Record<string, any> = {};
    if (state.on !== undefined) params.state = state.on;
    if (state.brightness !== undefined) {
      params.dimming = Math.max(MIN_DIMMING, Math.min(100, Math.round(state.brightness)));
    }
    if (state.color !== undefined) {
      const { r, g, b } = hsvToRgb(state.color.h, state.color.s, 100);
      params.r = r; params.g = g; params.b = b;
    } else if (state.temperature !== undefined) {
      params.temp = Math.round(state.temperature);
    }

    if (Object.keys(params).length === 0) return;

    await this.sendAndAwait(dev.ip, { method: 'setPilot', params });

    // Optimistic local-state update — getPilot will re-sync via the polling loop.
    if (state.on !== undefined) dev.state.on = state.on;
    if (state.brightness !== undefined) dev.state.brightness = params.dimming;
    if (state.color !== undefined) {
      dev.state.color = state.color;
      delete dev.state.temperature;
    } else if (state.temperature !== undefined) {
      dev.state.temperature = state.temperature;
      delete dev.state.color;
    }
    dev.reachable = true;
  }

  async dispose(): Promise<void> {
    this.socket?.close();
  }

  // Returns the list of WiZ devices currently known to the driver. Used by
  // the WiZ test page to populate its bulb selector without re-querying
  // /api/lights and filtering client-side.
  listDevices(): { id: string; mac: string; ip: string; name: string; reachable: boolean }[] {
    return [...this.devices.values()].map((d) => ({
      id: `wiz:${d.mac}`,
      mac: d.mac,
      ip: d.ip,
      name: NAME_OVERRIDES[d.mac] ?? `WiZ ${d.mac.slice(-6)}`,
      reachable: d.reachable,
    }));
  }

  // Fire-and-forget setPilot. Skips await-reply round trip; the receiver may
  // drop or reorder packets. Used for client-driven strobe / level streaming
  // where waiting for a reply would cap rate at ~10 Hz.
  fastSet(deviceId: string, params: Record<string, any>): void {
    const dev = this.devices.get(stripPrefix(deviceId));
    if (!dev || !this.socket) return;
    if (typeof params.dimming === 'number') {
      params.dimming = Math.max(MIN_DIMMING, Math.min(100, Math.round(params.dimming)));
    }
    this.socket.send(JSON.stringify({ method: 'setPilot', params }), WIZ_PORT, dev.ip);
  }

  // Server-side pulse: snap to peak, then linearly ramp dimming from peak
  // down to floor across decayMs at fps. Uses fire-and-forget UDP so the
  // ramp's effective rate isn't bottlenecked by reply RTT. A new pulse on
  // the same device cancels the prior one (token-based).
  private activePulseToken: Map<string, number> = new Map();

  async pulse(deviceId: string, opts: {
    r: number; g: number; b: number;
    peakDim: number; floorDim: number; decayMs: number; fps?: number;
  }): Promise<void> {
    const mac = stripPrefix(deviceId);
    const dev = this.devices.get(mac);
    if (!dev || !this.socket) throw new Error(`WiZ device not found: ${deviceId}`);
    const peak = Math.max(MIN_DIMMING, Math.min(100, Math.round(opts.peakDim)));
    const floor = Math.max(MIN_DIMMING, Math.min(100, Math.round(opts.floorDim)));
    const fps = Math.max(10, Math.min(60, opts.fps ?? 30));
    const intervalMs = Math.max(15, Math.round(1000 / fps));

    const token = (this.activePulseToken.get(mac) ?? 0) + 1;
    this.activePulseToken.set(mac, token);

    // Snap to peak.
    this.fastSet(mac, { state: true, r: opts.r, g: opts.g, b: opts.b, dimming: peak });

    const start = Date.now();
    while (true) {
      if (this.activePulseToken.get(mac) !== token) return;
      const elapsed = Date.now() - start;
      if (elapsed >= opts.decayMs) {
        this.fastSet(mac, { r: opts.r, g: opts.g, b: opts.b, dimming: floor });
        dev.state = { on: true, brightness: floor, color: rgbToHsv(opts.r, opts.g, opts.b) };
        if (this.activePulseToken.get(mac) === token) this.activePulseToken.delete(mac);
        if (this.onUpdate) this.onUpdate(mac, dev.state);
        return;
      }
      const t = elapsed / opts.decayMs;
      const dim = Math.round(peak + (floor - peak) * t);
      this.fastSet(mac, { r: opts.r, g: opts.g, b: opts.b, dimming: dim });
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  private async getPilot(ip: string): Promise<WizPilotResult> {
    const reply = await this.sendAndAwait(ip, { method: 'getPilot', params: {} });
    return (reply?.result ?? {}) as WizPilotResult;
  }

  // Per-request listener: filters by source IP and matching `method` field
  // in the reply. WiZ echoes the method back in every response, so this
  // works even when multiple requests to the same bulb are in-flight.
  private sendAndAwait(ip: string, payload: { method: string; params: any }): Promise<any> {
    if (!this.socket) throw new Error('WiZ socket not initialized');
    return new Promise((resolve, reject) => {
      const sock = this.socket!;
      const onMessage = (msg: Buffer, rinfo: RemoteInfo) => {
        if (rinfo.address !== ip) return;
        let data: any;
        try { data = JSON.parse(msg.toString()); } catch { return; }
        if (data?.method !== payload.method) return;
        cleanup();
        resolve(data);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`WiZ ${payload.method} timeout (${ip})`));
      }, COMMAND_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        sock.removeListener('message', onMessage);
      };
      sock.on('message', onMessage);
      sock.send(JSON.stringify(payload), WIZ_PORT, ip, (err) => {
        if (err) { cleanup(); reject(err); }
      });
    });
  }

  private parsePilot(p: WizPilotResult): LightState {
    const state: LightState = { on: !!p.state };
    if (typeof p.dimming === 'number') state.brightness = p.dimming;
    // r/g/b takes precedence — when present, bulb is in color mode.
    if (typeof p.r === 'number' && typeof p.g === 'number' && typeof p.b === 'number') {
      const { h, s } = rgbToHsv(p.r, p.g, p.b);
      state.color = { h, s };
    } else if (typeof p.temp === 'number') {
      state.temperature = p.temp;
    }
    return state;
  }
}

// Accept either bare MAC or "wiz:<mac>" so route handlers can pass through
// what they got from the client without forking a normalize step.
function stripPrefix(deviceId: string): string {
  return deviceId.startsWith('wiz:') ? deviceId.slice(4) : deviceId;
}

function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  h = h / 360; s = s / 100; v = v / 100;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r = 0, g = 0, b = 0;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number } {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  const s = max === 0 ? 0 : d / max;
  if (max !== min) {
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100) };
}
