// Serial (Adalight) driver — streams pixels to WLED over USB serial instead
// of WiFi/DDP. Why: on a congested/mesh WiFi, UDP frame delivery jitters
// tens of ms (≈ the whole frame budget) → choppy. A wired serial link has
// microsecond jitter, so realtime is rock-steady.
//
// Transport: Adalight ("Ada" magic header + 16-bit LED count + checksum +
// RGB bytes). WLED reads this on its serial port when the baud matches the
// device's `hw.baud` setting (we set 921600 = enough for ~960px @ ~30fps).
//
// Metadata (LED count + 2D matrix layout) still comes over HTTP from the
// same WLED — the box stays on WiFi for its JSON API; only the per-frame
// pixel bytes go over the wire. So patterns/layout behave identically to
// the DDP path; only the bytes' transport changes.

import { SerialPort } from 'serialport';
import type { LedDriver, LedLayout } from './led-driver.js';
import { wledMatrixLayout } from './wled.js';

// Must match WLED's configured serial baud (cfg hw.baud × 100). Overridable
// via SERIAL_BAUD env — high bauds (921600) can overflow the ESP's serial RX
// buffer mid-frame so WLED never parses a clean Adalight header; 460800/
// 230400 give the chip time to drain.
const BAUD = Number(process.env.SERIAL_BAUD) || 460800;

interface WledInfo {
  ver: string;
  name: string;
  leds: { count: number; rgbw?: boolean; matrix?: { w: number; h: number } };
}

// USB-serial bridge chips used on ESP32 boards, by vendorId — used to
// auto-pick the right port so "plug in and go" works without naming it.
//   10c4 = Silicon Labs CP210x · 1a86 = WCH CH340/CH9102 · 0403 = FTDI
//   303a = Espressif native USB (S2/S3/C3)
const ESP_VENDOR_IDS = new Set(['10c4', '1a86', '0403', '303a']);

// Find the most likely ESP32 serial port. Prefers a known bridge vendorId;
// falls back to the first /dev/cu.usb(serial|modem)* that isn't Bluetooth.
async function autodetectPort(): Promise<string | null> {
  const ports = await SerialPort.list();
  const byVendor = ports.find((p) => p.vendorId && ESP_VENDOR_IDS.has(p.vendorId.toLowerCase()));
  if (byVendor) return byVendor.path;
  const byName = ports.find((p) =>
    /usb(serial|modem)/i.test(p.path) && !/bluetooth/i.test(p.path));
  return byName?.path ?? null;
}

export class SerialDriver implements LedDriver {
  readonly kind = 'serial' as const;
  readonly host: string;       // WLED host (for the JSON API / display label)
  readonly portPath: string;
  readonly name: string;
  readonly numLeds: number;
  readonly bytesPerLed = 3 as const; // Adalight is RGB
  private readonly layout: LedLayout | null;
  private port: SerialPort | null = null;
  private streaming = false;
  // 6-byte Adalight header (constant for a fixed LED count); prepended to a
  // FRESH packet each frame — see sendFrame for why we must not reuse one.
  private header: Buffer;

  private constructor(host: string, portPath: string, info: WledInfo) {
    this.host = host;
    this.portPath = portPath;
    this.name = `${info.name || 'WLED'} (serial)`;
    this.numLeds = info.leds.count;
    this.layout = info.leds.matrix ? wledMatrixLayout(info.leds.matrix.w, info.leds.matrix.h) : null;
    // Adalight header is constant for a fixed LED count, so build it once.
    this.header = Buffer.alloc(6);
    const count = this.numLeds - 1; // Adalight encodes (N-1)
    const hi = (count >> 8) & 0xff;
    const lo = count & 0xff;
    this.header[0] = 0x41; // 'A'
    this.header[1] = 0x64; // 'd'
    this.header[2] = 0x61; // 'a'
    this.header[3] = hi;
    this.header[4] = lo;
    this.header[5] = hi ^ lo ^ 0x55; // Adalight checksum
  }

  // host: WLED IP/hostname for OPTIONAL metadata (LED count + matrix) over
  // HTTP. portPath: serial device; if omitted, auto-detect the plugged-in
  // ESP32. Serial is a wired, WiFi-independent transport — so if the box
  // isn't reachable over HTTP we fall back to known dimensions rather than
  // failing (these curtains are 960px / 32×30).
  static async connect(host: string, portPath?: string, fallback?: { numLeds: number; matrix?: { w: number; h: number } }): Promise<SerialDriver> {
    const fb = fallback ?? { numLeds: 960, matrix: { w: 32, h: 30 } };
    let info: WledInfo;
    try {
      const r = await fetch(`http://${host}/json/info`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) throw new Error(String(r.status));
      info = (await r.json()) as WledInfo;
      if (!info?.leds?.count) throw new Error('missing leds.count');
    } catch (e) {
      console.warn(`[serial] HTTP metadata from ${host} failed (${String((e as any)?.message ?? e)}) — using fallback ${fb.numLeds}px${fb.matrix ? ` ${fb.matrix.w}×${fb.matrix.h}` : ''}`);
      info = { ver: '?', name: 'WLED', leds: { count: fb.numLeds, matrix: fb.matrix } };
    }

    const path = portPath ?? (await autodetectPort());
    if (!path) {
      const avail = (await SerialPort.list()).map((p) => p.path).join(', ') || '(none)';
      throw new Error(`no serial port found — plug in the ESP32's USB-C data cable. Available: ${avail}`);
    }

    const d = new SerialDriver(host, path, info);
    await new Promise<void>((resolve, reject) => {
      d.port = new SerialPort({ path, baudRate: BAUD, autoOpen: false });
      d.port.open((err) => {
        if (err) return reject(new Error(`open ${path} @ ${BAUD}: ${err.message}`));
        // CRITICAL for ESP32: a serial-port open normally asserts DTR/RTS,
        // which on the ESP's auto-reset circuit can hold it in reset or drop
        // it into bootloader → WLED freezes. Deassert both so the chip just
        // runs WLED normally.
        d.port!.set({ dtr: false, rts: false }, () => resolve());
      });
    });
    d.port!.on('error', (e) => console.error('[serial] error:', e.message));
    return d;
  }

  getLayout(): LedLayout | null { return this.layout; }

  async startStreaming(): Promise<void> { this.streaming = true; }
  async stopStreaming(): Promise<void> { this.streaming = false; }

  sendFrame(buf: Uint8Array): void {
    if (!this.port || !this.port.writable) return;
    const n = Math.min(buf.length, this.numLeds * 3);
    // Allocate a FRESH packet every frame — do NOT reuse one Buffer.
    // serialport.write() is async and keeps a reference to the buffer until
    // it has fully drained to the OS (~63 ms for a 2886-byte frame at 460800
    // baud — nearly a whole frame interval). Mutating a shared buffer for the
    // next frame before the previous write finished corrupts the bytes still
    // in flight → WLED loses/shifts bytes and reads the Adalight stream at a
    // drifting phase → the whole strip flashes solid R/G/B. A fresh buffer per
    // frame is cheap (~46 KB/s at 16 fps) and correct.
    const out = Buffer.allocUnsafe(6 + n);
    this.header.copy(out, 0);
    out.set(buf.subarray(0, n), 6);
    this.port.write(out);
  }

  async dispose(): Promise<void> {
    this.streaming = false;
    await new Promise<void>((resolve) => {
      if (!this.port || !this.port.isOpen) return resolve();
      this.port.close(() => resolve());
    });
    this.port = null;
  }
}
