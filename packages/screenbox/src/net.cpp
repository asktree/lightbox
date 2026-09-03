#include "net.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <ESPmDNS.h>
#include <ArduinoOTA.h>
#include <map>
#include "secrets.h"

namespace net {

// Living-room light IDs, same order as packages/shared/src/rooms.ts
static const char* ROOM_LIGHT_IDS[] = {
  "hue:7", "hue:6",
  "tuya:eb58e8db101aa08a03txnf", "tuya:ebbacf4e20fe4b56366pik",
  "tuya-ble:eb9f3b3flegezedk", "tuya-ble:eba738os6ajviwqc",
  "wiz:9877d5b2867e",
};
static constexpr size_t ROOM_LIGHT_COUNT = sizeof(ROOM_LIGHT_IDS) / sizeof(ROOM_LIGHT_IDS[0]);

// Short names for the panel (server names are long / inconsistent)
static const char* DISPLAY_NAMES[ROOM_LIGHT_COUNT] = {
  "couch lamp", "iris",
  nullptr, "under tv",
  nullptr, nullptr,
  "kitchen",
};

static SemaphoreHandle_t   s_mutex;
static std::vector<Light>  s_lights;
static volatile uint32_t   s_version = 0;
static volatile Status     s_status = Status::Booting;
static WebSocketsClient    s_ws;
static bool                s_wsConnected = false;
static String              s_host;          // resolved LIGHTBOX_HOST (IP as text)

// LIGHTBOX_HOST may be an IP or an mDNS name like "hearth.local".
static bool resolveHost() {
  String h = LIGHTBOX_HOST;
  if (!h.endsWith(".local")) { s_host = h; return true; }
  IPAddress ip = MDNS.queryHost(h.substring(0, h.length() - 6), 3000);
  if (ip == IPAddress()) { Serial.printf("[net] mDNS: %s not found yet\n", h.c_str()); return false; }
  s_host = ip.toString();
  Serial.printf("[net] mDNS: %s -> %s\n", h.c_str(), s_host.c_str());
  return true;
}

// Pending outbound state per light, coalesced so a fast drag becomes ~10 PUTs/s.
struct Pending {
  bool hasColor = false; int h = 0, s = 0;
  bool hasTemp = false;  int temperature = 0;
  bool hasBri = false;   int brightness = 0;
  bool hasOn = false;    bool on = false;
  uint32_t lastSentMs = 0;
};
static std::map<String, Pending> s_pending;
static constexpr uint32_t SEND_INTERVAL_MS = 80;

// Echo policy. While a light is being dragged, inbound updates for it are
// dropped. After release we keep dropping until the server echoes back the
// LAST value we sent (the bridge's EventStream can replay intermediate states
// for well over a second), with a safety timeout so external changes still
// get through.
struct Control { bool active = false; uint32_t deadline = 0; bool hasColor = false; int h = 0, s = 0; };
static std::map<String, Control> s_control;
static constexpr uint32_t ECHO_TIMEOUT_MS = 3000;

// Returns true if this inbound state should be ignored. `incoming` may be null
// (when we only know the id).
static bool ignoring(const String& id, const Light* incoming) {
  auto it = s_control.find(id);
  if (it == s_control.end()) return false;
  Control& c = it->second;
  if (c.active) return true;
  if (millis() >= c.deadline) { s_control.erase(it); return false; }
  if (incoming && c.hasColor && incoming->hasColor &&
      abs(incoming->h - c.h) <= 2 && abs(incoming->s - c.s) <= 2) {
    s_control.erase(it);                     // that's my final command coming back
    return false;
  }
  return true;                               // stale intermediate echo
}

static int roomIndex(const char* id) {
  for (size_t i = 0; i < ROOM_LIGHT_COUNT; i++)
    if (strcmp(ROOM_LIGHT_IDS[i], id) == 0) return (int)i;
  return -1;
}

static Light parseLight(JsonObjectConst o) {
  Light l;
  l.id    = o["id"].as<const char*>();
  l.name  = o["name"].as<const char*>();
  { int idx = roomIndex(l.id.c_str()); if (idx >= 0 && DISPLAY_NAMES[idx]) l.name = DISPLAY_NAMES[idx]; }
  l.brand = o["brand"].as<const char*>();
  l.reachable = o["reachable"] | false;
  for (JsonVariantConst c : o["capabilities"].as<JsonArrayConst>()) {
    const char* cap = c.as<const char*>();
    if (!cap) continue;
    if (!strcmp(cap, "color")) l.canColor = true;
    if (!strcmp(cap, "temperature")) l.canTemp = true;
  }
  JsonObjectConst st = o["state"];
  l.on = st["on"] | false;
  l.brightness = st["brightness"] | 0;
  if (!st["color"].isNull()) {
    l.hasColor = true;
    l.h = st["color"]["h"] | 0;
    l.s = st["color"]["s"] | 0;
  }
  if (!st["temperature"].isNull()) {
    l.hasTemp = true;
    l.temperature = st["temperature"] | 0;
  }
  return l;
}

// Replace the whole room list from a lights array (lights_sync / GET /api/lights)
static void applyLightsArray(JsonArrayConst arr) {
  std::vector<Light> room(ROOM_LIGHT_COUNT);
  std::vector<bool> seen(ROOM_LIGHT_COUNT, false);
  for (JsonObjectConst o : arr) {
    const char* id = o["id"];
    int idx = id ? roomIndex(id) : -1;
    if (idx < 0) continue;
    room[idx] = parseLight(o);
    seen[idx] = true;
  }
  std::vector<Light> compact;
  for (size_t i = 0; i < ROOM_LIGHT_COUNT; i++) if (seen[i]) compact.push_back(room[i]);

  xSemaphoreTake(s_mutex, portMAX_DELAY);
  for (auto& l : compact)                      // keep local state for lights being dragged
    if (ignoring(l.id, &l))
      for (auto& old : s_lights) if (old.id == l.id) { l = old; break; }
  s_lights = compact;
  s_version++;
  xSemaphoreGive(s_mutex);
  Serial.printf("[net] room lights: %u\n", (unsigned)compact.size());
}

static void applyLightUpdate(JsonObjectConst o) {
  const char* id = o["id"];
  if (!id || roomIndex(id) < 0) return;
  Light l = parseLight(o);
  xSemaphoreTake(s_mutex, portMAX_DELAY);
  if (ignoring(l.id, &l)) { xSemaphoreGive(s_mutex); return; }
  for (auto& existing : s_lights) {
    if (existing.id == l.id) { existing = l; s_version++; break; }
  }
  xSemaphoreGive(s_mutex);
}

static void onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      s_wsConnected = true;
      s_status = Status::Online;
      Serial.println("[net] ws connected");
      break;
    case WStype_DISCONNECTED:
      if (s_wsConnected) Serial.println("[net] ws disconnected");
      s_wsConnected = false;
      if (WiFi.isConnected()) s_status = Status::ServerConnecting;
      break;
    case WStype_TEXT: {
      // Cheap pre-filter: only parse the message types we care about.
      if (length < 20) break;
      const bool isSync   = memmem(payload, min(length, (size_t)40), "\"lights_sync\"", 13) != nullptr;
      const bool isUpdate = memmem(payload, min(length, (size_t)40), "\"light_update\"", 14) != nullptr;
      if (!isSync && !isUpdate) break;
      JsonDocument doc;
      DeserializationError err = deserializeJson(doc, payload, length);
      if (err) { Serial.printf("[net] ws json error: %s\n", err.c_str()); break; }
      if (isSync)   applyLightsArray(doc["lights"].as<JsonArrayConst>());
      if (isUpdate) applyLightUpdate(doc["light"].as<JsonObjectConst>());
      break;
    }
    default: break;
  }
}

