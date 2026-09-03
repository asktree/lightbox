#pragma once

#include <stdbool.h>

// WiFi + mDNS + ArduinoOTA + the HTTP API. Runs even in safe mode — that's
// the whole point of safe mode (a crash-looping build must stay reflashable).
void netBegin(bool safeMode);
void netLoop();
bool netConnected();
