// Pattern renderers. Each one fills a Uint8Array of LED bytes (RGB or RGBW
// packed sequentially in strand order). Patterns receive normalized 3D
// coordinates ([0,1] per axis) when the device has been mapped; if no
// coords are available, they fall back to a strand-index-based 1D
// formulation so something still shows up.
//
// All patterns are deterministic functions of (t, params, leds, coords).
// The frame loop in frame-loop.ts drives them.

export interface NormCoord { x: number; y: number; z: number }

export interface PatternContext {
  numLeds: number;
  bytesPerLed: 3 | 4; // RGB or RGBW
  coords: NormCoord[] | null; // null when device hasn't been calibrated
  tSec: number; // elapsed seconds since stream started
  // Which sub-display this render is for (0 when the driver is a single
  // display). Stateful patterns key their motion accumulators on this so
  // two displays with different rates don't share drift state.
  segment?: number;
  // Latest per-stem audio energy from the audio bus. Two normalization
  // views; patterns pick which to read:
  //   energy        — empirical-CDF percentile (uniform on [0,1])
  //   energyMinMax  — robust min-max via p2..p98 (preserves loudness)
  // Plus a 12-band FFT envelope of the equal-weighted stem sum, percentile-
  // mapped per band. Megadrome's eq12 mode uses this.
  // All zero if no audio source is active.
  audio: {
    energy: { drums: number; bass: number; vocals: number; other: number };
    energyMinMax: { drums: number; bass: number; vocals: number; other: number };
    bands: number[];        // length 12 — percentile per band
    bandsMinMax: number[];  // length 12 — robust-minmax per band (p2..p98)
  };
}

// Common: HSV → RGB. Inputs h ∈ [0,360], s/v ∈ [0,1]. Returns 0..255 each.
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
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

function writePixel(out: Uint8Array, i: number, bpl: 3 | 4, r: number, g: number, b: number) {
  const o = i * bpl;
  if (bpl === 4) {
    // RGBW. Twinkly RGBW ordering is W,R,G,B (verified across xled libs).
    out[o] = 0;     // W
    out[o + 1] = r;
    out[o + 2] = g;
    out[o + 3] = b;
  } else {
    // Some Twinkly RGB strings use BGR order; in v3 protocol RGB is just
    // sequential bytes in the order the strip expects. The non-RGBW pixels
    // on family AB are GRB, but the API exposes RGB and the firmware
    // remaps internally for the RT path. Treat as RGB.
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
  }
}

// --- Patterns ---

export interface SolidParams { kind: 'solid'; hue: number; sat: number; val: number }
export function renderSolid(out: Uint8Array, ctx: PatternContext, p: SolidParams) {
  const [r, g, b] = hsvToRgb(p.hue, p.sat, p.val);
  for (let i = 0; i < ctx.numLeds; i++) writePixel(out, i, ctx.bytesPerLed, r, g, b);
}

export interface GradientParams {
  kind: 'gradient';
  axis: 'x' | 'y' | 'z' | 'index'; // which axis the gradient sweeps along
  hueStart: number;
  hueEnd: number;
  sat: number;
  val: number;
  speed: number; // hue offset rotations per second (negative = reverse)
}
export function renderGradient(out: Uint8Array, ctx: PatternContext, p: GradientParams) {
  const hueShift = (p.speed * ctx.tSec * 360) % 360;
  for (let i = 0; i < ctx.numLeds; i++) {
    let u: number; // [0,1] position along chosen axis
    if (p.axis === 'index' || !ctx.coords) {
      u = i / Math.max(1, ctx.numLeds - 1);
    } else {
      u = ctx.coords[i][p.axis];
    }
    const h = p.hueStart + (p.hueEnd - p.hueStart) * u + hueShift;
    const [r, g, b] = hsvToRgb(h, p.sat, p.val);
    writePixel(out, i, ctx.bytesPerLed, r, g, b);
  }
}

// Lightweight 3D value-noise (not "real" Perlin gradient noise — close
// enough visually for ambient color fields, no LUT setup).
function hash3(ix: number, iy: number, iz: number): number {
  let h = (ix * 374761393) ^ (iy * 668265263) ^ (iz * 2147483647);
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295; // [0,1)
}
function smoothstep(t: number): number { return t * t * (3 - 2 * t); }

