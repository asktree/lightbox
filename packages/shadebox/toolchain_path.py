# pioarduino's riscv32 toolchain package unpacks one level deep
# (toolchain-riscv32-esp/riscv32-esp-elf/bin), so PlatformIO's automatic
# <pkg>/bin PATH entry misses it. Prepend the real bin dir.
Import("env")
from pathlib import Path

pkg = Path(env.PioPlatform().get_package_dir("toolchain-riscv32-esp"))
nested = pkg / "riscv32-esp-elf" / "bin"
if nested.is_dir():
    env.PrependENVPath("PATH", str(nested))
