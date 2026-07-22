"""Spotify playhead + auto-ingest brain.

Polls Spotify's currently-playing endpoint and writes an interpolated,
drift-corrected playhead to packages/server/data/state/lightbox-autopilot.json every ~500ms.
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
import signal
import subprocess
import sys
import time
from pathlib import Path

from .config import load_config
from .spotify_api import make_client


POLL_INTERVAL_S = 2.0  # Spotify rate-limits; 2s/poll is a safe cadence
# Idle decay: sustained 24/7 polling at full cadence is what earns extended
# 429s (13h Retry-After, July 2026). After IDLE_AFTER_S with nothing
# playing, ease the currently-playing poll off and stop queue polls
# entirely; first poll that sees playback snaps back to full cadence.
IDLE_AFTER_S = 300.0
IDLE_POLL_INTERVAL_S = 30.0
# State lives under the repo (gitignored), logs under ~/.local/state —
# never /tmp, which macOS purges after ~3 days (it ate the forensic logs
# from the July 21-22 incident night). Paths are shared contracts with
# packages/server/src/routes/autopilot.ts and services/stem-sync.ts.
_REPO_ROOT = Path(__file__).resolve().parents[3]
STATE_DIR = _REPO_ROOT / "packages/server/data/state"
STATE_FILE = STATE_DIR / "lightbox-autopilot.json"
LOG_DIR = Path.home() / ".local/state/lightbox"
STATE_DIR.mkdir(parents=True, exist_ok=True)
STATE_WRITE_INTERVAL_S = 0.5
POLL_BACKOFF_MAX_RATE_S = 900.0  # 15 min cap on rate-limit backoff
POLL_BACKOFF_MAX_S = 60.0        # cap for auth/other error backoff
MAX_CONSECUTIVE_AUTH_FAILS = 10  # then die visibly with an "auth" tombstone

# Written at most once — first writer wins (the auth path writes its own
# tombstone before sys.exit, and the outer handler must not clobber it).
_tombstoned = False


def write_tombstone(exit_reason: str, last_error: str | None = None) -> None:
    """Final state file on ANY exit. The Node supervisor reads this instead
    of finding a vanished file: running=false + exit_reason tells it (and
    the UI) exactly why the daemon is gone."""
    global _tombstoned
    if _tombstoned:
        return
    _tombstoned = True
    now = time.time()
    state = {
        "running": False,
        "pid": os.getpid(),
        "exit_reason": exit_reason,  # "auth" | "stopped" | "crash"
        "last_error": last_error,
        "updated_at": now,
        "exited_at": now,
    }
    try:
        STATE_FILE.write_text(json.dumps(state))
    except Exception:
        pass


def classify_error(e: Exception) -> tuple[str, float | None]:
    """→ ("rate" | "auth" | "other", retry_after_s or None). Defensive
    across spotipy versions: prefer http_status/headers, fall back to
    string matching for non-SpotifyException failures."""
    status = getattr(e, "http_status", None)
    msg = str(e)
    if status == 429 or "429" in msg or "rate" in msg.lower():
        retry_after = None
        headers = getattr(e, "headers", None)  # only on newer spotipy
        if headers:
            try:
                raw = headers.get("Retry-After") or headers.get("retry-after")
                if raw is not None:
                    retry_after = float(raw)
            except (TypeError, ValueError, AttributeError):
                retry_after = None
        return "rate", retry_after
    if status == 401 or "401" in msg or "access token" in msg.lower():
        return "auth", None
    return "other", None


def main():
    ap = argparse.ArgumentParser(prog="scraper.autopilot")
    ap.add_argument("--auto-ingest", action="store_true",
                    help="Spawn download+demucs subprocess for unknown tracks")
    ap.add_argument("--prefetch", type=int, default=2,
                    help="Also pre-ingest the next N tracks from the Spotify play queue "
                         "so they're ready before they start (0 = off; needs --auto-ingest)")
    args = ap.parse_args()

    cfg = load_config()
    # retries=0/status_retries=0: urllib3 must never sleep inside a call
    # (a 429 Retry-After once slept 13.5h in-call and froze the heartbeat).
    # requests_timeout=10 bounds every call. open_browser=False: detached
    # headless daemon must never attempt interactive OAuth.
    sp = make_client(cfg, open_browser=False, retries=0, status_retries=0,
                     requests_timeout=10)

    # Fail fast if there's no usable cached token — validate_token refreshes
    # an expired one but never opens a browser. Without this the daemon
    # would hammer 401s for hours (which is what got us rate-limited).
    token_info = None
    try:
        auth = sp.auth_manager
        token_info = auth.validate_token(auth.cache_handler.get_cached_token())
    except Exception as e:
        print(f"token validation err: {e}", file=sys.stderr)
    if not token_info:
        msg = "no usable Spotify token — run the scraper OAuth flow interactively to re-auth"
        print(msg, file=sys.stderr)
        write_tombstone("auth", msg)
        sys.exit(2)

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
    # Coast window: a failed poll is not evidence of a pause — the music
    # almost certainly kept going. Keep playing=True (the anchor keeps
    # extrapolating) through consecutive poll failures for up to
    # COAST_MAX_S before declaring paused. None = last poll succeeded.
    coast_since_s: float | None = None
    COAST_MAX_S = 60.0
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
    consec_auth_fails = 0
    last_playing_s = time.monotonic()  # start attentive; decay if silent
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
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        log_f = open(LOG_DIR / "ingest.log", "ab")
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
            "coasting": coast_since_s is not None and playing,
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
            "poll_interval_s": round(poll_backoff_s, 1),
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
        if now_s - last_queue_poll_s >= QUEUE_POLL_INTERVAL_S and now_s - last_playing_s <= IDLE_AFTER_S:
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
                # limits) are non-fatal; try again next interval. retries=0
                # on the client means the failed call itself never slept.
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
            poll_ok = False
            try:
                cp = sp.currently_playing()
                poll_ok = True
                poll_backoff_s = POLL_INTERVAL_S
                consec_auth_fails = 0
                last_error = None
            except Exception as e:
                cp = None
                kind, retry_after_s = classify_error(e)
                if kind == "rate":
                    # Honor Retry-After ourselves (never in-call), doubling
                    # otherwise, capped at 15 min. Heartbeat keeps running.
                    poll_backoff_s = min(max(retry_after_s or 0.0, poll_backoff_s * 2),
                                         POLL_BACKOFF_MAX_RATE_S)
                    last_error = f"rate limited; next poll in {poll_backoff_s:.0f}s"
                    print(f"  {last_error}", file=sys.stderr)
                elif kind == "auth":
                    consec_auth_fails += 1
                    poll_backoff_s = min(POLL_BACKOFF_MAX_S,
                                         2.0 * (2 ** (consec_auth_fails - 1)))
                    last_error = f"auth error ({consec_auth_fails}x): {str(e)[:120]}"
                    print(f"  spotify auth err ({consec_auth_fails}x); next poll in {poll_backoff_s:.0f}s",
                          file=sys.stderr)
                    if consec_auth_fails >= MAX_CONSECUTIVE_AUTH_FAILS:
                        msg = ("spotify auth failing repeatedly — run the scraper "
                               "OAuth flow interactively to re-auth")
                        print(f"  {msg}; exiting", file=sys.stderr)
                        write_tombstone("auth", msg)
                        sys.exit(2)
                else:
                    poll_backoff_s = min(POLL_BACKOFF_MAX_S, poll_backoff_s * 2)
                    last_error = str(e)[:200]
                    print(f"  spotify poll err: {e}", file=sys.stderr)

            if not poll_ok:
                # Coast: a failed poll says nothing about playback. Hold the
                # last known playing state and let consumers extrapolate from
                # the existing anchor, until the failures have gone on long
                # enough that "still playing" stops being the safe bet.
                if playing:
                    if coast_since_s is None:
                        coast_since_s = now_s
                    elif now_s - coast_since_s > COAST_MAX_S:
                        playing = False
                        print(f"  poll failing for {COAST_MAX_S:.0f}s+ — declaring paused",
                              file=sys.stderr)
            elif cp and cp.get("is_playing"):
                coast_since_s = None
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
                coast_since_s = None
                playing = False

            if playing:
                last_playing_s = now_s
            elif last_error is None and now_s - last_playing_s > IDLE_AFTER_S:
                poll_backoff_s = IDLE_POLL_INTERVAL_S

        # Always write state — even paused or erroring — so the UI has
        # something to show. Nothing above can block past the 10s request
        # timeout, so the heartbeat can't go stale.
        if now_s - last_state_write_s > STATE_WRITE_INTERVAL_S:
            last_state_write_s = now_s
            write_state()

        time.sleep(0.1)


def _on_sigterm(signum, frame):
    # Raise SystemExit so finally/except blocks run and the "stopped"
    # tombstone gets written — the Node supervisor stops us with SIGTERM.
    raise SystemExit(0)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, _on_sigterm)
    try:
        main()
        write_tombstone("stopped")
    except (SystemExit, KeyboardInterrupt):
        # Auth exits already wrote their tombstone; write_tombstone is a
        # no-op after the first call, so this only claims clean stops.
        write_tombstone("stopped")
        raise
    except Exception as e:
        write_tombstone("crash", f"{type(e).__name__}: {e}"[:200])
        raise
