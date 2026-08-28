// Minimal on-screen sliders for live-tuning sketch parameters.
// Layout: up to 4 param sliders in two half-width rows at the top, one
// full-width slider at the bottom. Each shows "label value".
#pragma once
#include <LovyanGFX.hpp>

namespace sliders {
struct Slider { const char* label; float* val; float lo, hi; };
// top: 0..4 entries (row-major, two per row); bottom: optional full-width one.
void begin(const Slider* top, int nTop, const Slider* bottom);
// Feed every touch sample. Returns true if the touch is owned by a slider.
bool touch(bool down, int x, int y);
void draw(LGFX_Sprite& frame);
}
