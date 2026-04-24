"""Spotify → Hue autopilot.

Polls Spotify's currently-playing endpoint, reads the corresponding
madmom_onsets.json from the local library, and fires REST pulses to the
lightbox server every time the playhead crosses a peak in the configured
onset source.

Usage:
    python -m scraper.autopilot \
        --light-rid 85b9455f-e2a2-4461-a6fe-6d8760eecf46 \
        --source drums_low_strict.superflux \
        --offset-ms 0

The light rid is the CLIP v2 UUID (not "hue:7"). Get it from:
    curl -s http://localhost:3001/api/hue-stream/rest-lights
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import requests

from .config import load_config
from .spotify_api import make_client


LIGHTBOX = "http://localhost:3001"
TICK_HZ = 50
POLL_INTERVAL_S = 2.0  # Spotify rate-limits; 2s/poll is a safe cadence
MIN_GAP_MS = 150      # don't re-fire within this window (onset density guard)
STATE_FILE = Path("/tmp/lightbox-autopilot.json")
# Re-read every Spotify poll so UI checkbox changes take effect live
# without restarting the process. If absent, falls back to --light-rids
# from the command line.
LIGHTS_FILE = Path("/tmp/lightbox-autopilot-lights.json")
# Touched every spotify poll and every fire. UI reads this.
STATE_WRITE_INTERVAL_S = 0.5

# Parse "drums_low_strict.superflux" → ("drums_low_strict", "superflux").
# Matches the UI's source key format.
def split_source(key: str) -> tuple[str, str]:
    if "." not in key:
        raise SystemExit(f"source must be FORM: 'drums_low.cnn' etc., got {key!r}")
    src, det = key.split(".", 1)
    if det in ("sf", "superflux"):
        det = "superflux"
    elif det in ("cnn",):
        det = "cnn"
    else:
        raise SystemExit(f"detector must be 'cnn' or 'superflux'/'sf', got {det!r}")
    return src, det


def load_peaks(tracks_dir: Path, track_id: str, src: str, det: str) -> list[float]:
    p = tracks_dir / track_id / "madmom_onsets.json"
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text())
    except Exception:
        return []
    entry = data.get(src) or {}
    arr = entry.get(det) or []
    return [float(x) for x in arr if isinstance(x, (int, float))]


def fire_pulse(session: requests.Session, light_rid: str, peak: int, floor: int, decay_ms: int) -> Optional[float]:
    """Returns round-trip ms, or None on failure. The RTT is roughly
    (HTTP to lightbox + HTTPS to bridge + bridge processing time) — a
    useful proxy for how long after fire() the bulb actually lights up."""
    t0 = time.monotonic()
    try:
        session.post(
            f"{LIGHTBOX}/api/hue-stream/rest-pulse",
            json={
                "lightId": light_rid,
                "brightness": peak,
                "floor": floor,
                "decayMs": decay_ms,
            },
            timeout=2,
        )
        return (time.monotonic() - t0) * 1000.0
    except Exception as e:
        print(f"  fire err: {e}", file=sys.stderr)
        return None


def read_config_file() -> dict | None:
    """Live-updatable config from the UI. Shape: {lightRids: [...], offsetMs: N}.
    Returns the parsed dict or None on missing/malformed."""
    if not LIGHTS_FILE.exists():
        return None
    try:
        return json.loads(LIGHTS_FILE.read_text())
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser(prog="scraper.autopilot")
    # One or both accepted. --light-rids wins (comma-separated). --light-rid
    # retained for backwards-compat with earlier CLI invocations.
    ap.add_argument("--light-rid", default=None, help="CLIP v2 UUID of a single Hue light")
    ap.add_argument("--light-rids", default=None, help="Comma-separated CLIP v2 UUIDs of multiple lights")
    ap.add_argument("--source", default="drums_low_strict.superflux",
                    help="Onset source (default: drums_low_strict.superflux)")
    ap.add_argument("--offset-ms", type=int, default=0,
                    help="Delay light events by this many ms to align with audio latency (e.g. Sonos)")
    ap.add_argument("--peak", type=int, default=100)
    ap.add_argument("--floor", type=int, default=5)
    ap.add_argument("--decay-ms", type=int, default=300)
    ap.add_argument("--auto-ingest", action="store_true",
                    help="Spawn download+analyze+madmom subprocess for unknown tracks")
    args = ap.parse_args()

    src, det = split_source(args.source)
    cfg = load_config()
    sp = make_client(cfg)
    session = requests.Session()

    # Initial light set from CLI; live updates come from the lights file.
    # Empty is allowed — autopilot runs in "drift-only" mode: polls Spotify,
    # measures drift, but fires no pulses until a light is enabled via
    # /tmp/lightbox-autopilot-lights.json (UI checkboxes).
    initial_rids: list[str] = []
    if args.light_rids:
        initial_rids = [x.strip() for x in args.light_rids.split(",") if x.strip()]
    elif args.light_rid:
        initial_rids = [args.light_rid]
    selected_rids: list[str] = list(initial_rids)
    print(f"Autopilot: lights={[r[:8] for r in selected_rids] or '(drift-only)'} source={src}.{det} offset={args.offset_ms}ms auto_ingest={args.auto_ingest}")

    current_track_id: str | None = None
    current_track_name = ""
    current_track_artists: list[str] = []
    peaks: list[float] = []
    cursor_idx = -1
    anchor_monotonic_ms = 0.0
    anchor_spotify_s = 0.0
    playing = False
    last_poll_s = 0.0
    last_fire_ms = 0.0
    fires_total = 0
    last_state_write_s = 0.0
    last_error: str | None = None
    # Drift measurement: each poll compares our interpolated position against
    # Spotify's fresh reported position. drift_ms > 0 = Spotify is AHEAD of
    # our clock (our clock ran slow / Spotify skipped ahead / network delay
    # on the response). EMA-smoothed for display stability.
    drift_ms_smoothed: float | None = None
    DRIFT_EMA_ALPHA = 0.6
    # System audio output latency — polled infrequently since system_profiler
    # is slow (~1-2s per call). Covers: AirPlay/Sonos ≈ 2000ms, built-in ≈ 30ms.
    output_latency_ms: int | None = None
    output_device_name: str | None = None
    last_latency_check_s = 0.0
    LATENCY_CHECK_INTERVAL_S = 15.0
    # Bridge RTT: time from fire_pulse() call to HTTP response (includes the
    # full pulse: attack PUT + decay PUT to the Hue bridge). Used to suggest
    # an offset that accounts for how late the light actually flashes relative
    # to when we decide to flash it. EMA-smoothed.
    bridge_rtt_ms_smoothed: float | None = None
    BRIDGE_RTT_EMA_ALPHA = 0.3
    offset_s = args.offset_ms / 1000.0
    poll_backoff_s = POLL_INTERVAL_S
    ingesting: dict[str, subprocess.Popen] = {}
    blacklist: set[str] = set()

    def maybe_reload_peaks(tid: str) -> list[float]:
        return load_peaks(cfg.tracks_dir, tid, src, det)

    def write_state() -> None:
        state = {
            "running": True,
            "pid": os.getpid(),
            "track_id": current_track_id,
            "track_name": current_track_name,
            "artists": current_track_artists,
            "playing": playing,
            "position_s": round(anchor_spotify_s + (time.monotonic() * 1000 - anchor_monotonic_ms) / 1000.0, 2) if playing else 0,
            "peaks_total": len(peaks),
            "cursor_idx": cursor_idx,
            "fires_total": fires_total,
            "source": f"{src}.{det}",
            "offset_ms": int(round(offset_s * 1000)),
            "light_rids": list(selected_rids),
            "drift_ms": round(drift_ms_smoothed, 1) if drift_ms_smoothed is not None else None,
            "output_latency_ms": output_latency_ms,
            "output_device_name": output_device_name,
            "bridge_rtt_ms": round(bridge_rtt_ms_smoothed, 1) if bridge_rtt_ms_smoothed is not None else None,
            "ingesting": list(ingesting.keys()),
            "blacklist": list(blacklist),
            "last_error": last_error,
            "updated_at": time.time(),
        }
        try:
            STATE_FILE.write_text(json.dumps(state))
        except Exception:
            pass

    while True:
        now_s = time.monotonic()
        now_ms = now_s * 1000.0

        # Refresh audio output latency occasionally. Uses system_profiler so
        # we space it out — the output device rarely changes.
        if now_s - last_latency_check_s > LATENCY_CHECK_INTERVAL_S:
            last_latency_check_s = now_s
            try:
                from .audio_latency import get_output_latency_ms
                ms, dev = get_output_latency_ms()
                output_latency_ms = ms
                output_device_name = dev
            except Exception as e:
                print(f"  latency probe err: {e}", file=sys.stderr)

        # Reap finished ingest subprocesses so we can restart if needed.
        for done_tid in [t for t, p in ingesting.items() if p.poll() is not None]:
            proc = ingesting.pop(done_tid)
            if proc.returncode == 0:
                print(f"  [ingest done] {done_tid}")
            else:
                print(f"  [ingest FAILED] {done_tid} (rc={proc.returncode})")
                blacklist.add(done_tid)

        if now_s - last_poll_s >= poll_backoff_s:
            last_poll_s = now_s
            # Live-update config (light rids + offset) from the UI's file.
            cfg_file = read_config_file()
            if cfg_file is not None:
                rids = cfg_file.get("lightRids")
                if isinstance(rids, list):
                    selected_rids = [str(x) for x in rids if isinstance(x, str)]
                off = cfg_file.get("offsetMs")
                if isinstance(off, (int, float)):
                    offset_s = float(off) / 1000.0

            try:
                cp = sp.currently_playing()
                poll_backoff_s = POLL_INTERVAL_S
                last_error = None
            except Exception as e:
                cp = None
                msg = str(e)
                last_error = msg[:200]
                if "rate" in msg.lower() or "429" in msg:
                    poll_backoff_s = min(60.0, poll_backoff_s * 2)
                    print(f"  rate-limited; backing off to {poll_backoff_s:.0f}s", file=sys.stderr)
                else:
                    print(f"  spotify poll err: {e}", file=sys.stderr)

            if cp and cp.get("is_playing"):
                item = cp.get("item") or {}
                tid = item.get("id")
                progress_ms = cp.get("progress_ms") or 0

                if tid != current_track_id:
                    current_track_id = tid
                    current_track_name = item.get("name", "?")
                    current_track_artists = [a.get("name", "") for a in (item.get("artists") or [])]
                    peaks = maybe_reload_peaks(tid) if tid else []
                    name = current_track_name
                    artists = ", ".join(current_track_artists)
                    print(f"→ {artists} — {name} ({tid}) peaks={len(peaks)}")

                    # If unknown (no peaks file) and auto-ingest, kick off subprocess.
                    madmom_path = cfg.tracks_dir / tid / "madmom_onsets.json"
                    if (args.auto_ingest and tid and not madmom_path.exists()
                            and tid not in ingesting and tid not in blacklist):
                        print(f"  [ingest start] {tid}")
                        pkg_root = Path(__file__).resolve().parents[1]
                        ingesting[tid] = subprocess.Popen(
                            [sys.executable, "-m", "scraper", "ingest", tid, "--fast"],
                            cwd=str(pkg_root),
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL,
                        )
                elif not peaks:
                    # Same track; if ingest just completed, pick up the peaks.
                    madmom_path = cfg.tracks_dir / tid / "madmom_onsets.json"
                    if madmom_path.exists():
                        peaks = maybe_reload_peaks(tid)
                        if peaks:
                            print(f"  [peaks loaded] {tid} n={len(peaks)}")

                # Measure drift BEFORE reseating the anchor — compare what
                # we thought the position would be vs. what Spotify reports.
                # Only meaningful when we have a valid prior anchor AND the
                # track didn't just change (no jump).
                if playing and anchor_monotonic_ms > 0 and tid == current_track_id:
                    predicted_s = anchor_spotify_s + (now_ms - anchor_monotonic_ms) / 1000.0
                    reported_s = progress_ms / 1000.0
                    inst_drift_ms = (reported_s - predicted_s) * 1000.0
                    # Guard against large jumps (seek / track change) — ignore anything > 5s
                    if abs(inst_drift_ms) < 5000:
                        if drift_ms_smoothed is None:
                            drift_ms_smoothed = inst_drift_ms
                        else:
                            drift_ms_smoothed = drift_ms_smoothed * (1 - DRIFT_EMA_ALPHA) + inst_drift_ms * DRIFT_EMA_ALPHA

                anchor_monotonic_ms = now_ms
                anchor_spotify_s = progress_ms / 1000.0
                playing = True

                # Re-seat cursor to just-before current effective position.
                eff_pos = anchor_spotify_s - offset_s
                idx = -1
                for i, t in enumerate(peaks):
                    if t <= eff_pos:
                        idx = i
                    else:
                        break
                cursor_idx = idx
            else:
                playing = False

        # Always write state — even in drift-only / paused / no-peaks modes —
        # so the UI always has something to display.
        if now_s - last_state_write_s > STATE_WRITE_INTERVAL_S:
            last_state_write_s = now_s
            write_state()

        if not playing or not peaks:
            time.sleep(0.05)
            continue

        # Interpolate playhead since last poll using monotonic clock.
        elapsed_s = (now_ms - anchor_monotonic_ms) / 1000.0
        pos_s = anchor_spotify_s + elapsed_s - offset_s

        # Detect crossings since last tick.
        fired = False
        while cursor_idx + 1 < len(peaks) and peaks[cursor_idx + 1] <= pos_s:
            cursor_idx += 1
            fired = True

        if fired and (now_ms - last_fire_ms) > MIN_GAP_MS:
            last_fire_ms = now_ms
            fires_total += 1
            # Fire all currently-selected lights. Track RTT (EMA) of the
            # first light's pulse as our bridge-latency estimate.
            for i, rid in enumerate(selected_rids):
                rtt = fire_pulse(session, rid, args.peak, args.floor, args.decay_ms)
                if i == 0 and rtt is not None:
                    if bridge_rtt_ms_smoothed is None:
                        bridge_rtt_ms_smoothed = rtt
                    else:
                        bridge_rtt_ms_smoothed = (
                            (1 - BRIDGE_RTT_EMA_ALPHA) * bridge_rtt_ms_smoothed
                            + BRIDGE_RTT_EMA_ALPHA * rtt
                        )

        # ~50Hz tick.
        sleep_s = max(0.0, (1.0 / TICK_HZ) - (time.monotonic() - now_s))
        time.sleep(sleep_s)


if __name__ == "__main__":
    try:
        main()
    finally:
        try:
            if STATE_FILE.exists(): STATE_FILE.unlink()
        except Exception:
            pass