function hash4(ix: number, iy: number, iz: number, iw: number): number {
  let h = (ix * 374761393) ^ (iy * 668265263) ^ (iz * 2147483647) ^ (iw * 1597334677);
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}

// 4D value noise — quadrilinear interpolation of 16 hashed lattice corners.
// Used by megadrome to feed inner noise into the outer 4th coordinate.
function valueNoise4(x: number, y: number, z: number, w: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z), iw = Math.floor(w);
  const fx = x - ix, fy = y - iy, fz = z - iz, fw = w - iw;
  const sx = smoothstep(fx), sy = smoothstep(fy), sz = smoothstep(fz), sw = smoothstep(fw);
  // 16 corners — naming convention cWXYZ where W,X,Y,Z ∈ {0,1} for each axis offset
  const c0000 = hash4(ix,     iy,     iz,     iw);
  const c1000 = hash4(ix + 1, iy,     iz,     iw);
  const c0100 = hash4(ix,     iy + 1, iz,     iw);
  const c1100 = hash4(ix + 1, iy + 1, iz,     iw);
  const c0010 = hash4(ix,     iy,     iz + 1, iw);
  const c1010 = hash4(ix + 1, iy,     iz + 1, iw);
  const c0110 = hash4(ix,     iy + 1, iz + 1, iw);
  const c1110 = hash4(ix + 1, iy + 1, iz + 1, iw);
  const c0001 = hash4(ix,     iy,     iz,     iw + 1);
  const c1001 = hash4(ix + 1, iy,     iz,     iw + 1);
  const c0101 = hash4(ix,     iy + 1, iz,     iw + 1);
  const c1101 = hash4(ix + 1, iy + 1, iz,     iw + 1);
  const c0011 = hash4(ix,     iy,     iz + 1, iw + 1);
  const c1011 = hash4(ix + 1, iy,     iz + 1, iw + 1);
  const c0111 = hash4(ix,     iy + 1, iz + 1, iw + 1);
  const c1111 = hash4(ix + 1, iy + 1, iz + 1, iw + 1);
  // x
  const x000 = c0000 + (c1000 - c0000) * sx;
  const x100 = c0100 + (c1100 - c0100) * sx;
  const x010 = c0010 + (c1010 - c0010) * sx;
  const x110 = c0110 + (c1110 - c0110) * sx;
  const x001 = c0001 + (c1001 - c0001) * sx;
  const x101 = c0101 + (c1101 - c0101) * sx;
  const x011 = c0011 + (c1011 - c0011) * sx;
  const x111 = c0111 + (c1111 - c0111) * sx;
  // y
  const y00 = x000 + (x100 - x000) * sy;
  const y10 = x010 + (x110 - x010) * sy;
  const y01 = x001 + (x101 - x001) * sy;
  const y11 = x011 + (x111 - x011) * sy;
  // z
  const z0 = y00 + (y10 - y00) * sz;
  const z1 = y01 + (y11 - y01) * sz;
  // w
  return z0 + (z1 - z0) * sw;
}

function valueNoise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const sx = smoothstep(fx), sy = smoothstep(fy), sz = smoothstep(fz);
  const c000 = hash3(ix,     iy,     iz);
  const c100 = hash3(ix + 1, iy,     iz);
  const c010 = hash3(ix,     iy + 1, iz);
  const c110 = hash3(ix + 1, iy + 1, iz);
  const c001 = hash3(ix,     iy,     iz + 1);
  const c101 = hash3(ix + 1, iy,     iz + 1);
  const c011 = hash3(ix,     iy + 1, iz + 1);
  const c111 = hash3(ix + 1, iy + 1, iz + 1);
  const x00 = c000 + (c100 - c000) * sx;
  const x10 = c010 + (c110 - c010) * sx;
  const x01 = c001 + (c101 - c001) * sx;
  const x11 = c011 + (c111 - c011) * sx;
  const y0 = x00 + (x10 - x00) * sy;
  const y1 = x01 + (x11 - x01) * sy;
  return y0 + (y1 - y0) * sz;
}

