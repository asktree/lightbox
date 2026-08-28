// Display + full-frame 16-bit back buffer shared by every sketch.
// Handles the pixel-doubled (SCREENBOX_LOWRES) boards transparently.
#pragma once
#include "board.h"

namespace canvas {
extern board::Display lcd;
extern LGFX_Sprite    frame;               // W x H logical pixels
constexpr int W = board::LCD_W;
constexpr int H = board::LCD_H;

void begin();
void present();                            // push frame to the panel
// Push with a camera transform: rotate by `roll` degrees about the screen
// centre, offset by (dx, dy) logical px, scaled by `zoom` (>1 hides the corners).
void presentCamera(float roll, float dx, float dy, float zoom);
// Touch in logical pixels. Returns true while a finger is down.
bool touch(int& x, int& y);
}
