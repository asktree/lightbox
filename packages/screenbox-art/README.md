# screenbox-art

Generative art sketches for the screenbox ESP32-S3 touch panels. Not part of
`pnpm dev`/`pnpm build`. Shares the board definitions (`../screenbox/src/board.h`,
`boards/`) and the gitignored Wi-Fi secrets (`../screenbox/include/secrets.h`) with
the control-panel firmware, so any sketch flashes to either panel.

The hardware has no GPU: everything is CPU-rendered into a full-frame RGB565
sprite (`src/common/canvas.*`) and pushed over the 8-bit parallel bus. Every
sketch also runs Wi-Fi + ArduinoOTA on core 0 (`src/common/ota.*`) so it stays
reflashable over the air — no USB needed once a panel is online.

## Sketches

| name | what | touch |
|---|---|---|
| `fish` | school of hollow-square fish flocking over a spinning sphere (curl-noise current, cell boids, boid-driven altitude, perlin-coloured trails) | finger = predator; sliders tune altitude params + zoom |
| `fish3d` | variant: free 3-D boids pulled toward the sphere centre, depth by size + draw order only | same, sliders for sep/glob/coh/flow |
| `comet` | vertical light streak in a starry sky, spray with trails, sparkle-field ocean, boat-rock camera. Greyscale. | drag = look around; look all the way up |
| `comet_d` / `comet_d3` | comet, 1-bit / 3-level ordered dither | tap toggles 2 <-> 3 levels |
| `comet_r` / `comet_b` | comet through a red / blue tone curve (white -> tint -> black) | |
| `comet_c` | comet with a bank of tone curves (`tools/gen_curves.py` -> `src/comet/curves.h`); boots on `abyss` | centre tap: palette · left: gash/cross · right: steady/candle/flame/strobe · bottom band: boat rock on/off |

Tone curves for `comet_c` are designed in the **Comet Tone Curves** web tool
(a claude.ai artifact: live JS port of the sketch + R/G/B spline editors +
blackbody generator, exports JSON). Paste the JSON into `tools/gen_curves.py`,
run it, flash.

## Flashing

From the repo root (OTA, panel must be online):

```sh
pnpm art:fish:28     # 2.8" WT32S3-28S PRO  -> screenbox.local
pnpm art:fish:35     # 3.5" WT32-SC01 Plus  -> screenbox-35.local
pnpm art:comet:28
pnpm art:comet:35
pnpm art:comet_c:28  # palette bank; also comet_d / comet_d3 / comet_r / comet_b, fish3d
```

Or inside this directory: `pio run -e <sketch><28|35>[_ota] -t upload`. The
control-panel UI goes back on with `pnpm screenbox:ota` / `pnpm screenbox35:ota`.

## Adding a sketch

1. `src/<name>/main.cpp` with `setup()`/`loop()`; draw into `canvas::frame`,
   call `canvas::present()`. See `src/fish/main.cpp` for the pattern.
2. Add `<name>28` / `<name>35` envs (+ `_ota` twins) to `platformio.ini` that
   extend `fish28`/`fish35` with `build_src_filter = +<common/> +<<name>/>`.
3. Add the pnpm scripts here and in the root `package.json`.
