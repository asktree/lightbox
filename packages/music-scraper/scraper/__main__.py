"""CLI entry for the music-scraper."""
import argparse
import json
import sys

from .config import load_config
from .library import Library


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


def cmd_analyze(args):
    """Analyze tracks that have been downloaded but not yet analyzed."""
    import sqlite3
    import time
    from .analyzer import analyze_track

    cfg = load_config()
    lib = Library(cfg)

    # Pull anything with status=downloaded
    with sqlite3.connect(str(cfg.index_db)) as c:
        c.row_factory = sqlite3.Row
        sql = "SELECT * FROM tracks WHERE status='downloaded' ORDER BY queued_at"
        if args.limit:
            sql += f" LIMIT {int(args.limit)}"
        rows = c.execute(sql).fetchall()

    if not rows:
        print("Nothing to analyze.")
        return

    print(f"Analyzing {len(rows)} tracks...")
    ok = 0
    fail = 0
    start = time.time()

    for i, row in enumerate(rows, 1):
        tid = row["id"]
        artists = ", ".join(json.loads(row["artists"]))
        prefix = f"[{i}/{len(rows)}]"
        t0 = time.time()
        print(f"{prefix} {artists} — {row['name']} ({tid})", flush=True)
        try:
            audio = lib.audio_path(tid)
            analysis = lib.analysis_path(tid)
            if not audio.exists():
                raise RuntimeError(f"audio missing at {audio}")
            analyze_track(audio, analysis, demucs_device=args.device)
            lib.mark_status(tid, "analyzed")
            ok += 1
            print(f"    ✓ {time.time() - t0:.0f}s", flush=True)
        except Exception as e:
            lib.mark_status(tid, "failed", f"{type(e).__name__}: {e}")
            print(f"    ✗ {e}", flush=True)
            fail += 1

    elapsed = time.time() - start
    print(f"\nDone. {ok} analyzed, {fail} failed in {elapsed:.0f}s "
          f"({elapsed / max(1, ok):.1f}s/track avg).")


def cmd_run(args):
    """Process the queue — download tracks (analysis is a separate phase)."""
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


def main():
    ap = argparse.ArgumentParser(prog="scraper", description="Download + analyze music for musicbox")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_liked = sub.add_parser("list-liked", help="Enqueue recent liked songs")
    p_liked.add_argument("--limit", type=int, default=200)
    p_liked.set_defaults(func=cmd_list_liked)

    p_status = sub.add_parser("status", help="Show library state")
    p_status.set_defaults(func=cmd_status)

    p_run = sub.add_parser("run", help="Download queued tracks")
    p_run.add_argument("--limit", type=int, default=None, help="Max tracks to process this run")
    p_run.set_defaults(func=cmd_run)

    p_ana = sub.add_parser("analyze", help="Analyze downloaded tracks (Demucs + librosa + essentia)")
    p_ana.add_argument("--limit", type=int, default=None)
    p_ana.add_argument("--device", default="mps", help="Demucs backend: mps (Apple Silicon GPU), cpu, cuda")
    p_ana.set_defaults(func=cmd_analyze)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
