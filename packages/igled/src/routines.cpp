#include "routines.h"
#include "config.h"
#include "fx_soap.h"

FxParams fxParams;

// --- palette bank ----------------------------------------------------------
// The default palette starts from FastLED's party colors, with changes:
//   - all yellow and orange entries are gone (two red-oranges stay for warmth)
//   - black holds 7 of 16 entries (~40%), spread across the full range,
//     with black near both ends (purple side and blue side)
// Soap blends between entries, so each black entry makes a smooth dark
// valley between the colors.
static const CRGBPalette16 DefaultDark_p(
  CRGB(0x5500AB), CRGB::Black,    CRGB(0x84007C), CRGB::Black,
  CRGB(0xE5001B), CRGB(0xE81700), CRGB::Black,    CRGB::Black,
  CRGB(0xDD2200), CRGB::Black,    CRGB(0xC2003E), CRGB(0x8F0071),
  CRGB::Black,    CRGB(0x5F00A1), CRGB::Black,    CRGB(0x0007F9));

// ember: deep reds and red-orange over black, 8 black valleys
static const CRGBPalette16 Ember_p(
  CRGB(0xE5001B), CRGB::Black, CRGB(0x8B0000), CRGB::Black,
  CRGB(0xDD2200), CRGB(0xE81700), CRGB::Black, CRGB::Black,
  CRGB(0xA00010), CRGB::Black, CRGB(0xFF1A00), CRGB::Black,
  CRGB(0x6A0000), CRGB(0xC2003E), CRGB::Black, CRGB(0xE5001B));
// rose: pinks and magentas, softer, 6 black valleys
static const CRGBPalette16 Rose_p(
  CRGB(0xFF2E7A), CRGB::Black, CRGB(0xC2003E), CRGB(0xFF4FA3),
  CRGB::Black, CRGB(0x8F0071), CRGB(0xFF1F8F), CRGB::Black,
  CRGB(0xD1006B), CRGB::Black, CRGB(0xFF69B4), CRGB(0xB0004F),
  CRGB::Black, CRGB(0xFF2E7A), CRGB::Black, CRGB(0x8F0071));
// violet: purples into blue, 6 black valleys
static const CRGBPalette16 Violet_p(
  CRGB(0x5500AB), CRGB::Black, CRGB(0x8F0071), CRGB(0x5F00A1),
  CRGB::Black, CRGB(0x2F00D0), CRGB(0x0007F9), CRGB::Black,
  CRGB(0x6A00C8), CRGB::Black, CRGB(0x84007C), CRGB(0x3A00B8),
  CRGB::Black, CRGB(0x0007F9), CRGB(0x5500AB), CRGB::Black);
// midnight: blues only, mostly black
static const CRGBPalette16 Midnight_p(
  CRGB(0x0007F9), CRGB::Black, CRGB::Black, CRGB(0x0000A0),
  CRGB::Black, CRGB::Black, CRGB(0x1030FF), CRGB::Black,
  CRGB::Black, CRGB(0x000070), CRGB::Black, CRGB(0x0007F9),
  CRGB::Black, CRGB::Black, CRGB(0x2020C0), CRGB::Black);
// neon: magenta and electric blue, hard contrast, 6 black valleys
static const CRGBPalette16 Neon_p(
  CRGB(0xFF00FF), CRGB::Black, CRGB(0x0040FF), CRGB::Black,
  CRGB(0xFF00C8), CRGB(0x2000FF), CRGB::Black, CRGB(0xFF00FF),
  CRGB::Black, CRGB(0x0060FF), CRGB::Black, CRGB(0xFF0090),
  CRGB::Black, CRGB(0x0040FF), CRGB(0xFF00FF), CRGB::Black);
// blood: dark red, mostly black, one bright flash
static const CRGBPalette16 Blood_p(
  CRGB(0x8B0000), CRGB::Black, CRGB::Black, CRGB(0x600000),
  CRGB::Black, CRGB::Black, CRGB(0xA00000), CRGB::Black,
  CRGB::Black, CRGB(0xFF0000), CRGB::Black, CRGB::Black,
  CRGB(0x700000), CRGB::Black, CRGB(0x8B0000), CRGB::Black);
// candy: pink and blue alternating, 5 black valleys
static const CRGBPalette16 Candy_p(
  CRGB(0xFF2E7A), CRGB(0x0040FF), CRGB::Black, CRGB(0xFF4FA3),
  CRGB(0x2000FF), CRGB::Black, CRGB(0xFF1F8F), CRGB(0x0007F9),
  CRGB::Black, CRGB(0xFF69B4), CRGB(0x1030FF), CRGB::Black,
  CRGB(0xFF2E7A), CRGB::Black, CRGB(0x0040FF), CRGB(0xFF00C8));