static bool fetchLights() {
  HTTPClient http;
  String url = String("http://") + s_host + ":" + LIGHTBOX_PORT + "/api/lights";
  http.setTimeout(4000);
  if (!http.begin(url)) return false;
  int code = http.GET();
  if (code != 200) { Serial.printf("[net] GET lights -> %d\n", code); http.end(); return false; }
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, http.getStream());
  http.end();
  if (err) { Serial.printf("[net] lights json error: %s\n", err.c_str()); return false; }
  applyLightsArray(doc.as<JsonArrayConst>());
  return true;
}

// Ambience mode request: 0 = none pending, 1 = color, 2 = normal. Written by
// the UI thread, consumed (and sent) by the net task.
static volatile int s_modeRequest = 0;
// Curtains twinkle kelvin/val: -1 = none pending. Coalesced (latest wins).
static volatile int s_curtainsKelvin = -1;
static volatile int s_curtainsVal = -1;
static uint32_t s_curtainsSentMs = 0;

static void sendCurtains(int k, int v) {
  HTTPClient http;
  http.setTimeout(4000);
  String url = String("http://") + s_host + ":" + LIGHTBOX_PORT + "/api/ambience/twinkle";
  if (!http.begin(url)) return;
  http.addHeader("Content-Type", "application/json");
  char body[48];
  if (k >= 0 && v >= 0) snprintf(body, sizeof body, "{\"kelvin\":%d,\"val\":%d}", k, v);
  else if (k >= 0)      snprintf(body, sizeof body, "{\"kelvin\":%d}", k);
  else                  snprintf(body, sizeof body, "{\"val\":%d}", v);
  int code = http.POST(body);
  if (code != 200) Serial.printf("[net] twinkle -> %d\n", code);
  http.end();
}

