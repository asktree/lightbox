// WLED driver — DDP (Distributed Display Protocol) realtime UDP streaming.
//
// Why DDP over DNRGB:
//   - DDP frames have explicit fragmentation with a PUSH flag on the final
//     packet. WLED only commits to the LED strip when PUSH arrives, so
//     mid-frame UDP jitter or loss can't produce torn frames where the top
//     half of the strip is on frame N and the bottom is on frame N-1.
//   - Per-frame sequence numbers let WLED drop stale fragments cleanly.
//   - Same broad UDP/WLED setup; just a different envelope.
//
// Packet layout (10-byte header + payload):
//   byte 0:    flags  (VER1=0x40 always; PUSH=0x01 set on last fragment of a frame)
//   byte 1:    sequence (1..15, wraps; 0 reserved by spec)
//   byte 2:    data type (0x01 = RGB)
//   byte 3:    output id (1 = default WLED output)
//   bytes 4-7: data offset, uint32 big-endian (byte offset into the frame's pixel data)
//   bytes 8-9: data length, uint16 big-endian
//   bytes 10+: pixel bytes (R,G,B,R,G,B,...)
//
// Stopping = stop sending; WLED's DDP timeout reverts to effects after a
// couple seconds (its `arls_timeout` setting, typically ~2.5s).

import { createSocket, Socket } from 'dgram';
import { performance } from 'node:perf_hooks';
import type { LedDriver, LedLayout, NormCoord } from './led-driver.js';

const DDP_PORT = 4048;
// Default port the timecode_buffer usermod listens on (separate from 4048 so
// the firmware can run both the stock immediate path and the buffered path).
const DDP_BUFFER_PORT = 4049;
// 1440 bytes payload keeps each packet well under MTU 1500 once you add
// IP (20) + UDP (8) + DDP (10) headers (= 38, total 1478). 1440 is the
// de-facto standard chunk size in DDP installations.
const DDP_MAX_PAYLOAD = 1440;

const DDP_FLAG_VER1 = 0x40;
const DDP_FLAG_PUSH = 0x01;
// Timecode-present flag. When set, 4 big-endian bytes follow the 10-byte
// header (before pixel data) carrying a sender-clock millisecond value. Stock
// WLED parses past these bytes and ignores them; our timecode_buffer usermod
// uses them to schedule jitter-free playout.
const DDP_FLAG_TIME = 0x10;
const DDP_DATA_TYPE_RGB = 0x01;
const DDP_OUTPUT_ID = 1;

interface WledInfo {
  ver: string;
  name: string;
  leds: {
    count: number;
    rgbw?: boolean;
    matrix?: { w: number; h: number };
  };
}

export class WledDriver implements LedDriver {
  readonly kind = 'wled' as const;
  readonly host: string;
  readonly name: string;
  readonly numLeds: number;
  readonly bytesPerLed: 3 | 4;
  private readonly matrix?: { w: number; h: number };
  private readonly layout: LedLayout | null;
  private socket: Socket | null = null;
  private streaming = false;
  // DDP sequence number (1..15, wraps; 0 reserved per spec). Incremented
  // per frame so WLED can reject stale fragments.
  private ddpSeq = 0;
  // Timecode buffer mode. When on, frames are sent to DDP_BUFFER_PORT with a
  // per-frame timecode so the timecode_buffer usermod can absorb WiFi jitter
  // by playing each frame out on a fixed delay. Off = stock immediate DDP.
  private bufferMode = false;
  private bufferPort = DDP_BUFFER_PORT;
  // Scratch buffer for the pixel payload — reused across frames to avoid
  // GC churn at high frame rates.
  private payloadScratch: Uint8Array | null = null;

  private constructor(host: string, info: WledInfo) {
    this.host = host;
    this.name = info.name || 'WLED';
    this.numLeds = info.leds.count;
    // WLED's RGBW devices accept DRGBW (0x03) instead of DNRGB. We use
    // the RGB DNRGB path here — if the user's WLED is configured for an
    // RGBW string, the W channel is just implied off. Curtain is RGB.
    this.bytesPerLed = info.leds.rgbw ? 4 : 3;
    this.matrix = info.leds.matrix;
    this.layout = this.matrix ? wledMatrixLayout(this.matrix.w, this.matrix.h) : null;
    // Whether the timecode_buffer usermod is actually on this box (its info
    // panel entry shows up under `u`). Stock firmware silently drops packets
    // on the buffer port, so buffer mode must never engage without it.
    const u = (info as { u?: Record<string, unknown> }).u ?? {};
    this.hasTimecodeUsermod = Object.keys(u).some((k) => k.toLowerCase().includes('timecode'));
  }

  static async connect(host: string): Promise<WledDriver> {
    const r = await fetch(`http://${host}/json/info`);
    if (!r.ok) throw new Error(`WLED ${host} info → ${r.status}`);
    const info = (await r.json()) as WledInfo;
    if (!info?.leds?.count) throw new Error(`WLED ${host} info missing leds.count`);
    const d = new WledDriver(host, info);
    d.socket = createSocket('udp4');
    d.socket.on('error', (e) => console.error('[wled] udp error:', e));
    return d;
  }

  getLayout(): LedLayout | null { return this.layout; }

