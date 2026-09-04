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

// --- temporal dithering ------------------------------------------------------
// WS2812s are 8-bit with linear PWM, so the bottom of a fade steps through
// codes the eye can clearly see (4 -> 3 is a 25% jump). Routines that render
// in float write their sub-LSB remainder into fxFrac (0..255 = 0..1 LSB);
// applyDither() then flickers each byte between the two adjacent codes with a
// duty cycle equal to the fraction. The threshold walks a golden-ratio
// sequence per frame with a per-byte hash offset, so the time-average lands
// exactly on the fraction and neighboring bytes never blink in sync.
static inline uint32_t hash3(uint32_t ix, uint32_t iy, uint32_t iz) {
  uint32_t h = (ix * 374761393u) ^ (iy * 668265263u) ^ (iz * 2147483647u);
  h = (h ^ (h >> 13)) * 1274126177u;
  return h ^ (h >> 16);
}

static uint8_t  fxFrac[NUM_LEDS * 3];   // sub-LSB fractions, zero = no dither
static uint32_t ditherFrame = 0;

static void applyDither(CRGB* fb) {
  uint8_t* raw = reinterpret_cast<uint8_t*>(fb);
  const uint8_t phase = (uint8_t)(ditherFrame * 158u);   // ~0.618 * 256 per frame
  for (uint32_t i = 0; i < NUM_LEDS * 3; i++) {
    uint8_t f = fxFrac[i];
    if (!f) continue;
    // Below code 8 the 1-LSB alternation is >6% contrast at our ~15Hz
    // effective dither rate — visible as blinking on single dim pixels.
    // Round statically there instead.
    if (raw[i] < 8) { if (f >= 128 && raw[i] < 255) raw[i]++; continue; }
    uint8_t t = (uint8_t)(hash3(i, 0, 7) + phase);
    if (f > t && raw[i] < 255) raw[i]++;
  }
}

// --- twinkle ---------------------------------------------------------------
// Port of twinklybox's 'twinkle' pattern: each LED runs its own fade cycle
// with a hashed phase; per (led, cycle) a hash decides whether it lights.
// The fade envelope is computed in float and dithered, so the tail of each
// fade glides instead of stepping.
static void fxTwinkle(CRGB* fb, uint32_t nowMs) {
  const uint32_t period = fxParams.periodMs < 500 ? 500 : fxParams.periodMs;
  for (uint16_t i = 0; i < NUM_LEDS; i++) {
    uint32_t o = (uint32_t)i * 3;
    // Per-LED phase offset in ms so fades desynchronize.
    uint32_t phase = hash3(i, 101, 0) % period;
    uint32_t t = nowMs + phase;
    uint32_t n = t / period;
    if ((hash3(i, n, 1) & 0xFF) >= fxParams.density) {
      fb[i] = CRGB::Black;
      fxFrac[o] = fxFrac[o + 1] = fxFrac[o + 2] = 0;
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
    for (int c = 0; c < 3; c++) {
      float v = base.raw[c] * scale;
      uint8_t hi = (uint8_t)v;
      fb[i].raw[c] = hi;
      fxFrac[o + c] = (uint8_t)((v - hi) * 255.f);
    }
  }
}

// --- dispatch --------------------------------------------------------------
static uint32_t lastSoapFrame = 0;

void fxOnSwitch() {
  fxSoapReset();
  memset(fxFrac, 0, sizeof(fxFrac));   // routines that don't dither leave it 0
}

void fxRender(CRGB* fb, uint32_t nowMs) {
  ditherFrame++;
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
  applyDither(fb);
}
