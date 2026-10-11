"""Report this computer's audio output to the lightbox server.

Run this on the computer that plays the music when that computer is not the
lightbox server. It reads the default output device and its CoreAudio latency
(scraper/audio_latency.py) and sends them to the server each few seconds. The
server uses the report for light sync while it is fresh (15 s), then goes back
to its own output device. Stop the script when the music moves to the server.

Standard library only. No venv is necessary:

    python3 packages/music-scraper/scraper/output_reporter.py
    python3 packages/music-scraper/scraper/output_reporter.py --server http://hearth.local:3001
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request

try:
    from .audio_latency import get_output_latency_ms
except ImportError:  # run as a plain script
    from audio_latency import get_output_latency_ms

DEFAULT_SERVER = os.environ.get("LIGHTBOX_URL", "http://hearth.local:3001")
INTERVAL_S = 3.0
TIMEOUT_S = 3.0


def computer_name() -> str:
    try:
        out = subprocess.run(["scutil", "--get", "ComputerName"], capture_output=True, text=True, timeout=2)
        name = out.stdout.strip()
        if name:
            return name
    except Exception:
        pass
    return socket.gethostname()


def post_report(server: str, host: str, device: str | None, latency_ms: int) -> None:
    body = json.dumps({"host": host, "device": device, "latencyMs": latency_ms}).encode()
    req = urllib.request.Request(
        f"{server.rstrip('/')}/api/audio-latency/remote",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as res:
        res.read()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--server", default=DEFAULT_SERVER, help=f"lightbox server URL (default {DEFAULT_SERVER})")
    ap.add_argument("--once", action="store_true", help="send one report, then stop")
    args = ap.parse_args()

    host = computer_name()
    print(f"reporting audio output of {host!r} to {args.server} (Ctrl-C to stop)")
    last_line = None
    while True:
        ms, device = get_output_latency_ms()
        if ms is None:
            line = "no output device found"
        else:
            try:
                post_report(args.server, host, device, ms)
                line = f"{device!r}: {ms} ms"
            except Exception as e:
                line = f"server not reachable: {e}"
        # Print only when something changes, so the terminal stays quiet.
        if line != last_line:
            print(f"{time.strftime('%H:%M:%S')}  {line}", flush=True)
            last_line = line
        if args.once:
            return 0 if ms is not None and not line.startswith("server not reachable") else 1
        time.sleep(INTERVAL_S)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print()
        sys.exit(0)
