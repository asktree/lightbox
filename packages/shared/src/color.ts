/**
 * Colour maths for lightbox. The canonical colour of a light is a CIE 1931
 * chromaticity (x, y). Everything else — sRGB for WiZ/Tuya/Govee, HSV for
 * legacy inputs, Kelvin for whites — is converted here, at the edges.
 */

export interface XY { x: number; y: number; }
export interface RGB { r: number; g: number; b: number; }   // 0-1, sRGB (gamma-encoded)

/** A gamut triangle in xy space. */
export interface Gamut { r: XY; g: XY; b: XY; }

export const D65: XY = { x: 0.3127, y: 0.329 };

export const GAMUTS = {
  /** Philips Hue Gamut C (all current colour bulbs) */
  hueC: { r: { x: 0.6915, y: 0.3083 }, g: { x: 0.17, y: 0.7 }, b: { x: 0.1532, y: 0.0475 } } as Gamut,
  /** Philips Hue Gamut A (original 2012 bulbs, LivingColors) */
  hueA: { r: { x: 0.704, y: 0.296 }, g: { x: 0.2151, y: 0.7106 }, b: { x: 0.138, y: 0.08 } } as Gamut,
  /** Philips Hue Gamut B (2nd-gen A19 bulbs) */
  hueB: { r: { x: 0.675, y: 0.322 }, g: { x: 0.409, y: 0.518 }, b: { x: 0.167, y: 0.04 } } as Gamut,
  /** sRGB / Rec.709 primaries — what RGB-driven bulbs (WiZ, Tuya, Govee) approximate */
  srgb: { r: { x: 0.64, y: 0.33 }, g: { x: 0.3, y: 0.6 }, b: { x: 0.15, y: 0.06 } } as Gamut,
};

// ---------------------------------------------------------------------------
// xy <-> sRGB
// ---------------------------------------------------------------------------

function gammaEncode(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
function gammaDecode(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Linear-light sRGB from xy with luminance Y. May return values outside 0-1. */
export function xyToLinearRgb(xy: XY, Y = 1): RGB {
  const y = Math.max(xy.y, 1e-6);
  const X = (Y / y) * xy.x;
  const Z = (Y / y) * (1 - xy.x - xy.y);
  return {
    r: X * 3.2406 + Y * -1.5372 + Z * -0.4986,
    g: X * -0.9689 + Y * 1.8758 + Z * 0.0415,
    b: X * 0.0557 + Y * -0.204 + Z * 1.057,
  };
}

/**
 * Display colour for a chromaticity: the brightest sRGB colour of that hue.
 * Out-of-gamut chromaticities are clamped (negative channels -> 0) then
 * normalised so the brightest channel is 1. Good for painting UIs and for
 * driving RGB bulbs, which only care about the ratio between channels.
 */
export function xyToRgb(xy: XY): RGB {
  let { r, g, b } = xyToLinearRgb(xy);
  r = Math.max(0, r); g = Math.max(0, g); b = Math.max(0, b);
  const m = Math.max(r, g, b, 1e-6);
  return { r: gammaEncode(r / m), g: gammaEncode(g / m), b: gammaEncode(b / m) };
}

/** Chromaticity of an sRGB colour (0-1 channels). Black -> D65. */
export function rgbToXy(rgb: RGB): XY {
  const r = gammaDecode(rgb.r), g = gammaDecode(rgb.g), b = gammaDecode(rgb.b);
  const X = r * 0.4124 + g * 0.3576 + b * 0.1805;
  const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const Z = r * 0.0193 + g * 0.1192 + b * 0.9505;
  const sum = X + Y + Z;
  if (sum < 1e-9) return { ...D65 };
  return { x: X / sum, y: Y / sum };
}

export function rgbToHex(rgb: RGB): string {
  const h = (c: number) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0');
  return `#${h(rgb.r)}${h(rgb.g)}${h(rgb.b)}`;
}
export function hexToRgb(hex: string): RGB {
  hex = hex.replace('#', '');
  return {
    r: parseInt(hex.slice(0, 2), 16) / 255,
    g: parseInt(hex.slice(2, 4), 16) / 255,
    b: parseInt(hex.slice(4, 6), 16) / 255,
  };
}
export function xyToHex(xy: XY): string { return rgbToHex(xyToRgb(xy)); }

// ---------------------------------------------------------------------------
// HSV (legacy wheel model) -> xy, used for migrating old data and API inputs
// ---------------------------------------------------------------------------

export function hsvToRgb(h: number, s: number, v: number): RGB {
  s /= 100; v /= 100;
  const c = v * s, hp = (((h % 360) + 360) % 360) / 60, x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; } else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; } else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; } else { r = c; b = x; }
  const m = v - c;
  return { r: r + m, g: g + m, b: b + m };
}

