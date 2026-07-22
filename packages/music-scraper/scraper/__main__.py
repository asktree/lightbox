"""CLI entry for the music-scraper.

Pipeline is stems-only: download → demucs. (The former analyze/madmom/
prioritize commands are dead; see GRAVESTONE.md at repo root.)
"""
import argparse
import json
from pathlib import Path

from .config import load_config
from .library import Library


def _read_id_list(arg: str) -> list[str]:
    """--ids can be a path to a newline-delimited file OR a comma-separated list."""
    p = Path(arg)
    if p.exists():
        return [line.strip() for line in p.read_text().splitlines() if line.strip()]
    return [x.strip() for x in arg.split(",") if x.strip()]


def cmd_list_liked(args):
    """Fetch liked songs and enqueue into the library index."""
    from .spotify_api import make_client, liked_tracks

    cfg = load_config()
    client = make_client(cfg)
    lib = Library(cfg)

    print(f"Fetching up to {args.limit} liked tracks...")
    tracks = list(liked_tracks(client, limit=args.limit))
    print(f"  → {len(tracks)} tracks")

    added, skipped = lib.enqueue(tracks)
    print(f"  → {added} added to queue, {skipped} already present")


def cmd_list_playlists(args):
    """Enqueue tracks from user-owned playlists whose earliest added_at is >= --since."""
    from .spotify_api import make_client, owned_playlists_since

    cfg = load_config()
    client = make_client(cfg)
    lib = Library(cfg)

    print(f"Fetching owned playlists with earliest added_at >= {args.since}...")
    tracks = list(owned_playlists_since(client, since=args.since))
    print(f"  → {len(tracks)} unique tracks across matching playlists")

    added, skipped = lib.enqueue(tracks)
    print(f"  → {added} added to queue, {skipped} already present")


def cmd_status(_args):
    cfg = load_config()
    lib = Library(cfg)
    counts = lib.counts()
    if not counts:
        print("Library empty.")
        return
    total = sum(counts.values())
    print(f"{total} tracks total:")
    for status in ("queued", "downloaded", "analyzed", "failed"):
        n = counts.get(status, 0)
        if n:
            print(f"  {status:12s} {n}")


def cmd_run(args):
    """Process the queue — download tracks (stemming is a separate phase)."""
    import time
    from .downloader import download_track, DownloadError

    cfg = load_config()
    lib = Library(cfg)

    pending = lib.pending(limit=args.limit)
    if not pending:
        print("Queue empty.")
        return

    print(f"Processing {len(pending)} tracks...")
    ok = 0
    fail = 0
    start = time.time()

    for i, row in enumerate(pending, 1):
        tid = row["id"]
        name = row["name"]
        artists = ", ".join(json.loads(row["artists"]))
        prefix = f"[{i}/{len(pending)}]"
        print(f"{prefix} {artists} — {name} ({tid})")
        try:
            download_track(cfg, tid, row)
            lib.mark_status(tid, "downloaded")
            ok += 1
        except DownloadError as e:
            lib.mark_status(tid, "failed", str(e))
            print(f"    ✗ {e}")
            fail += 1
        except Exception as e:
            lib.mark_status(tid, "failed", f"{type(e).__name__}: {e}")
            print(f"    ✗ unexpected: {e}")
            fail += 1

    elapsed = time.time() - start
    print(f"\nDone. {ok} downloaded, {fail} failed in {elapsed:.0f}s "
          f"({elapsed / max(1, ok):.1f}s/track avg).")


def cmd_stem(args):
    """Demucs-stem downloaded tracks that don't have stems yet. The batch
    counterpart of `ingest` — useful for backfilling the library overnight."""
    import sqlite3
    import time
    from .analyzer import separate_stems, stems_present

    cfg = load_config()
    lib = Library(cfg)

    with sqlite3.connect(str(cfg.index_db)) as c:
        c.row_factory = sqlite3.Row
        if getattr(args, "ids", None):
            id_list = _read_id_list(args.ids)
            placeholders = ",".join("?" * len(id_list))
            rows = c.execute(
                f"SELECT * FROM tracks WHERE id IN ({placeholders})",
                id_list,
            ).fetchall() if id_list else []
        else:
            rows = c.execute(
                "SELECT * FROM tracks WHERE status IN ('downloaded','analyzed') ORDER BY queued_at"
            ).fetchall()

    todo = []
    for row in rows:
        tid = row["id"]
        if not lib.audio_path(tid).exists():
            continue
        if not stems_present(cfg.tracks_dir / tid / "stems"):
            todo.append(row)
    if args.limit:
        todo = todo[: int(args.limit)]

    if not todo:
        print("Nothing to stem.")
        return

    total = len(todo)
    print(f"Stemming {total} tracks...")
    ok = 0
    fail = 0
    start = time.time()
    for i, row in enumerate(todo, 1):
        tid = row["id"]
        artists = ", ".join(json.loads(row["artists"]))
        t0 = time.time()
        print(f"[{i}/{total}] {artists} — {row['name']} ({tid})", flush=True)
        try:
            separate_stems(lib.audio_path(tid), cfg.tracks_dir / tid / "stems", device=args.device)
            ok += 1
            print(f"    ✓ {time.time() - t0:.0f}s", flush=True)
        except Exception as e:
            print(f"    ✗ {type(e).__name__}: {e}", flush=True)
            fail += 1

    elapsed = time.time() - start
    print(f"\nDone. {ok} stemmed, {fail} failed in {elapsed:.0f}s "
          f"({elapsed / max(1, ok):.1f}s/track avg).")


