#include "net.h"
#include "config.h"
#include "ddp.h"
#include "routines.h"
#include "secrets.h"

#include <WiFi.h>
#include <ESPmDNS.h>
#include <ArduinoOTA.h>
#include <WebServer.h>
#include <Update.h>
#include <ArduinoJson.h>
#include <FastLED.h>

static WebServer server(80);
static bool gSafe = false;
static bool servicesUp = false;      // mDNS/OTA come up once WiFi connects
static char hostname[24] = "igled";
static uint32_t lastWifiOk = 0;

extern volatile uint16_t gShowFpsX10; // measured output fps (main.cpp)

// --- /json/info ------------------------------------------------------------
// Shape-compatible with the subset of WLED's /json/info that twinklybox
// reads: WledDriver.connect (leds.count/rgbw/matrix, name, ver), boxHealth
// (wifi.rssi, freeheap, live, and the "Timecode Buffer" + "played" usermod
// strings, same formats), and the buffer-mode autodetect (a `u` key
// containing "timecode").
static void handleInfo() {
  StreamStats st = streamStats();
  int rssi = WiFi.RSSI();
  int sig = 2 * (rssi + 100); if (sig < 0) sig = 0; if (sig > 100) sig = 100;
  char buf[768];
  snprintf(buf, sizeof(buf),
    "{\"ver\":\"igled %s\",\"brand\":\"igled\",\"name\":\"%s\",\"arch\":\"esp32\","
    "\"leds\":{\"count\":%d,\"rgbw\":false,\"fps\":%u,\"matrix\":{\"w\":%d,\"h\":%d}},"
    "\"wifi\":{\"rssi\":%d,\"signal\":%d,\"channel\":%d},"
    "\"freeheap\":%u,\"uptime\":%lu,\"live\":%s,\"safe\":%s,"
    "\"u\":{\"Timecode Buffer\":[\"%u/%u fr \\u00b7 %ums delay \\u00b7 %u.%ufps\"],"
    "\"TC played/drop/lost\":[\"%lu / %lu / %lu\"]}}",
    IGLED_VERSION, hostname,
    NUM_LEDS, gShowFpsX10 / 10, MATRIX_W, MATRIX_H,
    rssi, sig, WiFi.channel(),
    (unsigned)ESP.getFreeHeap(), (unsigned long)(millis() / 1000),
    st.live ? "true" : "false", gSafe ? "true" : "false",
    st.depth, st.slots, st.bufferMs, st.fpsX10 / 10, st.fpsX10 % 10,
    (unsigned long)st.played, (unsigned long)st.dropped, (unsigned long)st.lost);
  server.send(200, "application/json", buf);
}

// --- /json/state -----------------------------------------------------------
// {"rb":true} = remote reboot. There is deliberately no master brightness —
// routines and the stream sender own their own levels; "bri" is ignored.
static void handleState() {
  if (server.method() == HTTP_GET) {
    server.send(200, "application/json", "{\"on\":true,\"bri\":255}");
    return;
  }
  JsonDocument doc;
  if (deserializeJson(doc, server.arg("plain"))) {
    server.send(400, "application/json", "{\"error\":\"bad json\"}");
    return;
  }
  server.send(200, "application/json", "{\"success\":true}");
  if (doc["rb"].as<bool>()) { delay(150); ESP.restart(); }
}

// --- /api/routine ----------------------------------------------------------
static void sendRoutine() {
  char buf[320];
  snprintf(buf, sizeof(buf),
    "{\"kind\":\"%s\",\"hue\":%u,\"sat\":%u,\"val\":%u,"
    "\"density\":%u,\"periodMs\":%u,\"hueJitter\":%u,"
    "\"speed\":%u,\"smoothness\":%u,\"palette\":\"%s\"}",
    fxName(fxParams.kind), fxParams.hue, fxParams.sat, fxParams.val,
    fxParams.density, fxParams.periodMs, fxParams.hueJitter,
    fxParams.speed, fxParams.smoothness, fxPaletteName(fxParams.palette));
  server.send(200, "application/json", buf);
}

