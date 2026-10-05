#include "net.h"

#include <ArduinoOTA.h>
#include <ESPmDNS.h>
#include <WebServer.h>
#include <WiFi.h>
#include <Zigbee.h>
#include <esp_coexist.h>

#include "logbuf.h"
#include "radio.h"
#include "secrets.h"

namespace net {

static constexpr const char *HOSTNAME = "shadebox";

static blind::BlindEndpoint *s_shade = nullptr;
static String (*s_stateJson)() = nullptr;
static WebServer s_http(80);
static volatile uint32_t s_connectedAtMs = 0;  // 0 = Wi-Fi is not connected

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

// A number from the query string. Base 0, so 23 and 0x17 both work.
static uint32_t numArg(const char *name) { return strtoul(s_http.arg(name).c_str(), nullptr, 0); }

// Raw frames for experiments on the motor (HANDOVER §6.2). The reply is the
// state from before the frame. The answer from the blind goes to GET /log.
static void probeRoutes() {
  // POST /dp                        ask the blind for all its Tuya datapoints
  // POST /dp?id=&type=&value=       write one datapoint (type 1 bool, 2 value, 4 enum, 5 bitmap)
  s_http.on("/dp", HTTP_POST, [] {
    blind::Probe p = {};
    if (!s_http.hasArg("id")) {
      p.op = blind::Probe::Op::TuyaQuery;
      return replyState(radio::submitProbe(p));
    }
    uint32_t id = numArg("id"), type = numArg("type");
    bool typeOk = type == 1 || type == 2 || type == 4 || type == 5;
    if (id < 1 || id > 255 || !typeOk || !s_http.hasArg("value")) {
      return s_http.send(400, "application/json", "{\"error\":\"need id=1..255, type=1|2|4|5 and value\"}");
    }
    p.op = blind::Probe::Op::TuyaWrite;
    p.dp = id;
    p.type = type;
    p.value = numArg("value");
    replyState(radio::submitProbe(p));
  });
  // POST /attr?id=[&cluster=][&manuf=]            read one attribute (cluster default 0x0102)
  // POST /attr?id=&type=&value=[&cluster=][&manuf=]  write it (type = ZCL type id, e.g. 0x18 bitmap8)
  s_http.on("/attr", HTTP_POST, [] {
    if (!s_http.hasArg("id") || s_http.hasArg("value") != s_http.hasArg("type")) {
      return s_http.send(400, "application/json", "{\"error\":\"need id; a write needs type and value\"}");
    }
    blind::Probe p = {};
    p.op = s_http.hasArg("value") ? blind::Probe::Op::AttrWrite : blind::Probe::Op::AttrRead;
    p.cluster = s_http.hasArg("cluster") ? numArg("cluster") : 0x0102;
    p.attr = numArg("id");
    p.manuf = numArg("manuf");
    p.type = numArg("type");
    p.value = numArg("value");
    replyState(radio::submitProbe(p));
  });
  s_http.on("/log", HTTP_GET, [] {
    static char copy[logbuf::SIZE + 1];
    logbuf::snapshot(copy, sizeof(copy));
    s_http.send(200, "text/plain", copy);
  });
}

static void routes() {
  probeRoutes();
  s_http.on("/state", HTTP_GET, [] { replyState(); });
  // Commands are queued. The reply goes out first, then the Zigbee window
  // opens (radio.h), so the state in the reply is from before the command.
  s_http.on("/open", HTTP_POST, [] { replyState(radio::submit(radio::Kind::Open)); });
  s_http.on("/close", HTTP_POST, [] { replyState(radio::submit(radio::Kind::Close)); });
  s_http.on("/stop", HTTP_POST, [] { replyState(radio::submit(radio::Kind::Stop)); });
  s_http.on("/refresh", HTTP_POST, [] { replyState(radio::submit(radio::Kind::Refresh)); });
  s_http.on("/radio", HTTP_POST, [] {
    radio::Stats r = radio::stats();
    if (s_http.hasArg("hold") || s_http.hasArg("max")) {
      radio::tune(s_http.hasArg("hold") ? s_http.arg("hold").toInt() : r.holdMs, s_http.hasArg("max") ? s_http.arg("max").toInt() : r.maxMs);
    }
    if (s_http.hasArg("window")) radio::setWindowless(s_http.arg("window").toInt() == 0);
    replyState();
  });
  // POST /invert?on=0|1 sets the open/closed flip for commands and positions.
  // It is kept in flash. With no `on`, the reply only shows the state.
  s_http.on("/invert", HTTP_POST, [] {
    if (s_http.hasArg("on")) s_shade->setInverted(s_http.arg("on").toInt() != 0);
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
      if (s_connectedAtMs) {
        // Just lost. Give the automatic reconnect 20 s before a new begin().
        s_connectedAtMs = 0;
        lastAttempt = millis();
        logbuf::line("[net] wifi lost (status %d)", (int)WiFi.status());
      }
      if (millis() - lastAttempt > 20000) {
        logbuf::line("[net] still not connected (status %d), retrying", (int)WiFi.status());
        WiFi.disconnect();
        WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
        lastAttempt = millis();
      }
      vTaskDelay(pdMS_TO_TICKS(200));
      continue;
    }
    if (!s_connectedAtMs) {
      s_connectedAtMs = millis() | 1;
      if (services) logbuf::line("[net] wifi back, rssi=%d", WiFi.RSSI());
    }

    if (!services) {
      logbuf::line("[net] wifi ok, ip=%s rssi=%d — http://%s.local", WiFi.localIP().toString().c_str(), WiFi.RSSI(), HOSTNAME);
      MDNS.begin(HOSTNAME);
      MDNS.addService("http", "tcp", 80);
      ArduinoOTA.setHostname(HOSTNAME);
      ArduinoOTA.onStart([] { logbuf::line("[ota] update starting"); });
      ArduinoOTA.onEnd([] { logbuf::line("[ota] done, rebooting"); });
      ArduinoOTA.onError([](ota_error_t e) { logbuf::line("[ota] error %d", (int)e); });
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
uint32_t connectedForMs() {
  uint32_t at = s_connectedAtMs;
  return at && WiFi.isConnected() ? millis() - at : 0;
}
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
  logbuf::line("[net] wifi/zigbee coexistence %s", coex == ESP_OK ? "on" : esp_err_to_name(coex));
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  logbuf::line("[net] connecting to '%s'", WIFI_SSID);
  xTaskCreate(netTask, "net", 8192, nullptr, 1, nullptr);
}

}  // namespace net
