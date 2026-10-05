// ─── shadebox ───────────────────────────────────────────────────────────────
//
// Seeed XIAO ESP32-C6 running its own one-device Zigbee network for the
// Yoolax blinds. Lightbox (on hearth) drives it; this firmware is a dumb,
// reliable blind driver — open / close / stop / go-to % plus state.
// Gesture logic (tap to toggle/pause, dial to set) lives in lightbox.
//
// Wi-Fi and Zigbee share one radio. The board stays on Wi-Fi and gives the
// radio to Zigbee only for a short window around each command (radio.h).
//
// Control: HTTP API on shadebox.local (see net.h), or the serial console
// (115200), one command per line:
//   pair [s]    open the network for s seconds (default 180); Wi-Fi is
//               not reliable during that time
//   open | close | stop | go <0-100> | refresh
//   radio <hold ms> <max ms>   set the Zigbee window lengths
//   hold <s>    stay in Zigbee mode for s seconds
//   state       print state as JSON
//   invert      flip open/closed if the blind turns out backwards
//   forget      drop the paired blind
//   reset       wipe the Zigbee network entirely (reboots)
// Raw frames for experiments on the motor (HANDOVER §6.2); numbers can be
// decimal or 0x hex, and the answer from the blind goes to the log:
//   dp                              ask for all Tuya datapoints
//   dp <id> <type> <value>          write one (type 1 bool, 2 value, 4 enum, 5 bitmap)
//   attr <cluster> <id>             read one ZCL attribute
//   attr <cluster> <id> <type> <value>   write it (type = ZCL type id)

#include <Arduino.h>
#include <Zigbee.h>
#include <esp_ieee802154.h>

#include "blind.h"
#include "logbuf.h"
#include "net.h"
#include "radio.h"

#ifndef ZIGBEE_MODE_ZCZR
#error "Build with -DZIGBEE_MODE_ZCZR (coordinator/router libraries)"
#endif

static blind::BlindEndpoint shade(1);

// ─── Radio sharing ──────────────────────────────────────────────────────────
//
// radio.cpp changes the 802.15.4 priority between Wi-Fi mode and Zigbee
// mode. `coex <idle> <txrx> <at>` (1 high … 4 idle) sets it by hand for
// tests; the next Zigbee window overwrites it.

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
  radio::Stats r = radio::stats();
  char buf[520];
  snprintf(buf, sizeof(buf),
           "{\"up\":%lu,\"zb\":%s,\"pan\":\"0x%04x\",\"channel\":%u,\"paired\":%s,\"pairing\":%s,\"protocol\":\"%s\",\"open\":%d,\"moving\":%s,\"dir\":%d,\"target\":%d,\"inverted\":%s,"
           "\"radio\":\"%s\",\"rssi\":%d,\"windows\":%lu,\"timeouts\":%lu,\"ackMs\":%ld,\"windowMs\":%lu,\"heardAgoS\":%ld,\"holdMs\":%lu,\"maxMs\":%lu}",
           (unsigned long)(millis() / 1000), Zigbee.started() ? "true" : "false", esp_zb_get_pan_id(), esp_zb_get_current_channel(),
           s.paired ? "true" : "false", s.pairing ? "true" : "false", blind::protocolName(s.protocol), s.open,
           s.moving ? "true" : "false", s.dir, s.target, shade.inverted() ? "true" : "false",
           r.zigbee ? "zigbee" : "wifi", net::rssi(), (unsigned long)r.windows, (unsigned long)r.timeouts, (long)r.ackMs,
           (unsigned long)r.windowMs, (long)r.heardAgoS, (unsigned long)r.holdMs, (unsigned long)r.maxMs);
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
  else if (cmd == "open") ok = radio::submit(radio::Kind::Open);
  else if (cmd == "close") ok = radio::submit(radio::Kind::Close);
  else if (cmd == "stop") ok = radio::submit(radio::Kind::Stop);
  else if (cmd == "go") ok = radio::submit(radio::Kind::Go, arg.toInt());
  else if (cmd == "refresh") ok = radio::submit(radio::Kind::Refresh);
  else if (cmd == "hold") radio::hold((arg.length() ? arg.toInt() : 10) * 1000UL);
  else if (cmd == "radio") {
    int h = 0, m = 0;
    if (sscanf(arg.c_str(), "%d %d", &h, &m) == 2) radio::tune(h, m);
  }
  else if (cmd == "dp") {
    blind::Probe p = {};
    int id = 0, type = 0, value = 0;
    int n = sscanf(arg.c_str(), "%i %i %i", &id, &type, &value);
    if (n == 3) {
      p.op = blind::Probe::Op::TuyaWrite;
      p.dp = id;
      p.type = type;
      p.value = value;
    } else if (n <= 0) {
      p.op = blind::Probe::Op::TuyaQuery;
    } else {
      Serial.println("? dp, or dp <id> <type> <value>");
      return;
    }
    ok = radio::submitProbe(p);
  }
  else if (cmd == "attr") {
    blind::Probe p = {};
    int cluster = 0, id = 0, type = 0, value = 0;
    int n = sscanf(arg.c_str(), "%i %i %i %i", &cluster, &id, &type, &value);
    if (n != 2 && n != 4) {
      Serial.println("? attr <cluster> <id>, or attr <cluster> <id> <type> <value>");
      return;
    }
    p.op = n == 4 ? blind::Probe::Op::AttrWrite : blind::Probe::Op::AttrRead;
    p.cluster = cluster;
    p.attr = id;
    p.type = type;
    p.value = value;
    ok = radio::submitProbe(p);
  }
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
  Serial.println();
  logbuf::line("[shadebox] boot");

  shade.setManufacturerAndModel("iggy", "shadebox");
  // Every command we send gets a ZCL default response; log it so a blind
  // that silently refuses (unsupported command, not calibrated…) says why.
  Zigbee.onGlobalDefaultResponse([](zb_cmd_type_t cmd, esp_zb_zcl_status_t status, uint8_t ep, uint16_t cluster) {
    logbuf::line("[zb] default response: cluster 0x%04x cmd %d status 0x%02x", cluster, (int)cmd, status);
    radio::heard();
  });
  Zigbee.addEndpoint(&shade);
  net::begin(shade, stateJson);  // Wi-Fi first — see net.cpp
  if (!Zigbee.begin(ZIGBEE_COORDINATOR)) {
    logbuf::line("[zb] failed to start — rebooting");
    delay(2000);
    ESP.restart();
  }
  radio::begin(shade);
  shade.restore();
  Serial.println("[shadebox] ready. type 'pair' to add the blind");
  Serial.println(stateJson());
}

void loop() {
  // No Zigbee window at boot. The blind finds its parent again in Wi-Fi mode
  // without help (measured: 3 s to 72 s after boot). A window that opens
  // when Wi-Fi has just connected makes Wi-Fi lose the access point for 20 s
  // or more, even if the window is only 6 s long.
  pollSerial();
  radio::tick();
  shade.tick();
  delay(10);
}
