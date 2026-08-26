# screenbox

Physical touch-screen control panel for lightbox — an ESP32-S3 with a 2.8" touch LCD.
Currently a hello-world; the goal is a wall/desk panel for scenes, palettes and brightness.

## Hardware

**Wireless-Tag WT32S3-28S PRO** (internal model `ZX2D80CE02S`, a.k.a. PanelLan `SC05_X`)

| Part | Detail |
|---|---|
| MCU module | WT32-S3-WROVER-N8R2 — ESP32-S3, 8 MB flash, 2 MB QSPI PSRAM |
| Display | 2.8" 240×320 IPS, ST7789, 8-bit 8080 parallel bus |
| Touch | FT5x06-compatible capacitive, I2C |
| USB-C | native ESP32-S3 USB (Serial/JTAG) — flashing + serial monitor |
| Debug header | MX1.25 7-pin: 5V, 3V3, TXD0, RXD0, EN, BOOT(GPIO0), GND |
| Expansion header | MX1.25 8-pin: 5V, GND, GPIO 10/11/12/13/14/21 |
| RS485 | RXD 4, RTS 5, TXD 6 |
| Power | 5 V via USB-C, ~150 mA at full backlight |

Full pin map: [`src/board.h`](src/board.h). Datasheet: [`docs/`](docs/).

## Running it from `hearth` (the always-on server Mac)

Instructions for a Claude session on hearth — the panel should talk to the
lightbox server there, and hearth should be the machine that flashes it.

1. **Pull and install tools** (once):
   ```sh
   cd ~/Coding/lightbox && git pull
   pip3 install platformio intelhex      # PlatformIO Core + esptool helper
   pnpm install
   ```
2. **Create the secrets file** (gitignored — ask the human for the password):
   ```sh
   cp packages/screenbox/include/secrets.example.h packages/screenbox/include/secrets.h
   ```
   Then fill in: `WIFI_SSID` = the **2.4 GHz** network (`emojiemojiemoji`;
   the emoji-named network is 5 GHz-only and the ESP32 can't see it),
   `WIFI_PASSWORD`, and `LIGHTBOX_HOST` = `"hearth.local"` (or hearth's LAN
   IP from `ipconfig getifaddr en0` if mDNS is flaky).
3. **Make sure the server is running** on hearth: `pnpm server` (port 3001).
   `curl localhost:3001/api/health` should return `{"status":"ok",...}`.
4. **Flash** — two options:
   - **Over Wi-Fi (no cable):** the panel advertises itself as `screenbox.local`
     once it's online. Run `pnpm screenbox:ota` from the repo root. Verify
     first with `ping screenbox.local` (mDNS needs hearth on the same LAN as
     the panel, not just the tailnet).
   - **Over USB:** plug the panel into hearth (shows up as `/dev/cu.usbmodem*`,
     "USB JTAG/serial debug unit"), then `pnpm screenbox:flash`.
   The very first flash after changing `LIGHTBOX_HOST` has to be OTA or USB
   from *any* machine on the LAN — after that the panel finds hearth itself.
5. **Check it:** `pnpm screenbox:monitor` (USB only) shows `[net] wifi ok`,
   `[net] mDNS: hearth.local -> …`, `[net] room lights: 7`, `[net] ws connected`.
   The panel's bottom-right dot turns green and says "online".

Troubleshooting: "wifi failed" + a network scan in the serial log means
wrong SSID/password (scan shows what the ESP32 can see, 2.4 GHz only).
"server..." forever means it can't reach `LIGHTBOX_HOST:3001` — check the
server is up and that hearth isn't on a different subnet/VLAN than the panel.

## Boards and modes

| env | board | notes |
|---|---|---|
| `wt32s3_28s_pro` (default) | 2.8" WT32S3-28S PRO | 240×320, `screenbox.local` |
| `wt32_sc01_plus` | 3.5" WT32-SC01 Plus | 320×480, DejaVu 12 font, `screenbox-35.local` |
| `wt32_sc01_plus_lowres` | 3.5" WT32-SC01 Plus | same board rendered at 160×240 and pixel-doubled (2×2 pseudo pixels), TomThumb 3×5 font, half the wisps |

Each has an `_ota` twin. Switching modes on the 3.5" is just flashing the other env:
`pnpm screenbox35:ota` (full res) / `pnpm screenbox35:lowres` (pixel-doubled), both over Wi-Fi.
The dormant-wheel labyrinth is precomputed per wheel size by `tools/gen_labyrinth.py --size <2*WHEEL_R>`.

## Toolchain

[PlatformIO](https://platformio.org/) + Arduino-ESP32 + [LovyanGFX](https://github.com/lovyan03/LovyanGFX).

```sh
pip3 install platformio intelhex   # once
pnpm screenbox:flash               # build + flash over USB-C (from repo root)
pnpm screenbox:ota                 # build + flash over Wi-Fi (panel must be online)
pnpm screenbox:monitor             # serial output over USB (Ctrl+C to exit)
# or inside packages/screenbox: pio run / pio run -t upload / pio device monitor
```