static void handleRoutine() {
  if (server.method() == HTTP_GET) { sendRoutine(); return; }
  JsonDocument doc;
  if (deserializeJson(doc, server.arg("plain"))) {
    server.send(400, "application/json", "{\"error\":\"bad json\"}");
    return;
  }
  if (doc["kind"].is<const char*>()) {
    Fx k;
    if (!fxByName(doc["kind"], k)) {
      server.send(400, "application/json", "{\"error\":\"unknown kind\"}");
      return;
    }
    if (k != fxParams.kind) { fxParams.kind = k; fxOnSwitch(); }
  }
  if (doc["hue"].is<int>())        fxParams.hue = doc["hue"];
  if (doc["sat"].is<int>())        fxParams.sat = doc["sat"];
  if (doc["val"].is<int>())        fxParams.val = doc["val"];
  if (doc["density"].is<int>())    fxParams.density = doc["density"];
  if (doc["periodMs"].is<int>())   fxParams.periodMs = doc["periodMs"];
  if (doc["hueJitter"].is<int>())  fxParams.hueJitter = doc["hueJitter"];
  if (doc["speed"].is<int>())      fxParams.speed = doc["speed"];
  if (doc["smoothness"].is<int>()) fxParams.smoothness = doc["smoothness"];
  if (doc["palette"].is<const char*>()) {
    const char* want = doc["palette"];
    for (uint8_t i = 0; i < fxPaletteCount(); i++)
      if (strcmp(want, fxPaletteName(i)) == 0) { fxParams.palette = i; break; }
  } else if (doc["palette"].is<int>()) {
    uint8_t i = doc["palette"];
    if (i < fxPaletteCount()) fxParams.palette = i;
  }
  sendRoutine();
}

// --- /update (HTTP OTA) ----------------------------------------------------
// curl -F "update=@firmware.bin" http://<box>/update
static void handleUpdateDone() {
  server.sendHeader("Connection", "close");
  if (Update.hasError()) {
    server.send(500, "text/plain", "update FAILED\n");
  } else {
    server.send(200, "text/plain", "ok, rebooting\n");
    delay(300);
    ESP.restart();
  }
}

static void handleUpdateUpload() {
  HTTPUpload& up = server.upload();
  if (up.status == UPLOAD_FILE_START) {
    Update.begin(UPDATE_SIZE_UNKNOWN);
  } else if (up.status == UPLOAD_FILE_WRITE) {
    if (!Update.hasError()) Update.write(up.buf, up.currentSize);
  } else if (up.status == UPLOAD_FILE_END) {
    Update.end(true);
  } else if (up.status == UPLOAD_FILE_ABORTED) {
    Update.abort();
  }
}

// ---------------------------------------------------------------------------
void netBegin(bool safeMode) {
  gSafe = safeMode;

#ifdef IGLED_NAME
  // Per-device builds (couch1, window) bake in their name/hostname.
  snprintf(hostname, sizeof(hostname), "%s", IGLED_NAME);
#else
  uint8_t mac[6];
  WiFi.macAddress(mac);
  snprintf(hostname, sizeof(hostname), "igled-%02x%02x%02x", mac[3], mac[4], mac[5]);
#endif

  WiFi.mode(WIFI_STA);
  WiFi.setHostname(hostname);
  WiFi.setSleep(false);              // latency > power on a lights box
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  server.on("/json/info", HTTP_GET, handleInfo);
  server.on("/json/state", handleState);
  server.on("/api/routine", handleRoutine);
  server.on("/api/stats", HTTP_GET, []() {
    StreamStats st = streamStats();
    char buf[256];
    snprintf(buf, sizeof(buf),
      "{\"live\":%s,\"depth\":%u,\"slots\":%u,\"bufferMs\":%u,\"senderFpsX10\":%u,"
      "\"played\":%lu,\"dropped\":%lu,\"lost\":%lu,\"underruns\":%lu,\"heap\":%u}",
      st.live ? "true" : "false", st.depth, st.slots, st.bufferMs, st.fpsX10,
      (unsigned long)st.played, (unsigned long)st.dropped, (unsigned long)st.lost,
      (unsigned long)st.underruns, (unsigned)ESP.getFreeHeap());
    server.send(200, "application/json", buf);
  });
  server.on("/update", HTTP_POST, handleUpdateDone, handleUpdateUpload);
  server.on("/", HTTP_GET, []() {
    char buf[160];
    snprintf(buf, sizeof(buf), "igled %s · %s · %s\nroutine: %s\n",
             IGLED_VERSION, hostname, gSafe ? "SAFE MODE" : "ok", fxName(fxParams.kind));
    server.send(200, "text/plain", buf);
  });
  server.onNotFound([]() { server.send(404, "text/plain", "igled: not found\n"); });
  server.begin();

  ArduinoOTA.setHostname(hostname);
}

bool netConnected() { return WiFi.status() == WL_CONNECTED; }

void netLoop() {
  uint32_t now = millis();
  if (netConnected()) {
    lastWifiOk = now;
    if (!servicesUp) {
      servicesUp = true;
      MDNS.begin(hostname);
      MDNS.addService("http", "tcp", 80);
      MDNS.addService("igled", "tcp", 80);
      ArduinoOTA.begin();
      Serial.printf("[net] up as %s.local (%s)\n", hostname, WiFi.localIP().toString().c_str());
    }
    ArduinoOTA.handle();
  } else if (now - lastWifiOk > 30000) {
    // Auto-reconnect has been failing for a while — kick the radio.
    lastWifiOk = now;
    Serial.println("[net] wifi stuck, re-begin");
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }
  server.handleClient();
}
