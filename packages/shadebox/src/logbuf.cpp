#include "logbuf.h"

#include <stdarg.h>

namespace logbuf {

static char s_ring[SIZE];
static size_t s_head = 0;       // next write position
static bool s_wrapped = false;  // the ring is full; s_head is also the oldest byte
static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;

void line(const char *fmt, ...) {
  char buf[200];
  uint32_t ms = millis();
  int n = snprintf(buf, sizeof(buf), "%lu.%03lu ", (unsigned long)(ms / 1000), (unsigned long)(ms % 1000));
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf + n, sizeof(buf) - n - 1, fmt, ap);  // keep one byte for the newline
  va_end(ap);
  size_t len = strlen(buf);
  buf[len++] = '\n';

  Serial.write((const uint8_t *)buf, len);

  // Lines come from the Zigbee task, the net task and loop().
  portENTER_CRITICAL(&s_mux);
  for (size_t i = 0; i < len; i++) {
    s_ring[s_head] = buf[i];
    if (++s_head == SIZE) {
      s_head = 0;
      s_wrapped = true;
    }
  }
  portEXIT_CRITICAL(&s_mux);
}

size_t snapshot(char *dst, size_t cap) {
  if (!cap) return 0;
  portENTER_CRITICAL(&s_mux);
  bool wrapped = s_wrapped;
  size_t start = wrapped ? s_head : 0;
  size_t count = wrapped ? SIZE : s_head;
  bool cut = wrapped;
  if (count > cap - 1) {
    start = (start + count - (cap - 1)) % SIZE;
    count = cap - 1;
    cut = true;
  }
  size_t first = min(count, SIZE - start);
  memcpy(dst, s_ring + start, first);
  memcpy(dst + first, s_ring, count - first);
  portEXIT_CRITICAL(&s_mux);
  dst[count] = 0;

  // The oldest line is not complete after a wrap. Drop it.
  if (cut) {
    char *nl = strchr(dst, '\n');
    if (nl) {
      count -= (size_t)(nl + 1 - dst);
      memmove(dst, nl + 1, count + 1);
    }
  }
  return count;
}

}  // namespace logbuf
