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
  // Gamma encoding applied to every output byte. Linear pattern values
  // → perceptually-linear LED brightness. Default 2.2 (sRGB-ish). 1.0 =
  // pass-through. Higher = stretches more PWM range to the bottom (better
  // resolution where the eye is most sensitive).
  //
  // The LUT holds FLOATS and the fractional part is temporally dithered:
  // γ2.2 maps inputs 0..40 onto only ~5 output codes, so slow fades used to
  // step visibly ("stuttery twinkles"). Instead of rounding, each byte
  // flickers between the two adjacent codes with a duty cycle equal to the
  // fraction — the eye integrates it back into the in-between level. The
  // threshold walks a golden-ratio sequence per frame with a per-byte hash
  // offset, so the time-average is exact and neighbors don't blink in sync.
  private gamma = 2.2;
  private gammaLutF: Float32Array = new Float32Array(256);
  private static readonly DITHER_OFFSETS = (() => {
    const a = new Float32Array(1024);
    let h = 2166136261;
    for (let i = 0; i < a.length; i++) {
      h ^= i; h = Math.imul(h, 16777619);
      a[i] = ((h >>> 0) % 65536) / 65536;
    }
    return a;
  })();

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
      this.gammaLutF[i] = Math.pow(i / 255, this.gamma) * 255;
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

  // Per-segment pattern overrides (index-aligned with driver.getSegments()).
  // A null/missing entry falls back to the base pattern — so "same visualizer,
  // different hue/origin per display" is just setPatterns([a, b]).
  private segmentPatterns: (Pattern | null)[] = [];
  setSegmentPatterns(ps: (Pattern | null)[]) {
    this.segmentPatterns = ps;
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
    const segments = this.driver.getSegments?.();
    if (!this.pattern) {
      // Pattern unset — paint black so viewer + lights show black.
      this.buf.fill(0);
    } else if (segments && segments.length) {
      // Physically-separate sub-displays: render each independently against
      // its own [0,1] layout (own centroid), with per-segment pattern params
      // when set. Same tSec for all — stateful patterns (drift accumulators)
      // advance once per tick and stay phase-locked across displays.
      const bus = audioBus();
      const tSec = (Date.now() - this.t0Ms) / 1000;
      const audio = { energy: bus.energy, energyMinMax: bus.energyMinMax, bands: bus.bands, bandsMinMax: bus.bandsMinMax };
      const bpl = this.driver.bytesPerLed;
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const sub = this.buf.subarray(seg.start * bpl, (seg.start + seg.numLeds) * bpl);
        const p = this.segmentPatterns[i] ?? this.pattern;
        const ctx: PatternContext = {
          numLeds: seg.numLeds,
          bytesPerLed: bpl,
          coords: seg.layout?.coords ?? null,
          tSec,
          segment: i,
          audio,
        };
        render(sub, ctx, p);
      }
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
    // Gamma-encode the buffer in place, temporally dithering the fractional
    // part (see the field comment). Skipped at gamma=1.
    if (this.gamma !== 1) {
      const lut = this.gammaLutF;
      const off = FrameLoop.DITHER_OFFSETS;
      const b = this.buf;
      const phase = (this.frameCount * 0.6180339887498949) % 1;
      for (let i = 0; i < b.length; i++) {
        const g = lut[b[i]];
        const base = g | 0;
        // Only dither where the 1-LSB modulation is invisible. At our 30fps
        // the alternation is ~15Hz, and between codes N and N+1 the contrast
        // is ~1/(2N+1) — below N=8 that's >6% at 15Hz on single pixels,
        // which reads as flicker. Down there, plain rounding (tiny, brief
        // steps at near-black) beats a visibly blinking dot.
        if (base < 8) { b[i] = g - base >= 0.5 ? base + 1 : base; continue; }
        let t = phase + off[i & 1023];
        if (t >= 1) t -= 1;
        b[i] = g - base > t ? base + 1 : base;
      }
    }
    // Only ship to the wire when the user has explicitly started streaming.
    if (this.streaming) this.driver.sendFrame(this.buf);
    this.frameCount++;
    this.lastTickMs = Date.now();
  }
}
