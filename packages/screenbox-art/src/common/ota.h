// Background Wi-Fi + ArduinoOTA so art sketches stay reflashable over the air.
// Runs on core 0; the sketch never waits on it.
#pragma once
namespace ota {
void begin();
bool online();
}
