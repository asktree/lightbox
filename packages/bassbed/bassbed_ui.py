#!/usr/bin/env python3
"""bassbed_ui: bass shaker feed with live controls and per-frequency limits.

Audio path: BlackHole in -> low-pass -> gain -> limiter -> per side (low cut,
delay, trim, polarity, per-frequency ceiling) -> headphone jack.

A local web page changes everything while it runs, plays test sounds, and has
a calibration mode that records the most each side may put out at every Hz.

  python3 bassbed_ui.py          then open http://127.0.0.1:8765

Settings and limits are kept in bassbed_settings.json next to this file.
"""
import argparse
import ctypes
import ctypes.util
import json
import os
import sys
import threading
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sounddevice as sd
from scipy import signal

RATE = 48000
ORDER = 4
SETTINGS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bassbed_settings.json")

LIMITS = {"cutoff": (20.0, 200.0), "gain": (-20.0, 60.0), "limit": (0.05, 1.0),
          "trim_l": (-24.0, 0.0), "trim_r": (-24.0, 0.0), "delay_r": (0.0, 25.0),
          "hp_l": (10.0, 60.0), "hp_r": (10.0, 60.0), "test_freq": (15.0, 150.0)}
CHANNELS = ("left", "right", "both")
TESTS = ("off", "tone", "sweep", "thump")
TEST_AMP = 0.1               # test signal level before the gain slider, close to typical music peaks
SWEEP = (20.0, 120.0, 12.0)  # start Hz, end Hz, seconds
MAXD = int(RATE * 0.025)     # longest right-side delay, in samples
HP_OFF = LIMITS["hp_l"][0]   # low cut at its minimum means off
CAL_LO, CAL_HI = 15, 120     # Hz range that can be calibrated
CAL_MIN, CAL_START = -60.0, -40.0  # dB of full scale: slider floor, and the level a fresh calibration starts at

state = {"cutoff": 80.0, "gain": 0.0, "limit": 0.95, "mute": False, "channel": "left",
         "invert_r": False, "trim_l": 0.0, "trim_r": 0.0, "delay_r": 0.0,
         "hp_l": 10.0, "hp_r": 10.0, "test": "off", "test_freq": 40.0, "limits_on": True}
cal = {"on": False, "side": "l", "freq": 20, "level": CAL_START}
limits = {"l": {}, "r": {}}    # side -> {Hz: ceiling in dB of full scale}
curves = {"l": None, "r": None}  # ceiling actually enforced at each Hz from CAL_LO to CAL_HI
meter = {"in": 0.0, "out": 0.0, "limiting": 0, "xruns": 0, "test_hz": 0.0,
         "hold_l": 0, "hold_r": 0, "peak_l": 0.0, "peak_r": 0.0, "lost": False}
rev = [0]                      # bumped whenever the limits change, so the page knows to refetch them
lock = threading.Lock()


# ---------------------------------------------------------------- filters

def make_sos(cutoff):
    return signal.butter(ORDER, cutoff, btype="low", fs=RATE, output="sos")


def make_hp(freq):
    return signal.butter(2, freq, btype="high", fs=RATE, output="sos")


def _biquad(kind, f, gain_db, q=4.0):
    """RBJ cookbook EQ section and its exact inverse, as sos rows."""
    A = 10 ** (gain_db / 40)
    w = 2 * np.pi * f / RATE
    c, s = np.cos(w), np.sin(w)
    if kind == "peak":
        al = s / (2 * q)
        b = [1 + al * A, -2 * c, 1 - al * A]
        a = [1 + al / A, -2 * c, 1 - al / A]
    else:
        al = s / 2 * np.sqrt(2)
        r = 2 * np.sqrt(A) * al
        if kind == "low":
            b = [A * ((A + 1) - (A - 1) * c + r), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - r)]
            a = [(A + 1) + (A - 1) * c + r, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - r]
        else:
            b = [A * ((A + 1) + (A - 1) * c + r), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - r)]
            a = [(A + 1) - (A - 1) * c + r, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - r]
    b, a = np.array(b), np.array(a)
    return np.r_[b / a[0], 1.0, a[1:] / a[0]], np.r_[a / b[0], 1.0, b[1:] / b[0]]


# The ceiling curve is built from a shelf at each end and a peak every sixth of an octave between.
_Q = 5.0
_SHAPES = [("low", 14.0)] + [("peak", 16.0 * 2 ** (k / 6)) for k in range(19)] + [("high", 140.0)]
NSEC = len(_SHAPES)
GRID = np.arange(8.0, 201.0)                      # 1 Hz steps used to fit the curve
_IN = (GRID >= CAL_LO) & (GRID <= CAL_HI)         # the part that can be calibrated and must be honoured
_WEIGHT = np.where(_IN, 1.0, 0.2)                 # outside it, just keep the curve from running away


def _cascade(gains):
    rows = [_biquad(k, f, g, _Q) for (k, f), g in zip(_SHAPES, gains)]
    return np.array([r[0] for r in rows]), np.array([r[1] for r in rows])


