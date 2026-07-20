"""Spotify playhead + auto-ingest brain.

Polls Spotify's currently-playing endpoint and writes an interpolated,
drift-corrected playhead to /tmp/lightbox-autopilot.json every ~500ms.
Unknown tracks (and the next few queue entries) are auto-ingested
(download → demucs stems) so their energy envelopes are ready by the time
they play.

Autopilot drives NO lights. The lightbox server's stem-sync service reads
the state file and drives the Hue entertainment stream from stem energy.
(The original onset-pulse firing half is dead — see GRAVESTONE.md.)

Usage:
    python -m scraper.autopilot --auto-ingest --prefetch 2
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from .config import load_config
from .spotify_api import make_client


POLL_INTERVAL_S = 2.0  # Spotify rate-limits; 2s/poll is a safe cadence
STATE_FILE = Path("/tmp/lightbox-autopilot.json")
STATE_WRITE_INTERVAL_S = 0.5


def main():
    ap = argparse.ArgumentParser(prog="scraper.autopilot")
    ap.add_argument("--auto-ingest", action="store_true",
                    help="Spawn download+demucs subprocess for unknown tracks")
    ap.add_argument("--prefetch", type=int, default=2,
                    help="Also pre-ingest the next N tracks from the Spotify play queue "
                         "so they're ready before they start (0 = off; needs --auto-ingest)")
    args = ap.parse_args()

    cfg = load_config()
    sp = make_client(cfg)
    print(f"Autopilot: playhead+ingest brain · auto_ingest={args.auto_ingest} prefetch={args.prefetch}")

    current_track_id: str | None = None
    current_track_name = ""
    current_track_artists: list[str] = []
    current_album = ""
    current_art_url: str | None = None
    current_duration_s: float | None = None
    anchor_monotonic_ms = 0.0
    anchor_spotify_s = 0.0
    playing = False
    last_poll_s = 0.0
    last_state_write_s = 0.0
    last_error: str | None = None
    # Drift measurement: each poll compares our interpolated position against
    # Spotify's fresh reported position. drift_ms > 0 = Spotify is AHEAD of
    # our clock. EMA-smoothed for display stability.
    drift_ms_smoothed: float | None = None
    DRIFT_EMA_ALPHA = 0.6
    # System audio output latency — polled infrequently since the probe is
    # slow. Covers: AirPlay/Sonos ≈ 2000ms, built-in ≈ 30ms.
    output_latency_ms: int | None = None
    output_device_name: str | None = None
    last_latency_check_s = 0.0
    LATENCY_CHECK_INTERVAL_S = 15.0
    poll_backoff_s = POLL_INTERVAL_S
    ingesting: dict[str, subprocess.Popen] = {}
    blacklist: set[str] = set()
    # Transient failures (zotify hiccups) deserve one retry; blacklist only
    # after two strikes.
    fail_counts: dict[str, int] = {}
    # Queue prefetch: polled on its own (slower) cadence — the queue rarely
    # changes and each poll is an extra Web API request.
    QUEUE_POLL_INTERVAL_S = 10.0
    MAX_CONCURRENT_INGESTS = 2  # demucs is heavy; current track + one prefetch
    QUEUE_VIEW_N = 8            # how many up-next tracks the UI shows
    last_queue_poll_s = 0.0
    queue_view: list[dict] = []
    ingest_started: dict[str, float] = {}
    ingest_history: list[dict] = []

    def art_url(item: dict) -> str | None:
        """Mid-size (300px) album art URL from a Spotify track object."""
        imgs = ((item.get("album") or {}).get("images") or [])
        if not imgs:
            return None
        return (imgs[1] if len(imgs) > 1 else imgs[0]).get("url")

    def has_stems(tid: str) -> bool:
        d = cfg.tracks_dir / tid / "stems"
        return all((d / f"{s}.ogg").exists() for s in ("drums", "bass", "vocals", "other"))

    # "ready" = stems on disk (what the energy drive needs). Stems on disk
    # win over a blacklist entry — a track that failed and later got
    # ingested some other way (manual CLI run) is ready, not failed.
    def track_status(tid: str | None) -> str:
        if not tid:
            return "unknown"
        if tid in ingesting:
            return "ingesting"
        if has_stems(tid):
            return "ready"
        if tid in blacklist:
            return "failed"
        return "pending"

    def read_ingest_progress(tid: str) -> dict | None:
        p = cfg.tracks_dir / tid / "ingest-progress.json"
        try:
            return json.loads(p.read_text())
        except Exception:
            return None

    def spawn_ingest(tid: str, why: str) -> None:
        if not tid or tid in ingesting or tid in blacklist:
            return
        if has_stems(tid):
            return
        print(f"  [ingest start] {tid} ({why})")
        pkg_root = Path(__file__).resolve().parents[1]
        ingest_started[tid] = time.time()
        # Shared append log — transient zotify/demucs failures are otherwise
        # undiagnosable (the progress file only captures the exit code).
        log_f = open("/tmp/lightbox-ingest.log", "ab")
        ingesting[tid] = subprocess.Popen(
            [sys.executable, "-m", "scraper", "ingest", tid],
            cwd=str(pkg_root),
            stdout=log_f,
            stderr=log_f,
        )
        log_f.close()  # child holds its own fd

    def write_state() -> None:
        progress = {t: read_ingest_progress(t) for t in ingesting}
        if current_track_id and current_track_id not in progress and current_track_id in blacklist:
            progress[current_track_id] = read_ingest_progress(current_track_id)
        state = {
            "running": True,
            "pid": os.getpid(),
            "track_id": current_track_id,
            "track_name": current_track_name,
            "artists": current_track_artists,
            "album": current_album,
            "art_url": current_art_url,
            "duration_s": current_duration_s,
            "track_status": track_status(current_track_id),
            "playing": playing,
            "position_s": round(anchor_spotify_s + (time.monotonic() * 1000 - anchor_monotonic_ms) / 1000.0, 2) if playing else 0,
            "drift_ms": round(drift_ms_smoothed, 1) if drift_ms_smoothed is not None else None,
            "output_latency_ms": output_latency_ms,
            "output_device_name": output_device_name,
            "ingesting": list(ingesting.keys()),
            "ingest_started": dict(ingest_started),
            "ingest_progress": progress,
            "ingest_history": ingest_history[:10],
            "queue": [{**q, "status": track_status(q.get("id"))} for q in queue_view],
            "auto_ingest": args.auto_ingest,
            "prefetch": args.prefetch,
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

        # Refresh audio output latency occasionally.
        if now_s - last_latency_check_s > LATENCY_CHECK_INTERVAL_S:
            last_latency_check_s = now_s
            try:
                from .audio_latency import get_output_latency_ms
                ms, dev = get_output_latency_ms()
                output_latency_ms = ms
                output_device_name = dev
            except Exception as e:
                print(f"  latency probe err: {e}", file=sys.stderr)

        # Queue view + prefetch: pre-ingest what's coming next so stems are
        # ready before the track starts. Demucs takes well under a minute;
        # a few minutes of head start is plenty.
        if now_s - last_queue_poll_s >= QUEUE_POLL_INTERVAL_S:
            last_queue_poll_s = now_s
            try:
                raw_queue = sp.queue().get("queue") or []
                # Sanitize known /me/player/queue quirks in autoplay mode:
                # the endpoint sometimes returns the currently-playing track
                # repeated in every slot ("all bubbles"), and duplicates in
                # general. Drop the current track + dedupe by id. (The
                # deeper quirk — autoplay suggestions genuinely differing
                # per client — isn't fixable from here.)
                seen_qids: set[str] = set()
                upcoming = []
                for t in raw_queue:
                    qid = t.get("id")
                    if not qid or qid == current_track_id or qid in seen_qids:
                        continue
                    seen_qids.add(qid)
                    upcoming.append(t)
                    if len(upcoming) >= QUEUE_VIEW_N:
                        break
                queue_view = [{
                    "id": t.get("id"),
                    "name": t.get("name", "?"),
                    "artists": [a.get("name", "") for a in (t.get("artists") or [])],
                    "album": (t.get("album") or {}).get("name", ""),
                    "duration_s": round((t.get("duration_ms") or 0) / 1000.0, 1),
                    "art_url": art_url(t),
                } for t in upcoming]
                if args.auto_ingest and args.prefetch > 0:
                    for t in upcoming[: args.prefetch]:
                        if len(ingesting) >= MAX_CONCURRENT_INGESTS:
                            break
                        spawn_ingest(t.get("id"), "up next")
            except Exception as e:
                # Queue endpoint hiccups (404 when nothing plays, 429 rate
                # limits) are non-fatal; try again next interval.
                msg = str(e)
                if "429" in msg or "rate" in msg.lower():
                    last_queue_poll_s = now_s + 60.0  # extra-long backoff
                elif "404" not in msg:
                    print(f"  queue poll err: {e}", file=sys.stderr)

        # Reap finished ingest subprocesses.
        for done_tid in [t for t, p in ingesting.items() if p.poll() is not None]:
            proc = ingesting.pop(done_tid)
            secs = round(time.time() - ingest_started.pop(done_tid, time.time()), 1)
            meta = next((q for q in queue_view if q.get("id") == done_tid), None)
            ingest_history.insert(0, {
                "id": done_tid,
                "name": (meta or {}).get("name") or (current_track_name if done_tid == current_track_id else None),
                "artists": (meta or {}).get("artists") or (current_track_artists if done_tid == current_track_id else []),
                "ok": proc.returncode == 0,
                "rc": proc.returncode,
                "secs": secs,
                "at": time.time(),
            })
            del ingest_history[20:]
            if proc.returncode == 0:
                print(f"  [ingest done] {done_tid}")
            else:
                fail_counts[done_tid] = fail_counts.get(done_tid, 0) + 1
                if fail_counts[done_tid] >= 2:
                    print(f"  [ingest FAILED] {done_tid} (rc={proc.returncode}) — blacklisted")
                    blacklist.add(done_tid)
                else:
                    print(f"  [ingest failed] {done_tid} (rc={proc.returncode}) — will retry once")

        if now_s - last_poll_s >= poll_backoff_s:
            last_poll_s = now_s
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
                    current_album = (item.get("album") or {}).get("name", "")
                    current_art_url = art_url(item)
                    dur_ms = item.get("duration_ms")
                    current_duration_s = round(dur_ms / 1000.0, 1) if dur_ms else None
                    artists = ", ".join(current_track_artists)
                    print(f"→ {artists} — {current_track_name} ({tid}) {track_status(tid)}")

                # (Re-)attempt ingest for the current track while it's not
                # ready — covers both first sight and the retry after a
                # transient download failure. spawn_ingest guards
                # ingesting/blacklist/already-done, so this is idempotent.
                # Current track ignores the concurrency cap — it's what's
                # audible right now.
                if args.auto_ingest and tid:
                    spawn_ingest(tid, "now playing")

                # Measure drift BEFORE reseating the anchor.
                if playing and anchor_monotonic_ms > 0 and tid == current_track_id:
                    predicted_s = anchor_spotify_s + (now_ms - anchor_monotonic_ms) / 1000.0
                    reported_s = progress_ms / 1000.0
                    inst_drift_ms = (reported_s - predicted_s) * 1000.0
                    # Guard against large jumps (seek / track change)
                    if abs(inst_drift_ms) < 5000:
                        if drift_ms_smoothed is None:
                            drift_ms_smoothed = inst_drift_ms
                        else:
                            drift_ms_smoothed = drift_ms_smoothed * (1 - DRIFT_EMA_ALPHA) + inst_drift_ms * DRIFT_EMA_ALPHA

                anchor_monotonic_ms = now_ms
                anchor_spotify_s = progress_ms / 1000.0
                playing = True
            else:
                playing = False

        # Always write state — even paused — so the UI has something to show.
        if now_s - last_state_write_s > STATE_WRITE_INTERVAL_S:
            last_state_write_s = now_s
            write_state()

        time.sleep(0.1)


if __name__ == "__main__":
    try:
        main()
    finally:
        try:
            if STATE_FILE.exists(): STATE_FILE.unlink()
        except Exception:
            pass
