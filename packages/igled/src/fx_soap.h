// Soap — lifted from WLED v0.15.3 (wled00/FX.cpp, mode_2Dsoap).
//   Effect by @Stepko, idea from Stefan Petrick
//   (https://www.youtube.com/watch?v=DiHBgITrZck), adapted for WLED by
//   @blazoncek. WLED is (c) 2016-present Christian Schwinne and contributors,
//   licensed EUPL v1.2 — this file carries that lineage.
//
// Changes from the WLED original: the segment/SEGENV plumbing is replaced by
// a fixed 32x30 framebuffer and static state (we have exactly one device
// shape), and speed/smoothness/palette come in as plain arguments instead of
// slider globals. The noise field, smear pass, and all constants are
// unchanged.
#pragma once

#include <FastLED.h>
#include "config.h"

#ifndef IGLED_MIN
#define IGLED_MIN(a,b) ((a)<(b)?(a):(b))
#define IGLED_MAX(a,b) ((a)>(b)?(a):(b))
#endif

static uint8_t  soapNoise[NUM_LEDS];
static uint32_t soapX, soapY, soapZ;
static bool     soapPrimed = false;

inline void fxSoapReset() { soapPrimed = false; }

inline void fxSoap(CRGB* leds, uint8_t speed, uint8_t intensity, const CRGBPalette16& pal) {
  const int cols = MATRIX_W;
  const int rows = MATRIX_H;

  const uint32_t scale32_x = 160000U / cols;
  const uint32_t scale32_y = 160000U / rows;
  const uint32_t mov = IGLED_MIN(cols, rows) * (speed + 2) / 2;
  const uint8_t  smoothness = IGLED_MIN(250, intensity); // limit as >250 produces very little changes

  // init
  if (!soapPrimed) {
    soapX = random16();
    soapY = random16();
    soapZ = random16();
  } else {
    soapX += mov;
    soapY += mov;
    soapZ += mov;
  }

  for (int i = 0; i < cols; i++) {
    int32_t ioffset = scale32_x * (i - cols / 2);
    for (int j = 0; j < rows; j++) {
      int32_t joffset = scale32_y * (j - rows / 2);
      uint8_t data = inoise16(soapX + ioffset, soapY + joffset, soapZ) >> 8;
      soapNoise[XY(i, j)] = scale8(soapNoise[XY(i, j)], smoothness) + scale8(data, 255 - smoothness);
    }
  }

  if (!soapPrimed) {
    soapPrimed = true;
    for (int i = 0; i < cols; i++)
      for (int j = 0; j < rows; j++)
        leds[XY(i, j)] = ColorFromPalette(pal, ~soapNoise[XY(i, j)] * 3);
  }

  int zD;
  int zF;
  int amplitude;
  int shiftX = 0;
  int shiftY = 0;
  CRGB ledsbuff[IGLED_MAX(MATRIX_W, MATRIX_H)];

  amplitude = (cols >= 16) ? (cols - 8) / 8 : 1;
  for (int y = 0; y < rows; y++) {
    int amount   = ((int)soapNoise[XY(0, y)] - 128) * 2 * amplitude + 256 * shiftX;
    int delta    = abs(amount) >> 8;
    int fraction = abs(amount) & 255;
    for (int x = 0; x < cols; x++) {
      if (amount < 0) {
        zD = x - delta;
        zF = zD - 1;
      } else {
        zD = x + delta;
        zF = zD + 1;
      }
      CRGB PixelA = CRGB::Black;
      if ((zD >= 0) && (zD < cols)) PixelA = leds[XY(zD, y)];
      else                          PixelA = ColorFromPalette(pal, ~soapNoise[XY(abs(zD), y)] * 3);
      CRGB PixelB = CRGB::Black;
      if ((zF >= 0) && (zF < cols)) PixelB = leds[XY(zF, y)];
      else                          PixelB = ColorFromPalette(pal, ~soapNoise[XY(abs(zF), y)] * 3);
      ledsbuff[x] = (PixelA.nscale8(ease8InOutApprox(255 - fraction))) + (PixelB.nscale8(ease8InOutApprox(fraction)));
    }
    for (int x = 0; x < cols; x++) leds[XY(x, y)] = ledsbuff[x];
  }

  amplitude = (rows >= 16) ? (rows - 8) / 8 : 1;
  for (int x = 0; x < cols; x++) {
    int amount   = ((int)soapNoise[XY(x, 0)] - 128) * 2 * amplitude + 256 * shiftY;
    int delta    = abs(amount) >> 8;
    int fraction = abs(amount) & 255;
    for (int y = 0; y < rows; y++) {
      if (amount < 0) {
        zD = y - delta;
        zF = zD - 1;
      } else {
        zD = y + delta;
        zF = zD + 1;
      }
      CRGB PixelA = CRGB::Black;
      if ((zD >= 0) && (zD < rows)) PixelA = leds[XY(x, zD)];
      else                          PixelA = ColorFromPalette(pal, ~soapNoise[XY(x, abs(zD))] * 3);
      CRGB PixelB = CRGB::Black;
      if ((zF >= 0) && (zF < rows)) PixelB = leds[XY(x, zF)];
      else                          PixelB = ColorFromPalette(pal, ~soapNoise[XY(x, abs(zF))] * 3);
      ledsbuff[y] = (PixelA.nscale8(ease8InOutApprox(255 - fraction))) + (PixelB.nscale8(ease8InOutApprox(fraction)));
    }
    for (int y = 0; y < rows; y++) leds[XY(x, y)] = ledsbuff[y];
  }
}
