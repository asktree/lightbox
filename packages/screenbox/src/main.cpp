// screenbox: physical lightbox control panel.
#include <Arduino.h>
#include "net.h"
#include "ui.h"

void setup() {
  Serial.setTxBufferSize(4096);   // USB CDC drops bytes on bursty logs otherwise
  Serial.begin(115200);
  delay(200);
  Serial.println("\n[screenbox] booting on WT32S3-28S PRO");
  ui::begin();
  net::begin();
}

void loop() {
  ui::loop();
}
