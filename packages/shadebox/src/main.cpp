// ─── shadebox ───────────────────────────────────────────────────────────────
//
// Seeed XIAO ESP32-C6 running its own one-device Zigbee network for the
// Yoolax blinds. Lightbox (on hearth) drives it; this firmware is a dumb,
// reliable blind driver — open / close / stop / go-to % plus state.
// Gesture logic (tap to toggle/pause, dial to set) lives in lightbox.
//
// Control: HTTP API on shadebox.local (see net.h), or the serial console
// (115200), one command per line:
//   pair [s]    open the network for s seconds (default 180)
//   open | close | stop | go <0-100> | refresh
//   state       print state as JSON
//   invert      flip open/closed if the blind turns out backwards
//   forget      drop the paired blind
//   reset       wipe the Zigbee network entirely (reboots)

#include <Arduino.h>
#include <Zigbee.h>
#include <esp_ieee802154.h>

#include "blind.h"
#include "net.h"

#ifndef ZIGBEE_MODE_ZCZR
#error "Build with -DZIGBEE_MODE_ZCZR (coordinator/router libraries)"
#endif

static blind::BlindEndpoint shade(1);

// ─── Radio sharing ──────────────────────────────────────────────────────────
//
// Wi-Fi and Zigbee time-share one radio. Out of the box 802.15.4's *idle*
// (i.e. listening) state has the lowest priority, so whenever Wi-Fi wants the
// air the coordinator goes deaf — and a coordinator is listening ~always.
// Lift Zigbee: listening beats Wi-Fi background traffic, and an in-progress
// Zigbee tx/rx beats everything. Tunable live with `coex <idle> <txrx> <at>`
// (1 high … 4 idle).

static void setCoex(int idle, int txrx, int txrxAt) {
  esp_ieee802154_coex_config_t c = {
    .idle = (ieee802154_coex_event_t)idle,
    .txrx = (ieee802154_coex_event_t)txrx,
    .txrx_at = (ieee802154_coex_event_t)txrxAt,
  };
  esp_ieee802154_set_coex_config(c);
}

static void printCoex() {
  esp_ieee802154_coex_config_t c = esp_ieee802154_get_coex_config();
  Serial.printf("[coex] 802.15.4 priority idle=%d txrx=%d txrx_at=%d (1 high .. 4 idle)\n", c.idle, c.txrx, c.txrx_at);
}

// ─── State as JSON ──────────────────────────────────────────────────────────

String stateJson() {
  blind::State s = shade.state();
  char buf[300];
  snprintf(buf, sizeof(buf),
           "{\"up\":%lu,\"zb\":%s,\"pan\":\"0x%04x\",\"channel\":%u,\"paired\":%s,\"pairing\":%s,\"protocol\":\"%s\",\"open\":%d,\"moving\":%s,\"dir\":%d,\"target\":%d,\"inverted\":%s}",
           (unsigned long)(millis() / 1000), Zigbee.started() ? "true" : "false", esp_zb_get_pan_id(), esp_zb_get_current_channel(),
           s.paired ? "true" : "false", s.pairing ? "true" : "false", blind::protocolName(s.protocol), s.open,
           s.moving ? "true" : "false", s.dir, s.target, shade.inverted() ? "true" : "false");
  return buf;
}

// ─── Console ────────────────────────────────────────────────────────────────

static void runCommand(String line) {
  line.trim();
  if (!line.length()) return;
  int sp = line.indexOf(' ');
  String cmd = sp < 0 ? line : line.substring(0, sp);
  String arg = sp < 0 ? "" : line.substring(sp + 1);

  bool ok = true;
  if (cmd == "pair") shade.startPairing(arg.length() ? arg.toInt() : 180);
  else if (cmd == "open") ok = shade.open();
  else if (cmd == "close") ok = shade.close();
  else if (cmd == "stop") ok = shade.stop();
  else if (cmd == "go") ok = shade.goTo(arg.toInt());
  else if (cmd == "refresh") shade.refresh();
  else if (cmd == "invert") shade.setInverted(!shade.inverted());
  else if (cmd == "forget") shade.forget();
  else if (cmd == "proto") shade.setProtocol(arg == "tuya" ? blind::Protocol::Tuya : blind::Protocol::Zcl);
  else if (cmd == "close-net") Zigbee.closeNetwork();
  else if (cmd == "coex") {
    int a = 0, b = 0, c = 0;
    if (sscanf(arg.c_str(), "%d %d %d", &a, &b, &c) == 3) setCoex(a, b, c);
    printCoex();
    return;
  }
  else if (cmd == "reset") Zigbee.factoryReset();
  else if (cmd != "state") {
    Serial.printf("? unknown command '%s'\n", cmd.c_str());
    return;
  }
  if (!ok) Serial.println("! no blind paired");
  Serial.println(stateJson());
}

static void pollSerial() {
  static String buf;
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      runCommand(buf);
      buf = "";
    } else if (buf.length() < 64) {
      buf += c;
    }
  }
}

// ─── Arduino ────────────────────────────────────────────────────────────────

void setup() {
  Serial.begin(115200);
  delay(1500);  // let USB CDC enumerate so early logs aren't lost
  Serial.println("\n[shadebox] boot");

  shade.setManufacturerAndModel("iggy", "shadebox");
  // Every command we send gets a ZCL default response; log it so a blind
  // that silently refuses (unsupported command, not calibrated…) says why.
  Zigbee.onGlobalDefaultResponse([](zb_cmd_type_t cmd, esp_zb_zcl_status_t status, uint8_t ep, uint16_t cluster) {
    Serial.printf("[zb] default response: cluster 0x%04x cmd %d status 0x%02x\n", cluster, (int)cmd, status);
  });
  Zigbee.addEndpoint(&shade);
  net::begin(shade, stateJson);  // Wi-Fi first — see net.cpp
  if (!Zigbee.begin(ZIGBEE_COORDINATOR)) {
    Serial.println("[zb] failed to start — rebooting");
    delay(2000);
    ESP.restart();
  }
  printCoex();
  setCoex(IEEE802154_LOW, IEEE802154_HIGH, IEEE802154_HIGH);
  printCoex();
  shade.restore();
  Serial.println("[shadebox] ready. type 'pair' to add the blind");
  Serial.println(stateJson());
}

void loop() {
  pollSerial();
  shade.tick();
  delay(10);
}