static void sendMode(bool normal) {
  JsonDocument body;
  body["mode"] = normal ? "normal" : "color";
  JsonArray ids = body["ids"].to<JsonArray>();
  for (size_t i = 0; i < ROOM_LIGHT_COUNT; i++) ids.add(ROOM_LIGHT_IDS[i]);
  String json; serializeJson(body, json);
  HTTPClient http;
  http.setTimeout(9000);   // the server talks to both curtain boxes before replying
  String url = String("http://") + s_host + ":" + LIGHTBOX_PORT + "/api/ambience";
  if (!http.begin(url)) return;
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(json);
  Serial.printf("[net] ambience %s -> %d\n", normal ? "normal" : "color", code);
  http.end();
}

static void flushPending() {
  uint32_t now = millis();
  for (auto& kv : s_pending) {
    Pending& p = kv.second;
    bool dirty = p.hasColor || p.hasTemp || p.hasBri || p.hasOn;
    if (!dirty || now - p.lastSentMs < SEND_INTERVAL_MS) continue;

    JsonDocument body;
    if (p.hasOn)    body["on"] = p.on;
    if (p.hasBri)   body["brightness"] = p.brightness;
    if (p.hasColor) { body["color"]["h"] = p.h; body["color"]["s"] = p.s; }
    if (p.hasTemp)  body["temperature"] = p.temperature;
    body["transition"] = 100;
    String json; serializeJson(body, json);
    p.hasColor = p.hasTemp = p.hasBri = p.hasOn = false;
    p.lastSentMs = now;

    HTTPClient http;
    http.setReuse(true);
    http.setTimeout(2000);
    String url = String("http://") + s_host + ":" + LIGHTBOX_PORT + "/api/lights/" + kv.first;
    if (!http.begin(url)) continue;
    http.addHeader("Content-Type", "application/json");
    int code = http.PUT(json);
    if (code != 200) Serial.printf("[net] PUT %s -> %d\n", kv.first.c_str(), code);
    http.end();
  }
}