// coal: midnight's shape in 1000 K blackbody (linear RGB 255,7,0), mostly black
static const CRGBPalette16 Coal_p(
  CRGB(0xFF0700), CRGB::Black, CRGB::Black, CRGB(0xA00400),
  CRGB::Black, CRGB::Black, CRGB(0xFF0800), CRGB::Black,
  CRGB::Black, CRGB(0x700200), CRGB::Black, CRGB(0xFF0700),
  CRGB::Black, CRGB::Black, CRGB(0xC00500), CRGB::Black);

// kiln: coal's shape in 1400 K blackbody (linear RGB 255,31,0)
static const CRGBPalette16 Kiln_p(
  CRGB(0xFF1F00), CRGB::Black, CRGB::Black, CRGB(0xA01300),
  CRGB::Black, CRGB::Black, CRGB(0xFF2000), CRGB::Black,
  CRGB::Black, CRGB(0x700E00), CRGB::Black, CRGB(0xFF1F00),
  CRGB::Black, CRGB::Black, CRGB(0xC01700), CRGB::Black);

struct PaletteEntry { const char* name; const CRGBPalette16 pal; };
// No greens, yellows or oranges anywhere in the bank (owner's taste).
// Mirrored by SOAP_PALETTES in packages/server/src/routes/curtains.ts.
static const PaletteEntry PALETTES[] = {
  { "default", DefaultDark_p },
  { "ember", Ember_p },
  { "rose", Rose_p },
  { "violet", Violet_p },
  { "midnight", Midnight_p },
  { "coal", Coal_p },
  { "kiln", Kiln_p },
  { "neon", Neon_p },
  { "blood", Blood_p },
  { "candy", Candy_p },
};
static const uint8_t N_PALETTES = sizeof(PALETTES) / sizeof(PALETTES[0]);

uint8_t fxPaletteCount() { return N_PALETTES; }
const char* fxPaletteName(uint8_t i) { return i < N_PALETTES ? PALETTES[i].name : "?"; }

// --- names -----------------------------------------------------------------
const char* fxName(Fx k) {
  switch (k) {
    case Fx::Off:     return "off";
    case Fx::Solid:   return "solid";
    case Fx::Twinkle: return "twinkle";
    case Fx::Soap:    return "soap";
  }
  return "?";
}

bool fxByName(const char* name, Fx& out) {
  for (Fx k : { Fx::Off, Fx::Solid, Fx::Twinkle, Fx::Soap }) {
    if (strcmp(name, fxName(k)) == 0) { out = k; return true; }
  }
  return false;
}

// Small integer hash. Used for per-LED phase, lit/unlit draws and jitter.
static inline uint32_t hash3(uint32_t ix, uint32_t iy, uint32_t iz) {
  uint32_t h = (ix * 374761393u) ^ (iy * 668265263u) ^ (iz * 2147483647u);
  h = (h ^ (h >> 13)) * 1274126177u;
  return h ^ (h >> 16);
}

// --- twinkle ---------------------------------------------------------------
// Port of twinklybox's 'twinkle' pattern: each LED runs its own fade cycle
// with a hashed phase; per (led, cycle) a hash decides whether it lights.
// The fade envelope is computed in float and rounded to the nearest code.
// No temporal dither: at ~30fps a one-code flicker is visible, not smooth.
//
// Tail cut. At the last few codes the rounded colour drifts off target: a
// warm white loses blue (yellow) and then green (red). We measure that drift
// as CIE 1976 u'v' distance between the rounded colour and the base colour
// (sRGB primaries as a proxy for the strip's). The fade is cut below the
// lowest scale whose rounded colour is within TWINKLE_DUV_TOL, so the cut is
// one contiguous piece at the very end and never a blip mid-fade. Codes that
// sit near the target (e.g. (2,1,0) for 2700K) stay.
// 0.04 is roughly 10x a MacAdam JND: a clear hue shift, not a subtle one.
// For a 2700K white at ~30fps this drops (1,0,0) and (1,1,0), ~3.5 frames.
static const float TWINKLE_DUV_TOL = 0.04f;
static float twinkleMinScale = 0.f;   // fades below this scale show black
static bool  twinkleCutReady = false;

static void rgbToUv(float r, float g, float b, float& u, float& v) {
  float X = 0.4124f * r + 0.3576f * g + 0.1805f * b;
  float Y = 0.2126f * r + 0.7152f * g + 0.0722f * b;
  float Z = 0.0193f * r + 0.1192f * g + 0.9505f * b;
  float d = X + 15.f * Y + 3.f * Z;
  if (d <= 0.f) { u = v = 0.f; return; }
  u = 4.f * X / d; v = 9.f * Y / d;
}

static CRGB twinkleBase() {
  if (fxParams.useRgb) return CRGB(fxParams.r, fxParams.g, fxParams.b);
  return CHSV(fxParams.hue, fxParams.sat, 255);   // jitter ignored for the cut
}

