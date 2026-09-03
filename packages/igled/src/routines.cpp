#include "routines.h"
#include "config.h"
#include "fx_soap.h"

FxParams fxParams;

// --- palette bank ----------------------------------------------------------
struct PaletteEntry { const char* name; const CRGBPalette16 pal; };
static const PaletteEntry PALETTES[] = {
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

// --- twinkle ---------------------------------------------------------------
// Port of twinklybox's 'twinkle' pattern: each LED runs its own fade cycle
// with a hashed phase; per (led, cycle) a hash decides whether it lights.
static inline uint32_t hash3(uint32_t ix, uint32_t iy, uint32_t iz) {
  uint32_t h = (ix * 374761393u) ^ (iy * 668265263u) ^ (iz * 2147483647u);
  h = (h ^ (h >> 13)) * 1274126177u;
  return h ^ (h >> 16);
}

static void fxTwinkle(CRGB* fb, uint32_t nowMs) {
  const uint32_t period = fxParams.periodMs < 500 ? 500 : fxParams.periodMs;
  for (uint16_t i = 0; i < NUM_LEDS; i++) {
    // Per-LED phase offset in ms so fades desynchronize.
    uint32_t phase = hash3(i, 101, 0) % period;
    uint32_t t = nowMs + phase;
    uint32_t n = t / period;
    uint8_t  u = (uint8_t)(((t % period) * 255) / period);   // cycle position
    if ((hash3(i, n, 1) & 0xFF) >= fxParams.density) { fb[i] = CRGB::Black; continue; }
    uint8_t env = sin8(u >> 1);                              // half-sine 0..255..0
    env = scale8(env, env);                                  // ^2 for softer tails
    uint8_t h = fxParams.hue;
    if (fxParams.hueJitter) {
      int8_t j = (int8_t)(hash3(i, n, 2) & 0xFF);            // -128..127
      h = fxParams.hue + ((int16_t)j * fxParams.hueJitter) / 180;
    }
    fb[i] = CHSV(h, fxParams.sat, scale8(fxParams.val, env));
  }
}

// --- dispatch --------------------------------------------------------------
static uint32_t lastSoapFrame = 0;

void fxOnSwitch() { fxSoapReset(); }

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
