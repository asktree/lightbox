// Which ZCL lift reports to use for a motor that also gives a Tuya position.
//
// The Yoolax motor has two position sources. Its ZCL lift attribute follows
// the blind while it moves (a report for each 1 %), so it gives the live
// position. But after a rejoin the motor gives lift 0 to a read, at any
// height. Its Tuya position (dp 3) is right, but it comes only as the answer
// to a query.
//
// So: use the Tuya position after a join, and use the lift reports when they
// cannot be the stale 0.
//
// No Arduino or Zigbee types here, so a host test can include this file.

#pragma once
#include <stdint.h>

namespace liftrule {

// A report that comes this soon after another one is part of the same move.
static constexpr uint32_t LIVE_MS = 5000;

// tuyaPos         the motor gave a Tuya position at some time
// staleSinceJoin  no Tuya position came after the last join or rejoin
// raw             the ZCL lift value
// moving          a move that this board started is in progress
// msSinceLastLift time since the last lift report that was used
inline bool usable(bool tuyaPos, bool staleSinceJoin, uint8_t raw, bool moving, uint32_t msSinceLastLift) {
  if (!tuyaPos) return true;         // a plain ZCL motor: this is its only source
  if (staleSinceJoin) return false;  // the lift value can be the stale 0
  if (raw != 0) return true;         // the stale value is always 0
  // A real 0 is the end of a move, by this board or by the remote.
  return moving || msSinceLastLift < LIVE_MS;
}

}  // namespace liftrule
