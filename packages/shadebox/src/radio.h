// ─── Radio time-slicing ─────────────────────────────────────────────────────
//
// The C6 has one 2.4 GHz radio for Wi-Fi and Zigbee. No fixed coexistence
// priority gave both a reliable link. So the board stays in "Wi-Fi mode"
// (stock priorities, Wi-Fi wins) almost always. It goes to "Zigbee mode"
// (802.15.4 wins) only for a short window:
//
//   command arrives → reply on Wi-Fi → Zigbee window opens → command is sent
//   → the blind acknowledges it → short hold → back to Wi-Fi mode
//
// The blind is a sleepy end device: it polls its parent to get frames. The
// time from send to acknowledge is that poll delay. /state reports it as
// `ackMs`, so the window lengths can be set from measurements.
//
// Commands go through a one-slot queue. A newer command replaces one that
// was not sent yet (latest wins).

#pragma once
#include "blind.h"

namespace radio {

enum class Kind : uint8_t { None, Open, Close, Stop, Go, Refresh, Probe };

struct Stats {
  bool zigbee;         // true while a Zigbee window is open
  uint32_t windows;    // Zigbee windows since boot
  uint32_t timeouts;   // commands with no acknowledge in the window
  int32_t ackMs;       // last send → acknowledge time; -1 = none yet / timeout
  uint32_t windowMs;   // length of the last window
  int32_t heardAgoS;   // seconds since the last frame from the blind; -1 = never
  uint32_t holdMs;     // tunables, see tune()
  uint32_t maxMs;
  bool windowless;     // see setWindowless()
};

// Call after Zigbee.begin(). Records the stock priorities as "Wi-Fi mode".
void begin(blind::BlindEndpoint &shade);
void tick();  // call every loop

// Queue a command. Returns false if no blind is paired.
bool submit(Kind kind, int arg = 0);

// Queue a raw frame (blind.h). It uses the same slot as a command. The
// window stays open some seconds after the acknowledge, for the answer.
bool submitProbe(const blind::Probe &probe);

// Stay in Zigbee mode for `ms` (pairing). If `untilHeard`, the hold ends
// soon after the first frame from the blind. Wi-Fi can lose the access point
// during a hold of more than some seconds.
void hold(uint32_t ms, bool untilHeard = false);

// A frame came from the blind, or the stack confirmed delivery to it.
void heard();

// Window lengths: `holdMs` after the acknowledge, `maxMs` without one.
void tune(uint32_t holdMs, uint32_t maxMs);

// With `on` (the default), a command goes out at once in Wi-Fi mode. A
// Zigbee window opens only if the blind does not acknowledge in 0.75 s.
// With `off`, each command gets a window, as before. Not kept across a
// restart.
void setWindowless(bool on);

Stats stats();

}  // namespace radio
