#pragma once

#include "wled.h"
#include <AsyncUDP.h>

// =============================================================================
// Timecode Buffer usermod
// -----------------------------------------------------------------------------
// Adds a jitter-absorbing playout buffer to WLED's realtime path.
//
// WHY THIS EXISTS
//   Stock WLED renders every realtime (DDP/E1.31/Art-Net) frame the instant it
//   arrives. On a clean wired LAN that is ideal. On jittery WiFi (mesh, 2.4GHz,
//   multi-hop) packets arrive in bursts and droughts, so "render immediately"
//   means the LEDs micro-freeze and lurch. There is no way to disable that in
//   stock WLED — the DDP timecode field is parsed-and-ignored (see
//   handleDDPPacket(): `if (p->flags & DDP_FLAGS_TIME) c = 4;`).
//
// WHAT THIS DOES
//   Listens on its OWN UDP port (default 4049) for standard DDP packets that
//   carry a timecode (DDP flag 0x10). Each packet's timecode is a millisecond
//   value on the SENDER's monotonic clock. We buffer whole frames and play each
//   one out when `localClock >= timecode + offset`, where `offset` is chosen
//   once at stream start to add a fixed latency (default 500ms). Network jitter
//   smaller than the buffer is completely absorbed: late packets still arrive
//   before their scheduled playout time, so playback stays metronome-smooth.
//
//   The packet format is *exactly* standard DDP-with-timecode. The very same
//   bytes sent to port 4048 (stock WLED) play immediately with no buffering —
//   so the sender can fall back to direct mode just by changing the port.
//
// CLOCK SYNC
//   None required. We never compare absolute clocks — `offset` folds away the
//   unknown clock difference at init. Slow crystal drift between the sender and
//   the ESP32 is corrected by nudging `offset` ±1ms when the buffered lead time
//   wanders from the target (see driftAdjust()).
//
// CONCURRENCY
//   The AsyncUDP onPacket callback runs in the async_tcp task. It only assembles
//   bytes into the not-yet-published write slot and advances `head` on PUSH.
//   loop() (main task) reads `tail`. head/tail are volatile; the ring is a
//   single-producer/single-consumer queue, so no locks are needed. All LED
//   writes (setRealtimePixel/realtimeLock) happen in loop(), never in the
//   callback — matching how the serial Adalight path works.
// =============================================================================

#ifndef USERMOD_ID_TIMECODE_BUFFER
#define USERMOD_ID_TIMECODE_BUFFER 0x7C42  // "TC" — unspecified-range custom id
#endif

// DDP wire constants (from the DDP spec, 3waylabs.com/ddp) defined locally so
// this usermod is self-contained and version-independent: WLED 0.15.x does not
// expose these in a usermod-visible header, while 16.x does (under different
// names). Prefixed to avoid any clash with core defines.
#define TCB_DDP_HEADER_LEN 10
#define TCB_DDP_FLAG_VER    0xC0   // version mask
#define TCB_DDP_FLAG_VER1   0x40   // version = 1
#define TCB_DDP_FLAG_PUSH   0x01   // render now (last fragment of a frame)
#define TCB_DDP_FLAG_QUERY  0x02
#define TCB_DDP_FLAG_REPLY  0x04
#define TCB_DDP_FLAG_STORAGE 0x08
#define TCB_DDP_FLAG_TIME   0x10   // 4-byte timecode follows the header

class TimecodeBufferUsermod : public Usermod {
  private:
    // ---- config (persisted to cfg.json) ----
    bool     enabled    = true;
    uint16_t udpPort    = 4049;   // separate from stock DDP (4048) to avoid bind clash
    uint16_t maxBufferMs = 2000;  // cap on the playout delay (AirPlay gives us ~2s)
    uint16_t minBufferMs = 300;   // floor so a fast stream still gets some cushion

    // ---- runtime ----
    AsyncUDP  udp;
    bool      listening = false;