def _resp_db(sos):
    return 20 * np.log10(np.abs(signal.sosfreqz(sos, worN=GRID, fs=RATE)[1]))


# How much each section moves the curve per dB of its own gain, used to steer the fit.
_M = np.array([_resp_db(_cascade([1.0 if j == i else 0.0 for j in range(NSEC)])[0]) for i in range(NSEC)]).T


def design_ceiling(table):
    """Turn {Hz: ceiling dB} into a weighting filter, its inverse, and the curve really enforced.

    The weighting boosts each frequency by how far its ceiling sits under full
    scale. A limiter at full scale in that weighted domain, followed by the
    inverse filter, holds a sustained tone at any frequency under the curve.
    The fit leans toward the strict side, and is then shifted down so that
    between CAL_LO and CAL_HI it never sits above a requested ceiling.
    Returns None when there is nothing to limit.
    """
    if not table:
        return None
    hz = sorted(table)
    want = np.interp(GRID, hz, [table[h] for h in hz])  # straight lines between set points, flat past the ends
    if want.min() > -0.05:
        return None
    target = -want
    g = np.zeros(NSEC)
    for _ in range(18):
        r = target - _resp_db(_cascade(g)[0])
        w = _WEIGHT * np.where(r > 0, 5.0, 1.0)  # allowing too much costs more than allowing too little
        A = _M * w[:, None]
        g = np.clip(g + np.linalg.solve(A.T @ A + 0.02 * np.eye(NSEC), A.T @ (r * w)), -60, 60)
    w, wi = _cascade(g)
    short = float(np.max((target - _resp_db(w))[_IN]))  # worst place the fit would allow more than asked
    k = 10 ** (max(0.0, short) / 20)
    w[0, :3] *= k
    wi[0, :3] /= k
    return w, wi, [round(float(v), 1) for v in -_resp_db(w)[_IN]]


def redesign(side):
    d = design_ceiling(limits[side])
    dsp["ceil_" + side] = d
    curves[side] = None if d is None else d[2]


dsp = {"sos": make_sos(state["cutoff"]), "hp_l": make_hp(state["hp_l"]), "hp_r": make_hp(state["hp_r"]),
       "ceil_l": None, "ceil_r": None}


class CeilingLimiter:
    """Frequency-dependent hard ceiling for one shaker."""

    def __init__(self):
        self.reset()

    def reset(self):
        self.z = np.zeros((NSEC, 2))
        self.zi = np.zeros((NSEC, 2))
        self.red = 1.0
        self.active = False

    def process(self, x, design):
        """Return (signal, held). design is the tuple from design_ceiling, or None for off."""
        if design is None:
            if self.active:
                self.reset()
            return x, False
        self.active = True
        xw, self.z = signal.sosfilt(design[0], x, zi=self.z)
        peak = float(np.abs(xw).max())
        want = 1.0 / peak if peak > 1.0 else 1.0
        # slow release: letting go within a bass cycle would reshape the wave and push it over the ceiling
        red = want if want < self.red else self.red + (want - self.red) * 0.01
        xw = xw * np.linspace(self.red, red, len(x))
        np.clip(xw, -1.0, 1.0, out=xw)  # hard stop in the weighted domain
        self.red = red
        y, self.zi = signal.sosfilt(design[1], xw, zi=self.zi)
        return y, want < 1.0


class TestGen:
    """Test signals that replace the music at the input of the chain."""

    def __init__(self):
        self.phase = 0.0
        self.n = 0
        self.amp = 0.0
        self.mode = "off"

    def block(self, frames, mode, freq):
        """Return (signal, current_hz), or (None, 0) when off and fully faded out."""
        if mode != "off" and mode != self.mode:
            self.n = 0
        if mode != "off":
            self.mode = mode
        target = TEST_AMP if mode != "off" else 0.0
        if target == 0.0 and self.amp == 0.0:
            self.mode = "off"
            return None, 0.0
        step = TEST_AMP * frames / (RATE * 0.05)  # 50 ms fade
        new_amp = min(target, self.amp + step) if target > self.amp else max(target, self.amp - step)
        env = np.linspace(self.amp, new_amp, frames)
        self.amp = new_amp
        idx = self.n + np.arange(frames)
        self.n += frames
        if self.mode == "thump":
            t = (idx % RATE) / RATE
            dur = 4.0 / freq
            x = np.where(t < dur, np.sin(2 * np.pi * freq * t) * np.sin(np.pi * t / dur) ** 2, 0.0)
            return x * env, freq
        if self.mode == "sweep":
            f0, f1, secs = SWEEP
            f = f0 * (f1 / f0) ** ((idx % int(secs * RATE)) / (secs * RATE))
        else:
            f = np.full(frames, freq)
        ph = self.phase + np.cumsum(2 * np.pi * f / RATE)
        self.phase = float(ph[-1] % (2 * np.pi))
        return np.sin(ph) * env, float(f[-1])


# ---------------------------------------------------------------- audio engine

