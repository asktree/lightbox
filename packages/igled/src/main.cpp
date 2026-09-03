// igled — from-scratch firmware for the Govee curtain matrices.
//
// Two modes, seamlessly interleaved:
//   - dumb listener: twinklybox streams DDP frames (immediate on :4048,
//     timecode-buffered AirPlay-style on :4049) — see stream.cpp
//   - native routines: when nothing has streamed for ~2.5s the box renders
//     its own effect (soap / twinkle / solid) — see routines.cpp
//
// Boot safety: these boxes are physically hard to reach, so a bad build must
// never cost a ladder trip. A crash counter in RTC memory survives resets;
// three crash-reboots in a row and we boot into SAFE MODE — WiFi + OTA +
// HTTP only, LEDs untouched — and wait to be reflashed. The counter clears
// after two minutes of healthy uptime.

#include <Arduino.h>
#include <FastLED.h>
#include <esp_system.h>
#include "config.h"
#include "ddp.h"
#include "routines.h"
#include "net.h"

static CRGB leds[NUM_LEDS];

RTC_NOINIT_ATTR static uint32_t crashCount;
static bool safeMode = false;
static bool crashCountCleared = false;
static bool streamStarted = false;

volatile uint16_t gShowFpsX10 = 0;    // read by net.cpp for /json/info
static uint32_t showCount = 0;
static uint32_t fpsWindowStart = 0;
static uint32_t lastFxFrame = 0;

#define FX_FRAME_MS 33                // ~30fps; strip transmit caps us near this anyway
#define SAFE_MODE_AFTER_CRASHES 3

void setup() {
  Serial.begin(115200);

  esp_reset_reason_t rr = esp_reset_reason();
  bool wasCrash = (rr == ESP_RST_PANIC || rr == ESP_RST_INT_WDT ||
                   rr == ESP_RST_TASK_WDT || rr == ESP_RST_WDT);
  if (rr == ESP_RST_POWERON || rr == ESP_RST_BROWNOUT) crashCount = 0; // RTC mem is garbage after power-on
  else if (wasCrash) crashCount++;
  else crashCount = 0;                                                // deliberate restart (OTA, rb)
  safeMode = crashCount >= SAFE_MODE_AFTER_CRASHES;

  Serial.printf("[igled] v%s reset=%d crashes=%u%s\n",
                IGLED_VERSION, (int)rr, (unsigned)crashCount, safeMode ? " -> SAFE MODE" : "");

  if (!safeMode) {
    FastLED.addLeds<WS2812, LED_PIN, LED_ORDER>(leds, NUM_LEDS);
    FastLED.setMaxPowerInVoltsAndMilliamps(POWER_VOLTS, POWER_MA);
    FastLED.setBrightness(140);
    fill_solid(leds, NUM_LEDS, CRGB::Black);
    FastLED.show();
  }

  netBegin(safeMode);
}

void loop() {
  netLoop();

  if (safeMode) { delay(2); return; }

  uint32_t now = millis();

  if (!crashCountCleared && now > 120000) { crashCountCleared = true; crashCount = 0; }

  // The DDP listener wants the network stack warm; start it on first connect.
  if (!streamStarted && netConnected()) {
    streamStarted = true;
    streamBegin(leds);
  }

  bool shown = false;
  if (streamConsume(now)) {
    FastLED.show();
    shown = true;
  } else if (!streamLive(now) && now - lastFxFrame >= FX_FRAME_MS) {
    lastFxFrame = now;
    fxRender(leds, now);
    FastLED.show();
    shown = true;
  }

  if (shown) showCount++;
  if (now - fpsWindowStart >= 2000) {
    uint32_t span = now - fpsWindowStart;
    gShowFpsX10 = span ? (uint16_t)((showCount * 10000UL) / span) : 0;
    showCount = 0;
    fpsWindowStart = now;
  }
}
