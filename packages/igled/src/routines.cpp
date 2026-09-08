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

struct PaletteEntry { const char* name; const CRGBPalette16 pal; };
static const PaletteEntry PALETTES[] = {
  { "default", DefaultDark_p },
  { "party",   CRGBPalette16(PartyColors_p) },
  { "lava",    CRGBPalette16(LavaColors_p) },
  { "ocean",   CRGBPalette16(OceanColors_p) },
  { "forest",  CRGBPalette16(ForestColors_p) },
  { "rainbow", CRGBPalette16(RainbowColors_p) },
  { "heat",    CRGBPalette16(HeatColors_p) },
  { "cloud",   CRGBPalette16(CloudColors_p) },
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
      fxSoap(fb, fxParams.speed, fxParams.smoothness, PALETTES[pi].pal);
      lastSoapFrame = nowMs;
      break;
    }
  }
}