class Engine:
    """Everything that happens to one block of audio. Has no device code, so it can be tested offline."""

    def __init__(self, in_ch, out_ch):
        self.in_ch, self.out_ch = in_ch, out_ch
        self.zi = np.zeros((dsp["sos"].shape[0], 2))
        self.zl = np.zeros((1, 2))
        self.zr = np.zeros((1, 2))
        self.gen = TestGen()
        self.ceil = {"l": CeilingLimiter(), "r": CeilingLimiter()}
        self.gain = 0.0      # linear gain actually applied
        self.red = 1.0       # main limiter reduction
        self.l = self.r = 0.0
        self.tail = np.zeros(MAXD, dtype=np.float32)
        self.cal_amp = 0.0
        self.cal_phase = 0.0
        self.cal_side = "l"
        self.failed = False

    def _peak(self, side, x, held=False):
        meter["hold_" + side] = 8 if held else max(0, meter["hold_" + side] - 1)
        meter["peak_" + side] = max(float(np.abs(x).max()), meter["peak_" + side] * 0.9)

    def _ceiling(self, side, x):
        x, held = self.ceil[side].process(x, dsp["ceil_" + side] if state["limits_on"] else None)
        self._peak(side, x, held)
        return x

    def _calibration(self, frames):
        """Calibration tone at exactly the slider level, or None when calibration is off and faded out."""
        target = 10 ** (cal["level"] / 20) if cal["on"] else 0.0
        if cal["side"] != self.cal_side:
            if self.cal_amp > 0:
                target = 0.0  # fade out on the old side before moving across
            else:
                self.cal_side = cal["side"]
        if target == 0.0 and self.cal_amp == 0.0:
            return None
        step = frames / (RATE * 0.05)  # full scale in 50 ms, so level changes do not click
        new = min(target, self.cal_amp + step) if target > self.cal_amp else max(target, self.cal_amp - step)
        env = np.linspace(self.cal_amp, new, frames)
        self.cal_amp = new
        ph = self.cal_phase + 2 * np.pi * cal["freq"] / RATE * np.arange(1, frames + 1)
        self.cal_phase = float(ph[-1] % (2 * np.pi))
        return np.sin(ph) * env

    def process(self, indata, outdata, frames, xrun=False):
        if xrun:
            meter["xruns"] += 1
        mono = indata.mean(axis=1) if self.in_ch > 1 else indata[:, 0]
        meter["in"] = max(float(np.abs(mono).max()), meter["in"] * 0.9)
        outdata[:] = 0
        if meter["lost"]:
            return  # output device unplugged: CoreAudio would reroute us to the default output, which feeds BlackHole

        tone = self._calibration(frames)
        if tone is not None:
            # calibration bypasses the whole chain: the slider is the level that leaves the jack
            col = 0 if self.cal_side == "l" else min(1, self.out_ch - 1)
            outdata[:, col] = tone
            self._peak(self.cal_side, tone)
            self._peak("r" if self.cal_side == "l" else "l", np.zeros(1))
            meter["out"] = max(float(np.abs(tone).max()), meter["out"] * 0.9)
            meter["limiting"] = 0
            return

        test, meter["test_hz"] = self.gen.block(frames, state["test"], state["test_freq"])
        if test is not None:
            mono = test.astype(np.float32)  # test sound replaces the music at the bed
            meter["in"] = max(float(np.abs(mono).max()), meter["in"])
        y, self.zi = signal.sosfilt(dsp["sos"], mono, zi=self.zi)
        # ramp gain across the block so slider moves do not click
        target = 0.0 if state["mute"] else 10 ** (state["gain"] / 20)
        y = y * np.linspace(self.gain, target, frames)
        self.gain = target
        # main limiter: instant attack, slow release, ramped across the block
        peak = float(np.abs(y).max())
        limit = state["limit"]
        want = min(1.0, limit / peak) if peak > 0 else 1.0
        red = want if want < self.red else self.red + (want - self.red) * 0.02
        y = y * np.linspace(self.red, red, frames)
        np.clip(y, -limit, limit, out=y)
        self.red = red
        meter["limiting"] = 20 if want < 1.0 else max(0, meter["limiting"] - 1)
        meter["out"] = max(float(np.abs(y).max()), meter["out"] * 0.9)

        # per-side multiplier: channel select, trim, and polarity; ramped so switches do not click
        ch = state["channel"]
        tl = 0.0 if ch == "right" else 10 ** (state["trim_l"] / 20)
        tr = 0.0 if ch == "left" else 10 ** (state["trim_r"] / 20)
        if state["invert_r"]:
            tr = -tr
        # low cut per side keeps each shaker out of the range where it bottoms out
        yl = y
        if state["hp_l"] > HP_OFF:
            yl, self.zl = signal.sosfilt(dsp["hp_l"], y, zi=self.zl)
        # right side can be delayed to line its phase up with the left
        buf = np.concatenate((self.tail, y.astype(np.float32)))
        self.tail = buf[-MAXD:]
        d = min(MAXD, int(round(state["delay_r"] * RATE / 1000)))
        yr = buf[MAXD - d:MAXD - d + frames]
        if state["hp_r"] > HP_OFF:
            yr, self.zr = signal.sosfilt(dsp["hp_r"], yr, zi=self.zr)
        # per-frequency ceilings come last, so they cap what actually leaves the jack
        left = self._ceiling("l", yl * np.linspace(self.l, tl, frames))
        right = self._ceiling("r", yr * np.linspace(self.r, tr, frames))
        self.l, self.r = tl, tr
        outdata[:, 0] = left
        if self.out_ch > 1:
            outdata[:, 1] = right
        np.clip(outdata, -1.0, 1.0, out=outdata)

    def callback(self, indata, outdata, frames, time, status):
        try:
            self.process(indata, outdata, frames, bool(status))
        except Exception:
            outdata[:] = 0  # never let a bug leave garbage on the amp
            if not self.failed:
                self.failed = True
                traceback.print_exc()


