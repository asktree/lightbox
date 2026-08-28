// picture: show a still image (src/picture/image.h, made by tools/img2header.py),
// keeping Wi-Fi + OTA alive so the panel can be reflashed afterwards.
#include <Arduino.h>
#include "canvas.h"
#include "ota.h"
#include "image.h"

void setup() {
  Serial.begin(115200);
  canvas::begin();
  canvas::lcd.setSwapBytes(true);     // the array is host-order uint16; the panel wants big-endian
  canvas::lcd.pushImage(0, 0, IMG_W, IMG_H, IMG);
  ota::begin();
}

void loop() { delay(100); }
