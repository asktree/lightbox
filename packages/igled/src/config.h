// Hardware config. There is exactly one kind of device — a Govee curtain
// matrix rewired to an ESP32 — so this is compile-time, not runtime config.
// Values read off the old WLED setup on Ubert (cfg.json, Sep 2026):
//   960 LEDs, one 32x30 panel, row-major from top-left (no serpentine),
//   WS2812-class chip on GPIO 16, RGB byte order, 2A power budget.
#pragma once

#include <stdint.h>

#define IGLED_VERSION "0.1.0"

#define MATRIX_W 32
#define MATRIX_H 30
#define NUM_LEDS (MATRIX_W * MATRIX_H)

#define LED_PIN   16
#define LED_ORDER RGB      // FastLED EOrder; WLED had color order 1 = RGB
#define POWER_VOLTS 5
#define POWER_MA  2000

// Row-major, row 0 at the top — matches the panel wiring and the layout
// twinklybox's wledMatrixLayout() assumes.
static inline uint16_t XY(int x, int y) { return (uint16_t)y * MATRIX_W + (uint16_t)x; }
