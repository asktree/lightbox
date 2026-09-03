// Networking: Wi-Fi, lightbox REST + WebSocket sync. Runs on core 0 so the UI
// thread (Arduino loop, core 1) never blocks on HTTP.
#pragma once
#include <Arduino.h>
#include <vector>

namespace net {

struct Light {
  String id;
  String name;
  String brand;
  bool   reachable = false;
  bool   canColor  = false;
  bool   canTemp   = false;
  bool   on        = false;
  int    brightness = 0;       // 0-100
  bool   hasColor  = false;
  int    h = 0, s = 0;         // hue 0-360, sat 0-100
  bool   hasTemp   = false;
  int    temperature = 0;      // kelvin
};

enum class Status { Booting, WifiConnecting, WifiFailed, ServerConnecting, Online };

void begin();

// --- state (read by UI) ---
Status status();
const char* statusText();
// Copy of the room's lights (safe to call from the UI thread). Order = room order.
std::vector<Light> lights();
// Bumps every time the light list changes, so the UI can redraw only when needed.
uint32_t version();

// --- commands (called by UI; coalesced + throttled, sent from the net task) ---
// Call around a drag so server echoes don't fight the finger.
void startControlling(const String& id);
void stopControlling(const String& id);
void setColor(const String& id, int h, int s);
void setTemperature(const String& id, int kelvin);
void setBrightness(const String& id, int brightness);
void setOn(const String& id, bool on);
// Ambience mode: POSTs /api/ambience with this room's light ids. The server
// flips the lights (CT mode <-> color) and switches the curtains' routine.
void setMode(bool normal);
// Curtains twinkle routine (normal mode): color along the blackbody locus,
// brightness 0-255. Coalesced like light commands; POSTs /api/ambience/twinkle.
void setCurtainsKelvin(int kelvin);
void setCurtainsVal(int val);

}  // namespace net