    // Ring buffer of whole frames. One contiguous pixel block + parallel
    // metadata arrays. Allocated in setup() once the strip length is known.
    uint8_t*  ringBuf      = nullptr;   // slotCount * bytesPerFrame, RGB triplets
    uint32_t* slotTimecode = nullptr;   // sender-clock ms for each slot
    uint16_t* slotLeds     = nullptr;   // LED count actually present in each slot
    uint16_t  slotCount    = 0;
    size_t    bytesPerFrame= 0;         // numLeds * 3
    uint16_t  numLeds      = 0;

    volatile uint16_t head = 0;         // producer writes here, publishes by advancing
    volatile uint16_t tail = 0;         // consumer (loop) reads here
    // Assembly state for the in-progress frame at `head` (callback-owned):
    bool      slotOpen     = false;     // are we mid-assembling head's frame?
    uint8_t   asmSeq       = 0;         // DDP seq of the frame being assembled
    uint16_t  asmMaxLed    = 0;         // highest LED index written so far +1
    uint32_t  asmTimecode  = 0;

    // Dynamic buffering: measure the incoming frame interval and size the
    // playout delay to use almost the whole ring (more frames buffered = more
    // jitter tolerance), capped at maxBufferMs. Lower sender fps → bigger delay.
    uint16_t  bufferMs        = 500;    // current playout delay (computed)
    uint32_t  frameIntervalMs = 33;     // EMA of sender frame spacing (ms)
    uint32_t  lastPubTc       = 0;      // last published timecode (interval + jump detect)
    bool      havePubTc       = false;

    // Playout state (loop-owned):
    bool      playing      = false;
    volatile bool resyncRequested = false; // set by producer on a clock jump
    uint32_t  offset       = 0;         // localMs = timecode + offset
    uint32_t  lastDrift    = 0;
    uint32_t  lastRenderMs = 0;
    uint32_t  emptySince   = 0;

    // Stats (surfaced in the Info panel):
    uint32_t  framesPlayed = 0;
    uint32_t  framesDropped= 0;         // dropped because we fell behind
    uint32_t  framesLost   = 0;         // abandoned partial frames (lost PUSH)
    uint32_t  underruns    = 0;

    static const char _name[];

    inline uint16_t ringNext(uint16_t i) const { return (i + 1 >= slotCount) ? 0 : i + 1; }
    inline uint16_t ringDepth() const {
      uint16_t h = head, t = tail;
      return (h >= t) ? (h - t) : (uint16_t)(slotCount - t + h);
    }