static void netTask(void*) {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  s_status = Status::WifiConnecting;
  Serial.printf("[net] connecting to '%s'\n", WIFI_SSID);

  uint32_t wifiStart = millis();
  bool wsStarted = false, fetched = false, servicesStarted = false, hostResolved = false;
  uint32_t lastFetchTry = 0, lastResolveTry = 0;

  for (;;) {
    if (!WiFi.isConnected()) {
      if (s_status == Status::Online || s_status == Status::ServerConnecting) {
        Serial.println("[net] wifi lost");
        s_status = Status::WifiConnecting;
        wifiStart = millis();
      }
      if (millis() - wifiStart > 20000 && s_status == Status::WifiConnecting) {
        s_status = Status::WifiFailed;
        Serial.printf("[net] wifi failed (status %d) — scanning 2.4 GHz networks:\n", (int)WiFi.status());
        WiFi.disconnect(true);
        vTaskDelay(pdMS_TO_TICKS(300));
        int n = WiFi.scanNetworks(false, true);
        Serial.printf("[net] scan found %d networks\n", n);
        for (int i = 0; i < n; i++) {
          String ssid = WiFi.SSID(i);
          Serial.printf("   ch%2d %4ddBm %s len=%d [", WiFi.channel(i), WiFi.RSSI(i), WiFi.BSSIDstr(i).c_str(), ssid.length());
          for (size_t k = 0; k < ssid.length(); k++) Serial.printf("%02x", (uint8_t)ssid[k]);
          Serial.printf("] %s%s\n", ssid.c_str(), ssid == WIFI_SSID ? "  <-- ours" : "");
          Serial.flush();
          vTaskDelay(pdMS_TO_TICKS(20));   // don't overflow the USB CDC tx buffer
        }
        Serial.print("[net] configured ssid bytes [");
        for (const char* c = WIFI_SSID; *c; c++) Serial.printf("%02x", (uint8_t)*c);
        Serial.println("]");
        WiFi.scanDelete();
        WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
        wifiStart = millis();
        s_status = Status::WifiConnecting;
      }
      vTaskDelay(pdMS_TO_TICKS(200));
      continue;
    }

    if (s_status == Status::WifiConnecting) {
      Serial.printf("[net] wifi ok, ip=%s rssi=%d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
      s_status = Status::ServerConnecting;
      fetched = false;
    }

    if (!servicesStarted) {
      // Advertise as screenbox.local and accept over-the-air firmware uploads
      // (pio run -e wt32s3_28s_pro_ota -t upload) so flashing doesn't need USB.
      MDNS.begin(SCREENBOX_HOSTNAME);
      ArduinoOTA.setHostname(SCREENBOX_HOSTNAME);
      ArduinoOTA.onStart([] { Serial.println("[ota] update starting"); });
      ArduinoOTA.onEnd([] { Serial.println("[ota] done, rebooting"); });
      ArduinoOTA.onError([](ota_error_t e) { Serial.printf("[ota] error %d\n", (int)e); });
      ArduinoOTA.begin();
      servicesStarted = true;
    }
    ArduinoOTA.handle();

    if (!hostResolved) {
      if (millis() - lastResolveTry > 3000) { lastResolveTry = millis(); hostResolved = resolveHost(); }
      vTaskDelay(pdMS_TO_TICKS(50));
      continue;
    }

    if (!fetched && millis() - lastFetchTry > 3000) {
      lastFetchTry = millis();
      fetched = fetchLights();
    }

    if (!wsStarted) {
      s_ws.begin(s_host, LIGHTBOX_PORT, "/ws");
      s_ws.onEvent(onWsEvent);
      s_ws.setReconnectInterval(3000);
      wsStarted = true;
    }
    s_ws.loop();

    flushPending();
    if (s_modeRequest) { int m = s_modeRequest; s_modeRequest = 0; sendMode(m == 2); }
    if ((s_curtainsKelvin >= 0 || s_curtainsVal >= 0) && millis() - s_curtainsSentMs >= 250) {
      int k = s_curtainsKelvin, v = s_curtainsVal;
      s_curtainsKelvin = s_curtainsVal = -1;
      s_curtainsSentMs = millis();
      sendCurtains(k, v);
    }
    vTaskDelay(pdMS_TO_TICKS(5));
  }
}

void begin() {
  s_mutex = xSemaphoreCreateMutex();
  xTaskCreatePinnedToCore(netTask, "net", 12288, nullptr, 1, nullptr, 0);
}

Status status() { return s_status; }

const char* statusText() {
  switch (s_status) {
    case Status::Booting:          return "booting";
    case Status::WifiConnecting:   return "wifi...";
    case Status::WifiFailed:       return "wifi failed";
    case Status::ServerConnecting: return "server...";
    case Status::Online:           return "online";
  }
  return "?";
}

std::vector<Light> lights() {
  xSemaphoreTake(s_mutex, portMAX_DELAY);
  std::vector<Light> copy = s_lights;
  xSemaphoreGive(s_mutex);
  return copy;
}

uint32_t version() { return s_version; }

// Commands: optimistically update the local copy so the UI feels instant,
// and queue the change for the net task.
void startControlling(const String& id) {
  xSemaphoreTake(s_mutex, portMAX_DELAY);
  Control& c = s_control[id]; c.active = true; c.hasColor = false;
  xSemaphoreGive(s_mutex);
}
void stopControlling(const String& id) {
  xSemaphoreTake(s_mutex, portMAX_DELAY);
  Control& c = s_control[id]; c.active = false; c.deadline = millis() + ECHO_TIMEOUT_MS;
  xSemaphoreGive(s_mutex);
}

void setColor(const String& id, int h, int s) {
  xSemaphoreTake(s_mutex, portMAX_DELAY);
  for (auto& l : s_lights) if (l.id == id) { l.hasColor = true; l.h = h; l.s = s; l.hasTemp = false; s_version++; break; }
  Pending& p = s_pending[id]; p.hasColor = true; p.h = h; p.s = s; p.hasTemp = false;
  auto it = s_control.find(id);
  if (it != s_control.end()) { it->second.hasColor = true; it->second.h = h; it->second.s = s; }
  xSemaphoreGive(s_mutex);
}
void setTemperature(const String& id, int kelvin) {
  xSemaphoreTake(s_mutex, portMAX_DELAY);
  for (auto& l : s_lights) if (l.id == id) { l.hasTemp = true; l.temperature = kelvin; l.hasColor = false; s_version++; break; }
  Pending& p = s_pending[id]; p.hasTemp = true; p.temperature = kelvin; p.hasColor = false;
  xSemaphoreGive(s_mutex);
}
void setBrightness(const String& id, int brightness) {
  xSemaphoreTake(s_mutex, portMAX_DELAY);
  for (auto& l : s_lights) if (l.id == id) { l.brightness = brightness; s_version++; break; }
  Pending& p = s_pending[id]; p.hasBri = true; p.brightness = brightness;
  xSemaphoreGive(s_mutex);
}
void setMode(bool normal) { s_modeRequest = normal ? 2 : 1; }
void setCurtainsKelvin(int kelvin) { s_curtainsKelvin = kelvin; }
void setCurtainsVal(int val) { s_curtainsVal = val; }

void setOn(const String& id, bool on) {
  xSemaphoreTake(s_mutex, portMAX_DELAY);
  for (auto& l : s_lights) if (l.id == id) { l.on = on; s_version++; break; }
  Pending& p = s_pending[id]; p.hasOn = true; p.on = on;
  xSemaphoreGive(s_mutex);
}

}  // namespace net
