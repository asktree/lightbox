// Frame loop: renders the active pattern at the target rate. UDP send is
// gated on `streaming` so the same compute drives both:
//   - the 3D preview viewer (always),
//   - the actual LED stream (only when start() has been called).
// Lives entirely on the server — the client only sends pattern/param
// updates, never per-frame data.

import type { LedDriver } from './led-driver.js';
import { type Pattern, type PatternContext, render } from './patterns.js';
import { audioBus } from './audio-bus.js';
import { tickFollower } from './musicbox-follower.js';

export class FrameLoop {
  private driver: LedDriver;
  private pattern: Pattern | null = null;
  // Default 30 fps: matches WLED's WS281x ceiling for ~1000-LED chains
  // (~30 ms wire time per frame at 800 kHz) and is well within Twinkly's
  // native 28 fps. Users can crank via setHz up to 60.
  private targetHz = 30;
  // streaming = whether we ship frames over the wire. The pattern compute
  // (and viewer buffer update) is always running.
  private streaming = false;
  private timer: NodeJS.Timeout | null = null;
  private buf: Uint8Array;
  private t0Ms = Date.now();
  private frameCount = 0;
  private lastTickMs = 0;
  // Gamma encoding LUT applied to every output byte. Linear pattern values
  // → perceptually-linear LED brightness. Default 2.2 (sRGB-ish). 1.0 =
  // pass-through. Higher = stretches more PWM range to the bottom (better
  // resolution where the eye is most sensitive).
  private gamma = 2.2;
  private gammaLut: Uint8Array = new Uint8Array(256);

  constructor(driver: LedDriver) {
    this.driver = driver;
    this.buf = new Uint8Array(driver.numLeds * driver.bytesPerLed);
    this.rebuildGammaLut();
    // Start the compute loop immediately. Wire send stays off until
    // start() is called — so the viewer mirrors the pattern without
    // touching the actual lights.
    this.startTimer();
  }

  private startTimer() {
    if (this.timer) return;
    const periodMs = 1000 / this.targetHz;
    this.timer = setInterval(() => this.tick(), periodMs);
  }

  private rebuildGammaLut() {
    for (let i = 0; i < 256; i++) {
      this.gammaLut[i] = Math.round(Math.pow(i / 255, this.gamma) * 255);
    }
  }
  setGamma(g: number) {
    this.gamma = Math.max(0.1, Math.min(30, g));
    this.rebuildGammaLut();
  }
  getGamma() { return this.gamma; }

  setPattern(p: Pattern | null) {
    this.pattern = p;
  }

  setHz(hz: number) {
    this.targetHz = Math.max(1, Math.min(60, hz));
    // Rebuild the timer at the new period (always-on).
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.startTimer();
  }

  isRunning() { return this.streaming; }
  getFrame(): Uint8Array { return this.buf; }
  getStats() {
    return {
      running: this.streaming,
      hz: this.targetHz,
      frameCount: this.frameCount,
      patternKind: this.pattern?.kind ?? null,
    };
  }

  // Flip streaming ON. Hands the driver responsibility for entering
  // whatever "accept my frames" mode it needs (Twinkly RT, WLED auto).
  async start() {
    if (this.streaming) return;
    await this.driver.startStreaming();
    this.streaming = true;
  }

  // Flip streaming OFF. Pattern compute keeps running for the viewer.
  // Driver hands control back to its built-in behavior.
  async stop() {
    if (!this.streaming) return;
    this.streaming = false;
    try { await this.driver.stopStreaming(); } catch { /* best-effort */ }
  }

  private tick() {
    // Pull latest playback state from musicbox into the audio bus before
    // we render. Cheap (binary search + a few mults) and keeps pattern
    // code agnostic to where the audio comes from.
    tickFollower();
    if (!this.pattern) {
      // Pattern unset — paint black so viewer + lights show black.
      this.buf.fill(0);
    } else {
      const bus = audioBus();
      const layout = this.driver.getLayout();
      const ctx: PatternContext = {
        numLeds: this.driver.numLeds,
        bytesPerLed: this.driver.bytesPerLed,
        coords: layout?.coords ?? null,
        tSec: (Date.now() - this.t0Ms) / 1000,
        audio: { energy: bus.energy, energyMinMax: bus.energyMinMax, bands: bus.bands, bandsMinMax: bus.bandsMinMax },
      };
      render(this.buf, ctx, this.pattern);
    }
    // Gamma-encode the buffer in place if a non-unity gamma is set.
    // Skipped at gamma=1 to avoid the loop overhead in that case.
    if (this.gamma !== 1) {
      const lut = this.gammaLut;
      const b = this.buf;
      for (let i = 0; i < b.length; i++) b[i] = lut[b[i]];
    }
    // Only ship to the wire when the user has explicitly started streaming.
    if (this.streaming) this.driver.sendFrame(this.buf);
    this.frameCount++;
    this.lastTickMs = Date.now();
  }
}
