"""Ground-truth latency measurement via mic and webcam.

Two modes, both printing a single JSON object on stdout as the last line:

  python -m scraper.latency_probe audio
      Plays a click train through the default output device while recording
      the mic, then matched-filters the recording to find each click's true
      acoustic arrival. Reports the median schedule->ear latency. This is the
      end-to-end ground truth (CoreAudio buffers + DSP + acoustic flight),
      unlike scraper.audio_latency which only sums what CoreAudio *reports*.
      Both numbers are included for comparison.

  python -m scraper.latency_probe video --duration 14
      Captures webcam frames and tracks a brightness metric per frame.
      Prints "READY" (own line, flushed) once frames are flowing so the
      orchestrator knows when to start flashing a light, then dumps the
      timeline plus detected rising edges. The server matches edges against
      its command-send timestamps to get per-light command->photon latency.

Timestamps are wall-clock (time.time()) so they are directly comparable with
Date.now() on the Node side — same machine, same clock.
"""
from __future__ import annotations

import argparse
import json
import sys
import time

import numpy as np


# ---- audio mode ----

SR = 48000
CLICK_HZ = 880          # A5 — a soft bell "ding", not a harsh chirp
CLICK_S = 0.09
N_CLICKS = 8
LEAD_IN_S = 0.5


def _click_template() -> np.ndarray:
    # Bell-like pluck: fundamental + quiet octave, 3ms attack, exponential
    # decay. Pleasant to hear; the sharp attack still gives the matched
    # filter a clean sub-ms alignment peak.
    n = int(SR * CLICK_S)
    t = np.arange(n) / SR
    tone = np.sin(2 * np.pi * CLICK_HZ * t) + 0.3 * np.sin(2 * np.pi * CLICK_HZ * 2 * t)
    env = np.minimum(t / 0.003, 1.0) * np.exp(-t / 0.025)
    return (tone * env * 0.7).astype(np.float32)