def find_device(name, kind):
    key = "max_input_channels" if kind == "input" else "max_output_channels"
    for i, d in enumerate(sd.query_devices()):
        if name.lower() in d["name"].lower() and d[key] >= 1:
            return i, d
    sys.exit(f"no {kind} device matching {name!r}")


# PortAudio's device list is frozen at startup, so hot-plug has to be asked of CoreAudio directly.
_ca = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreAudio"))
_cf = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreFoundation"))


class _Addr(ctypes.Structure):
    _fields_ = [("sel", ctypes.c_uint32), ("scope", ctypes.c_uint32), ("elem", ctypes.c_uint32)]


_fourcc = lambda s: int.from_bytes(s.encode(), "big")
_ca.AudioObjectGetPropertyDataSize.argtypes = [ctypes.c_uint32, ctypes.POINTER(_Addr), ctypes.c_uint32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
_ca.AudioObjectGetPropertyData.argtypes = [ctypes.c_uint32, ctypes.POINTER(_Addr), ctypes.c_uint32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32), ctypes.c_void_p]
_cf.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
_cf.CFRelease.argtypes = [ctypes.c_void_p]


def live_devices():
    """Names of the audio devices CoreAudio has right now, or None if it would not say."""
    addr = _Addr(_fourcc("dev#"), _fourcc("glob"), 0)
    size = ctypes.c_uint32()
    if _ca.AudioObjectGetPropertyDataSize(1, ctypes.byref(addr), 0, None, ctypes.byref(size)):
        return None
    ids = (ctypes.c_uint32 * (size.value // 4))()
    if _ca.AudioObjectGetPropertyData(1, ctypes.byref(addr), 0, None, ctypes.byref(size), ids):
        return None
    names = []
    for i in ids:
        addr = _Addr(_fourcc("lnam"), _fourcc("glob"), 0)
        ref, size = ctypes.c_void_p(), ctypes.c_uint32(8)
        if _ca.AudioObjectGetPropertyData(i, ctypes.byref(addr), 0, None, ctypes.byref(size), ctypes.byref(ref)) or not ref.value:
            continue
        buf = ctypes.create_string_buffer(256)
        _cf.CFStringGetCString(ref, buf, 256, 0x08000100)
        _cf.CFRelease(ref)
        names.append(buf.value.decode(errors="replace"))
    return names


def watch_output(name):
    """Flag meter["lost"] while no device matches name: when the headphone jack is unplugged CoreAudio
    silently reroutes the stream to the default output, which is a multi-output that feeds BlackHole,
    and the bed then howls through its own input."""
    def run():
        while True:
            threading.Event().wait(0.5)
            names = live_devices()
            if names is None:
                continue
            present = any(name.lower() in n.lower() for n in names)
            if present == meter["lost"]:
                meter["lost"] = not present
                print("output device lost: muted" if not present else "output device back", flush=True)
    threading.Thread(target=run, daemon=True).start()


def open_stream(inp, out, block):
    in_i, in_d = find_device(inp, "input")
    out_i, out_d = find_device(out, "output")
    watch_output(out)
    in_ch = min(2, in_d["max_input_channels"])
    out_ch = min(2, out_d["max_output_channels"])
    eng = Engine(in_ch, out_ch)
    print(f"in:  {in_d['name']}\nout: {out_d['name']}")
    return sd.Stream(device=(in_i, out_i), samplerate=RATE, blocksize=block,
                     channels=(in_ch, out_ch), dtype="float32", latency="low", callback=eng.callback)


# ---------------------------------------------------------------- settings file

def save_settings():
    data = {"state": state, "limits": {s: {str(h): v for h, v in sorted(limits[s].items())} for s in "lr"}}
    tmp = SETTINGS + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, SETTINGS)


def apply_state(req):
    for k, (lo, hi) in LIMITS.items():
        if isinstance(req.get(k), (int, float)) and not isinstance(req.get(k), bool):
            state[k] = float(min(hi, max(lo, req[k])))
    for k in ("mute", "invert_r", "limits_on"):
        if isinstance(req.get(k), bool):
            state[k] = req[k]
    if req.get("channel") in CHANNELS:
        state["channel"] = req["channel"]
    if req.get("test") in TESTS:
        state["test"] = req["test"]


def load_settings():
    try:
        with open(SETTINGS) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return
    apply_state(data.get("state", {}))
    state["test"] = "off"  # never start up playing a test sound
    for s in "lr":
        for h, v in data.get("limits", {}).get(s, {}).items():
            try:
                h, v = int(h), float(v)
            except (TypeError, ValueError):
                continue
            if CAL_LO <= h <= CAL_HI:
                limits[s][h] = min(0.0, max(CAL_MIN, v))


# ---------------------------------------------------------------- calibration actions

def _inherit(side, freq):
    """Level to start from at a frequency: its own saved value, else the nearest saved one below, else quiet."""
    tab = limits[side]
    if freq in tab:
        return tab[freq]
    below = [h for h in tab if h < freq]
    return tab[max(below)] if below else CAL_START


def cal_action(req):
    """Apply one calibration request. Returns True when the limits changed."""
    a = req.get("action")
    side, f = cal["side"], cal["freq"]
    changed = False
    if a in ("start", "side"):
        if req.get("side") in ("l", "r"):
            side = cal["side"] = req["side"]
        if a == "start":
            cal["on"] = True
            state["test"] = "off"
        cal["level"] = _inherit(side, f)
    elif a == "stop":
        cal["on"] = False
    elif a in ("set", "nudge"):
        v = req.get("level") if a == "set" else cal["level"] + (req.get("delta") or 0)
        if isinstance(v, (int, float)):
            cal["level"] = float(min(0.0, max(CAL_MIN, v)))
            limits[side][f] = cal["level"]
            changed = True
    elif a == "next":
        limits[side][f] = cal["level"]  # space confirms this frequency, then carries the level to the next
        changed = True
        cal["freq"] = min(CAL_HI, f + 1)
        cal["level"] = limits[side].get(cal["freq"], cal["level"])
    elif a == "prev":
        cal["freq"] = max(CAL_LO, f - 1)
        cal["level"] = limits[side].get(cal["freq"], cal["level"])
    elif a == "goto" and isinstance(req.get("freq"), (int, float)):
        cal["freq"] = int(min(CAL_HI, max(CAL_LO, round(req["freq"]))))
        cal["level"] = _inherit(side, cal["freq"])
    elif a == "clear" and req.get("side") in ("l", "r"):
        limits[req["side"]].clear()
        side = req["side"]
        if side == cal["side"]:
            cal["level"] = CAL_START
        changed = True
    if changed:
        redesign(side)
        rev[0] += 1
    return changed


# ---------------------------------------------------------------- web page

PAGE = r"""<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Bass bed</title>
<style>
:root{--bg:#14141a;--fg:#e8e6f0;--dim:#8a879a;--acc:#b48cff;--acc2:#4fd1c5;--bar:#2a2a36;--warn:#ff6b6b}
@media (prefers-color-scheme:light){:root{--bg:#f6f5fa;--fg:#1c1b22;--dim:#6b687a;--acc:#6b3fd4;--acc2:#0f8f86;--bar:#dddbe8;--warn:#d22}}
body{background:var(--bg);color:var(--fg);font:16px/1.4 -apple-system,system-ui,sans-serif;max-width:520px;margin:32px auto;padding:0 16px}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--dim);font-size:13px;margin-bottom:24px}
.row{margin:22px 0}.lab{display:flex;justify-content:space-between;align-items:baseline}
.val{font-variant-numeric:tabular-nums;font-size:22px;font-weight:600}
input[type=range]{width:100%;accent-color:var(--acc);height:32px}
.nudge{display:flex;gap:8px;margin-top:4px;flex-wrap:wrap}
button{background:var(--bar);color:var(--fg);border:0;border-radius:8px;padding:8px 14px;font:inherit;cursor:pointer}
button.on{background:var(--warn);color:#fff}button.sel{background:var(--acc);color:#fff}
.meter{height:10px;background:var(--bar);border-radius:5px;overflow:hidden;margin-top:6px}
.meter i{display:block;height:100%;width:0;background:var(--acc);transition:width .1s}
.small{color:var(--dim);font-size:13px}.flag{color:var(--warn);font-weight:600;visibility:hidden}
.box{border:1px solid var(--bar);border-radius:12px;padding:14px}.box.live{border-color:var(--warn)}
canvas{width:100%;height:160px;display:block;margin:8px 0;cursor:crosshair}
.big{font-variant-numeric:tabular-nums;font-size:34px;font-weight:700}
.kl{color:var(--acc)}.kr{color:var(--acc2)}
</style>
<h1>Bass bed</h1><div class=sub>BlackHole → low-pass → gain → limiter → per-side limits → headphone jack</div>

<div class=row><div class=lab><span>Gain</span><span class=val id=v_gain></span></div>
<input type=range id=gain min=-20 max=60 step=0.5>
<div class=nudge><button data-k=gain data-d=-1>−1 dB</button><button data-k=gain data-d=1>+1 dB</button><button id=mute>Mute</button></div></div>

<div class=row><div class=lab><span>Cutoff</span><span class=val id=v_cutoff></span></div>
<input type=range id=cutoff min=20 max=200 step=1>
<div class=nudge><button data-k=cutoff data-d=-5>−5 Hz</button><button data-k=cutoff data-d=5>+5 Hz</button></div></div>

<div class=row><div class=lab><span>Output channel</span></div>
<div class=nudge><button data-ch=left>Left</button><button data-ch=right>Right</button><button data-ch=both>Both</button><button id=invr>Invert right</button></div></div>

<div class=row><div class=lab><span>Left trim</span><span class=val id=v_trim_l></span></div>
<input type=range id=trim_l min=-24 max=0 step=0.5>
<div class=lab><span>Right trim</span><span class=val id=v_trim_r></span></div>
<input type=range id=trim_r min=-24 max=0 step=0.5>
<div class=lab><span>Right delay</span><span class=val id=v_delay_r></span></div>
<input type=range id=delay_r min=0 max=25 step=0.25>
<div class=small>Delay plus invert covers every phase offset. A full cycle is 12.5 ms at 80 Hz, 25 ms at 40 Hz.</div></div>

<div class=row><div class=lab><span>Test sound</span><span class=val id=v_test_freq></span></div>
<div class=nudge><button data-t=off>Off</button><button data-t=tone>Tone</button><button data-t=sweep>Sweep</button><button data-t=thump>Thump</button></div>
<input type=range id=test_freq min=15 max=150 step=1>
<div class=small>Replaces the music at the bed while on, and goes through the whole chain like music does. Sweep runs 20 to 120 Hz over 12 seconds.</div></div>

<div class=row><div class=lab><span>Left low cut</span><span class=val id=v_hp_l></span></div>
<input type=range id=hp_l min=10 max=60 step=1>
<div class=lab><span>Right low cut</span><span class=val id=v_hp_r></span></div>
<input type=range id=hp_r min=10 max=60 step=1>
<div class=small>Removes the deepest bass entirely. Far left is off.</div></div>

<div class="row box" id=calbox>
<div class=lab><span>Limits per frequency <label class=small><input type=checkbox id=limon> enforce</label></span><span class=small><span class=kl>■ left</span> <span id=n_l></span> &nbsp;<span class=kr>■ right</span> <span id=n_r></span></span></div>
<canvas id=plot></canvas>
<div class=nudge><button data-side=l>Left</button><button data-side=r>Right</button><button id=calgo>Start</button><button id=calclear>Clear side</button></div>
<div class=lab style="margin-top:14px"><span class=big id=calhz></span><span class=big id=callv></span></div>
<input type=range id=cal_level min=-60 max=0 step=0.5>
<div class=nudge><button id=calprev>← back 1 Hz</button><button id=calnext>Save and next Hz</button></div>
<div class=small id=calhelp style="margin-top:8px">Start plays a steady tone on the chosen side at exactly the level on the slider. Raise it until the shaker clacks, back off a little, then press <b>space</b>: that saves the limit and moves up 1 Hz with the same level. <b>← →</b> step through frequencies, <b>↑ ↓</b> nudge the level by 0.5 dB (shift for 3 dB), <b>Esc</b> stops. Click the graph to jump to a frequency. Music is held to the saved curve.</div></div>

<div class=row><div class=lab><span>Limiter ceiling</span><span class=val id=v_limit></span></div>
<input type=range id=limit min=0.05 max=1 step=0.01></div>

<div class=row><div class=lab><span class=small>Input</span><span class=small id=t_in></span></div><div class=meter><i id=m_in></i></div>
<div class=lab style="margin-top:12px"><span class=small>Output <span class=flag id=f_lim>limiting</span></span><span class=small id=t_out></span></div><div class=meter><i id=m_out></i></div>
<div class=lab style="margin-top:12px"><span class=small>Left at the jack <span class=flag id=f_l>held by limits</span></span><span class=small id=t_l></span></div>
<div class=lab><span class=small>Right at the jack <span class=flag id=f_r>held by limits</span></span><span class=small id=t_r></span></div>
<div class=small id=xr style="margin-top:10px"></div></div>
<script>
const $=id=>document.getElementById(id);
const SL=['gain','cutoff','limit','trim_l','trim_r','delay_r','hp_l','hp_r','test_freq'];
const fmt={gain:v=>(v>0?'+':'')+v.toFixed(1)+' dB',cutoff:v=>v.toFixed(0)+' Hz',limit:v=>Math.round(v*100)+'%',
 trim_l:v=>v.toFixed(1)+' dB',trim_r:v=>v.toFixed(1)+' dB',delay_r:v=>v.toFixed(2)+' ms',
 hp_l:v=>v>10?v.toFixed(0)+' Hz':'off',hp_r:v=>v>10?v.toFixed(0)+' Hz':'off',test_freq:v=>v.toFixed(0)+' Hz'};
const db=x=>x>1e-5?(20*Math.log10(x)).toFixed(1)+' dB':'−∞';
let s=null,m=null,cal=null,L=null,rev=-1,drag=null,clearArmed=0;
function pick(key,val){document.querySelectorAll('[data-'+key+']').forEach(b=>b.classList.toggle('sel',b.dataset[key]===val))}
function render(){
 if(!s)return;
 for(const k of SL){$('v_'+k).textContent=fmt[k](s[k]);if(drag!==k)$(k).value=s[k]}
 if(s.test==='sweep')$('v_test_freq').textContent=m.test_hz.toFixed(0)+' Hz';
 pick('ch',s.channel);pick('t',s.test);pick('side',cal.side);
 $('invr').classList.toggle('sel',s.invert_r);$('invr').textContent=s.invert_r?'Right inverted':'Invert right';
 $('mute').classList.toggle('on',s.mute);$('mute').textContent=s.mute?'Muted':'Mute';
 $('limon').checked=s.limits_on;
 $('calgo').classList.toggle('on',cal.on);$('calgo').textContent=cal.on?'Stop tone':'Start';
 $('calbox').classList.toggle('live',cal.on);
 $('calhz').textContent=cal.freq+' Hz';$('callv').textContent=cal.level.toFixed(1)+' dB';
 if(drag!=='cal_level')$('cal_level').value=cal.level;
 $('m_in').style.width=Math.min(100,m.in*100)+'%';$('m_out').style.width=Math.min(100,m.out*100)+'%';
 $('t_in').textContent=db(m.in);$('t_out').textContent=db(m.out);$('t_l').textContent=db(m.peak_l);$('t_r').textContent=db(m.peak_r);
 $('f_lim').style.visibility=m.limiting?'visible':'hidden';
 $('f_l').style.visibility=m.hold_l?'visible':'hidden';$('f_r').style.visibility=m.hold_r?'visible':'hidden';
 $('xr').textContent=(m.lost?'OUTPUT DEVICE UNPLUGGED — muted. Plug the jack back in and restart. ':'')+(m.xruns?m.xruns+' audio glitches since start':'');
 if(L){$('n_l').textContent=Object.keys(L.limits.l).length+' set';$('n_r').textContent=Object.keys(L.limits.r).length+' set'}
 draw();
}
function draw(){
 const c=$('plot');if(!L||!c.getContext)return;
 const r=c.getBoundingClientRect(),d=window.devicePixelRatio||1,W=r.width,H=r.height;
 if(c.width!==Math.round(W*d)||c.height!==Math.round(H*d)){c.width=Math.round(W*d);c.height=Math.round(H*d)}
 const g=c.getContext('2d');g.setTransform(d,0,0,d,0,0);g.clearRect(0,0,W,H);
 const cs=getComputedStyle(document.documentElement),col=n=>cs.getPropertyValue(n).trim();
 const x=f=>(f-L.lo)/(L.hi-L.lo)*(W-34)+28,y=v=>-Math.max(-60,v)/60*(H-20)+5;
 g.font='10px -apple-system,sans-serif';g.lineWidth=1;g.strokeStyle=col('--bar');g.fillStyle=col('--dim');
 for(const v of [0,-20,-40,-60]){g.beginPath();g.moveTo(28,y(v));g.lineTo(W-6,y(v));g.stroke();g.fillText(v,2,y(v)+3)}
 for(const f of [20,40,60,80,100,120]){g.beginPath();g.moveTo(x(f),5);g.lineTo(x(f),H-15);g.stroke();g.fillText(f,x(f)-7,H-2)}
 for(const [side,name] of [['l','--acc'],['r','--acc2']]){
  g.strokeStyle=g.fillStyle=col(name);const cv=L.curve[side];
  if(cv){g.lineWidth=2;g.beginPath();cv.forEach((v,i)=>{const X=x(L.lo+i),Y=y(v);i?g.lineTo(X,Y):g.moveTo(X,Y)});g.stroke()}
  for(const f in L.limits[side])g.fillRect(x(+f)-1.5,y(L.limits[side][f])-1.5,3,3)}
 g.strokeStyle=g.fillStyle=col(cal.on?'--warn':'--dim');g.lineWidth=1;
 g.beginPath();g.moveTo(x(cal.freq),5);g.lineTo(x(cal.freq),H-15);g.stroke();
 g.beginPath();g.arc(x(cal.freq),y(cal.level),4,0,7);g.fill();
}
function apply(j){s=j.state;m=j.meter;cal=j.cal;if(j.rev!==rev){rev=j.rev;loadLimits()}render()}
async function post(path,o){try{apply(await(await fetch(path,{method:'POST',body:JSON.stringify(o)})).json())}catch(e){}}
async function loadLimits(){try{L=await(await fetch('/limits')).json();render()}catch(e){}}
async function poll(){try{apply(await(await fetch('/state')).json())}catch(e){$('xr').textContent='audio process not responding'}}
const set=o=>{if(s){Object.assign(s,o);render()}return post('/set',o)};
const calp=o=>post('/cal',o);
for(const k of SL){const e=$(k);e.oninput=()=>{drag=k;set({[k]:+e.value})};e.onchange=()=>{drag=null}}
document.querySelectorAll('[data-k]').forEach(b=>b.onclick=()=>{if(!s)return;const k=b.dataset.k,e=$(k);
 set({[k]:Math.min(+e.max,Math.max(+e.min,s[k]+ +b.dataset.d))})});
document.querySelectorAll('[data-ch]').forEach(b=>b.onclick=()=>set({channel:b.dataset.ch}));
document.querySelectorAll('[data-t]').forEach(b=>b.onclick=()=>set({test:b.dataset.t}));
document.querySelectorAll('[data-side]').forEach(b=>b.onclick=()=>calp({action:'side',side:b.dataset.side}));
$('mute').onclick=()=>set({mute:!s.mute});
$('invr').onclick=()=>set({invert_r:!s.invert_r});
$('limon').onchange=()=>set({limits_on:$('limon').checked});
$('calgo').onclick=()=>{$('calgo').blur();calp({action:cal.on?'stop':'start'})};
$('calnext').onclick=()=>{$('calnext').blur();calp({action:'next'})};
$('calprev').onclick=()=>{$('calprev').blur();calp({action:'prev'})};
$('cal_level').oninput=()=>{drag='cal_level';cal.level=+$('cal_level').value;render();calp({action:'set',level:cal.level})};
$('cal_level').onchange=()=>{drag=null;$('cal_level').blur()};
$('calclear').onclick=()=>{const b=$('calclear'),name=cal.side==='l'?'left':'right';
 if(Date.now()-clearArmed<3000){clearArmed=0;b.textContent='Clear side';b.classList.remove('on');calp({action:'clear',side:cal.side})}
 else{clearArmed=Date.now();b.textContent='Click again to clear '+name;b.classList.add('on');
  setTimeout(()=>{if(clearArmed){clearArmed=0;b.textContent='Clear side';b.classList.remove('on')}},3000)}};
$('plot').onclick=e=>{if(!L)return;const r=$('plot').getBoundingClientRect();
 calp({action:'goto',freq:Math.round((e.clientX-r.left-28)/(r.width-34)*(L.hi-L.lo)+L.lo)})};
document.addEventListener('keydown',e=>{
 if(!cal||!cal.on||e.metaKey||e.ctrlKey||e.altKey)return;
 let a=null;const k=e.key,step=e.shiftKey?3:0.5;
 if(k===' '||k==='ArrowRight')a={action:'next'};
 else if(k==='ArrowLeft'||k==='Backspace')a={action:'prev'};
 else if(k==='ArrowUp')a={action:'nudge',delta:step};
 else if(k==='ArrowDown')a={action:'nudge',delta:-step};
 else if(k==='Escape')a={action:'stop'};
 if(!a)return;
 e.preventDefault();const f=document.activeElement;if(f&&f.blur)f.blur();
 calp(a)});
document.addEventListener('keyup',e=>{if(cal&&cal.on&&e.key===' ')e.preventDefault()});
setInterval(poll,150);poll();
</script>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, body, ctype="application/json"):
        data = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def snapshot(self):
        return json.dumps({"state": state, "meter": meter, "cal": cal, "rev": rev[0]})

    def do_GET(self):
        if self.path == "/state":
            self.send(self.snapshot())
        elif self.path == "/limits":
            self.send(json.dumps({"lo": CAL_LO, "hi": CAL_HI, "curve": curves,
                                  "limits": {s: {str(h): v for h, v in limits[s].items()} for s in "lr"}}))
        else:
            self.send(PAGE, "text/html; charset=utf-8")

    def do_POST(self):
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        except ValueError:
            req = {}
        if not isinstance(req, dict):
            req = {}
        with lock:
            if self.path == "/cal":
                cal_action(req)
            else:
                apply_state(req)
                if state["test"] != "off":
                    cal["on"] = False  # one tone source at a time
                if "cutoff" in req:
                    dsp["sos"] = make_sos(state["cutoff"])
                for k in ("hp_l", "hp_r"):
                    if k in req:
                        dsp[k] = make_hp(state[k])
            save_settings()
        self.send(self.snapshot())


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--in", dest="inp", default="BlackHole")
    p.add_argument("--out", default="External Headphones")
    p.add_argument("--block", type=int, default=256)
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--no-open", action="store_true")
    a = p.parse_args()
    load_settings()
    dsp["sos"] = make_sos(state["cutoff"])
    dsp["hp_l"], dsp["hp_r"] = make_hp(state["hp_l"]), make_hp(state["hp_r"])
    redesign("l")
    redesign("r")
    # let the audio thread take over from the web thread quickly; the default 5 ms wait drops buffers
    sys.setswitchinterval(0.0005)
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    url = f"http://127.0.0.1:{a.port}"
    with open_stream(a.inp, a.out, a.block):
        print(f"sliders: {url}\nCtrl-C to stop.")
        if not a.no_open:
            webbrowser.open(url)
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    main()
