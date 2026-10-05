# shadebox — handover

Status of the Yoolax blind project on 2026-10-03, for the next Claude session on
**hearth**. All the code and all the known facts are in this file and in `src/`.
The project was started from the laptop on 2026-10-02.

## 0. Update 2026-10-04 (hearth)

Iggy's decisions: the board stays on a USB charger in the bedroom, on Wi-Fi.
The gesture is a chord: hold **button 2** and turn the dial. Sections 4.1 and 5
below are history; this section replaces them.

**Radio: time-slicing (built, not tested on the board).** The board stays in
Wi-Fi mode (stock coexistence priorities). It gives the radio to Zigbee only for
a short window around each command. See `src/radio.h`.

- A command gets its HTTP reply first. Then the Zigbee window opens and the
  command is sent. The window closes `holdMs` (400) after the blind acknowledges,
  or after `maxMs` (6000) with no acknowledge.
- Commands use a one-slot queue. The newest command wins.
- `/state` has new fields: `radio`, `rssi`, `windows`, `timeouts`, `ackMs` (send
  to acknowledge time, the blind's poll delay), `windowMs`, `heardAgoS`.
- `POST /radio?hold=<ms>&max=<ms>` sets the window lengths. Serial: `radio <hold>
  <max>` and `hold <s>`.
- Pairing holds Zigbee mode. Wi-Fi is not reliable during that time.
- There is no Zigbee window at boot. See the measurements below.

**Measured on the board, 2026-10-05 (board on hearth's USB, blind in range):**

- The blind acknowledges a command in 0.36 s to 0.41 s (`ackMs`). A window
  with an acknowledge is about 1 s long.
- Wi-Fi survives a 6 s window when it was connected for some time before.
- A window that opens when Wi-Fi has just connected makes Wi-Fi lose the
  access point (`BEACON_TIMEOUT`), for 20 s to 35 s. A 20 s window and a 6 s
  window both did this. So the boot window is removed.
- With no boot window, Wi-Fi is up 4 s after boot and stays up.
- After a reboot of the board, the blind is not reachable until it joins
  again. It does this without help, in Wi-Fi mode. The delay was 3 s, 5 s and
  72 s in three boots, and more than 100 s in a fourth. A command in that
  time gets no acknowledge.
- To open the serial port resets the board (`rst:0x15 USB_UART_HPSYS`).

**Remote log and probes (the log is tested; the probes are not).** The board has no
serial reader in the bedroom. `GET /log` returns the last 8 KB of log lines,
each with the uptime in seconds. `POST /dp` and `POST /attr` send raw frames
for the travel-limit experiment (section 6.2).

**To measure after the first flash:** `ackMs` for some commands, the `timeouts`
count, and `heardAgoS` when idle. The blind reports its position at least each
300 s, so a large `heardAgoS` means the blind cannot reach the board in Wi-Fi
mode. Fall back to hearth USB only if this cannot be made reliable.

**USB flash: done on 2026-10-05.** The new firmware is on the board, and OTA
works (about 55 s for one upload). Hearth asks "Allow accessory to connect?" on
its screen for a new USB device; until someone clicks Allow, the board has no
serial port.

**Lightbox side (built, live on hearth):**

- `packages/server/src/services/shade.ts`: HTTP client with a latest-wins queue.
  It retries for 30 s, because the board does not answer during a Zigbee window.
- `packages/server/src/routes/shade.ts`: `GET /api/shade`, `POST
  /api/shade/open|close|stop`, `POST /api/shade/go {open}`.
- `tap-dial.ts`: button 2 held + rotation sets the blind openness (clockwise =
  more open). The first tick starts from the last known position. A go-to
  command replaces a movement in progress. If the position is not known, the
  chord sends stop.
- Button 2 also keeps its Hue app action on the bridge. Remove that action in
  the Hue app if it is not wanted.

**PlatformIO on hearth:** the pioarduino platform needs pioarduino core 6.2.0.
The stock `pio` 6.1.19 refuses it. The core is in its own venv,
`~/.local/share/pio-venv-pioarduino`, so the screenbox toolchain is not changed.
The package scripts put that venv first on PATH. `include/secrets.h` exists on
hearth.

**Next:** check Wi-Fi from the bedroom charger, set the travel limits
(section 6), then test the chord with real positions.

## 1. Goal

Control the Yoolax Zigbee roller blind from lightbox. Use a gesture on the Hue
Tap Dial (the "puck"). Iggy does not use Home Assistant. Lightbox is the home
system, and it runs on hearth.

## 2. Hardware

| Item | Facts |
|---|---|
| Blind | Yoolax motorized roller shade, **Zigbee** motor. Yoolax support confirmed this (order 111-3828171-0633027). Hubitat users report it as model **TS0301**. It speaks standard ZCL Window Covering (cluster `0x0102`) and Tuya `0xEF00`. Both work. Battery motor, so it is a "sleepy" end device: commands can take some seconds. |
| Remote | Long white 16-channel remote with a screen. **P1/P2** are inside the battery compartment, above the AAA bay. (2026-10-05: Iggy calls it the "easyone" remote; the exact model is not known, see section 6.1.) |
| Board | Seeed **XIAO ESP32-C6**. It is the Zigbee coordinator: it makes a one-device Zigbee network for the blind. |
| Server | **hearth** (`hearth.local`), the always-on Mac. Lightbox runs there. |

A Zigbee device can join only one coordinator. If you replace the board, pair
the blind again.

## 3. What works

- The board makes the Zigbee network. The blind joined it, and the blind moves on
  commands from the board.
- The board keeps the network, the blind identity, the protocol and the `invert`
  flag in flash. After a reboot, the blind joins again in about 15 s with no
  re-pair. Only the position is lost until the next report.
- Wi-Fi, mDNS (`shadebox.local`) and the HTTP API work.
- OTA (flash over Wi-Fi) works. One OTA took 78 s, because Wi-Fi and Zigbee share
  the radio.
- `invert` is **on**: the motor direction is reversed, so the firmware flips it.

## 4. What does not work

### 4.1 Wi-Fi and Zigbee share one radio — main blocker

The C6 has one 2.4 GHz radio for both Wi-Fi and 802.15.4 (Zigbee). Test results
with the coexistence priority (`coex <idle> <txrx> <txrx_at>` on the console):

| Setting | Result |
|---|---|
| Stock | Wi-Fi OK. Zigbee is slow: the blind took 80 s to join again. |
| Zigbee high priority | The blind joins in 4 s. Wi-Fi cannot find the router. |
| Middle setting | Both failed. |

The firmware boots with `setCoex(IEEE802154_LOW, IEEE802154_HIGH, IEEE802154_HIGH)`
(see `src/main.cpp`). This is the last setting from that session. It is not a
known-good setting.

Espressif's own Zigbee gateway design uses **two chips** for this reason. Options,
best first:

1. **USB to hearth.** If hearth is in Zigbee range of the blind, connect the C6 to
   hearth by USB. Turn off Wi-Fi on the board. Lightbox talks to it on the serial
   console. This is the most reliable option and needs no new hardware.
2. **Two chips.** The C6 runs only Zigbee. A second cheap ESP32 does Wi-Fi. They
   connect by UART (a few wires). This is Espressif's design. Cost is about $5 and
   some soldering. Iggy is a hardware beginner: give each physical step.
3. **Tune one chip.** It is possible, but it will probably always be unreliable.

**Ask Iggy first:** how far is hearth from the blind?

### 4.2 Position reports are wrong

The blind reports the same position at all heights. The motor does not know its
travel range. Set the travel limits to fix this (section 6).

## 5. Gesture spec (agreed, not built)

From the 2026-10-02 session:

- **Tap** = toggle: open the blind if it is closed, close it if it is open.
- **Tap while it moves** = pause (stop).
- **Dial after a tap** = for some seconds after a tap, rotation sets the blind
  position. After that time, the dial goes back to its usual job.

This is all the spec that exists. **Open questions for Iggy:**

- **Which button?** The dial has 4 buttons. `packages/server/src/services/tap-dial.ts`
  now uses **button 1** as the kelvin modifier, and rotation for brightness.
  Buttons 2–4 keep their Hue app actions. One of buttons 2–4 must become the
  blind button, and lightbox must then handle its events.
- **Which room?** `tap-dial.ts` says the dial is in the bedroom. Confirm that the
  blind is in the same room.
- **How many seconds** does the dial control the blind after a tap?

Gesture logic goes in lightbox, not in the firmware. The firmware stays a simple
blind driver.

## 6. Travel limits and direction

### 6.1 With the remote (the method from the manual)

**Open point, 2026-10-05:** Iggy says that her remote is the "easyone" remote
with a small screen, and that it is not the 16-channel remote in the pictures
of this manual. No manual for an "easyone" remote was found. Get a photo or the
model text of her remote, and find its steps, before she presses key pairs.
The steps below are for the Yoolax 16-channel remote only.

Source: the Yoolax manual 58630 (link below), section "16-channel remote
control", pages 35 to 47. That manual is for the Matter motor. They are not
tested here. An earlier version of this section had steps from user reports
(hold up/down + ♥ for 6 s); their source remote is not known.

The remote: top row **∧** (open), **□** (stop), **∨** (close). Second row: two
round-arrow buttons for small steps. Third row: **CH−**, **♥** (favorite),
**CH+**. **P1** (left) and **P2** (right) are in the battery compartment.

With no limits, the blind does not stop by itself. Stop it with **□**.

1. **Channel.** Press **CH−** or **CH+** to the channel of this blind.
2. **Setting mode.** Hold **P1** for 3 s. The screen flashes `nn`. Setting mode
   stops after 3 minutes with no button press, or when P1 is held for 5 s.
3. **Top limit.** Move the blind to the top position. Press **∧ and ♥**
   together. Two jogs: the limit is set. One jog: an old top limit was deleted;
   press again to set it.
4. **Bottom limit.** Move the blind to the bottom position. Press **∨ and ♥**
   together. Two jogs: set. One jog: deleted; press again.
5. Other key pairs in setting mode: **∧ and ∨** deletes both limits (and the
   favorite). **∧ and □** unpairs the remote from the motor. The manual also has
   pairs for direction, speed and the favorite position (pages 40 and 41).
6. **Pair the remote again** (page 46), in setting mode: hold the motor button
   for 2 s until the blind jogs one time. Press **P2** one time; the blind jogs
   two times. Press **P1** one time.
7. If you reverse the motor direction, send `invert` on the console to turn
   the firmware flip off.

To see if the limits are set (page 45): press the motor button one time. If the
blind moves, the limits are set. Press it again to stop.

Motor button reference: 2 s = sleep on/off, 6 s = Zigbee pairing (blue flash),
16 s = **factory reset** (do not do this by accident; it also removes the remote
pairing). Three orange flashes = asleep.

Manuals: Zigbee manual is model 58628/58629 on the Yoolax product-manual page.
Matter version (different motor, same 16-channel remote; it has a text layer):
https://cdn.shopify.com/s/files/1/0558/5109/0060/files/58630-Program_Matter_Shades_with_Remote.pdf

### 6.2 Over Zigbee (not tested — an experiment)

Iggy asked if the limits can be set without the remote. Possibly. Nobody has
tried it on this motor. Candidates:

- **ZCL Window Covering `Mode` attribute `0x0017`.** Bit 0 = reverse motor
  direction. Bit 1 = calibration mode. Many motors ignore it.
- **Tuya datapoints on `0xEF00`.** Zigbee2MQTT uses these on some Tuya roller
  motors: DP 5 = motor direction, DP 16 = "border" (set or delete the up and down
  limits). This motor may not use the same numbers.

The firmware can send these as raw frames (probes). Each probe goes through the
radio queue, like a command. The Zigbee window stays open 3 s after the
acknowledge, for the answer. Read the answer with `GET /log`.

```
POST /dp                                  ask for all Tuya datapoints
POST /dp?id=5&type=4&value=1              write a datapoint
                                          (type 1 bool, 2 value, 4 enum, 5 bitmap)
POST /attr?id=0x0017                      read an attribute (cluster default 0x0102)
POST /attr?id=0x0017&type=0x18&value=2    write it (type = ZCL type id)
     optional: &cluster=0x0102 &manuf=0x1002
GET  /log                                 the log, oldest line first
```

Rules to read the log:

- `[probe] …` is the frame that was sent.
- `[tuya] dp <id> type <t> len <n> = <value>` is a datapoint from the blind.
- `[zb] attr <cluster>/<id> type <t> size <n> = <bytes>` is an attribute value.
  The bytes are little-endian.
- `[zb] write attr on <cluster>: status 0x00` means that the blind accepted a write.
- A refused read or write gives **no line**. The Arduino core drops it. If
  `ackMs` is 0 or more and there is no answer line, the blind refused the frame.
- A read on the Basic cluster (0x0000) gives no line. The core keeps the answer.

**Read results, 2026-10-05 (limits not set, blind did not move):**

| Item | Value | Meaning |
|---|---|---|
| dp 1 (enum) | 1 | control: 0 open, 1 stop, 2 close |
| dp 2 (value) | 0 | go-to position |
| dp 3 (value) | 0 | position |
| dp 5 (enum) | 0 | motor direction: 0 forward, 1 back |
| dp 10 (value) | 0 | not known (travel time on other Tuya motors) |
| dp 11 (enum) | 1 | not known |
| dp 12 (bitmap) | 0 | fault |
| dp 13 (value) | 81 | battery % |
| dp 21 (value) | 35 | not known; a write is not kept (see "Speed" below) |
| dp 107 (bool) | 0 | not known (a limit state on one other TS0301 motor) |
| 0x0001/0x0021 | 0xa2 | battery, half-percent units (81 %) |
| 0x0102/0x0000 | 0 | type: roller shade |
| 0x0102/0x0007 | 0x03 | ConfigStatus: operational, online, **not closed loop** |
| 0x0102/0x0008 | 0 | lift % |
| 0x0102/0x0017 | 0x00 | Mode; the attribute exists (bit 0 reverse, bit 1 calibration) |
| 0x0102/0xF000 | 0 (u8) | Tuya attribute, meaning not known |
| 0x0102/0xF001 | 0 (bool) | Tuya attribute (calibration on other devices) |
| 0x0102/0xF002 | 0 (enum8) | Tuya attribute (motor reversal on other devices) |
| 0x0102/0xF003 | no answer | refused |
| 0x0102/0xF006 | 0 (enum8) | Tuya attribute, meaning not known |

The dump has no dp 7 and no dp 16. Read these again after the limits are set;
a value that changed shows what holds the limit state.

**Position sources (found 2026-10-05, limits set):**

- The lift attribute `0x0102/0x0008` follows the blind while it moves. The
  board asks for a report for each 1 % (at most one each second), and the
  move tests before 2026-10-05 03:18Z got these reports. This is the live
  position.
- After a rejoin the motor gives lift 0 to a read, at any height. It is not
  known when this value becomes right again.
- The Tuya position (dp 3) was right each time. It comes as the answer to a
  query (`POST /refresh`). After one move with the dial (2026-10-05 14:14Z)
  the motor sent no dp 3 by itself.
- So the board uses dp 3 after a join, and uses the lift reports when they
  cannot be the stale 0. The rule is in `src/liftrule.h`.
- When a move starts, the motor sends `0x0102/0xF008` = the target (raw).
- Raw 100 = bottom (closed), raw 0 = top (open), in the two sources.
- dp 10 = travel time in ms (32099). dp 2 = the target of the last move.

**Speed (tested 2026-10-05, limits set):**

- The motor runs at 3.1 % each second, up and down (26 % in 8.39 s between
  lift reports, four runs). Full travel: 32.1 s.
- dp 21 is not a speed setting that Zigbee can write. The motor echoes a
  written value (25, 34, 45, 100), but the next data query gives 35 again,
  and a move right after a write of 25 ran at the same speed.
- A data query lists only dp 1, 2, 3, 5, 10, 11, 12, 13, 21 and 107. So the
  speed setting that the remote has is not on Zigbee.
- Do not write to a datapoint that the motor does not list. On other Tuya
  motors, dp 16 and some dp above 100 set or delete the limits.
- If the speed is changed with the remote, read dp 21 again. If it changes,
  dp 21 is the speed number.

**Research, 2026-10-05:** no source documents a Zigbee command that sets the
limits on this motor. Zigbee2MQTT has three TS0301 covers. `TS0301_cover_1`
(A-OK AM25) has the same dp 1, 2, 3, 5, 13 as this motor and no limit
datapoint. `TS0301_cover_2` uses dp 16 for limits but has a different datapoint
layout. The plain `TS0301` entry (Yookee) uses only the standard cluster. A
Zemismart ZM15B converter uses dp 107 (enum) as limit state and dp 118 for
limit commands. Hubitat users of the Yoolax TS0301 set the limits with the
remote.

**Do not write a limit or calibration command with nobody at the blind.** A
shade with no limits has no stop; a wrong command can roll it too far. Stop the
motor (`POST /stop`) if it moves in a way that is not expected. The remote
method (section 6.1) is the safe one.

## 7. Firmware

| File | Job |
|---|---|
| `src/main.cpp` | Boot order, coexistence, serial console |
| `src/blind.h/.cpp` | Zigbee endpoint: pair, commands (ZCL and Tuya), state, movement inference |
| `src/net.h/.cpp` | Wi-Fi, mDNS, HTTP API, OTA |
| `src/radio.h/.cpp` | Wi-Fi/Zigbee time-slicing, command queue |
| `src/logbuf.h/.cpp` | Log lines to Serial and to a ring buffer (`GET /log`) |
| `platformio.ini` | Envs `xiao_c6` (USB) and `xiao_c6_ota` (Wi-Fi) |
| `partitions.csv` | Includes the Zigbee storage partitions |
| `toolchain_path.py` | Fixes the PATH for the pioarduino RISC-V toolchain |
| `include/secrets.h` | Wi-Fi name and password. **Gitignored.** Copy `secrets.example.h`. |

Boot order matters. Start Wi-Fi first, then enable coexistence, then start
Zigbee. This is the order in Espressif's gateway example. With other orders,
Wi-Fi did not connect.

**HTTP API** (`shadebox.local`, port 80):

```
GET  /state            state JSON
POST /open | /close | /stop | /refresh
POST /go?open=0..100   go to an openness
POST /pair?s=180       open the Zigbee network for joining
POST /radio?hold=&max= set the Zigbee window lengths (ms)
POST /invert?on=0|1    set the open/closed flip (kept in flash)
GET  /log              log lines, oldest first
POST /dp, POST /attr   raw frames, see section 6.2
```

**Serial console** (115200 baud, one command for each line):
`pair [s]`, `open`, `close`, `stop`, `go <0-100>`, `refresh`, `state`, `invert`,
`forget`, `reset` (wipes the Zigbee network and reboots), `coex <idle> <txrx> <txrx_at>`,
`dp [<id> <type> <value>]`, `attr <cluster> <id> [<type> <value>]`.

## 8. Set up on hearth

1. Pull lightbox: `git pull`.
2. PlatformIO: see section 0. Hearth uses the pioarduino core in its own venv.
   The first build downloads the pioarduino platform (Arduino-ESP32 3.x). This
   is necessary for the C6 and Zigbee.
3. Make `include/secrets.h`. Copy `include/secrets.example.h`. Use the
   **2.4 GHz** SSID `emojiemojiemoji`; the emoji-named network is 5 GHz only. The
   same values are in `packages/screenbox/include/secrets.h` if it exists on
   hearth. If not, ask Iggy for the password. Do not commit it.
4. Build: `pnpm shadebox:flash` with the board on hearth's USB (`/dev/cu.usbmodem*`).
   The board was last on the laptop, so the first flash on hearth must be by USB
   unless it is on Wi-Fi.
5. Watch it: `pnpm shadebox:monitor`. Check that the blind joins again (about 15 s)
   and that `state` shows the blind.
6. After the board is on Wi-Fi, `pnpm shadebox:ota` flashes it over the air.

Do not ssh-restart `pnpm dev` or the server on hearth. Iggy restarts it from her
own Terminal (see the lightbox memory note on dev-server launch).

## 9. Next steps, in order

1. Ask Iggy how far hearth is from the blind. Choose the radio option (section 4.1).
2. Set the travel limits with the remote (6.1), or try the Zigbee experiment (6.2).
   Then check that `state` positions track the real position.
3. Add a blind driver to the lightbox server. It calls the HTTP API, or the serial
   console if option 1 was chosen.
4. Add the gesture to `tap-dial.ts` (section 5). Get the open answers from Iggy first.