export interface PerlinParams {
  kind: 'perlin';
  scale: number;   // spatial frequency (higher = finer detail)
  speed: number;   // in-place "boil" rate (field morphs without moving)
  // Directional drift: the whole field floats across the display.
  floatSpeed?: number; // drift rate (normalized units/sec)
  floatDir?: number;   // drift heading, degrees (0 = +x / right)
  // Slow rotation of the field around the display center.
  spinSpeed?: number;  // revolutions/sec
  hueRange: number; // span of hues to paint, in degrees (e.g. 60 for analogous, 360 for rainbow)
  hueCenter: number; // base hue
  sat: number;
  val: number;
}

// Accumulated "distance moved" for perlin — boil phase, drift offset, and spin
// angle integrate the slider rates over real elapsed time. Because we
// accumulate (rather than compute speed×tSec), changing a slider just changes
// the RATE from here on, so the field never jumps. Module-level so it persists
// across frames (only one pattern runs at a time).
// Keyed by ctx.segment so independent displays (each rendered every tick
// with their own params) each integrate their own rates.
interface MotionState { lastT: number; boil: number; driftX: number; driftY: number; spin: number; dScroll: number }
function motionState(map: Map<number, MotionState>, segment: number): MotionState {
  let st = map.get(segment);
  if (!st) { st = { lastT: 0, boil: 0, driftX: 0, driftY: 0, spin: 0, dScroll: 0 }; map.set(segment, st); }
  return st;
}
const pnMotion = new Map<number, MotionState>();
// Separate map for megadrome so switching patterns doesn't share drift state.
const mdMotion = new Map<number, MotionState>();

export function renderPerlin(out: Uint8Array, ctx: PatternContext, p: PerlinParams) {
  const st = motionState(pnMotion, ctx.segment ?? 0);
  // Static per-display offset: shoves each display into a far-apart region
  // of the noise field so two displays never show the same image, even with
  // identical params and zero drift.
  const segOff = (ctx.segment ?? 0) * 997.7;
  // Advance accumulators by the real frame delta. Guard against the first
  // frame, stream restarts (tSec resets → negative), and long pauses.
  let dt = ctx.tSec - st.lastT;
  st.lastT = ctx.tSec;
  if (!(dt > 0) || dt > 0.5) dt = 0;
  const dirRad = ((p.floatDir ?? 0) * Math.PI) / 180;
  st.boil   += (p.speed ?? 0) * dt;
  st.driftX += Math.cos(dirRad) * (p.floatSpeed ?? 0) * dt;
  st.driftY += Math.sin(dirRad) * (p.floatSpeed ?? 0) * dt;
  st.spin    = (st.spin + (p.spinSpeed ?? 0) * dt * 2 * Math.PI) % (2 * Math.PI);

  const cx = 0.5, cy = 0.5;            // spin/drift origin = display center
  const cs = Math.cos(st.spin), sn = Math.sin(st.spin);
  for (let i = 0; i < ctx.numLeds; i++) {
    let bx: number, by: number, bz: number;
    if (ctx.coords) {
      const c = ctx.coords[i];
      bx = c.x; by = c.y; bz = c.z;
    } else {
      bx = i / Math.max(1, ctx.numLeds - 1); by = 0; bz = 0;
    }
    // Rotate the sample point around the center, then translate by the drift.
    const ox = bx - cx, oy = by - cy;
    const x = (cx + ox * cs - oy * sn + st.driftX + segOff) * p.scale;
    const y = (cy + ox * sn + oy * cs + st.driftY + segOff) * p.scale;
    const z = bz * p.scale + st.boil;   // boil = walk through the field's z
    const n = valueNoise3(x, y, z);
    const h = p.hueCenter + (n - 0.5) * p.hueRange;
    const [r, g, b] = hsvToRgb(h, p.sat, p.val);
    writePixel(out, i, ctx.bytesPerLed, r, g, b);
  }
}

// Planes sweeping through the sculpture. Two directions:
//   'up'     — every plane has normal (0,1,0) and travels y=0 → y=1.
//   'random' — each plane's normal is a deterministic-random point on
//              the unit sphere (seeded by spawn index, so it's still
//              reproducible across reconnects). Travels offset=-1 → +1
//              along its own normal, sweeping through the centroid.
// LED brightness = max over active planes of a softness falloff vs.
// distance to that plane. Mostly-dark by design.
//
// All math is deterministic on time — no random state held across frames.
export interface PlanesParams {
  kind: 'planes';
  direction: 'up' | 'random';
  hue: number;       // 0–360
  sat: number;       // 0–1
  val: number;       // 0–1, peak brightness of a plane
  speed: number;     // distance (in normalized-coord units) per second
  spawnRate: number; // planes per second
  thickness: number; // span the plane covers along its normal, 0–1
  softness: number;  // 0 = hard slab, →1 = soft gaussian-ish edge
}