    // ---- UDP receive: assemble DDP fragments into the head slot -------------
    void onPacket(AsyncUDPPacket& pkt) {
      if (!enabled || !ringBuf) return;
      uint8_t* d = pkt.data();
      size_t   len = pkt.length();
      if (len < TCB_DDP_HEADER_LEN) return;

      uint8_t flags = d[0];
      if ((flags & TCB_DDP_FLAG_VER) != TCB_DDP_FLAG_VER1) return;   // only DDP v1
      if (flags & (TCB_DDP_FLAG_QUERY | TCB_DDP_FLAG_REPLY | TCB_DDP_FLAG_STORAGE)) return;

      uint8_t  seq      = d[1] & 0x0F;
      // bytes 4..7 channelOffset (big-endian), 8..9 dataLen (big-endian)
      uint32_t chanOff  = ((uint32_t)d[4] << 24) | ((uint32_t)d[5] << 16) |
                          ((uint32_t)d[6] << 8)  |  (uint32_t)d[7];
      uint16_t dataLen  = ((uint16_t)d[8] << 8) | d[9];

      size_t   payloadStart = TCB_DDP_HEADER_LEN;
      uint32_t timecode = 0;
      if (flags & TCB_DDP_FLAG_TIME) {
        if (len < TCB_DDP_HEADER_LEN + 4) return;
        timecode = ((uint32_t)d[10] << 24) | ((uint32_t)d[11] << 16) |
                   ((uint32_t)d[12] << 8)  |  (uint32_t)d[13];
        payloadStart += 4;
      }
      // No timecode? Not for us — ignore (sender should target 4048 for that).
      else return;

      if (len < payloadStart + dataLen) return;                 // truncated

      // DDP byte offset / 3 = first LED index of this fragment (RGB only).
      uint16_t firstLed = (uint16_t)(chanOff / 3);
      uint16_t fragLeds = (uint16_t)(dataLen / 3);

      // A change in sequence number means a new frame began. If we were still
      // assembling the previous one, its PUSH was lost — abandon it.
      if (slotOpen && seq != asmSeq) {
        framesLost++;
        slotOpen = false;
      }

      if (!slotOpen) {
        // Race-free SPSC: the producer (this callback, on the async task) only
        // ever writes `head`; the consumer (loop) only writes `tail`. So when
        // the ring is full we DROP THE INCOMING frame rather than reaching over
        // to advance tail (which used to corrupt the indices under load). The
        // consumer is always draining, so fullness is transient.
        if (ringNext(head) == tail) { framesDropped++; return; }
        slotOpen    = true;
        asmSeq      = seq;
        asmMaxLed   = 0;
        asmTimecode = timecode;
      }

      // Copy this fragment's pixels into the head slot at the right offset.
      uint8_t* slot = ringBuf + (size_t)head * bytesPerFrame;
      uint16_t lastLed = firstLed + fragLeds;
      if (lastLed > numLeds) lastLed = numLeds;                 // clamp to strip
      size_t copyBytes = (size_t)(lastLed - firstLed) * 3;
      if ((int16_t)(lastLed - firstLed) > 0) {
        memcpy(slot + (size_t)firstLed * 3, d + payloadStart, copyBytes);
        if (lastLed > asmMaxLed) asmMaxLed = lastLed;
      }

      // PUSH = last fragment of the frame. Publish the slot.
      if (flags & TCB_DDP_FLAG_PUSH) {
        // Discontinuity: the sender's monotonic clock jumped backward (it
        // restarted) or far forward. Re-seat playout instead of flailing until
        // the buffer drains — kills the flicker on dev restarts.
        if (havePubTc) {
          int32_t d = (int32_t)(asmTimecode - lastPubTc);
          if (d < -200 || d > 2000) {
            resyncRequested = true;   // consumer re-inits offset on next loop()
            havePubTc = false;
          } else if (d > 2 && d < 200) {
            // EMA of the frame interval (clamped to sane fps 5..200 Hz).
            frameIntervalMs = (frameIntervalMs * 7 + (uint32_t)d) / 8;
          }
        }
        lastPubTc = asmTimecode;
        havePubTc = true;
        slotTimecode[head] = asmTimecode;
        slotLeds[head]     = asmMaxLed;
        head     = ringNext(head);   // publish (single writer)
        slotOpen = false;
      }
    }

    // How many frames we want queued ahead: ~75% of the ring (leaving 25%
    // headroom for bursts), but clamped so the buffered TIME (frames × interval)
    // stays within [minBufferMs, maxBufferMs]. At a lower sender fps the same
    // frame count is more milliseconds — so the delay grows automatically,
    // "using the buffer as much as we can" up to the 2s cap.
    uint16_t targetFill() const {
      if (slotCount < 4) return 1;
      uint16_t byRing = (uint16_t)(((uint32_t)slotCount * 3) / 4);
      uint16_t cap = frameIntervalMs ? (uint16_t)(maxBufferMs / frameIntervalMs) : byRing;
      uint16_t flo = frameIntervalMs ? (uint16_t)(minBufferMs / frameIntervalMs) : 4;
      uint16_t t = byRing < cap ? byRing : cap;
      if (t < flo) t = flo;
      if (t < 2) t = 2;
      if (t > (uint16_t)(slotCount - 1)) t = slotCount - 1;
      return t;
    }

    // ---- render one buffered slot to the strip ------------------------------
    void renderSlot(uint16_t s) {
      uint8_t* px = ringBuf + (size_t)s * bytesPerFrame;
      uint16_t n  = slotLeds[s];
      // Refresh the realtime lock (mirrors core DDP path). Using
      // REALTIME_MODE_DDP avoids realtimeLock()'s immediate strip.show() — we
      // let handleNotifications() show once via the e131NewData flag instead.
      realtimeLock(realtimeTimeoutMs, REALTIME_MODE_DDP);
      if (!realtimeOverride) {
        for (uint16_t i = 0; i < n; i++) {
          uint16_t o = i * 3;
          setRealtimePixel(i, px[o], px[o + 1], px[o + 2], 0);
        }
      }
      e131NewData = true;          // main loop performs the actual strip.show()
      framesPlayed++;
      lastRenderMs = millis();
    }

