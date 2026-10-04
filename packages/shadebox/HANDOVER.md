# shadebox — handover

Status of the Yoolax blind project on 2026-10-03, for the next Claude session on
**hearth**. All the code and all the known facts are in this file and in `src/`.
The project was started from the laptop on 2026-10-02.

## 1. Goal

Control the Yoolax Zigbee roller blind from lightbox. Use a gesture on the Hue
Tap Dial (the "puck"). Iggy does not use Home Assistant. Lightbox is the home
system, and it runs on hearth.

## 2. Hardware

| Item | Facts |
|---|---|
| Blind | Yoolax motorized roller shade, **Zigbee** motor. Yoolax support confirmed this (order 111-3828171-0633027). Hubitat users report it as model **TS0301**. It speaks standard ZCL Window Covering (cluster `0x0102`) and Tuya `0xEF00`. Both work. Battery motor, so it is a "sleepy" end device: commands can take some seconds. |
| Remote | Long white 16-channel remote with a screen. **P1/P2** are inside the battery compartment, above the AAA bay. |
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

### 6.1 With the remote (known method)

The sequence comes from users of this model and from search snippets of the
Yoolax manual. It is not fully verified. If the motor goes into a strange state,
stop and wait about one minute before you try again.

1. **Pair the remote again.** Hold the motor button for about 2 s, until the blind
   jogs one time. Then press **P2** one time. Then press **P1** one time. The blind
   jogs to confirm.
2. **Start limit setup.** Hold **up/down + ♥** for 6 s, until the blind jogs one time.
3. **Top limit.** Move the blind to the top position. Hold **up/down + ♥** for 2 s,
   until the blind jogs two times.
4. **Bottom limit.** Move the blind to the bottom position. Hold **up/down + ♥** for
   2 s, until the blind jogs two times.
5. If up and down are reversed, look in the remote manual for a direction-reverse
   step. If you reverse the motor, send `invert` on the console to turn the
   firmware flip off.

Motor button reference: 2 s = sleep on/off, 6 s = Zigbee pairing (blue flash),
16 s = **factory reset** (do not do this by accident; it also removes the remote
pairing). Three orange flashes = asleep.

Manuals: Zigbee manual is model 58628/58629 on the Yoolax product-manual page.
Matter version (different motor, for reference):
https://cdn.shopify.com/s/files/1/0558/5109/0060/files/58630-Program_Matter_Shades_with_Remote.pdf

### 6.2 Over Zigbee (not tested — an experiment)

Iggy asked if the limits can be set without the remote. Possibly. Nobody has
tried it on this motor. Candidates:

- **ZCL Window Covering `Mode` attribute `0x0017`.** Bit 0 = reverse motor
  direction. Bit 1 = calibration mode. Many motors ignore it.
- **Tuya datapoints on `0xEF00`.** Zigbee2MQTT uses these on some Tuya roller
  motors: DP 5 = motor direction, DP 16 = "border" (set or delete the up and down
  limits). This motor may not use the same numbers.

The firmware does not send these yet. Add a console command to write them, then
test. Use the remote method if this fails.

## 7. Firmware

| File | Job |
|---|---|
| `src/main.cpp` | Boot order, coexistence, serial console |
| `src/blind.h/.cpp` | Zigbee endpoint: pair, commands (ZCL and Tuya), state, movement inference |
| `src/net.h/.cpp` | Wi-Fi, mDNS, HTTP API, OTA |
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
```

**Serial console** (115200 baud, one command for each line):
`pair [s]`, `open`, `close`, `stop`, `go <0-100>`, `refresh`, `state`, `invert`,
`forget`, `reset` (wipes the Zigbee network and reboots), `coex <idle> <txrx> <txrx_at>`.

## 8. Set up on hearth

1. Pull lightbox: `git pull`.
2. Install PlatformIO if it is not there: `brew install platformio`. The first build
   downloads the pioarduino platform (Arduino-ESP32 3.x). This is necessary for
   the C6 and Zigbee.
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