// Deterministic uniform point on the unit sphere, seeded by spawn index.
// Uses two hashes for (azimuth, polar) — produces a stable normal per
// spawn so a plane that started before reconnect keeps its direction.
function unitNormalForSpawn(n: number): [number, number, number] {
  const u = hash3(n, 13, 7);
  const v = hash3(n, 31, 11);
  const theta = 2 * Math.PI * u;
  const cosphi = 2 * v - 1;
  const sinphi = Math.sqrt(Math.max(0, 1 - cosphi * cosphi));
  return [sinphi * Math.cos(theta), sinphi * Math.sin(theta), cosphi];
}

export function renderPlanes(out: Uint8Array, ctx: PatternContext, p: PlanesParams) {
  const [rOn, gOn, bOn] = hsvToRgb(p.hue, p.sat, p.val);
  const halfThick = Math.max(0.001, p.thickness * 0.5);
  const spawnPeriod = 1 / Math.max(0.01, p.spawnRate);
  const softK = Math.max(0.05, p.softness);

  // Total distance a plane travels from spawn until fully off the far side.
  // - up: 0..1 along y, plus a little for the trailing fade
  // - random: -1..+1 along its normal (covers the unit cube + buffer)
  const span = p.direction === 'up' ? (1 + halfThick) : (2 + halfThick);
  const maxAge = span / Math.max(0.001, p.speed);
  const tMin = Math.max(0, ctx.tSec - maxAge);
  const nMin = Math.ceil(tMin / spawnPeriod);
  const nMax = Math.floor(ctx.tSec / spawnPeriod);

  // Precompute each active plane's normal + current offset along that
  // normal, so the inner LED loop doesn't re-hash N times per LED.
  const planeCount = Math.max(0, nMax - nMin + 1);
  const normals = new Float32Array(planeCount * 3);
  const offsets = new Float32Array(planeCount);
  for (let k = 0; k < planeCount; k++) {
    const n = nMin + k;
    const tSpawn = n * spawnPeriod;
    const progress = (ctx.tSec - tSpawn) * p.speed;
    if (p.direction === 'up') {
      normals[k * 3 + 0] = 0;
      normals[k * 3 + 1] = 1;
      normals[k * 3 + 2] = 0;
      // For 'up', offset is the plane's y position; LED offset = yLed.
      offsets[k] = progress;
    } else {
      const [nx, ny, nz] = unitNormalForSpawn(n);
      normals[k * 3 + 0] = nx;
      normals[k * 3 + 1] = ny;
      normals[k * 3 + 2] = nz;
      // For 'random', offset is along the normal from the centroid
      // (0.5,0.5,0.5). Start at -1, end at +1.
      offsets[k] = -1 + progress;
    }
  }

  for (let i = 0; i < ctx.numLeds; i++) {
    let xLed: number, yLed: number, zLed: number;
    if (ctx.coords) {
      const c = ctx.coords[i];
      xLed = c.x; yLed = c.y; zLed = c.z;
    } else {
      const u = i / Math.max(1, ctx.numLeds - 1);
      xLed = 0.5; yLed = u; zLed = 0.5;
    }
    let bri = 0;
    for (let k = 0; k < planeCount; k++) {
      let ledOffset: number;
      if (p.direction === 'up') {
        ledOffset = yLed;
      } else {
        // Signed distance from centroid along this plane's normal
        ledOffset =
          (xLed - 0.5) * normals[k * 3] +
          (yLed - 0.5) * normals[k * 3 + 1] +
          (zLed - 0.5) * normals[k * 3 + 2];
      }
      const d = Math.abs(ledOffset - offsets[k]);
      if (d > halfThick) continue;
      const u = d / halfThick;
      const fall = p.softness <= 0.001 ? 1 : Math.exp(-(u * u) / (softK * softK));
      if (fall > bri) bri = fall;
    }
    if (bri <= 0) {
      writePixel(out, i, ctx.bytesPerLed, 0, 0, 0);
    } else {
      writePixel(out, i, ctx.bytesPerLed,
        Math.round(rOn * bri),
        Math.round(gOn * bri),
        Math.round(bOn * bri));
    }
  }
}