def cmd_ingest(args):
    """End-to-end pipeline for a single Spotify track id: enqueue if new,
    download if missing, demucs-stem if missing. Idempotent. Used by the
    autopilot to ingest unknown tracks on the fly.

    Writes {track}/ingest-progress.json at every stage boundary so the
    autopilot UI can show live per-track pipeline progress.
    """
    import time
    import sqlite3
    from .downloader import download_track, DownloadError
    from .analyzer import separate_stems, stems_present
    from .spotify_api import make_client, _track_to_dict

    tid = args.track_id
    cfg = load_config()
    lib = Library(cfg)

    progress_path = cfg.tracks_dir / tid / "ingest-progress.json"
    stage_started: dict[str, float] = {}

    def progress(stage: str, error: str | None = None) -> None:
        try:
            cur = json.loads(progress_path.read_text()) if progress_path.exists() else {}
        except Exception:
            cur = {}
        stages = cur.get("stages") or {}
        now = time.time()
        # Close out the previous stage's timing, open the new one.
        prev = cur.get("stage")
        if prev and prev in stage_started and prev not in ("done", "failed"):
            stages.setdefault(prev, {})["secs"] = round(now - stage_started[prev], 1)
        if stage not in ("done", "failed"):
            stage_started[stage] = now
            stages.setdefault(stage, {})["started_at"] = now
        cur.update({"stage": stage, "stages": stages, "error": error, "updated_at": now})
        try:
            progress_path.parent.mkdir(parents=True, exist_ok=True)
            progress_path.write_text(json.dumps(cur))
        except Exception:
            pass

    # 1. Make sure the row exists.
    with sqlite3.connect(str(cfg.index_db)) as c:
        c.row_factory = sqlite3.Row
        row = c.execute("SELECT * FROM tracks WHERE id=?", (tid,)).fetchone()

    if not row:
        print(f"[ingest] fetching metadata for {tid}")
        progress("metadata")
        sp = make_client(cfg)
        t = sp.track(tid)
        d = _track_to_dict(t, None)
        if not d:
            raise SystemExit(f"Spotify returned no metadata for {tid}")
        lib.enqueue([d])
        with sqlite3.connect(str(cfg.index_db)) as c:
            c.row_factory = sqlite3.Row
            row = c.execute("SELECT * FROM tracks WHERE id=?", (tid,)).fetchone()

    audio_path = lib.audio_path(tid)
    stems_dir = cfg.tracks_dir / tid / "stems"

    # 2. Download if missing or last attempt failed. Serialized across
    # processes via flock — concurrent zotify invocations trample each
    # other's session/cache and die with rc=1 and empty stderr.
    if not audio_path.exists():
        import fcntl
        print(f"[ingest] downloading {tid}")
        progress("download")
        t0 = time.time()
        lock_dir = Path.home() / ".local/state/lightbox"
        lock_dir.mkdir(parents=True, exist_ok=True)
        lock_f = open(lock_dir / "zotify.lock", "w")
        try:
            fcntl.flock(lock_f, fcntl.LOCK_EX)
            if not audio_path.exists():  # may have appeared while we waited
                download_track(cfg, tid, dict(row))
                lib.mark_status(tid, "downloaded")
                print(f"[ingest] downloaded in {time.time()-t0:.0f}s")
        except (DownloadError, Exception) as e:
            lib.mark_status(tid, "failed", str(e))
            progress("failed", error=f"download: {e}")
            raise SystemExit(f"download failed: {e}")
        finally:
            try:
                fcntl.flock(lock_f, fcntl.LOCK_UN)
                lock_f.close()
            except Exception:
                pass

    # 3. Demucs stems if missing.
    if not stems_present(stems_dir):
        print(f"[ingest] demucs {tid}")
        progress("demucs")
        t0 = time.time()
        try:
            separate_stems(audio_path, stems_dir, device=args.device)
            print(f"[ingest] stems in {time.time()-t0:.0f}s")
        except Exception as e:
            lib.mark_status(tid, "failed", f"{type(e).__name__}: {e}")
            progress("failed", error=f"demucs: {type(e).__name__}: {e}")
            raise SystemExit(f"demucs failed: {e}")

    progress("done")
    print(f"[ingest] ✓ {tid} ready")


def main():
    ap = argparse.ArgumentParser(prog="scraper", description="Download + stem music for musicbox")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_liked = sub.add_parser("list-liked", help="Enqueue recent liked songs")
    p_liked.add_argument("--limit", type=int, default=200)
    p_liked.set_defaults(func=cmd_list_liked)

    p_pl = sub.add_parser("list-playlists", help="Enqueue tracks from owned playlists since a cutoff date")
    p_pl.add_argument("--since", default="2023-01-01", help="ISO date; playlists with earliest track before this are skipped")
    p_pl.set_defaults(func=cmd_list_playlists)

    p_status = sub.add_parser("status", help="Show library state")
    p_status.set_defaults(func=cmd_status)

    p_run = sub.add_parser("run", help="Download queued tracks")
    p_run.add_argument("--limit", type=int, default=None, help="Max tracks to process this run")
    p_run.set_defaults(func=cmd_run)

    p_stem = sub.add_parser("stem", help="Demucs-stem downloaded tracks missing stems (batch backfill)")
    p_stem.add_argument("--limit", type=int, default=None)
    p_stem.add_argument("--device", default="mps", help="Demucs backend: mps (Apple Silicon GPU), cpu, cuda")
    p_stem.add_argument("--ids", default=None, help="Restrict to these track IDs. Value is a file path (newline-delimited) OR comma-separated list.")
    p_stem.set_defaults(func=cmd_stem)

    p_ing = sub.add_parser("ingest", help="End-to-end ingest of a single track: download + demucs stems, idempotent")
    p_ing.add_argument("track_id", help="Spotify track id")
    p_ing.add_argument("--device", default="mps", help="Demucs backend")
    p_ing.set_defaults(func=cmd_ingest)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
