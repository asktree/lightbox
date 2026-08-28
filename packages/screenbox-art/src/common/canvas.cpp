#include "canvas.h"
#include <Arduino.h>

namespace canvas {
board::Display lcd;
LGFX_Sprite    frame(&lcd);

void begin() {
  lcd.init();
  lcd.setBrightness(220);
  lcd.fillScreen(TFT_BLACK);
  frame.setColorDepth(16);
  frame.setPsram(false);                   // internal RAM if it fits, else PSRAM
  if (!frame.createSprite(W, H)) {
    frame.setPsram(true);
    if (!frame.createSprite(W, H)) {
      Serial.println("[canvas] frame alloc FAILED");
      for (;;) delay(1000);
    }
    Serial.println("[canvas] frame in PSRAM");
  } else Serial.println("[canvas] frame in internal RAM");
  Serial.printf("[canvas] %dx%d (scale %d) free heap=%u psram=%u\n", W, H, board::PIXEL_SCALE,
                ESP.getFreeHeap(), ESP.getFreePsram());
}

void present() {
  if (board::PIXEL_SCALE == 1) frame.pushSprite(0, 0);
  else {
    frame.setPivot(0, 0);
    frame.pushRotateZoom(&lcd, 0, 0, 0.f, board::PIXEL_SCALE, board::PIXEL_SCALE);
  }
}

void presentCamera(float roll, float dx, float dy, float zoom) {
  const float s = board::PIXEL_SCALE;
  frame.setPivot(W * 0.5f, H * 0.5f);
  // if the pan pushes the frame's top edge below the panel's top, clear what it uncovers
  float topEdge = (H * 0.5f + dy - H * 0.5f * zoom) * s;
  if (topEdge > 0) lcd.fillRect(0, 0, W * s, (int)topEdge + 2, TFT_BLACK);
  frame.pushRotateZoom(&lcd, (W * 0.5f + dx) * s, (H * 0.5f + dy) * s, roll, zoom * s, zoom * s);
}

bool touch(int& x, int& y) {
  uint16_t tx, ty;
  bool down = lcd.getTouch(&tx, &ty);
  x = tx / board::PIXEL_SCALE; y = ty / board::PIXEL_SCALE;
  return down;
}
}  // namespace canvas