// Faithful 3D port of megadrome2.js.
//   - Nested 3D-into-4D noise gives each LED a `cum ∈ [0,1]`.
//   - `proportionalCumOctaveMap`: cum is binned into one of N+1 bands,
//     with band widths proportional to that band's current energy (+ gain).
//     Last bucket is a "deadzone" so silence/quiet sections naturally
//     have unlit LEDs.
//   - LED brightness = its assigned band's energy. LEDs in the deadzone
//     bucket render black. Result: louder bands claim more LEDs and those
//     LEDs are brighter.
//   - Hue is per-band (megadrome's `octaveHueMap((octave+1)/N)`) — all
//     LEDs in a band share one hue.
//   - Bass-radial pulse: bass stem energy shifts the radial noise coord
//     inward, making the noise field appear to expand outward when bass
//     hits. Same mechanic as megadrome's PULSE_SIZE, with real bass stem
//     instead of FFT-band-derived bass.
//
// For now the "bands" are the 4 stems (drums/bass/vocals/other). A future
// FFT-bands mode would feed the same proportional-cum-mapping code from
// per-chunk frequency-band energies instead of stem energies.
export interface MegadromeParams {
  kind: 'megadrome';
  // Which audio-bus view drives band weights, brightness, and bass pulse.
  //   'percentile'    — uniform-on-[0,1] (every song lights up the same average amount)
  //   'robust-minmax' — p2..p98 bounded (quiet sections actually read as quiet)
  normMode: 'percentile' | 'robust-minmax';
  // What populates the cum→band mapping:
  //   'stems' — 4 stems (drums/bass/vocals/other) as bands. Our adaptation.
  //   'eq12'  — 12 log-spaced FFT bands on the combined stem sum. Matches
  //             the original megadrome algorithm. Requires musicbox track
  //             envelope (synth source → all bands silent).
  bandMode: 'stems' | 'eq12';
  originX: number;     // pixel-space origin (0..1)
  originY: number;
  originZ: number;
  rotationScalar: number;  // ROTATION_SCALAR — outer noise xy frequency
  dScalar: number;         // D_SCALAR — outer noise radial frequency
  d2Scalar: number;        // D2_SCALAR — inner noise radial frequency
  noise2PosScalar: number; // NOISE2_POS_SCALAR — inner noise xy frequency
  noise2Scalar: number;    // NOISE2_SCALAR — how much inner noise modulates outer's 4th axis
  pulseSize: number;       // PULSE_SIZE — multiplier on bass energy → radial shift
  hueOffset: number;       // HUE_OFFSET (degrees)
  hueRange: number;        // HUE_RANGE (degrees)
  sat: number;
  val: number;             // peak brightness when band energy = 1
  baseline: number;        // floor brightness so silence isn't pitch black if desired
  // PROPORTION_GAIN — added to every band weight in the cum mapping.
  // Negative pushes quiet bands toward the deadzone (more dark); positive
  // flattens the distribution (more uniform band shares).
  propGain: number;
  // PROPORTION_DEADZONE — fixed weight on an extra "black" bucket.
  // Higher → more LEDs land in deadzone (more dark space, especially during
  // silence). 0 = no deadzone, every LED always gets a stem band.
  propDeadzone: number;
  // Post-normalization gain. Only applied when normMode === 'robust-minmax'
  // (percentile mode is already uniform on [0,1] and doesn't need it).
  // Multiplies each stem's value before band weighting + brightness, clamped
  // to [0,1]. Default 1.0. Use > 1 to push more LEDs into bright regions,
  // < 1 to keep the show more subdued.
  minMaxGain: number;
  // Spatial motion (megadrome is otherwise static — only the audio pulse moves
  // it). Directional drift + slow spin around the origin, accumulated so slider
  // changes adjust the rate without jumping the field.
  floatSpeed?: number; // drift rate (normalized units/sec)
  floatDir?: number;   // drift heading, degrees (0 = +x / right)
  spinSpeed?: number;  // revolutions/sec around the origin
  dSpeed?: number;     // radial-distance scroll rate (units/sec, +/- = out/in)
}

