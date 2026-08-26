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

## Toolchain

[PlatformIO](https://platformio.org/) + Arduino-ESP32 + [LovyanGFX](https://github.com/lovyan03/LovyanGFX).

```sh
pip3 install platformio intelhex   # once
pnpm screenbox:flash               # build + flash over USB-C (from repo root)
pnpm screenbox:monitor             # serial output (Ctrl+C to exit)
# or inside packages/screenbox: pio run / pio run -t upload / pio device monitor
```
