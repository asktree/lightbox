#include "ddp.h"
#include "config.h"
#include <AsyncUDP.h>

// ---------------------------------------------------------------------------
// Wire format: standard DDP (3waylabs.com/ddp). 10-byte header; if the TIME
// flag (0x10) is set, 4 big-endian bytes of sender-clock milliseconds follow
// before the pixel data. Fragments of one frame share a sequence number
// (1..15); the PUSH flag marks the last fragment.
//
// Buffering (design carried over from our old WLED usermod, reimplemented):
//   - No clock sync. At playout start, offset = localNow - oldestTimecode
//     folds away the unknown sender<->box clock difference; each frame then
//     plays when localNow >= timecode + offset.
//   - Ring depth is steered toward a target fill (~75% of the ring, clamped
//     to [MIN,MAX]_BUFFER_MS of buffered time) by nudging offset a few ms
//     every 100ms. That one mechanism sets the delay, absorbs crystal drift,
//     and recovers from slow over/underruns.
//   - Sender clock jumps (dev restart) trigger a resync instead of a stall.
//
// Concurrency: single-producer (AsyncUDP callback, async_tcp task) single-
// consumer (loop). Producer only writes `head`, consumer only writes `tail`,
// both volatile — a lock-free SPSC ring. When the ring is full the incoming
// frame is dropped; the consumer never has slots reached into from the
// producer side.
// ---------------------------------------------------------------------------

#define DDP_PORT_IMMEDIATE 4048
#define DDP_PORT_BUFFERED  4049

#define DDP_HEADER_LEN 10
#define DDP_FLAG_VER_MASK 0xC0
#define DDP_FLAG_VER1     0x40
#define DDP_FLAG_PUSH     0x01
#define DDP_FLAG_QUERY    0x02
#define DDP_FLAG_REPLY    0x04
#define DDP_FLAG_STORAGE  0x08
#define DDP_FLAG_TIME     0x10

#define RING_SLOTS     24          // 24 * 2880B = ~69KB; ~480ms at 50fps
#define BYTES_PER_FRAME (NUM_LEDS * 3)
#define MIN_BUFFER_MS  300
#define MAX_BUFFER_MS  2000
#define LIVE_TIMEOUT_MS 2500

static CRGB* fb = nullptr;

static AsyncUDP udpImmediate;
static AsyncUDP udpBuffered;

// Buffered ring. Pixel slots live on the heap (69KB — too big for static
// DRAM once WiFi + lwIP have taken their share); allocated once in
// streamBegin and never freed.
static uint8_t* ringMem = nullptr;   // RING_SLOTS * BYTES_PER_FRAME
static inline uint8_t* ringSlot(uint16_t i) { return ringMem + (size_t)i * BYTES_PER_FRAME; }
static uint32_t slotTimecode[RING_SLOTS];
static uint16_t slotLeds[RING_SLOTS];
static volatile uint16_t head = 0;
static volatile uint16_t tail = 0;

// Immediate path: assemble into asmImm, publish by copy into immBuf + flag.
static uint8_t immAsm[BYTES_PER_FRAME];
static uint8_t immBuf[BYTES_PER_FRAME];
static volatile uint16_t immLeds = 0;
static volatile bool immReady = false;

// Producer assembly state (owned by the UDP callback task)
struct Assembly {
  bool     open = false;
  uint8_t  seq = 0;
  uint16_t maxLed = 0;
  uint32_t timecode = 0;
};
static Assembly asmBuf; // buffered port
static Assembly asmImm; // immediate port

// Consumer playout state (owned by loop)
static bool     playing = false;
static uint32_t offsetMs = 0;
static uint32_t lastNudge = 0;
static uint32_t emptySince = 0;
static volatile bool resyncRequested = false;

// Sender cadence (producer-written, consumer-read; word-sized, benign races)
static volatile uint32_t frameIntervalMs = 20;   // EMA; twinklybox runs 50Hz
static uint32_t lastPubTc = 0;
static bool     havePubTc = false;

// Stats
static volatile uint32_t stPlayed = 0, stDropped = 0, stLost = 0, stUnderruns = 0;
static volatile uint16_t stBufferMs = 0;
static volatile uint32_t lastFrameArrival = 0;