    void startListening() {
      if (listening || !enabled) return;
      if (udp.listen(udpPort)) {
        udp.onPacket([this](AsyncUDPPacket pkt) { this->onPacket(pkt); });
        listening = true;
        DEBUG_PRINTF_P(PSTR("[timecode_buffer] listening on UDP %u\n"), udpPort);
      } else {
        DEBUG_PRINTLN(F("[timecode_buffer] UDP listen failed"));
      }
    }

    bool allocate() {
      freeBuffers();
      numLeds = strip.getLengthTotal();
      if (numLeds == 0) return false;
      bytesPerFrame = (size_t)numLeds * 3;
      // Size the ring to whatever heap we can spare (more frames = more buffer
      // time we can dial up at low fps), keeping a reserve for WLED. Cap at 40
      // frames — enough for a 2s delay even at 20fps. Back off if malloc fails.
      const uint32_t reserve = 45000;
      uint32_t freeHeap = ESP.getFreeHeap();
      uint32_t budget = freeHeap > reserve ? freeHeap - reserve : 0;
      uint16_t need = (uint16_t)(budget / bytesPerFrame);
      if (need > 40) need = 40;
      if (need < 8) need = 8;
      // Try requested size, then back off if heap can't hold it.
      for (uint16_t sc = need; sc >= 8; sc = (sc > 12 ? sc - 4 : sc - 1)) {
        size_t bytes = (size_t)sc * bytesPerFrame;
        // Plain malloc: these boxes have no PSRAM, and DRAM is required anyway
        // for the per-pixel byte access in renderSlot(). Back off if the heap
        // can't satisfy the requested ring size.
        ringBuf = (uint8_t*)malloc(bytes);
        slotTimecode = (uint32_t*)malloc((size_t)sc * sizeof(uint32_t));
        slotLeds = (uint16_t*)malloc((size_t)sc * sizeof(uint16_t));
        if (ringBuf && slotTimecode && slotLeds) {
          slotCount = sc;
          DEBUG_PRINTF_P(PSTR("[timecode_buffer] ring=%u frames (%u leds, %u B)\n"),
                         sc, numLeds, (unsigned)bytes);
          return true;
        }
        freeBuffers();
        if (sc == 8) break;
      }
      DEBUG_PRINTLN(F("[timecode_buffer] alloc failed"));
      return false;
    }

    void freeBuffers() {
      if (ringBuf)      { free(ringBuf);      ringBuf = nullptr; }
      if (slotTimecode) { free(slotTimecode); slotTimecode = nullptr; }
      if (slotLeds)     { free(slotLeds);     slotLeds = nullptr; }
      slotCount = 0; head = tail = 0; slotOpen = false; playing = false;
    }

  public:
    void setup() override {
      if (!enabled) return;
      if (!allocate()) { enabled = false; return; }
      // Do NOT open the UDP socket here. At usermod setup() time the network
      // stack (LwIP/WiFi) may not be initialized yet, and AsyncUDP::listen()
      // can hard-fault. We open the socket from connected() once WiFi is up —
      // the standard WLED pattern for realtime listeners.
    }

    void connected() override { startListening(); }

