#!/usr/bin/env bash
# Wire the out-of-tree usermod + override into the WLED checkout so PlatformIO
# can find them. Safe to re-run (idempotent). Re-run after re-cloning WLED.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WLED="$HERE/WLED"

if [ ! -d "$WLED" ]; then
  echo "WLED/ not found. Clone it first:"
  echo "  git clone --depth 1 --branch v16.0.0 https://github.com/wled/WLED.git \"$WLED\""
  exit 1
fi

# 1. Symlink the usermod source into WLED/usermods/ (load_usermods.py resolves
#    custom_usermods names to usermods/<name>).
ln -sfn "$HERE/usermod/timecode_buffer" "$WLED/usermods/timecode_buffer"
echo "linked usermods/timecode_buffer -> $HERE/usermod/timecode_buffer"

# 2. Drop the build env override in place.
cp "$HERE/platformio_override.ini" "$WLED/platformio_override.ini"
echo "copied platformio_override.ini"

echo
echo "Ready. Build with:"
echo "  cd \"$WLED\" && pio run -e timecode_esp32"
echo "Firmware: $WLED/.pio/build/timecode_esp32/firmware.bin"
echo "Flash via WLED web UI: Config > Security & Updates > Manual OTA update."