static inline uint16_t ringNext(uint16_t i) { return (i + 1 >= RING_SLOTS) ? 0 : i + 1; }
static inline uint16_t ringDepth() {
  uint16_t h = head, t = tail;
  return (h >= t) ? (h - t) : (uint16_t)(RING_SLOTS - t + h);
}

// Target queue depth: most of the ring, clamped so depth * frameInterval sits
// inside [MIN_BUFFER_MS, MAX_BUFFER_MS]. Lower sender fps -> fewer frames is
// already more milliseconds, so the delay adapts on its own.
static uint16_t targetFill() {
  uint32_t iv = frameIntervalMs ? frameIntervalMs : 20;
  uint16_t byRing = (RING_SLOTS * 3) / 4;
  uint16_t cap = MAX_BUFFER_MS / iv;
  uint16_t flo = MIN_BUFFER_MS / iv;
  uint16_t t = byRing < cap ? byRing : cap;
  if (t < flo) t = flo;
  if (t < 2) t = 2;
  if (t > RING_SLOTS - 2) t = RING_SLOTS - 2;
  return t;
}

// Parse one DDP packet; assemble into the right destination. Both ports feed
// the same parser — the TIME flag, not the port, selects buffered playout.
static void onDdp(AsyncUDPPacket& pkt) {
  uint8_t* d = pkt.data();
  size_t len = pkt.length();
  if (len < DDP_HEADER_LEN) return;
  uint8_t flags = d[0];
  if ((flags & DDP_FLAG_VER_MASK) != DDP_FLAG_VER1) return;
  if (flags & (DDP_FLAG_QUERY | DDP_FLAG_REPLY | DDP_FLAG_STORAGE)) return;

  uint8_t  seq     = d[1] & 0x0F;
  uint32_t chanOff = ((uint32_t)d[4] << 24) | ((uint32_t)d[5] << 16) | ((uint32_t)d[6] << 8) | d[7];
  uint16_t dataLen = ((uint16_t)d[8] << 8) | d[9];

  size_t payloadStart = DDP_HEADER_LEN;
  uint32_t timecode = 0;
  bool hasTime = (flags & DDP_FLAG_TIME) != 0;
  if (hasTime) {
    if (len < DDP_HEADER_LEN + 4) return;
    timecode = ((uint32_t)d[10] << 24) | ((uint32_t)d[11] << 16) | ((uint32_t)d[12] << 8) | d[13];
    payloadStart += 4;
  }
  if (len < payloadStart + dataLen) return;   // truncated

  // Buffered playout needs a timecode; a timecode-less frame on 4049 (or a
  // stamped one on 4048) just follows the flag, not the port.
  bool buffered = hasTime;
  Assembly& a = buffered ? asmBuf : asmImm;

  uint16_t firstLed = (uint16_t)(chanOff / 3);
  uint16_t fragLeds = dataLen / 3;

  // New sequence while mid-frame = the previous frame's PUSH was lost.
  if (a.open && seq != a.seq) { stLost = stLost + 1; a.open = false; }

  if (buffered && !ringMem) return;   // allocation failed at boot
  if (!a.open) {
    if (buffered && ringNext(head) == tail) { stDropped = stDropped + 1; return; } // ring full
    a.open = true;
    a.seq = seq;
    a.maxLed = 0;
    a.timecode = timecode;
  }

  uint8_t* dst = buffered ? ringSlot(head) : immAsm;
  uint16_t lastLed = firstLed + fragLeds;
  if (lastLed > NUM_LEDS) lastLed = NUM_LEDS;
  if (lastLed > firstLed) {
    memcpy(dst + (size_t)firstLed * 3, d + payloadStart, (size_t)(lastLed - firstLed) * 3);
    if (lastLed > a.maxLed) a.maxLed = lastLed;
  }

  if (!(flags & DDP_FLAG_PUSH)) return;

  // --- publish the completed frame ---
  lastFrameArrival = millis();
  if (!buffered) {
    memcpy(immBuf, immAsm, (size_t)a.maxLed * 3);
    immLeds = a.maxLed;
    immReady = true;
    a.open = false;
    return;
  }

  // Sender clock discontinuity (restart / big jump): ask the consumer to
  // re-seat playout rather than draining a stale-epoch buffer.
  if (havePubTc) {
    int32_t dtc = (int32_t)(a.timecode - lastPubTc);
    if (dtc < -200 || dtc > 2000) {
      resyncRequested = true;
      havePubTc = false;
    } else if (dtc > 2 && dtc < 200) {
      frameIntervalMs = (frameIntervalMs * 7 + (uint32_t)dtc) / 8;
    }
  }
  lastPubTc = a.timecode;
  havePubTc = true;
  slotTimecode[head] = a.timecode;
  slotLeds[head] = a.maxLed;
  head = ringNext(head);
  a.open = false;
}

