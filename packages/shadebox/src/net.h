// ─── Network ────────────────────────────────────────────────────────────────
//
// Wi-Fi + mDNS (shadebox.local) + a tiny HTTP API that lightbox calls, plus
// ArduinoOTA so the board can be reflashed without USB. Runs in its own task.
//
//   GET  /state            → state JSON
//   POST /open | /close | /stop | /refresh
//   POST /go?open=0..100   → go to an openness
//   POST /pair?s=180       → open the Zigbee network for joining
//   POST /radio?hold=&max= → set the Zigbee window lengths, in ms (radio.h)
//   POST /invert?on=0|1    → set the open/closed flip (kept in flash)
//   GET  /log              → the last log lines as text (logbuf.h)
//   POST /dp | /attr       → raw frames for experiments (see net.cpp)
//
// Every POST answers with the state JSON from before the command. Commands
// are queued and sent in a Zigbee window after the reply.

#pragma once
#include <Arduino.h>

#include "blind.h"

namespace net {

// Call BEFORE Zigbee.begin(): Wi-Fi must be up when coexistence is enabled.
void begin(blind::BlindEndpoint &shade, String (*stateJson)());

bool connected();
int rssi();  // dBm, or 0 when Wi-Fi is not connected

}  // namespace net