const MD_NUM_BANDS = 4;     // drums, bass, vocals, other
const MD_NUM_BUCKETS = 5;   // 4 bands + 1 deadzone

export function renderMegadrome(out: Uint8Array, ctx: PatternContext, p: MegadromeParams) {
  // Build the band energy array + bass pulse signal based on bandMode.
  // stems mode: 4 stems (drums/bass/vocals/other). normMode toggles
  //   between percentile and robust-minmax × user gain.
  // eq12 mode:  12 percentile-mapped FFT bands of the equal-weighted
  //   stem sum. Bass pulse uses megadrome's classic weighted-low-band
  //   sum (bands 0..4 with a tent centered on band 2) — matches the
  //   original `getPulseSize` weighting on octave indices.
  let bandEnergies: number[];
  let bassPulse: number;
  if (p.bandMode === 'eq12') {
    // eq12 honors normMode just like stems: percentile (uniform CDF) vs
    // robust-minmax (p2..p98 bounded). minMaxGain applies in robust-minmax
    // mode the same way it does for stems — multiply then clamp to [0,1].
    const src = p.normMode === 'robust-minmax' ? ctx.audio.bandsMinMax : ctx.audio.bands;
    const g = p.normMode === 'robust-minmax' ? p.minMaxGain : 1;
    bandEnergies = new Array(src.length);
    for (let b = 0; b < src.length; b++) bandEnergies[b] = Math.min(1, src[b] * g);
    const bb = bandEnergies;
    bassPulse = (bb[0] * 0.1 + bb[1] * 0.4 + bb[2] * 0.6 + bb[3] * 0.4 + bb[4] * 0.1) * p.pulseSize;
  } else {
    const src = p.normMode === 'robust-minmax' ? ctx.audio.energyMinMax : ctx.audio.energy;
    const g = p.normMode === 'robust-minmax' ? p.minMaxGain : 1;
    bandEnergies = [
      Math.min(1, src.drums  * g),
      Math.min(1, src.bass   * g),
      Math.min(1, src.vocals * g),
      Math.min(1, src.other  * g),
    ];
    // Bass pulse normally rides the bass stem. But for a track with no
    // stems (stems zero-filled — e.g. a no-Demucs download), the bass stem
    // is always 0 and the pulse would die. When all stems read silent, fall
    // back to the low FFT bands (same weighting eq12 uses) so the radial
    // pulse still works off the bass frequencies. ctx.audio.bands is always
    // populated regardless of bandMode.
    const stemsSilent = bandEnergies.every((e) => e < 1e-4);
    if (stemsSilent) {
      const bb = ctx.audio.bands;
      bassPulse = (bb[0] * 0.1 + bb[1] * 0.4 + bb[2] * 0.6 + bb[3] * 0.4 + bb[4] * 0.1) * p.pulseSize;
    } else {
      bassPulse = bandEnergies[1] * p.pulseSize; // bass stem
    }
  }
  const N = bandEnergies.length;

  // Proportional weights for each real band + a deadzone bucket. The
  // cumulative thresholds partition [0,1] proportionally to weight;
  // an LED's `cum` (noise output) picks whichever bucket it falls into.
  // wSum=0 (full silence + no deadzone weight) → all LEDs land in deadzone.
  const weights = new Array<number>(N);
  let wSum = 0;
  for (let b = 0; b < N; b++) {
    weights[b] = Math.max(bandEnergies[b] + p.propGain, 0);
    wSum += weights[b];
  }
  wSum += Math.max(p.propDeadzone + p.propGain, 0);
  const cumThresh = new Array<number>(N);
  {
    let acc = 0;
    for (let b = 0; b < N; b++) {
      acc += wSum > 0 ? weights[b] / wSum : 0;
      cumThresh[b] = acc;
    }
  }

  // Per-band hue — same megadrome formula `(octave+1)/N` × hueRange.
  const bandHues = new Array<number>(N);
  for (let b = 0; b < N; b++) {
    // band 0 (lowest freq / bass in eq12) sits exactly at hueOffset; higher
    // bands fan out across hueRange from there.
    bandHues[b] = ((p.hueOffset + (b / N) * p.hueRange) % 360 + 360) % 360;
  }

  const st = motionState(mdMotion, ctx.segment ?? 0);
  // Static per-display offset — same trick as perlin: each display samples a
  // far-apart region of the noise field, so identical params still give
  // completely different (but same-character) imagery.
  const segOff = (ctx.segment ?? 0) * 997.7;
  // Advance spatial-motion accumulators by real elapsed dt so changing a slider
  // adjusts the rate without jumping the field. Guard first frame / reset / pause.
  {
    let dt = ctx.tSec - st.lastT;
    st.lastT = ctx.tSec;
    if (!(dt > 0) || dt > 0.5) dt = 0;
    const dirRad = ((p.floatDir ?? 0) * Math.PI) / 180;
    st.driftX += Math.cos(dirRad) * (p.floatSpeed ?? 0) * dt;
    st.driftY += Math.sin(dirRad) * (p.floatSpeed ?? 0) * dt;
    st.spin = (st.spin + (p.spinSpeed ?? 0) * dt * 2 * Math.PI) % (2 * Math.PI);
    st.dScroll += (p.dSpeed ?? 0) * dt;
  }
  const mdCos = Math.cos(st.spin), mdSin = Math.sin(st.spin);

  for (let i = 0; i < ctx.numLeds; i++) {
    let cx: number, cy: number, cz: number;
    if (ctx.coords) {
      const c = ctx.coords[i];
      cx = c.x - p.originX;
      cy = c.y - p.originY;
      cz = c.z - p.originZ;
    } else {
      const u = i / Math.max(1, ctx.numLeds - 1);
      cx = u - p.originX;
      cy = 0.5 - p.originY;
      cz = 0.5 - p.originZ;
    }
    // Spin around the origin (radial is invariant), then drift the field.
    { const rx = cx * mdCos - cy * mdSin; const ry = cx * mdSin + cy * mdCos; cx = rx + st.driftX + segOff; cy = ry + st.driftY + segOff; }
    const radial = Math.sqrt(cx * cx + cy * cy + cz * cz);

    const inner = valueNoise3(
      cx * p.noise2PosScalar,
      cy * p.noise2PosScalar,
      radial * p.d2Scalar - bassPulse + st.dScroll,
    );
    const cum = valueNoise4(
      cx * p.rotationScalar,
      radial * p.dScalar - bassPulse + st.dScroll,
      cy * p.rotationScalar,
      inner * p.noise2Scalar,
    );

    // Pick band whose cumulative threshold contains cum. Linear scan over
    // at most N+1=13 entries — negligible vs the noise compute.
    let band = N; // deadzone fallback
    for (let b = 0; b < N; b++) {
      if (cum < cumThresh[b]) { band = b; break; }
    }
    if (band === N) {
      writePixel(out, i, ctx.bytesPerLed, 0, 0, 0);
      continue;
    }
    const bri = Math.max(0, Math.min(1, p.baseline + bandEnergies[band] * p.val));
    const [r, g, b] = hsvToRgb(bandHues[band], p.sat, bri);
    writePixel(out, i, ctx.bytesPerLed, r, g, b);
  }
}

