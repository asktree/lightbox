#include "net.h"

#include <ArduinoOTA.h>
#include <ESPmDNS.h>
#include <WebServer.h>
#include <WiFi.h>
#include <Zigbee.h>
#include <esp_coexist.h>

#include "radio.h"
#include "secrets.h"

namespace net {

static constexpr const char *HOSTNAME = "shadebox";

static blind::BlindEndpoint *s_shade = nullptr;
static String (*s_stateJson)() = nullptr;
static WebServer s_http(80);

// ─── HTTP routes ────────────────────────────────────────────────────────────

static void replyState(bool ok = true) {
  if (!Zigbee.started()) {
    s_http.send(503, "application/json", "{\"error\":\"zigbee starting\"}");
    return;
  }
  if (!ok) {
    s_http.send(409, "application/json", "{\"error\":\"no blind paired\"}");
    return;
  }
  s_http.send(200, "application/json", s_stateJson());
}

static void routes() {
  s_http.on("/state", HTTP_GET, [] { replyState(); });
  // Commands are queued. The reply goes out first, then the Zigbee window
  // opens (radio.h), so the state in the reply is from before the command.
  s_http.on("/open", HTTP_POST, [] { replyState(radio::submit(radio::Kind::Open)); });
  s_http.on("/close", HTTP_POST, [] { replyState(radio::submit(radio::Kind::Close)); });
  s_http.on("/stop", HTTP_POST, [] { replyState(radio::submit(radio::Kind::Stop)); });
  s_http.on("/refresh", HTTP_POST, [] { replyState(radio::submit(radio::Kind::Refresh)); });
  s_http.on("/radio", HTTP_POST, [] {
    radio::Stats r = radio::stats();
    radio::tune(s_http.hasArg("hold") ? s_http.arg("hold").toInt() : r.holdMs, s_http.hasArg("max") ? s_http.arg("max").toInt() : r.maxMs);
    replyState();
  });
  s_http.on("/go", HTTP_POST, [] {
    if (!s_http.hasArg("open")) return s_http.send(400, "application/json", "{\"error\":\"missing ?open=0..100\"}");
    replyState(radio::submit(radio::Kind::Go, s_http.arg("open").toInt()));
  });
  // Reply first: pairing holds the radio in Zigbee mode.
  s_http.on("/pair", HTTP_POST, [] {
    replyState();
    s_http.client().flush();
    delay(150);
    s_shade->startPairing(s_http.hasArg("s") ? s_http.arg("s").toInt() : 180);
  });
  s_http.onNotFound([] { s_http.send(404, "application/json", "{\"error\":\"not found\"}"); });
}

// ─── Task ───────────────────────────────────────────────────────────────────

static void netTask(void *) {
  bool services = false;
  uint32_t lastAttempt = millis();

  for (;;) {
    if (!WiFi.isConnected()) {
      if (millis() - lastAttempt > 20000) {
        Serial.printf("[net] still not connected (status %d), retrying\n", (int)WiFi.status());
        WiFi.disconnect();
        WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
        lastAttempt = millis();
      }
      vTaskDelay(pdMS_TO_TICKS(200));
      continue;
    }

    if (!services) {
      Serial.printf("[net] wifi ok, ip=%s rssi=%d — http://%s.local\n", WiFi.localIP().toString().c_str(), WiFi.RSSI(), HOSTNAME);
      MDNS.begin(HOSTNAME);
      MDNS.addService("http", "tcp", 80);
      ArduinoOTA.setHostname(HOSTNAME);
      ArduinoOTA.onStart([] { Serial.println("[ota] update starting"); });
      ArduinoOTA.onEnd([] { Serial.println("[ota] done, rebooting"); });
      ArduinoOTA.onError([](ota_error_t e) { Serial.printf("[ota] error %d\n", (int)e); });
      ArduinoOTA.begin();
      routes();
      s_http.begin();
      services = true;
    }

    ArduinoOTA.handle();
    s_http.handleClient();
    vTaskDelay(pdMS_TO_TICKS(5));
  }
}

bool connected() { return WiFi.isConnected(); }
int rssi() { return WiFi.isConnected() ? WiFi.RSSI() : 0; }

// ─── Startup ────────────────────────────────────────────────────────────────
//
// Wi-Fi and Zigbee share the C6's single radio. Following Espressif's
// single-chip gateway example: bring Wi-Fi up first, then explicitly enable
// Wi-Fi/802.15.4 coexistence, and only then start Zigbee. Without the coex
// call the always-listening coordinator starves Wi-Fi (scans find no AP).
// Coexistence also needs Wi-Fi modem sleep left ON — so unlike screenbox,
// no setSleep(false).

void begin(blind::BlindEndpoint &shade, String (*stateJson)()) {
  s_shade = &shade;
  s_stateJson = stateJson;
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(HOSTNAME);
  esp_err_t coex = esp_coex_wifi_i154_enable();
  Serial.printf("[net] wifi/zigbee coexistence %s\n", coex == ESP_OK ? "on" : esp_err_to_name(coex));
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("[net] connecting to '%s'\n", WIFI_SSID);
  xTaskCreate(netTask, "net", 8192, nullptr, 1, nullptr);
}

}  // namespace net
