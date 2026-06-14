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
    this.layout = tm && bm && tm.w === bm.w ? wledMatrixLayout(tm.w, tm.h + bm.h) : null;
  }

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
  get isBuffered(): boolean { return this.top.isBuffered; }

  sendFrame(buf: Uint8Array): void {
    // Top rows are the first topBytes of the row-major frame; the rest is the
    // bottom box. subarray is a view (no copy).
    this.top.sendFrame(buf.subarray(0, this.topBytes));
    this.bottom.sendFrame(buf.subarray(this.topBytes));
  }

  async dispose(): Promise<void> {
    await Promise.all([this.top.dispose(), this.bottom.dispose()]);
  }
}
