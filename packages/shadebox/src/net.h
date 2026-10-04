// ─── Network ────────────────────────────────────────────────────────────────
//
// Wi-Fi + mDNS (shadebox.local) + a tiny HTTP API that lightbox calls, plus
// ArduinoOTA so the board can be reflashed without USB. Runs in its own task.
//
//   GET  /state            → state JSON
//   POST /open | /close | /stop | /refresh
//   POST /go?open=0..100   → go to an openness
//   POST /pair?s=180       → open the Zigbee network for joining
//
// Every POST answers with the (post-command) state JSON.

#pragma once
#include <Arduino.h>

#include "blind.h"

namespace net {

// Call BEFORE Zigbee.begin(): Wi-Fi must be up when coexistence is enabled.
void begin(blind::BlindEndpoint &shade, String (*stateJson)());

}  // namespace net
