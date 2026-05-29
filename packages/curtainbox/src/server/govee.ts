// Govee LAN driver for the Curtain Lights Pro (H70B6), focused on the
// reverse-engineered "razer / DreamView" streaming mode that allows
// per-segment color (the standard LAN API only does whole-device color).
//
// Protocol (from LedFx's reverse-engineering — no official docs exist):
//   - Discovery: multicast {"msg":{"cmd":"scan",...}} → 239.255.255.250:4001,
//     devices reply on :4002.
//   - Control: JSON to deviceIP:4003.
//   - Enter stream mode: brightness(100) then razer-activate packet.
//   - Each frame: a base64'd byte packet wrapped in {"cmd":"razer","data":{"pt":...}}:
//       [0xBB, 0x00, MODE, 0xB0, STRETCH, N]  +  RGB×N  +  XOR-checksum
//     where MODE is one of three captured header variants, STRETCH is
//     0 (per-segment) or 1 (stretch pattern to fit), N is the segment count.
//   - Single UDP packet per frame, no fragmentation — so the max workable N
//     is exactly what we're probing.

import { createSocket, Socket } from 'dgram';

const DISCOVERY_PORT = 4001;
const RESPONSE_PORT = 4002;
const CONTROL_PORT = 4003;
const MULTICAST_ADDR = '239.255.255.250';

// Pre-activate / deactivate packets, captured by LedFx. Base64 of:
//   activate:   BB 00 01 B1 01 0A
//   deactivate: BB 00 01 B1 00 0B
const ACTIVATE_PT = 'uwABsQEK';
const DEACTIVATE_PT = 'uwABsQAL';

export type HeaderMode = 'dreams' | 'chroma' | 'govee';
// 4-byte prefix per mode; stretch flag + segment count are appended.
const HEADER_PREFIX: Record<HeaderMode, number[]> = {
  dreams: [0xbb, 0x00, 0xfa, 0xb0],
  chroma: [0xbb, 0x00, 0x0e, 0xb0],
  govee: [0xbb, 0x00, 0x20, 0xb0],
};

export interface GoveeDevice {
  ip: string;
  device: string; // mac-ish device id
  sku: string;    // model, e.g. H70B6
  raw: any;
}

export class GoveeLan {
  private socket: Socket | null = null;
  private ready = false;

  async init(): Promise<void> {
    if (this.ready) return;
    this.socket = createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('error', (e) => console.error('[govee] udp error:', e));
    await new Promise<void>((resolve, reject) => {
      this.socket!.once('error', reject);
      // Bind to the response port so device scan replies land here.
      this.socket!.bind(RESPONSE_PORT, () => {
        try {
          this.socket!.setBroadcast(true);
          this.socket!.addMembership(MULTICAST_ADDR);
        } catch (e) {
          // addMembership can fail on some interfaces; unicast replies still work.
          console.warn('[govee] multicast membership:', e);
        }
        resolve();
      });
    });
    this.ready = true;
  }

  async discover(timeoutMs = 3000): Promise<GoveeDevice[]> {
    await this.init();
    const found = new Map<string, GoveeDevice>();
    const onMsg = (msg: Buffer, rinfo: { address: string }) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.msg?.cmd === 'scan' && data.msg?.data) {
          const d = data.msg.data;
          const dev: GoveeDevice = {
            ip: d.ip ?? rinfo.address,
            device: d.device ?? rinfo.address,
            sku: d.sku ?? d.model ?? '?',
            raw: d,
          };
          found.set(dev.device, dev);
        }
      } catch { /* not JSON / not a scan reply */ }
    };
    this.socket!.on('message', onMsg);
    const scan = JSON.stringify({ msg: { cmd: 'scan', data: { account_topic: 'reserve' } } });
    this.socket!.send(scan, DISCOVERY_PORT, MULTICAST_ADDR);
    await new Promise((r) => setTimeout(r, timeoutMs));
    this.socket!.off('message', onMsg);
    return [...found.values()];
  }

  private sendJson(ip: string, obj: unknown) {
    if (!this.socket) return;
    this.socket.send(JSON.stringify(obj), CONTROL_PORT, ip);
  }

  setBrightness(ip: string, value: number) {
    this.sendJson(ip, { msg: { cmd: 'brightness', data: { value: Math.max(0, Math.min(100, value)) } } });
  }
  turn(ip: string, on: boolean) {
    this.sendJson(ip, { msg: { cmd: 'turn', data: { value: on ? 1 : 0 } } });
  }
  // Whole-device solid color via the standard LAN API — useful as a
  // connectivity sanity check before trying the razer stream.
  setColor(ip: string, r: number, g: number, b: number) {
    this.sendJson(ip, { msg: { cmd: 'colorwc', data: { color: { r, g, b }, colorTemInKelvin: 0 } } });
  }

  activateStream(ip: string) {
    this.sendJson(ip, { msg: { cmd: 'razer', data: { pt: ACTIVATE_PT } } });
  }
  deactivateStream(ip: string) {
    this.sendJson(ip, { msg: { cmd: 'razer', data: { pt: DEACTIVATE_PT } } });
  }

  // colors: flattened RGB, length must be N*3. Builds + sends one frame.
  sendFrame(ip: string, colors: Uint8Array, mode: HeaderMode = 'dreams', stretch = false) {
    const n = Math.floor(colors.length / 3);
    const prefix = HEADER_PREFIX[mode];
    const packet = new Uint8Array(prefix.length + 2 + colors.length + 1);
    let o = 0;
    for (const b of prefix) packet[o++] = b;
    packet[o++] = stretch ? 0x01 : 0x00;
    packet[o++] = n & 0xff;
    packet.set(colors, o);
    o += colors.length;
    // XOR checksum over everything before the checksum byte.
    let xor = 0;
    for (let i = 0; i < packet.length - 1; i++) xor ^= packet[i];
    packet[packet.length - 1] = xor;
    const pt = Buffer.from(packet).toString('base64');
    this.sendJson(ip, { msg: { cmd: 'razer', data: { pt } } });
  }

  // ---- BLE-passthrough over LAN (`ptReal`) ----
  // A separate channel from `razer`: tunnels Govee's BLE command packets
  // through the LAN. Each packet is 20 bytes: up to 19 command bytes,
  // zero-padded, with an XOR checksum as the 20th byte. Confirmed envelope
  // (from wez/govee2mqtt): {"msg":{"cmd":"ptReal","data":{"command":[b64,...]}}}.
  sendPtReal(ip: string, packets: Uint8Array[]) {
    const command = packets.map((p) => Buffer.from(p).toString('base64'));
    this.sendJson(ip, { msg: { cmd: 'ptReal', data: { command } } });
  }

  dispose() {
    try { this.socket?.close(); } catch { /* ignore */ }
    this.socket = null;
    this.ready = false;
  }
}