def run_audio() -> dict:
    import sounddevice as sd

    rng = np.random.default_rng()
    click = _click_template()
    # Lead with a couple seconds of quiet noise: Bluetooth outputs buffer and
    # ramp for the first ~1-2s of a fresh stream, and we want the steady-state
    # latency (the one music playback experiences), not link-establishment.
    warmup_s = 2.5
    # Randomized gaps so a wrong peak can't alias onto the click grid.
    gaps = warmup_s + LEAD_IN_S + np.concatenate([[0], np.cumsum(rng.uniform(0.4, 0.9, N_CLICKS - 1))])
    total_s = float(gaps[-1]) + 3.0
    signal = np.zeros(int(total_s * SR), dtype=np.float32)
    signal[: int(warmup_s * SR)] = rng.uniform(-0.03, 0.03, int(warmup_s * SR)).astype(np.float32)
    for g in gaps:
        i = int(g * SR)
        signal[i:i + len(click)] += click * 0.8

    # Record the mic in a separate input stream while the click train plays.
    # Each callback chunk is wall-clock stamped; sample i of a chunk arrived
    # at approximately t_callback - (chunk_len - i)/SR.
    chunks: list[tuple[float, np.ndarray]] = []

    def on_input(indata, frames, time_info, status):  # noqa: ANN001
        chunks.append((time.time(), indata[:, 0].copy()))

    in_stream = sd.InputStream(samplerate=SR, channels=1, callback=on_input, blocksize=1024)
    in_stream.start()
    input_latency_s = float(in_stream.latency)
    time.sleep(0.3)  # let the input stream settle before t0
    t0 = time.time()
    sd.play(signal, SR)
    sd.wait()
    time.sleep(0.3)
    in_stream.stop()
    in_stream.close()

    if not chunks:
        return {"ok": False, "error": "no mic data captured (permission?)"}

    rec = np.concatenate([c for _, c in chunks])
    # Wall time of recording sample 0, from the first chunk's stamp.
    first_t, first_chunk = chunks[0]
    rec_t0 = first_t - len(first_chunk) / SR - input_latency_s

    # Matched filter, then a global lag scan: one common latency shifts the
    # whole click train, so score every candidate lag by summing the
    # correlation at (nominal_k + lag) across all clicks. The randomized gaps
    # guarantee only the true lag lines all clicks up at once — this is
    # immune to the per-click aliasing a naive windowed argmax suffers.
    corr = np.abs(np.correlate(rec, click, mode="valid"))
    noise = float(np.median(corr)) + 1e-9

    nominal_idx = np.array([int((t0 + float(g) - rec_t0) * SR) for g in gaps])
    max_lag = int(3.0 * SR)
    step = SR // 1000  # 1ms grid
    lag_scores = np.zeros(max_lag // step)
    for li in range(len(lag_scores)):
        idx = nominal_idx + li * step
        valid = idx[(idx >= 0) & (idx < len(corr))]
        if len(valid):
            lag_scores[li] = float(np.sum(corr[valid]))
    best_lag_s = float(np.argmax(lag_scores) * step) / SR

    # Refine each click within ±60ms of the consensus lag.
    latencies = []
    half = int(0.06 * SR)
    for k, g in enumerate(gaps):
        center = nominal_idx[k] + int(best_lag_s * SR)
        lo, hi = max(0, center - half), min(len(corr), center + half)
        if hi <= lo:
            continue
        w = corr[lo:hi]
        peak = int(np.argmax(w))
        if w[peak] < 8 * noise:
            continue  # click not heard (muted output / mic too far)
        latencies.append(((lo + peak) - nominal_idx[k]) / SR * 1000)

    reported = None
    device = None
    try:
        from scraper.audio_latency import get_output_latency_ms
        reported, device = get_output_latency_ms()
    except Exception:
        pass

    if len(latencies) < max(3, N_CLICKS // 2):
        return {
            "ok": False,
            "error": f"only {len(latencies)}/{N_CLICKS} clicks detected — check volume and mic",
            "coreaudio_reported_ms": reported,
            "output_device_name": device,
        }

    arr = np.array(latencies)
    return {
        "ok": True,
        "audio_latency_ms": round(float(np.median(arr)), 1),
        "jitter_ms": round(float(np.percentile(arr, 75) - np.percentile(arr, 25)), 1),
        "clicks_detected": len(latencies),
        "clicks_played": N_CLICKS,
        "per_click_ms": [round(x, 1) for x in latencies],
        "coreaudio_reported_ms": reported,
        "output_device_name": device,
    }


# ---- video mode ----

def run_video(duration_s: float, camera_index: int, on_ready=None) -> dict:
    import cv2

    cap = cv2.VideoCapture(camera_index)
    if not cap.isOpened():
        return {"ok": False, "error": f"cannot open camera {camera_index} (permission?)"}
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 320)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 240)

    # Warm up: first frames are dark/AGC-unsettled.
    for _ in range(5):
        cap.read()
    if on_ready:
        on_ready()

    samples: list[tuple[float, float]] = []
    t_end = time.time() + duration_s
    while time.time() < t_end:
        ok, frame = cap.read()
        t = time.time()
        if not ok:
            continue
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.float32)
        # Mean of the brightest decile: robust when the light is a small
        # region of the frame, and immune to dark-room noise floors.
        flat = gray.ravel()
        k = max(1, len(flat) // 10)
        bright = float(np.mean(np.partition(flat, -k)[-k:]))
        samples.append((t, bright))
    cap.release()

    if len(samples) < 20:
        return {"ok": False, "error": f"only {len(samples)} frames captured"}

    b = np.array([s[1] for s in samples])
    ts = np.array([s[0] for s in samples])
    lo, hi = float(np.percentile(b, 5)), float(np.percentile(b, 95))
    if hi - lo < 8:
        return {
            "ok": False,
            "error": f"brightness never moved (range {hi - lo:.1f}) — is the light in frame?",
            "fps": round(len(samples) / duration_s, 1),
        }
    # Rising edges = sharp single-frame jumps only. A real light flash slams
    # most of the brightness swing inside one frame interval; the webcam's
    # auto-exposure recovery after a flash is a gradual multi-frame ramp and
    # must NOT count (it produced phantom edges ~1.4s after every pulse).
    swing = hi - lo
    q_lo = lo + 0.25 * swing
    q_hi = lo + 0.75 * swing
    edges = []
    for i in range(1, len(b)):
        if b[i] >= q_hi and b[i - 1] < q_hi:
            # Crossed the high threshold — count it only if the climb from
            # the low threshold took at most 3 frames (~200ms). Real flashes
            # traverse the swing in 1-2 frames; AGC recovery takes ~1s+.
            for k in range(1, 4):
                if i - k < 0:
                    break
                if b[i - k] <= q_lo:
                    edges.append(float((ts[i - k] + ts[i]) / 2))
                    break
    # Collapse near-duplicates (shouldn't happen, but cheap insurance).
    deduped = []
    for e in edges:
        if not deduped or e - deduped[-1] > 0.15:
            deduped.append(e)
    edges = deduped

    return {
        "ok": True,
        "edges": edges,
        "fps": round(len(samples) / duration_s, 1),
        "frames": len(samples),
        "brightness_lo": round(lo, 1),
        "brightness_hi": round(hi, 1),
        "timeline": [[round(t, 4), round(v, 1)] for t, v in samples],
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("mode", choices=["audio", "video"])
    p.add_argument("--duration", type=float, default=14.0)
    p.add_argument("--camera", type=int, default=0)
    args = p.parse_args()
    result = (
        run_audio() if args.mode == "audio"
        else run_video(args.duration, args.camera, on_ready=lambda: print("READY", flush=True))
    )
    print(json.dumps(result))
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
