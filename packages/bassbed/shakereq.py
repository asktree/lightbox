#!/usr/bin/env python3
"""shakereq: a low-latency low-pass + boost for a bass shaker on macOS.

Reads system audio from a virtual input (BlackHole), keeps only the bass,
adds gain, limits the peaks, and writes the result to the amp's output
(the headphone jack by default). Speakers keep the full-range signal.

Setup (one time):
  1. brew install blackhole-2ch
     (or download from https://existential.audio/blackhole/)
  2. Audio MIDI Setup -> "+" -> Create Multi-Output Device.
     Tick "MacBook Air Speakers" and "BlackHole 2ch".
     Tick "Drift Correction" on BlackHole. Set this device as system output.
  3. pip3 install sounddevice numpy scipy

Run:
  python3 shakereq.py
  python3 shakereq.py --cutoff 50 --channels left   (one puck on the L channel)
  python3 shakereq.py --list                       (see device names)

Ctrl-C stops it. Latency is about 3 buffers: with --block 128 at 48 kHz
that is under 10 ms, which is not felt.
"""
import argparse
import sys

import numpy as np
import sounddevice as sd
from scipy import signal


def parse():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--in", dest="inp", default="BlackHole", help="input device name (substring)")
    p.add_argument("--out", default="External Headphones", help="output device name (substring)")
    p.add_argument("--cutoff", type=float, default=80.0, help="low-pass cutoff in Hz (default 80)")
    p.add_argument("--order", type=int, default=4, help="filter order (default 4 = 24 dB/octave)")
    p.add_argument("--gain", type=float, default=0.0, help="gain in dB after the filter (default 0)")
    p.add_argument("--limit", type=float, default=0.95, help="peak limit, 0..1 (default 0.95)")
    p.add_argument("--block", type=int, default=128, help="buffer size in samples (default 128)")
    p.add_argument("--rate", type=int, default=48000, help="sample rate (default 48000)")
    p.add_argument("--channels", choices=["both", "left", "right"], default="both",
                   help="which output channel gets the signal (default both; 'left' for one puck on L)")
    p.add_argument("--list", action="store_true", help="list audio devices and exit")
    return p.parse_args()


def find_device(name, kind):
    key = "max_input_channels" if kind == "input" else "max_output_channels"
    for i, d in enumerate(sd.query_devices()):
        if name.lower() in d["name"].lower() and d[key] >= 1:
            return i, d
    sys.exit(f"no {kind} device matching {name!r}. Run with --list to see names.")


def main():
    a = parse()
    if a.list:
        print(sd.query_devices())
        return
    in_i, in_d = find_device(a.inp, "input")
    out_i, out_d = find_device(a.out, "output")
    in_ch = min(2, in_d["max_input_channels"])
    out_ch = min(2, out_d["max_output_channels"])

    # Butterworth low-pass as second-order sections, one filter state per channel.
    sos = signal.butter(a.order, a.cutoff, btype="low", fs=a.rate, output="sos")
    zi = np.zeros((sos.shape[0], 2))
    gain = 10 ** (a.gain / 20)
    limit = a.limit
    clipped = [0]
    out_cols = {"both": range(out_ch), "left": [0], "right": [min(1, out_ch - 1)]}[a.channels]

    def callback(indata, outdata, frames, time, status):
        if status:
            print(status, file=sys.stderr)
        mono = indata.mean(axis=1) if in_ch > 1 else indata[:, 0]
        y, zi[:] = signal.sosfilt(sos, mono, zi=zi)
        y *= gain
        peak = np.abs(y).max()
        if peak > limit:
            y *= limit / peak
            clipped[0] += 1
        outdata[:] = 0
        for c in out_cols:
            outdata[:, c] = y

    print(f"in:  {in_d['name']}\nout: {out_d['name']}\n"
          f"low-pass {a.cutoff:.0f} Hz, order {a.order}, gain {a.gain:+.1f} dB, channels {a.channels}, block {a.block} @ {a.rate} Hz\n"
          f"Ctrl-C to stop.")
    with sd.Stream(device=(in_i, out_i), samplerate=a.rate, blocksize=a.block,
                   channels=(in_ch, out_ch), dtype="float32", latency="low", callback=callback):
        try:
            while True:
                sd.sleep(5000)
                if clipped[0]:
                    print(f"limiter active in {clipped[0]} buffers (lower --gain or the Mac volume)")
                    clipped[0] = 0
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    main()
