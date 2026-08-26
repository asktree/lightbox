// First light: prove the display, backlight, touch and USB serial all work.
#include <Arduino.h>
#include "board.h"

static board::Display lcd;
static uint32_t taps = 0;
static bool fingerDown = false;
static uint16_t hue = 0;

static void drawHeader() {
  lcd.fillRect(0, 0, lcd.width(), 44, TFT_NAVY);
  lcd.setTextColor(TFT_WHITE, TFT_NAVY);
  lcd.setTextDatum(textdatum_t::middle_center);
  lcd.setFont(&fonts::FreeSansBold12pt7b);
  lcd.drawString("hello, screenbox", lcd.width() / 2, 22);
}

static void drawFooter() {
  lcd.fillRect(0, lcd.height() - 30, lcd.width(), 30, TFT_BLACK);
  lcd.setTextColor(TFT_LIGHTGREY, TFT_BLACK);
  lcd.setTextDatum(textdatum_t::middle_center);
  lcd.setFont(&fonts::Font2);
  String msg = taps == 0 ? String("touch the screen") : String("taps: ") + taps;
  lcd.drawString(msg.c_str(), lcd.width() / 2, lcd.height() - 15);
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n[screenbox] booting on WT32S3-28S PRO");

  lcd.init();
  lcd.setBrightness(200);
  lcd.fillScreen(TFT_BLACK);
  drawHeader();
  drawFooter();

  Serial.printf("[screenbox] display %dx%d ready, psram=%u bytes\n",
                lcd.width(), lcd.height(), ESP.getPsramSize());
}

void loop() {
  uint16_t x, y;
  bool touched = lcd.getTouch(&x, &y);

  if (touched) {
    // paint a rainbow blob wherever the finger is
    uint32_t c = lcd.color888(128 + 127 * sinf(hue * 0.05f),
                              128 + 127 * sinf(hue * 0.05f + 2.1f),
                              128 + 127 * sinf(hue * 0.05f + 4.2f));
    lcd.fillCircle(x, y, 8, c);
    hue++;

    if (!fingerDown) {   // rising edge = a new tap
      taps++;
      drawFooter();
      Serial.printf("[screenbox] tap #%lu at (%u,%u)\n", (unsigned long)taps, x, y);
    }
  }
  fingerDown = touched;
  delay(10);
}
