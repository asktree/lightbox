// Native routines — what the box shows when nothing is streaming to it.
#pragma once

#include <FastLED.h>

enum class Fx : uint8_t { Off = 0, Solid, Twinkle, Soap };

struct FxParams {
  Fx      kind = Fx::Soap;
  // solid / twinkle color
  uint8_t hue = 30;          // amber-ish
  uint8_t sat = 255;
  uint8_t val = 200;
  // twinkle
  uint8_t  density = 13;     // /255 chance a pixel lights each cycle (~5%)
  uint16_t periodMs = 6000;  // one fade in->out
  uint8_t  hueJitter = 0;    // +/- degrees-ish of per-dot hue wobble
  // soap
  uint8_t speed = 32;
  uint8_t smoothness = 200;
  uint8_t palette = 0;       // index into the palette bank
};

extern FxParams fxParams;

const char* fxName(Fx k);
bool fxByName(const char* name, Fx& out);
uint8_t fxPaletteCount();
const char* fxPaletteName(uint8_t i);

void fxRender(CRGB* fb, uint32_t nowMs);
void fxOnSwitch();  // call after changing fxParams.kind (resets stateful fx)