export function rgbToHsv(rgb: RGB): { h: number; s: number; v: number } {
  const { r, g, b } = rgb;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h: h * 360, s: max === 0 ? 0 : (d / max) * 100, v: max * 100 };
}

/** HSV hue/sat (the old wheel) -> chromaticity. */
export function hsToXy(h: number, s: number): XY { return rgbToXy(hsvToRgb(h, s, 100)); }

/** Chromaticity -> nearest HSV hue/sat (lossy; for legacy consumers). */
export function xyToHs(xy: XY): { h: number; s: number } {
  const { h, s } = rgbToHsv(xyToRgb(xy));
  return { h: Math.round(h), s: Math.round(s) };
}

/**
 * Old palette-node coordinates were wheel positions (0-1, centre 0.5,
 * angle = hue, radius = saturation). Convert to chromaticity.
 */
export function wheelPointToXy(p: { x: number; y: number }): XY {
  const dx = p.x - 0.5, dy = p.y - 0.5;
  const s = Math.min(100, Math.sqrt(dx * dx + dy * dy) * 2 * 100);
  const h = ((Math.atan2(dy, dx) * 180 / Math.PI + 90) % 360 + 360) % 360;
  return hsToXy(h, s);
}

// ---------------------------------------------------------------------------
// Gamut handling
// ---------------------------------------------------------------------------

function cross(a: XY, b: XY, c: XY): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

export function inGamut(xy: XY, g: Gamut): boolean {
  const s1 = cross(g.r, g.g, xy), s2 = cross(g.g, g.b, xy), s3 = cross(g.b, g.r, xy);
  const neg = s1 < 0 || s2 < 0 || s3 < 0, pos = s1 > 0 || s2 > 0 || s3 > 0;
  return !(neg && pos);
}

function closestOnSegment(a: XY, b: XY, p: XY): XY {
  const abx = b.x - a.x, aby = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / (abx * abx + aby * aby)));
  return { x: a.x + abx * t, y: a.y + aby * t };
}