// Scan the tail once per param change: walk the scale up from zero and stop
// at the first rounded colour that is near the target.
static void twinkleComputeCut() {
  twinkleCutReady = true;
  twinkleMinScale = 0.f;
  if (!fxParams.cut) return;
  CRGB base = twinkleBase();
  float bu, bv; rgbToUv(base.r, base.g, base.b, bu, bv);
  for (float s = 0.0001f; s < 0.1f; s += 0.0001f) {
    float r = roundf(base.r * s), g = roundf(base.g * s), b = roundf(base.b * s);
    if (r + g + b <= 0.f) continue;
    float u, v; rgbToUv(r, g, b, u, v);
    float du = u - bu, dv = v - bv;
    if (sqrtf(du * du + dv * dv) <= TWINKLE_DUV_TOL) { twinkleMinScale = s; return; }
  }
}

static void fxTwinkle(CRGB* fb, uint32_t nowMs) {
  if (!twinkleCutReady) twinkleComputeCut();   // boot defaults, before any POST
  const uint32_t period = fxParams.periodMs < 500 ? 500 : fxParams.periodMs;
  for (uint16_t i = 0; i < NUM_LEDS; i++) {
    // Per-LED phase offset in ms so fades desynchronize.
    uint32_t phase = hash3(i, 101, 0) % period;
    uint32_t t = nowMs + phase;
    uint32_t n = t / period;
    if ((hash3(i, n, 1) & 0xFF) >= fxParams.density) {
      fb[i] = CRGB::Black;
      continue;
    }
    float u = (t % period) / (float)period;                // cycle position 0..1
    float env = sinf((float)M_PI * u);
    env *= env;                                            // ^2 for softer tails
    CRGB base;
    if (fxParams.useRgb) {
      base = CRGB(fxParams.r, fxParams.g, fxParams.b);
    } else {
      uint8_t h = fxParams.hue;
      if (fxParams.hueJitter) {
        int8_t j = (int8_t)(hash3(i, n, 2) & 0xFF);        // -128..127
        h = fxParams.hue + ((int16_t)j * fxParams.hueJitter) / 180;
      }
      base = CHSV(h, fxParams.sat, 255);
    }
    float scale = fxParams.val * env / 255.f;              // 0..1
    if (scale < twinkleMinScale) { fb[i] = CRGB::Black; continue; }
    for (int c = 0; c < 3; c++) fb[i].raw[c] = (uint8_t)(base.raw[c] * scale + 0.5f);
  }
}

// --- dispatch --------------------------------------------------------------
static uint32_t lastSoapFrame = 0;
static CRGB soapFb[NUM_LEDS];

// Black + brightness for soap. The palette blends linearly toward its
// black entries, so a pixel's peak channel m is its position on the
// black->colour ramp. `black` bends that ramp with a power curve,
// m' = 255 * (m/255)^gamma, gamma = 1 + black/32: the dark end stretches
// (black valleys grow) and the bright end compresses, but the ramp stays
// continuous and monotone — no cut, every pixel stays on the gradient.
// The curve is a 256-entry LUT rebuilt on param change.
static uint8_t blackLut[256];
static uint8_t blackLutFor = 255;   // param value the LUT was built for

static void buildBlackLut() {
  blackLutFor = fxParams.black;
  const float gamma = 1.f + fxParams.black / 32.f;
  blackLut[0] = 0;
  for (int m = 1; m < 256; m++) blackLut[m] = (uint8_t)(255.f * powf(m / 255.f, gamma) + 0.5f);
}

static void soapPost(CRGB* out, const CRGB* in) {
  if (blackLutFor != fxParams.black) buildBlackLut();
  const uint8_t bri = fxParams.bri;
  for (uint16_t i = 0; i < NUM_LEDS; i++) {
    CRGB c = in[i];
    uint8_t m = c.r > c.g ? (c.r > c.b ? c.r : c.b) : (c.g > c.b ? c.g : c.b);
    if (fxParams.black && m) {
      uint32_t nm = blackLut[m];
      for (int k = 0; k < 3; k++) c.raw[k] = (uint8_t)(((uint32_t)c.raw[k] * nm + m / 2) / m);
    }
    if (bri < 255) c.nscale8(bri);
    out[i] = c;
  }
}

void fxOnSwitch() {
  fxSoapReset();
  twinkleComputeCut();
}

void fxParamsChanged() {
  twinkleComputeCut();
}

void fxRender(CRGB* fb, uint32_t nowMs) {
  switch (fxParams.kind) {
    case Fx::Off:
      fill_solid(fb, NUM_LEDS, CRGB::Black);
      break;
    case Fx::Solid:
      fill_solid(fb, NUM_LEDS, CHSV(fxParams.hue, fxParams.sat, fxParams.val));
      break;
    case Fx::Twinkle:
      fxTwinkle(fb, nowMs);
      break;
    case Fx::Soap: {
      uint8_t pi = fxParams.palette < N_PALETTES ? fxParams.palette : 0;
      // Soap shifts its own previous frame, so it must keep an untouched
      // buffer; black level and brightness are applied on the copy out.
      fxSoap(soapFb, fxParams.speed, fxParams.smoothness, PALETTES[pi].pal);
      soapPost(fb, soapFb);
      lastSoapFrame = nowMs;
      break;
    }
  }
}
