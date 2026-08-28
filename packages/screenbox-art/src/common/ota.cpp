#include "ota.h"
#include <Arduino.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <ArduinoOTA.h>
#include "secrets.h"

#ifndef SCREENBOX_HOSTNAME
#define SCREENBOX_HOSTNAME "screenbox-art"
#endif

namespace ota {
namespace {
volatile bool s_online = false;

void task(void*) {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setHostname(SCREENBOX_HOSTNAME);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  uint32_t started = millis();
  while (!WiFi.isConnected()) {
    vTaskDelay(pdMS_TO_TICKS(250));
    if (millis() - started > 20000) {          // retry from scratch every 20 s
      Serial.printf("[ota] wifi retry (status %d)\n", (int)WiFi.status());
      WiFi.disconnect(true);
      vTaskDelay(pdMS_TO_TICKS(500));
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
      started = millis();
    }
  }
  Serial.printf("[ota] wifi ok ip=%s rssi=%d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  MDNS.begin(SCREENBOX_HOSTNAME);
  ArduinoOTA.setHostname(SCREENBOX_HOSTNAME);
  ArduinoOTA.onStart([] { Serial.println("[ota] update starting"); });
  ArduinoOTA.onEnd([] { Serial.println("[ota] done, rebooting"); });
  ArduinoOTA.onError([](ota_error_t e) { Serial.printf("[ota] error %d\n", (int)e); });
  ArduinoOTA.begin();
  s_online = true;
  for (;;) {
    ArduinoOTA.handle();
    vTaskDelay(pdMS_TO_TICKS(20));
  }
}
}  // namespace

void begin() { xTaskCreatePinnedToCore(task, "ota", 8192, nullptr, 1, nullptr, 0); }
bool online() { return s_online; }
}  // namespace ota
