// Twinkly driver — auth, mode, layout, RT-mode UDP frame streaming.
//
// Protocol notes (firmware family AB, e.g. PHBlinky):
//   - HTTP REST on :80 for control. Auth via challenge/response → bearer token.
//   - Real-time pixel streaming via UDP on :7777. Mode must be set to 'rt'.
//   - UDP v3 frame format:
//       byte 0:        0x03
//       bytes 1..8:    8-byte authentication token (raw — base64-decoded
//                      from the HTTP login response).
//       bytes 9..10:   0x00 0x00 (reserved / zero)
//       byte 11:       fragment index (0-based, increments per packet in
//                      a multi-fragment frame).
//       bytes 12..:    LED data. RGBW = 4 bytes/LED, RGB = 3 bytes/LED.
//   - Each fragment carries up to ~250 LEDs (1000 bytes RGBW) to stay
//     well under MTU 1500. Total frame = ceil(N / FRAGMENT_LEDS) packets.
//   - LED order in the data block is sequential strand-index.
//
// Layout:
//   GET /xled/v1/led/layout/full → { coordinates: [{x,y,z}, ...], source }.
//   Coordinates come from the in-app phone-camera scan; range varies per
//   install. We normalize to a unit-ish cube on fetch so patterns can be
//   written in [0,1].

import { createSocket, Socket } from 'dgram';
import type { LedDriver, LedLayout } from './led-driver.js';

const HTTP_PORT = 80;
const UDP_PORT = 7777;
// Twinkly firmware (fw_family AB) expects exactly 900 bytes of LED data per
// fragment in v3 RT protocol. The firmware computes "where to write this
// fragment" as `fragment_index * fixed_fragment_size`, and `fixed_fragment_size`
// is 900 bytes — empirically and matching xled-py / jinx / xled-js. Sending
// larger fragments makes the offset math go wrong: only the FIRST fragment's
// data sticks; subsequent fragments overwrite the leading LEDs again.
const FRAGMENT_DATA_BYTES = 900;
const AUTH_TTL_REFRESH_MS = 14_000_000; // re-auth ~3.9h, token good for 4h

export interface Gestalt {
  device_name: string;
  number_of_led: number;
  bytes_per_led: number; // 3 (RGB) or 4 (RGBW)
  led_profile: 'RGB' | 'RGBW';
  fw_family: string;
  hw_id: string;
  uuid: string;
  product_code: string;
}

export interface RawCoord { x: number; y: number; z: number }
export interface NormCoord { x: number; y: number; z: number } // [0,1] cube
export interface Layout {
  source: string | null;
  coords: RawCoord[];
  normalized: NormCoord[];
  bbox: { min: RawCoord; max: RawCoord };
}

export interface DeviceInfo {
  ip: string;
  gestalt: Gestalt;
  layout: Layout | null;
}

export class TwinklyDevice implements LedDriver {
  readonly kind = 'twinkly' as const;
  readonly ip: string;
  gestalt!: Gestalt;
  layout: Layout | null = null;

  // LedDriver bits — derived from gestalt + layout after connect().
  get host(): string { return this.ip; }
  get name(): string { return this.gestalt?.device_name ?? 'Twinkly'; }
  get numLeds(): number { return this.gestalt?.number_of_led ?? 0; }
  get bytesPerLed(): 3 | 4 { return this.gestalt?.bytes_per_led === 3 ? 3 : 4; }
  getLayout(): LedLayout | null {
    if (!this.layout) return null;
    return { coords: this.layout.normalized, source: this.layout.source ?? '3d' };
  }
  async startStreaming(): Promise<void> { await this.setMode('rt'); }
  async stopStreaming(): Promise<void> { try { await this.setMode('movie'); } catch { /* best-effort */ } }
  async dispose(): Promise<void> {
    try { this.udp?.close(); } catch { /* ignore */ }
    this.udp = null;
  }

  private tokenB64: string | null = null;
  private tokenBytes: Buffer | null = null;
  private tokenAcquiredMs = 0;

  private udp: Socket | null = null;

  constructor(ip: string) {
    this.ip = ip;
  }

  async connect(): Promise<DeviceInfo> {
    this.gestalt = await this.get<Gestalt>('/xled/v1/gestalt');
    await this.ensureToken();
    this.layout = await this.fetchLayout();
    if (!this.udp) {
      this.udp = createSocket('udp4');
      this.udp.on('error', (e) => console.error('[twinkly] udp error:', e));
    }
    return { ip: this.ip, gestalt: this.gestalt, layout: this.layout };
  }

  async setMode(mode: 'rt' | 'movie' | 'effect' | 'color' | 'off' | 'demo'): Promise<void> {
    await this.ensureToken();
    await this.post('/xled/v1/led/mode', { mode });
  }