// Sparse dots that slowly fade in and out, desynchronized per LED. Each LED
// runs its own fade cycle: per (led, cycle) a hash decides whether the LED
// lights this cycle (density) and where in the cycle it starts (phase), so
// dots appear at ever-shifting spots with no stored state — deterministic on
// time, like the other patterns.
export interface TwinkleParams {
  kind: 'twinkle';
  hue: number;      // 0–360 (amber ≈ 35)
  sat: number;      // 0–1
  val: number;      // 0–1, peak brightness of a dot
  density: number;  // 0–1, expected fraction of LEDs lit at any moment
  period: number;   // seconds for one full fade-in → fade-out
  hueJitter: number; // ± degrees of per-dot hue variation (0 = uniform)
}
export function renderTwinkle(out: Uint8Array, ctx: PatternContext, p: TwinkleParams) {
  const period = Math.max(0.5, p.period);
  const density = Math.max(0, Math.min(1, p.density));
  const seg = (ctx.segment ?? 0) * 7919; // decorrelate stacked displays
  for (let i = 0; i < ctx.numLeds; i++) {
    // Per-LED phase offset so fades don't happen in lockstep.
    const phase = hash3(i, 101, seg);
    const cycles = ctx.tSec / period + phase;
    const n = Math.floor(cycles);
    const u = cycles - n; // position within this LED's current cycle, [0,1)
    // Lit this cycle? Independent draw per (led, cycle).
    if (hash3(i, n, seg + 1) >= density) {
      writePixel(out, i, ctx.bytesPerLed, 0, 0, 0);
      continue;
    }
    // Smooth in/out envelope over the cycle.
    const env = Math.sin(Math.PI * u);
    const h = p.hue + (hash3(i, n, seg + 2) - 0.5) * 2 * p.hueJitter;
    const [r, g, b] = hsvToRgb(h, p.sat, p.val * env * env);
    writePixel(out, i, ctx.bytesPerLed, r, g, b);
  }
}

