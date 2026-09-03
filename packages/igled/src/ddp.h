// DDP listener ("dumb mode"): twinklybox streams raw RGB frames, igled shows
// them. Two flavors on two ports, same wire format:
//   :4048  immediate — frame renders as soon as its PUSH fragment lands
//   :4049  buffered  — frames carry a sender-clock ms timecode (DDP TIME flag)
//          and play out on a fixed delay, AirPlay-style, absorbing WiFi jitter
#pragma once

#include <FastLED.h>

struct StreamStats {
  uint32_t played, dropped, lost, underruns;
  uint16_t depth, slots;
  uint16_t bufferMs;      // effective playout delay right now
  uint16_t fpsX10;        // measured sender fps * 10
  bool     live;          // a stream is (recently) feeding us
};

void streamBegin(CRGB* framebuffer);   // call once WiFi is up
// Pump from loop(). Returns true when the framebuffer holds a new frame that
// should be shown now.
bool streamConsume(uint32_t nowMs);
bool streamLive(uint32_t nowMs);       // fed within the last ~2.5s
StreamStats streamStats();