  // Stream one frame of LED data. Splits into fragments per Twinkly v3 protocol.
  // `pixels` is a Uint8Array of length N * bytesPerLed (RGB or RGBW packed).
  sendFrame(pixels: Uint8Array): void {
    if (!this.udp || !this.tokenBytes) return;
    const bpl = this.gestalt.bytes_per_led;
    const n = this.gestalt.number_of_led;
    const expected = n * bpl;
    if (pixels.length !== expected) {
      // Defensive: skip the frame rather than blow up the stream.
      console.warn(`[twinkly] frame length ${pixels.length} != expected ${expected}, skipping`);
      return;
    }
    // Fragment by bytes, not by LED count, because the firmware's
    // expected slot size is in bytes (900). At RGBW (4B/LED) → 225 LEDs
    // per fragment; at RGB (3B/LED) → 300 LEDs per fragment.
    const ledsPerFrag = Math.floor(FRAGMENT_DATA_BYTES / bpl);
    const numFrags = Math.ceil(n / ledsPerFrag);
    for (let f = 0; f < numFrags; f++) {
      const ledStart = f * ledsPerFrag;
      const ledEnd = Math.min(n, ledStart + ledsPerFrag);
      const fragLeds = ledEnd - ledStart;
      const dataStart = ledStart * bpl;
      const header = Buffer.alloc(12);
      header[0] = 0x03;
      this.tokenBytes.copy(header, 1, 0, 8);
      // bytes 9, 10 are zero by alloc
      header[11] = f;
      const payload = Buffer.concat([
        header,
        Buffer.from(pixels.buffer, pixels.byteOffset + dataStart, fragLeds * bpl),
      ]);
      this.udp.send(payload, UDP_PORT, this.ip);
    }
  }

  // --- Internals ---

  private async ensureToken(): Promise<void> {
    if (this.tokenB64 && Date.now() - this.tokenAcquiredMs < AUTH_TTL_REFRESH_MS) return;
    await this.login();
  }

  private async login(): Promise<void> {
    // Twinkly login: send 32 random bytes as base64 'challenge', server
    // returns 'authentication_token' (base64) + 'challenge-response'.
    // Echo the challenge-response back to /verify, then the token is live.
    const challenge = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) challenge[i] = Math.floor(Math.random() * 256);
    const loginRes = await this.post<{ authentication_token: string; 'challenge-response': string }>(
      '/xled/v1/login',
      { challenge: challenge.toString('base64') },
      /* skipAuth */ true,
    );
    const tokenB64 = loginRes.authentication_token;
    const tokenBytes = Buffer.from(tokenB64, 'base64');
    if (tokenBytes.length !== 8) {
      throw new Error(`Unexpected token length ${tokenBytes.length} (want 8)`);
    }
    // Verify before considering the token live. Some firmwares enforce this
    // for control endpoints; the login alone does not.
    this.tokenB64 = tokenB64;
    this.tokenBytes = tokenBytes;
    this.tokenAcquiredMs = Date.now();
    await this.post('/xled/v1/verify', { 'challenge-response': loginRes['challenge-response'] });
  }

  private async fetchLayout(): Promise<Layout | null> {
    try {
      const r = await this.get<{ coordinates?: RawCoord[]; source?: string; synthesized?: boolean }>(
        '/xled/v1/led/layout/full',
      );
      const coords = r.coordinates ?? [];
      if (coords.length === 0) return null;
      const bbox = {
        min: { x: Infinity, y: Infinity, z: Infinity },
        max: { x: -Infinity, y: -Infinity, z: -Infinity },
      };
      for (const c of coords) {
        if (c.x < bbox.min.x) bbox.min.x = c.x;
        if (c.y < bbox.min.y) bbox.min.y = c.y;
        if (c.z < bbox.min.z) bbox.min.z = c.z;
        if (c.x > bbox.max.x) bbox.max.x = c.x;
        if (c.y > bbox.max.y) bbox.max.y = c.y;
        if (c.z > bbox.max.z) bbox.max.z = c.z;
      }
      // Normalize each axis to [0,1] independently. Patterns can decide
      // whether to preserve aspect ratio or not.
      const span = {
        x: bbox.max.x - bbox.min.x || 1,
        y: bbox.max.y - bbox.min.y || 1,
        z: bbox.max.z - bbox.min.z || 1,
      };
      const normalized: NormCoord[] = coords.map((c) => ({
        x: (c.x - bbox.min.x) / span.x,
        y: (c.y - bbox.min.y) / span.y,
        z: (c.z - bbox.min.z) / span.z,
      }));
      return { source: r.source ?? null, coords, normalized, bbox };
    } catch (e) {
      console.warn('[twinkly] layout fetch failed:', e);
      return null;
    }
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>(path, 'GET');
  }

  private async post<T>(path: string, body: unknown, skipAuth = false): Promise<T> {
    return this.request<T>(path, 'POST', body, skipAuth);
  }

  // tiny http client — fetch is fine for our local needs, but Twinkly's
  // server is finicky about Content-Length so we let fetch handle that.
  private async request<T>(path: string, method: 'GET' | 'POST', body?: unknown, skipAuth = false): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (!skipAuth && this.tokenB64) headers['X-Auth-Token'] = this.tokenB64;
    const res = await fetch(`http://${this.ip}:${HTTP_PORT}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !skipAuth) {
      // Token expired or rejected — re-login once and retry.
      this.tokenB64 = null;
      await this.login();
      headers['X-Auth-Token'] = this.tokenB64!;
      const retry = await fetch(`http://${this.ip}:${HTTP_PORT}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (!retry.ok) throw new Error(`${method} ${path} → ${retry.status}`);
      return (await retry.json()) as T;
    }
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }
}