  // Toggle timecode buffering. `on` routes frames to the usermod's buffer port
  // with per-frame timecodes; `off` reverts to stock immediate DDP on 4048.
  // The 500ms-ish playout delay lives on the device, not here.
  setBufferMode(on: boolean, opts?: { port?: number }): void {
    if (on && !this.hasTimecodeUsermod) {
      // Stock firmware: nothing listens on the buffer port — frames would
      // vanish silently. Refuse rather than blackhole the display.
      console.log(`[wled] ${this.host}: buffer mode requested but timecode usermod not present — staying on stock DDP`);
      this.bufferMode = false;
      return;
    }
    this.bufferMode = on;
    if (opts?.port) this.bufferPort = opts.port;
  }

  get isBuffered(): boolean { return this.bufferMode; }
  private hasTimecodeUsermod = false;

  // WLED auto-detects realtime — no handshake. We just track the streaming
  // flag locally so the FrameLoop's gating is honored.
  async startStreaming(): Promise<void> { this.streaming = true; }
  // Stop sending → WLED falls back to its own effects after the timeout.
  async stopStreaming(): Promise<void> { this.streaming = false; }

  sendFrame(buf: Uint8Array): void {
    if (!this.socket) return;
    const bpl = this.bytesPerLed;
    const N = this.numLeds;

    // Stage the frame's RGB pixel data into a single Uint8Array. If the
    // pattern wrote RGBW (W,R,G,B) we strip W on the way in. Reused across
    // frames to avoid per-frame allocation.
    const payloadLen = N * 3;
    if (!this.payloadScratch || this.payloadScratch.length !== payloadLen) {
      this.payloadScratch = new Uint8Array(payloadLen);
    }
    const payload = this.payloadScratch;
    if (bpl === 4) {
      for (let i = 0; i < N; i++) {
        const s = i * 4, d = i * 3;
        payload[d + 0] = buf[s + 1]; // R (W=buf[s] is dropped)
        payload[d + 1] = buf[s + 2]; // G
        payload[d + 2] = buf[s + 3]; // B
      }
    } else {
      payload.set(buf.subarray(0, payloadLen));
    }

    // Sequence rolls 1..15. Skipping 0 matches the DDP spec's "no
    // sequence" reservation. All fragments of one frame share this value —
    // the usermod groups fragments into a frame by sequence number.
    this.ddpSeq = (this.ddpSeq % 15) + 1;

    // In buffer mode every fragment of this frame carries the SAME timecode:
    // a monotonic sender-clock millisecond stamp, taken once per frame. The
    // usermod schedules playout off this value. uint32 wraps after ~49 days;
    // the usermod's comparisons are wrap-safe so that's harmless.
    const buffered = this.bufferMode;
    const timecode = buffered ? Math.round(performance.now()) >>> 0 : 0;
    const destPort = buffered ? this.bufferPort : DDP_PORT;
    const tcLen = buffered ? 4 : 0;

    // Fragment into chunks ≤ DDP_MAX_PAYLOAD. PUSH only on the last
    // fragment so WLED commits to LEDs atomically per frame.
    const numChunks = Math.max(1, Math.ceil(payloadLen / DDP_MAX_PAYLOAD));
    for (let i = 0; i < numChunks; i++) {
      const offset = i * DDP_MAX_PAYLOAD;
      const len = Math.min(DDP_MAX_PAYLOAD, payloadLen - offset);
      const isLast = i === numChunks - 1;
      const pkt = Buffer.alloc(10 + tcLen + len);
      pkt[0] = DDP_FLAG_VER1 | (buffered ? DDP_FLAG_TIME : 0) | (isLast ? DDP_FLAG_PUSH : 0);
      pkt[1] = this.ddpSeq;
      pkt[2] = DDP_DATA_TYPE_RGB;
      pkt[3] = DDP_OUTPUT_ID;
      pkt.writeUInt32BE(offset, 4);
      pkt.writeUInt16BE(len, 8);
      if (buffered) pkt.writeUInt32BE(timecode, 10);
      // Copy this chunk's payload bytes in (after the optional timecode).
      Buffer.from(payload.buffer, payload.byteOffset + offset, len).copy(pkt, 10 + tcLen);
      this.socket.send(pkt, destPort, this.host);
    }
  }

  async dispose(): Promise<void> {
    this.streaming = false;
    try { this.socket?.close(); } catch { /* ignore */ }
    this.socket = null;
  }
}

// Map a W×H matrix into normalized 3D coords. Strand order is row-major
// (linear index i → row=i/W, col=i%W). z=0 = flat plane. y is flipped so
// row 0 is at the top of the layout (matches WLED's matrix convention).
// Exported so the serial (Adalight) driver can reuse it — same WLED, just
// a different transport for the pixel bytes.
export function wledMatrixLayout(w: number, h: number): LedLayout {
  const coords: NormCoord[] = [];
  for (let i = 0; i < w * h; i++) {
    const col = i % w;
    const row = Math.floor(i / w);
    coords.push({
      x: w > 1 ? col / (w - 1) : 0.5,
      y: h > 1 ? 1 - row / (h - 1) : 0.5,
      z: 0,
    });
  }
  return { coords, matrix: { w, h }, source: 'matrix' };
}