export interface StrobeParams {
  kind: 'strobe';
  hue: number;
  sat: number;
  val: number; // on-state brightness
  hz: number;  // flashes per second
  duty: number; // 0..1 fraction of cycle that's "on"
}
export function renderStrobe(out: Uint8Array, ctx: PatternContext, p: StrobeParams) {
  const phase = (ctx.tSec * p.hz) % 1;
  const on = phase < p.duty;
  const [r, g, b] = on ? hsvToRgb(p.hue, p.sat, p.val) : [0, 0, 0];
  for (let i = 0; i < ctx.numLeds; i++) writePixel(out, i, ctx.bytesPerLed, r, g, b);
}

// Orientation debug: lights a single distinct-colored pixel in each corner of
// each vertical half of the display (so a stacked rig shows both boxes). The
// corner color scheme is fixed — TL=red, TR=green, BL=blue, BR=yellow — so you
// can read off any flip/rotation by comparing the physical curtain to the
// preview (which shows the true, pre-driver orientation).
export interface DebugCornersParams { kind: 'debugcorners' }
export function renderDebugCorners(out: Uint8Array, ctx: PatternContext, _p: DebugCornersParams) {
  const bpl = ctx.bytesPerLed;
  const N = ctx.numLeds;
  for (let i = 0; i < N; i++) writePixel(out, i, bpl, 0, 0, 0); // black field

  const coords = ctx.coords;
  if (!coords || N === 0) return;
  // Recover matrix width: row-major, so y is constant within a row; W = run
  // length of the first row. H falls out of N/W.
  let W = 1;
  while (W < N && coords[W].y === coords[0].y) W++;
  const H = Math.floor(N / W);
  if (W < 2 || H < 2) return;

  // Two stacked halves (top = couch1 rows, bottom = window rows). For a single
  // box H/2 still works — you just get two banded sets of corners.
  const halfH = Math.floor(H / 2);
  const mark = (row: number, col: number, r: number, g: number, b: number) => {
    const i = row * W + col;
    if (i >= 0 && i < N) writePixel(out, i, bpl, r, g, b);
  };
  const halves: [number, number][] = [[0, halfH - 1], [halfH, H - 1]];
  for (const [top, bot] of halves) {
    mark(top, 0, 255, 0, 0);       // TL red
    mark(top, W - 1, 0, 255, 0);   // TR green
    mark(bot, 0, 0, 0, 255);       // BL blue
    mark(bot, W - 1, 255, 255, 0); // BR yellow
  }
}

// Union for dispatch
export type Pattern =
  | SolidParams | GradientParams | PerlinParams | PlanesParams | StrobeParams | MegadromeParams
  | TwinkleParams | DebugCornersParams;

export function render(out: Uint8Array, ctx: PatternContext, p: Pattern) {
  switch (p.kind) {
    case 'solid':     return renderSolid(out, ctx, p);
    case 'gradient':  return renderGradient(out, ctx, p);
    case 'perlin':    return renderPerlin(out, ctx, p);
    case 'planes':    return renderPlanes(out, ctx, p);
    case 'strobe':    return renderStrobe(out, ctx, p);
    case 'twinkle':   return renderTwinkle(out, ctx, p);
    case 'megadrome': return renderMegadrome(out, ctx, p);
    case 'debugcorners': return renderDebugCorners(out, ctx, p);
  }
}
