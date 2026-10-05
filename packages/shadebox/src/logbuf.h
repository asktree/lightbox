// ─── Log buffer ─────────────────────────────────────────────────────────────
//
// The board is on a charger in the bedroom, so nobody reads its serial port.
// line() prints a line on Serial and also keeps it in a ring buffer. GET /log
// returns the buffer, so the answers from the blind are visible over Wi-Fi.

#pragma once
#include <Arduino.h>

namespace logbuf {

constexpr size_t SIZE = 8192;

// printf for one line. Do not end the format with a newline. The line gets
// the uptime in seconds as a prefix. Long lines are cut at about 190 chars.
void line(const char *fmt, ...) __attribute__((format(printf, 1, 2)));

// Copy the buffer into dst, oldest line first, NUL-terminated. Returns the
// length. dst needs SIZE + 1 bytes to hold all of it.
size_t snapshot(char *dst, size_t cap);

}  // namespace logbuf