/** Nearest point inside the gamut triangle (identity if already inside). */
export function clipToGamut(xy: XY, g: Gamut): XY {
  if (inGamut(xy, g)) return xy;
  const cands = [closestOnSegment(g.r, g.g, xy), closestOnSegment(g.g, g.b, xy), closestOnSegment(g.b, g.r, xy)];
  let best = cands[0], bd = Infinity;
  for (const c of cands) {
    const d = (c.x - xy.x) ** 2 + (c.y - xy.y) ** 2;
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Whites: the Planckian locus. Colour temperature is a curve on the diagram.
// ---------------------------------------------------------------------------

/** CCT (1667-25000 K) -> xy on the Planckian locus (Kim et al. 2002). */
export function kelvinToXy(K: number): XY {
  const T = Math.max(1667, Math.min(25000, K));
  const t1 = 1e3 / T, t2 = 1e6 / (T * T), t3 = 1e9 / (T * T * T);
  const x = T <= 4000
    ? -0.2661239 * t3 - 0.234358 * t2 + 0.8776956 * t1 + 0.17991
    : -3.0258469 * t3 + 2.1070379 * t2 + 0.2226347 * t1 + 0.24039;
  const x2 = x * x, x3 = x2 * x;
  const y = T <= 2222
    ? -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683
    : T <= 4000
      ? -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
      : 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
  return { x, y };
}

/**
 * Exact blackbody chromaticity at any temperature: Planck's law integrated
 * against the CIE 1931 CMFs. Unlike kelvinToXy (Kim approximation, valid
 * 1667K+), this holds all the way down into ember territory (1000K).
 * Memoized per 10K.
 */
const _bbCache = new Map<number, XY>();
export function blackbodyXy(K: number): XY {
  const key = Math.round(Math.max(500, K) / 10) * 10;
  const hit = _bbCache.get(key);
  if (hit) return hit;
  let X = 0, Y = 0, Z = 0;
  for (let lam = 380; lam <= 780; lam += 5) {
    const l = lam * 1e-9;
    // Planck spectral radiance, arbitrary scale (c2 = h*c/kB = 1.4388e-2 m·K)
    const M = 1 / (l ** 5 * (Math.exp(0.0143877688 / (l * key)) - 1));
    const c = cmf1931(lam);
    X += M * c.X; Y += M * c.Y; Z += M * c.Z;
  }
  const s = X + Y + Z;
  const xy = { x: X / s, y: Y / s };
  _bbCache.set(key, xy);
  return xy;
}

/** Approximate CCT of a chromaticity (McCamy 1992). Only meaningful near the locus. */
export function xyToKelvin(xy: XY): number {
  const n = (xy.x - 0.332) / (0.1858 - xy.y);
  return 449 * n ** 3 + 3525 * n ** 2 + 6823.3 * n + 5520.33;
}

/** Distance from the Planckian locus (Duv-ish, in xy units). */
export function distanceFromPlanckian(xy: XY): number {
  let best = Infinity;
  for (let K = 1700; K <= 10000; K += K < 4000 ? 50 : 200) {
    const p = kelvinToXy(K);
    best = Math.min(best, Math.hypot(p.x - xy.x, p.y - xy.y));
  }
  return best;
}

/** Sampled Planckian locus for drawing. */
export function planckianLocus(kMin = 1700, kMax = 10000, steps = 48): { K: number; xy: XY }[] {
  const out: { K: number; xy: XY }[] = [];
  for (let i = 0; i <= steps; i++) {
    // sample uniformly in mired (1/K) so the warm end isn't crowded
    const m = 1e6 / kMax + (1e6 / kMin - 1e6 / kMax) * (1 - i / steps);
    const K = 1e6 / m;
    out.push({ K, xy: kelvinToXy(K) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The horseshoe: CIE 1931 2° spectral locus, from the Wyman/Sloan/Shirley
// (2013) multi-lobe Gaussian fit of the colour-matching functions.
// ---------------------------------------------------------------------------

function lobe(l: number, mu: number, s1: number, s2: number): number {
  const t = (l - mu) / (l < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
}
export function cmf1931(lambda: number): { X: number; Y: number; Z: number } {
  return {
    X: 1.056 * lobe(lambda, 599.8, 37.9, 31.0) + 0.362 * lobe(lambda, 442.0, 16.0, 26.7) - 0.065 * lobe(lambda, 501.1, 20.4, 26.2),
    Y: 0.821 * lobe(lambda, 568.8, 46.9, 40.5) + 0.286 * lobe(lambda, 530.9, 16.3, 31.1),
    Z: 1.217 * lobe(lambda, 437.0, 11.8, 36.0) + 0.681 * lobe(lambda, 459.0, 26.0, 13.8),
  };
}

export function wavelengthToXy(lambda: number): XY {
  const { X, Y, Z } = cmf1931(lambda);
  const s = X + Y + Z;
  return { x: X / s, y: Y / s };
}

/**
 * Closed polygon of the visible region: spectral locus 380..700 nm followed
 * by the purple line back to the start. Cached.
 */
let _locus: XY[] | null = null;
export function spectralLocus(stepNm = 2): XY[] {
  if (_locus && stepNm === 2) return _locus;
  const pts: XY[] = [];
  for (let l = 380; l <= 700; l += stepNm) pts.push(wavelengthToXy(l));
  if (stepNm === 2) _locus = pts;
  return pts;
}

/** Is the chromaticity inside the visible horseshoe? */
export function inVisibleGamut(xy: XY, locus: XY[] = spectralLocus()): boolean {
  let inside = false;
  for (let i = 0, j = locus.length - 1; i < locus.length; j = i++) {
    const a = locus[i], b = locus[j];
    if ((a.y > xy.y) !== (b.y > xy.y) && xy.x < ((b.x - a.x) * (xy.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Nearest point inside the visible horseshoe (identity if inside). */
export function clipToVisible(xy: XY, locus: XY[] = spectralLocus()): XY {
  if (inVisibleGamut(xy, locus)) return xy;
  let best = locus[0], bd = Infinity;
  for (let i = 0; i < locus.length; i++) {
    const c = closestOnSegment(locus[i], locus[(i + 1) % locus.length], xy);
    const d = (c.x - xy.x) ** 2 + (c.y - xy.y) ** 2;
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

/** Bounding box of the horseshoe — handy for laying out diagrams. */
export const VISIBLE_BOUNDS = { xMin: 0, xMax: 0.74, yMin: 0, yMax: 0.84 };