    void loop() override {
      if (!enabled || !ringBuf) return;
      uint32_t now = millis();
      uint16_t h = head;   // snapshot the volatile producer index once

      // Sender clock jumped (restart/discontinuity): drop the stale-epoch
      // buffer and re-prime cleanly. One brief blank instead of long flailing.
      if (resyncRequested) {
        resyncRequested = false;
        tail = h;            // clear ring (consumer owns tail)
        playing = false;
        return;
      }

      if (tail == h) {                     // buffer empty
        if (playing) {
          if (emptySince == 0) emptySince = now;
          else if (now - emptySince > 300) { playing = false; underruns++; }
        }
        return;
      }
      emptySince = 0;

      if (!playing) {
        // Prime: wait until the ring holds the target cushion before starting,
        // so playout begins with a full buffer (and a measured frame interval).
        if (ringDepth() < targetFill()) return;
        offset  = now - slotTimecode[tail];  // oldest plays now; rest = cushion
        playing = true;
        lastDrift = now;
      }

      // Render the earliest due frame. If we've fallen behind (NEXT is also due)
      // drop the current one — a backstop; the fill control below normally
      // keeps us from ever getting here.
      while (tail != h) {
        uint32_t playTime = slotTimecode[tail] + offset;
        if ((int32_t)(now - playTime) < 0) break;        // earliest not due yet
        uint16_t nxt = ringNext(tail);
        if (nxt != h) {
          uint32_t nextPlay = slotTimecode[nxt] + offset;
          if ((int32_t)(now - nextPlay) >= 0) {          // next also due -> drop
            tail = nxt; framesDropped++; continue;
          }
        }
        renderSlot(tail);
        tail = nxt;
        break;
      }

      // Fill-targeting control (replaces fixed-delay + drift correction): nudge
      // the playout offset to hold the ring near targetFill(). Buffer low → play
      // later (accumulate); high → play a touch earlier (drain). This maximizes
      // buffered time within the 2s cap AND absorbs clock drift in one place.
      if (now - lastDrift >= 100) {
        lastDrift = now;
        uint16_t depth = (h >= tail) ? (h - tail) : (uint16_t)(slotCount - tail + h);
        uint16_t target = targetFill();
        if (depth < target) offset += 2;            // low — delay more
        else if (depth > target + 1) offset -= 1;   // high — drain gently
        bufferMs = (uint16_t)((uint32_t)depth * frameIntervalMs); // effective delay (reported)
      }
    }

    // ---- config persistence -------------------------------------------------
    void addToConfig(JsonObject& root) override {
      JsonObject top = root.createNestedObject(FPSTR(_name));
      top[F("enabled")]     = enabled;
      top[F("port")]        = udpPort;
      top[F("maxBufferMs")] = maxBufferMs;
      top[F("minBufferMs")] = minBufferMs;
    }

    bool readFromConfig(JsonObject& root) override {
      JsonObject top = root[FPSTR(_name)];
      if (top.isNull()) return false;
      bool ok = true;
      ok &= getJsonValue(top[F("enabled")],     enabled,     enabled);
      ok &= getJsonValue(top[F("port")],        udpPort,     udpPort);
      ok &= getJsonValue(top[F("maxBufferMs")], maxBufferMs, maxBufferMs);
      ok &= getJsonValue(top[F("minBufferMs")], minBufferMs, minBufferMs);
      if (maxBufferMs > 5000) maxBufferMs = 5000;          // sanity clamp
      if (minBufferMs > maxBufferMs) minBufferMs = maxBufferMs;
      return ok;
    }

    void addToJsonInfo(JsonObject& root) override {
      JsonObject user = root[F("u")];
      if (user.isNull()) user = root.createNestedObject(F("u"));
      JsonArray a = user.createNestedArray(F("Timecode Buffer"));
      if (!enabled)        { a.add(F("disabled")); return; }
      if (!listening)      { a.add(F("not listening")); return; }
      char buf[64];
      // depth/cap frames · current effective delay · measured fps
      unsigned fpsX10 = frameIntervalMs ? (10000u / frameIntervalMs) : 0;
      snprintf_P(buf, sizeof(buf), PSTR("%u/%u fr · %ums delay · %u.%ufps"),
                 ringDepth(), slotCount, bufferMs, fpsX10 / 10, fpsX10 % 10);
      a.add(buf);
      JsonArray st = user.createNestedArray(F("TC played/drop/lost"));
      snprintf_P(buf, sizeof(buf), PSTR("%lu / %lu / %lu"),
                 (unsigned long)framesPlayed, (unsigned long)framesDropped,
                 (unsigned long)framesLost);
      st.add(buf);
    }

    uint16_t getId() override { return USERMOD_ID_TIMECODE_BUFFER; }
};

const char TimecodeBufferUsermod::_name[] PROGMEM = "TimecodeBuffer";