void streamBegin(CRGB* framebuffer) {
  fb = framebuffer;
  if (!ringMem) {
    ringMem = (uint8_t*)malloc((size_t)RING_SLOTS * BYTES_PER_FRAME);
    if (!ringMem) Serial.println("[ddp] ring alloc failed — buffered mode disabled");
  }
  if (udpImmediate.listen(DDP_PORT_IMMEDIATE))
    udpImmediate.onPacket([](AsyncUDPPacket pkt) { onDdp(pkt); });
  if (udpBuffered.listen(DDP_PORT_BUFFERED))
    udpBuffered.onPacket([](AsyncUDPPacket pkt) { onDdp(pkt); });
}

static void copyToFb(const uint8_t* px, uint16_t n) {
  if (n > NUM_LEDS) n = NUM_LEDS;
  for (uint16_t i = 0; i < n; i++) fb[i] = CRGB(px[i * 3], px[i * 3 + 1], px[i * 3 + 2]);
}

bool streamConsume(uint32_t now) {
  if (!fb) return false;

  // Immediate path wins if a frame is waiting (only one mode streams at a time).
  if (immReady) {
    immReady = false;
    copyToFb(immBuf, immLeds);
    stPlayed = stPlayed + 1;
    return true;
  }

  uint16_t h = head;

  if (resyncRequested) {
    resyncRequested = false;
    tail = h;              // discard the stale epoch (consumer owns tail)
    playing = false;
    return false;
  }

  if (tail == h) {         // ring empty
    if (playing) {
      if (emptySince == 0) emptySince = now;
      else if (now - emptySince > 300) { playing = false; stUnderruns = stUnderruns + 1; }
    }
    return false;
  }
  emptySince = 0;

  if (!playing) {
    if (ringDepth() < targetFill()) return false;   // prime a full cushion first
    offsetMs = now - slotTimecode[tail];            // oldest plays now
    playing = true;
    lastNudge = now;
  }

  bool rendered = false;
  while (tail != h) {
    uint32_t playAt = slotTimecode[tail] + offsetMs;
    if ((int32_t)(now - playAt) < 0) break;         // earliest frame not due yet
    uint16_t nxt = ringNext(tail);
    if (nxt != h && (int32_t)(now - (slotTimecode[nxt] + offsetMs)) >= 0) {
      tail = nxt;                                   // behind: drop, catch up
      stDropped = stDropped + 1;
      continue;
    }
    copyToFb(ringSlot(tail), slotLeds[tail]);
    stPlayed = stPlayed + 1;
    tail = nxt;
    rendered = true;
    break;
  }

  // Fill-targeting: hold the ring near target depth by shifting playout time.
  if (now - lastNudge >= 100) {
    lastNudge = now;
    uint16_t depth = ringDepth();
    uint16_t target = targetFill();
    if (depth < target) offsetMs += 2;              // low -> play later
    else if (depth > target + 1) offsetMs -= 1;     // high -> drain gently
    stBufferMs = (uint16_t)(depth * frameIntervalMs);
  }
  return rendered;
}

bool streamLive(uint32_t now) {
  uint32_t last = lastFrameArrival;
  return last != 0 && (now - last) < LIVE_TIMEOUT_MS;
}

StreamStats streamStats() {
  StreamStats s;
  s.played = stPlayed; s.dropped = stDropped; s.lost = stLost; s.underruns = stUnderruns;
  s.depth = ringDepth(); s.slots = RING_SLOTS;
  s.bufferMs = stBufferMs;
  uint32_t iv = frameIntervalMs;
  s.fpsX10 = iv ? (uint16_t)(10000 / iv) : 0;
  s.live = streamLive(millis());
  return s;
}
