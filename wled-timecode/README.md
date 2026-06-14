# WLED Timecode Buffer

A WLED usermod that adds a **jitter-absorbing playout buffer** to WLED's
realtime path, plus the matching sender support in twinklybox.

## The problem

Stock WLED renders every realtime (DDP/E1.31/Art-Net) frame the instant it
arrives. On a clean wired LAN that's ideal — minimum latency. On jittery WiFi
(mesh, 2.4 GHz-only ESP32, multi-hop) packets arrive in bursts and droughts, so
"render immediately" makes the LEDs micro-freeze and lurch. WLED has no buffer
option, and its DDP **timecode** field is parsed-and-ignored
(`handleDDPPacket()`: `if (p->flags & DDP_FLAGS_TIME) c = 4;`).

This is fine for most people but wrong for our setup: we drive over WiFi (no
cable, no local AP) **and** play through AirPlay, which already adds ~2 s of
delay. We have latency to spare and only care about smoothness. So we add the
buffer WLED won't.

## How it works

The sender (twinklybox) stamps each DDP frame with a **monotonic millisecond
timecode** on its own clock and sends it to a **separate UDP port (4049)**. The
usermod buffers whole frames and plays each one out when
`localClock >= timecode + offset`, where `offset` is chosen once at stream start
to add a fixed delay (default **500 ms**). Jitter smaller than the buffer is
fully absorbed — late packets still arrive before their scheduled playout time.

- **No clock sync needed.** We never compare absolute clocks; `offset` folds away
  the unknown sender↔device clock difference at init.
- **Drift correction.** Slow crystal drift is corrected by nudging `offset` ±1 ms
  when the buffered lead time wanders from target (imperceptible).
- **Same bytes, two modes.** The packet is standard DDP-with-timecode. Sent to
  port **4048** it plays immediately (stock WLED, no buffer); sent to **4049**
  the usermod buffers it. The sender just changes the port.
- **Clean fallback.** When the stream stops, the buffer drains and WLED's
  realtime timeout reverts to its own effects — exactly like stock.

### Packet format (standard DDP + timecode)

```
byte 0:     flags  (0x40 VER1 | 0x10 TIME | 0x01 PUSH on last fragment)
byte 1:     sequence (1..15; all fragments of one frame share it)
byte 2:     data type (0x01 RGB)
byte 3:     output id (1)
bytes 4-7:  channel/byte offset into the frame (uint32 BE)
bytes 8-9:  data length (uint16 BE)
bytes 10-13: timecode — sender-clock ms (uint32 BE)   <-- only when TIME flag set
bytes 14+:  pixel bytes (R,G,B,...)
```

Fragments are grouped into a frame by sequence number; the frame is published to
the ring buffer when its PUSH fragment lands.

## Layout

```
wled-timecode/
├── usermod/timecode_buffer/      # authoritative usermod source (lives here)
│   ├── timecode_buffer.h         #   all the logic
│   ├── timecode_buffer.cpp       #   REGISTER_USERMOD instance
│   └── library.json
├── platformio_override.ini       # build env "timecode_esp32" (esp32dev + this mod)
├── setup-build.sh                # symlinks usermod + copies override into WLED/
├── WLED/                         # git-ignored checkout (v16.0.0)
└── README.md
```

## Build & flash

```bash
# one-time: get the WLED source at the version this was written against
git clone --depth 1 --branch v16.0.0 https://github.com/wled/WLED.git wled-timecode/WLED

# wire the usermod + override into the checkout (idempotent; re-run after re-clone)
cd wled-timecode && ./setup-build.sh

# build (first build downloads the ESP32 toolchain — several minutes)
cd WLED && pio run -e timecode_esp32
# -> .pio/build/timecode_esp32/firmware.bin
```

Flash **over OTA** from the WLED web UI: `Config > Security & Updates > Manual
OTA update` → upload `firmware.bin`. **Keep a copy of each box's current
firmware first** (download via the same page or back up) so a bad build can't
strand the box.

> Box identity: the curtain is `wled-fcac0c` (MAC 3076f5fcac0c, ~192.168.20.243).
> Confirm by MAC before flashing — there are two near-identical boxes.

## Configure on the device

After flashing, the usermod appears under `Config > Usermods` as
**TimecodeBuffer**:

| Setting   | Default | Meaning                                            |
|-----------|---------|----------------------------------------------------|
| `enabled` | on      | master switch                                      |
| `port`    | 4049    | UDP port it listens on (must match the sender)     |
| `bufferMs`| 500     | playout delay / jitter headroom                    |
| `maxFps`  | 30      | used only to size the ring buffer (overestimate ok)|

The Info panel shows live buffer depth and `played / dropped / lost` counters —
the first place to look when tuning.

### Memory note

The ring buffer is `~ceil(bufferMs × maxFps / 1000) + margin` frames of
`numLeds × 3` bytes. For the 960-LED curtain at 500 ms / 30 fps that's ~21
frames × 2880 B ≈ **60 KB**, allocated from PSRAM if present, else DRAM (with
automatic back-off if the heap can't hold the requested size). Check free heap in
`/json/info` if you push `bufferMs` or `maxFps` higher.

## Drive it from twinklybox

The sender lives in `packages/twinklybox/src/server/wled.ts`
(`WledDriver.setBufferMode()`). Toggle at runtime:

```bash
# connect to the WLED box first (POST /api/connect {kind:'wled'})
curl -XPOST localhost:3010/api/buffer -H 'content-type: application/json' -d '{"on":true}'
# back to stock immediate DDP:
curl -XPOST localhost:3010/api/buffer -H 'content-type: application/json' -d '{"on":false}'
```

When on, frames go to port 4049 with timecodes; when off, port 4048 immediate.
`bufferMs` is a device-side setting — change it in the WLED usermod config, not
the sender.

## Status

- [x] Usermod written against WLED v16.0.0 source (verified APIs)
- [x] Sender support in twinklybox (`setBufferMode`, `/api/buffer`)
- [ ] Firmware compiled
- [ ] Flashed to curtain box
- [ ] On-hardware tuning (buffer depth telemetry, drift slew constants)