// Build a 20-byte BLE packet: command bytes, zero-padded to 19, then an
// XOR checksum byte. Matches govee2mqtt's `finish()`.
export function blePacket(bytes: number[]): Uint8Array {
  const p = new Uint8Array(20);
  for (let i = 0; i < Math.min(19, bytes.length); i++) p[i] = bytes[i] & 0xff;
  let xor = 0;
  for (let i = 0; i < 19; i++) xor ^= p[i];
  p[19] = xor;
  return p;
}

// Encode a Govee scene-application command into an array of 20-byte BLE
// packets (ready for sendPtReal). Faithful port of govee2mqtt's
// SetSceneCode::encode + AlgoClaw's multi-line method:
//   - decode the scene's base64 scenceParam
//   - wrap into a3-prefixed "lines" (first: a30001[N]02, last marker: a3ff)
//   - chunk to 19 bytes, pad+checksum each → 20-byte packets
//   - append the modeCmd packet: 33 05 04 <code-lo> <code-hi>
export function encodeSceneCommand(sceneCode: number, scenceParamB64: string): Uint8Array[] {
  const bytes = Buffer.from(scenceParamB64, 'base64');
  const data: number[] = [0xa3, 0x00, 0x01, 0x00 /* line count, back-patched */, 0x02];
  let numLines = 0;
  let lastLineMarker = 1;
  for (const b of bytes) {
    if (data.length % 19 === 0) {
      numLines += 1;
      data.push(0xa3);
      lastLineMarker = data.length; // index the line-number byte will occupy
      data.push(numLines);
    }
    data.push(b);
  }
  data[lastLineMarker] = 0xff; // last line uses 0xff instead of its number
  data[3] = numLines + 1;      // back-patch total line count

  const packets: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += 19) {
    packets.push(blePacket(data.slice(i, i + 19)));
  }
  // modeCmd — selects the scene code (little-endian).
  packets.push(blePacket([0x33, 0x05, 0x04, sceneCode & 0xff, (sceneCode >> 8) & 0xff]));
  return packets;
}

// Build a rainbow across N segments → flattened RGB Uint8Array. `phase`
// shifts the hue origin (0..1) so callers can animate it.
export function rainbow(n: number, phase = 0, value = 1): Uint8Array {
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const h = ((i / n + phase) % 1) * 360;
    const [r, g, b] = hsv(h, 1, value);
    out[i * 3] = r; out[i * 3 + 1] = g; out[i * 3 + 2] = b;
  }
  return out;
}

// Solid color across N segments.
export function solid(n: number, r: number, g: number, b: number): Uint8Array {
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) { out[i * 3] = r; out[i * 3 + 1] = g; out[i * 3 + 2] = b; }
  return out;
}

// Index markers: light segment 0 red, every 10th green, rest dim blue.
// Useful for visually counting how many segments actually respond.
export function ruler(n: number): Uint8Array {
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    if (i === 0) { out[i * 3] = 255; }
    else if (i % 10 === 0) { out[i * 3 + 1] = 255; }
    else { out[i * 3 + 2] = 40; }
  }
  return out;
}

function hsv(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = v - c;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
