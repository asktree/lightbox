// CombinedWledDriver — drives two vertically-stacked WLED matrices as ONE
// taller display. `top` renders the upper rows, `bottom` the lower. Patterns
// see a single W×(topH+bottomH) matrix and render one frame; we split it at the
// seam and ship each half to its box.
//
// Sync: both boxes run the timecode buffer (port 4049). Each frame is sent to
// both in the same tick with near-identical timecodes, and each box plays on
// the same 500ms delay — so the two halves stay aligned and the seam doesn't
// tear. (Each box folds its own clock origin into its playout offset, so they
// don't need a shared clock; they only need to start streaming together, which
// they do.)

import type { LedDriver, LedLayout } from './led-driver.js';
import { WledDriver, wledMatrixLayout } from './wled.js';

export class CombinedWledDriver implements LedDriver {
  readonly kind = 'wled' as const;
  readonly name: string;
  readonly host: string;
  readonly numLeds: number;
  readonly bytesPerLed = 3 as const;
  private readonly layout: LedLayout | null;
  private readonly topBytes: number;
  private readonly topW: number;
  private readonly topH: number;
  // Both panels (Ubert top, Doggert bottom) are mounted rotated 180°, so each
  // half of the frame is rotated 180° (full pixel-order reversal) before
  // sending. Per-box, in place — the boxes keep their top/bottom positions.
  private rotate180 = true;
  private topScratch: Uint8Array | null = null;
  private bottomScratch: Uint8Array | null = null;
  // Doggert's on-box timecode buffer holds frames ~500ms. When only one box
  // buffers, we software-delay the OTHER box by this much so the two halves
  // display at the same wall-clock time (no temporal tear at the seam).
  private static readonly MATCH_DELAY_MS = 500;
  private topQueue: { t: number; data: Uint8Array }[] = [];
  private bottomQueue: { t: number; data: Uint8Array }[] = [];

  private constructor(
    private readonly top: WledDriver,
    private readonly bottom: WledDriver,
  ) {
    this.numLeds = top.numLeds + bottom.numLeds;
    this.topBytes = top.numLeds * 3;
    this.name = `${top.name}+${bottom.name} (stacked)`;
    this.host = `${top.host}+${bottom.host}`;
    // Combined matrix = same width, stacked heights. Falls back to no layout
    // if either box isn't a matching-width matrix.
    const tm = top.getLayout()?.matrix;
    const bm = bottom.getLayout()?.matrix;
    this.topW = tm?.w ?? 0;
    this.topH = tm?.h ?? 0;
    this.layout = tm && bm && tm.w === bm.w ? wledMatrixLayout(tm.w, tm.h + bm.h) : null;
  }

  // Toggle the per-box 180° rotation (in case the mount changes).
  setRotate180(on: boolean): void { this.rotate180 = on; }

  // topHost renders the upper rows (row 0), bottomHost the lower.
  static async connect(topHost: string, bottomHost: string): Promise<CombinedWledDriver> {
    const [top, bottom] = await Promise.all([
      WledDriver.connect(topHost),
      WledDriver.connect(bottomHost),
    ]);
    return new CombinedWledDriver(top, bottom);
  }

  // Wrap two already-connected boxes (caller handles connect + fallback).
  static fromPair(top: WledDriver, bottom: WledDriver): CombinedWledDriver {
    return new CombinedWledDriver(top, bottom);
  }

  getLayout(): LedLayout | null { return this.layout; }

  async startStreaming(): Promise<void> {
    await Promise.all([this.top.startStreaming(), this.bottom.startStreaming()]);
  }
  async stopStreaming(): Promise<void> {
    await Promise.all([this.top.stopStreaming(), this.bottom.stopStreaming()]);
  }

  setBufferMode(on: boolean, opts?: { port?: number }): void {
    this.top.setBufferMode(on, opts);
    this.bottom.setBufferMode(on, opts);
  }
  // Per-box buffer control — e.g. Doggert (bottom) buffers while Ubert (top)
  // runs stock DDP because its usermod isn't loaded.
  setBufferModeEach(top: boolean, bottom: boolean, opts?: { port?: number }): void {
    this.top.setBufferMode(top, opts);
    this.bottom.setBufferMode(bottom, opts);
  }
  get isBuffered(): boolean { return this.top.isBuffered || this.bottom.isBuffered; }
  get bufferedTop(): boolean { return this.top.isBuffered; }
  get bufferedBottom(): boolean { return this.bottom.isBuffered; }

  setBrightness(bri: number): void {
    this.top.setBrightness(bri);
    this.bottom.setBrightness(bri);
  }

  // Send to one box, optionally software-delayed by delayMs (to match the other
  // box's on-box buffer). delayMs<=0 sends immediately.
  private sendBox(driver: WledDriver, queue: { t: number; data: Uint8Array }[], data: Uint8Array, delayMs: number, now: number): void {
    if (delayMs <= 0) { driver.sendFrame(data); return; }
    queue.push({ t: now, data: data.slice() });  // copy — `data` may be reused scratch
    while (queue.length && now - queue[0].t >= delayMs) {
      driver.sendFrame(queue.shift()!.data);
    }
    if (queue.length > 90) queue.splice(0, queue.length - 90); // ~3s safety cap
  }

  // Rotate a half 180° = reverse its pixel order (row-major W×H block:
  // pixel i → N-1-i). Reads `count` pixels starting at byte `srcStart` of `buf`
  // into `scratch` (reversed). Returns `scratch`.
  private rotateHalf180(buf: Uint8Array, srcStart: number, count: number, scratch: Uint8Array): Uint8Array {
    for (let i = 0; i < count; i++) {
      const s = srcStart + (count - 1 - i) * 3;
      const d = i * 3;
      scratch[d] = buf[s]; scratch[d + 1] = buf[s + 1]; scratch[d + 2] = buf[s + 2];
    }
    return scratch;
  }

  sendFrame(buf: Uint8Array): void {
    const now = Date.now();
    let topData: Uint8Array;
    let bottomData: Uint8Array;
    if (this.rotate180) {
      const topCount = this.top.numLeds;
      const botCount = this.bottom.numLeds;
      if (!this.topScratch || this.topScratch.length !== topCount * 3) this.topScratch = new Uint8Array(topCount * 3);
      if (!this.bottomScratch || this.bottomScratch.length !== botCount * 3) this.bottomScratch = new Uint8Array(botCount * 3);
      topData = this.rotateHalf180(buf, 0, topCount, this.topScratch);
      bottomData = this.rotateHalf180(buf, this.topBytes, botCount, this.bottomScratch);
    } else {
      topData = buf.subarray(0, this.topBytes);
      bottomData = buf.subarray(this.topBytes);
    }
    // Delay whichever box LACKS the on-box buffer so both halves are in sync.
    const M = CombinedWledDriver.MATCH_DELAY_MS;
    const topDelay = this.bottom.isBuffered && !this.top.isBuffered ? M : 0;
    const bottomDelay = this.top.isBuffered && !this.bottom.isBuffered ? M : 0;
    this.sendBox(this.top, this.topQueue, topData, topDelay, now);
    this.sendBox(this.bottom, this.bottomQueue, bottomData, bottomDelay, now);
  }

  async dispose(): Promise<void> {
    await Promise.all([this.top.dispose(), this.bottom.dispose()]);
  }
}
