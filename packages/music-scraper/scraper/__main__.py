"""CLI entry for the music-scraper."""
import argparse
import json
import sys
from pathlib import Path

from .config import load_config
from .library import Library


def _read_id_list(arg: str) -> list[str]:
    """--ids can be a path to a newline-delimited file OR a comma-separated list."""
    p = Path(arg)
    if p.exists():
        return [line.strip() for line in p.read_text().splitlines() if line.strip()]
    return [x.strip() for x in arg.split(",") if x.strip()]


# Long-running analyze/madmom loops re-read this file between iterations.
# Any track IDs found get yanked to the front of the remaining queue, so
# you can jump the line on a running batch without restarting. Written to
# by `scraper prioritize <tid>`.
PRIORITY_FILE = Path("/tmp/scraper-priority-ids")

def _read_priority_ids() -> list[str]:
    if not PRIORITY_FILE.exists():
        return []
    return [line.strip() for line in PRIORITY_FILE.read_text().splitlines() if line.strip()]

def _reorder_with_priority(remaining: list, handled: set) -> list:
    """Pull any priority-file IDs to the front, preserving priority order.
    Already-handled IDs are dropped from consideration."""
    pri = _read_priority_ids()
    if not pri:
        return remaining
    by_id = {r["id"]: r for r in remaining}
    front = []
    for pid in pri:
        if pid in handled:
            continue
        row = by_id.get(pid)
        if row is not None:
            front.append(row)
    front_ids = {r["id"] for r in front}
    rest = [r for r in remaining if r["id"] not in front_ids]
    return front + rest


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


def cmd_analyze(args):
    """Analyze tracks that have been downloaded but not yet analyzed."""
    import sqlite3
    import time
    from .analyzer import analyze_track

    cfg = load_config()
    lib = Library(cfg)

    # Pull candidates. Default: status=downloaded (fresh analyze candidates).
    # With --ids: restrict to that set, ignoring status (so we can retry
    # failed tracks or re-analyze).
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
            rows = c.execute("SELECT * FROM tracks WHERE status='downloaded' ORDER BY queued_at").fetchall()

    # Optional priority: comma-separated artist names that should be analyzed
    # first. Case-insensitive substring match against the artists JSON array.
    if getattr(args, "priority", None):
        wants = [p.strip().lower() for p in args.priority.split(",") if p.strip()]
        def priority_rank(row):
            artists_blob = (row["artists"] or "").lower()
            for i, want in enumerate(wants):
                if want in artists_blob:
                    return i
            return len(wants)
        rows = sorted(rows, key=priority_rank)
        n_pri = sum(1 for r in rows if priority_rank(r) < len(wants))
        print(f"Priority: {n_pri} track(s) matching [{', '.join(wants)}] will run first")

    if args.limit:
        rows = rows[: int(args.limit)]

    if not rows:
        print("Nothing to analyze.")
        return

    total = len(rows)
    print(f"Analyzing {total} tracks...")
    ok = 0
    fail = 0
    start = time.time()
    handled: set = set()
    remaining = rows
    idx = 0

    while remaining:
        remaining = _reorder_with_priority(remaining, handled)
        row = remaining[0]
        remaining = remaining[1:]
        idx += 1
        tid = row["id"]
        artists = ", ".join(json.loads(row["artists"]))
        prefix = f"[{idx}/{total}]"
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
        finally:
            handled.add(tid)

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


def cmd_ingest(args):
    """End-to-end pipeline for a single Spotify track id: enqueue if new,
    download if missing, analyze if needed, madmom if missing. Idempotent.
    Used by the autopilot to ingest unknown tracks on the fly.
    """
    import time
    import sqlite3
    from .downloader import download_track, DownloadError
    from .analyzer import analyze_track
    from .madmom_onsets import analyze_track as madmom_analyze
    from .spotify_api import make_client, _track_to_dict

    tid = args.track_id
    cfg = load_config()
    lib = Library(cfg)

    # 1. Make sure the row exists.
    with sqlite3.connect(str(cfg.index_db)) as c:
        c.row_factory = sqlite3.Row
        row = c.execute("SELECT * FROM tracks WHERE id=?", (tid,)).fetchone()

    if not row:
        print(f"[ingest] fetching metadata for {tid}")
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
    analysis_path = lib.analysis_path(tid)
    madmom_path = cfg.tracks_dir / tid / "madmom_onsets.json"

    # 2. Download if missing or last attempt failed.
    if not audio_path.exists():
        print(f"[ingest] downloading {tid}")
        t0 = time.time()
        try:
            download_track(cfg, tid, dict(row))
            lib.mark_status(tid, "downloaded")
            print(f"[ingest] downloaded in {time.time()-t0:.0f}s")
        except (DownloadError, Exception) as e:
            lib.mark_status(tid, "failed", str(e))
            raise SystemExit(f"download failed: {e}")

    # 3. Analyze (Demucs+librosa+essentia) if missing.
    if not analysis_path.exists():
        print(f"[ingest] analyzing {tid}")
        t0 = time.time()
        try:
            analyze_track(audio_path, analysis_path, demucs_device=args.device)
            lib.mark_status(tid, "analyzed")
            print(f"[ingest] analyzed in {time.time()-t0:.0f}s")
        except Exception as e:
            lib.mark_status(tid, "failed", f"{type(e).__name__}: {e}")
            raise SystemExit(f"analyze failed: {e}")

    # 4. Madmom onsets if missing.
    if not madmom_path.exists():
        print(f"[ingest] madmom {tid}")
        t0 = time.time()
        try:
            madmom_analyze(tid, fast=getattr(args, "fast", False))
            print(f"[ingest] madmom in {time.time()-t0:.0f}s")
        except Exception as e:
            raise SystemExit(f"madmom failed: {e}")

    print(f"[ingest] ✓ {tid} ready")


def cmd_prioritize(args):
    """Add track IDs to the priority-jump file. Running analyze/madmom
    loops re-read this file between tracks and pull matching IDs to the
    front of the remaining queue. Accepts multiple ids, a file path, or
    a comma-separated list."""
    ids: list[str] = []
    for raw in args.ids_or_paths:
        ids.extend(_read_id_list(raw))
    existing = _read_priority_ids()
    existing_set = set(existing)
    added = [t for t in ids if t not in existing_set]
    if not added:
        print(f"(already queued) priority file has {len(existing)} ids")
        return
    all_ids = existing + added
    PRIORITY_FILE.write_text("\n".join(all_ids) + "\n")
    print(f"Added {len(added)} to {PRIORITY_FILE} (total {len(all_ids)})")
    for t in added: print(f"  + {t}")


def cmd_unprioritize(args):
    """Clear the priority-jump file, or drop specific IDs."""
    if args.ids_or_paths:
        drop = set()
        for raw in args.ids_or_paths:
            drop.update(_read_id_list(raw))
        keep = [t for t in _read_priority_ids() if t not in drop]
        if keep:
            PRIORITY_FILE.write_text("\n".join(keep) + "\n")
        else:
            try: PRIORITY_FILE.unlink()
            except FileNotFoundError: pass
        print(f"Dropped {len(drop)} ids; {len(keep)} remain")
    else:
        try: PRIORITY_FILE.unlink(); print(f"Cleared {PRIORITY_FILE}")
        except FileNotFoundError: print("Priority file already empty")


def cmd_madmom(args):
    """(Re-)run madmom onset detection on tracks that have stems on disk.
    Writes {track}/madmom_onsets.json. Priority-orderable by artist."""
    import sqlite3
    import time
    from .madmom_onsets import analyze_track as madmom_analyze

    cfg = load_config()
    lib = Library(cfg)

    # All tracks with stems present on disk. Falls back to status>=analyzed
    # since the analyzer writes stems/* and usually keeps them.
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
            rows = c.execute("SELECT * FROM tracks WHERE status IN ('analyzed','downloaded')").fetchall()

    # Filter to tracks that actually have stems on disk.
    have_stems = []
    for row in rows:
        tid = row["id"]
        stems_dir = cfg.tracks_dir / tid / "stems"
        if stems_dir.is_dir() and any(stems_dir.glob("*.ogg")):
            have_stems.append(row)
    rows = have_stems

    # Optional skip-if-exists
    if not args.force:
        rows = [r for r in rows if not (cfg.tracks_dir / r["id"] / "madmom_onsets.json").exists()]

    # Priority
    if args.priority:
        wants = [p.strip().lower() for p in args.priority.split(",") if p.strip()]
        def rank(row):
            blob = (row["artists"] or "").lower()
            for i, w in enumerate(wants):
                if w in blob:
                    return i
            return len(wants)
        rows = sorted(rows, key=rank)
        n_pri = sum(1 for r in rows if rank(r) < len(wants))
        print(f"Priority: {n_pri} track(s) matching [{', '.join(wants)}] will run first")

    if args.limit:
        rows = rows[: int(args.limit)]

    if not rows:
        print("Nothing to process.")
        return

    total = len(rows)
    print(f"Running madmom on {total} tracks...")
    ok = 0; fail = 0
    start = time.time()
    handled: set = set()
    remaining = rows
    idx = 0
    while remaining:
        remaining = _reorder_with_priority(remaining, handled)
        row = remaining[0]
        remaining = remaining[1:]
        idx += 1
        tid = row["id"]
        artists = ", ".join(json.loads(row["artists"]))
        prefix = f"[{idx}/{total}]"
        t0 = time.time()
        print(f"{prefix} {artists} — {row['name']} ({tid})", flush=True)
        try:
            madmom_analyze(tid, fast=getattr(args, "fast", False))
            ok += 1
            print(f"    ✓ {time.time() - t0:.0f}s", flush=True)
        except SystemExit as e:
            print(f"    ✗ {e}", flush=True)
            fail += 1
        except Exception as e:
            print(f"    ✗ {type(e).__name__}: {e}", flush=True)
            fail += 1
        finally:
            handled.add(tid)

    elapsed = time.time() - start
    print(f"\nDone. {ok} processed, {fail} failed in {elapsed:.0f}s "
          f"({elapsed / max(1, ok):.1f}s/track avg).")


def main():
    ap = argparse.ArgumentParser(prog="scraper", description="Download + analyze music for musicbox")
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

    p_ana = sub.add_parser("analyze", help="Analyze downloaded tracks (Demucs + librosa + essentia)")
    p_ana.add_argument("--limit", type=int, default=None)
    p_ana.add_argument("--device", default="mps", help="Demucs backend: mps (Apple Silicon GPU), cpu, cuda")
    p_ana.add_argument("--priority", default=None, help="Comma-separated artist substrings to run first (e.g. 'Knife,Orbital')")
    p_ana.add_argument("--ids", default=None, help="Restrict to these track IDs. Value is a file path (newline-delimited) OR comma-separated list.")
    p_ana.set_defaults(func=cmd_analyze)

    p_ing = sub.add_parser("ingest", help="End-to-end ingest of a single track: download+analyze+madmom, idempotent")
    p_ing.add_argument("track_id", help="Spotify track id")
    p_ing.add_argument("--device", default="mps", help="Demucs backend")
    p_ing.add_argument("--fast", action="store_true", help="Madmom step only computes drums_low_strict.superflux")
    p_ing.set_defaults(func=cmd_ingest)

    p_mad = sub.add_parser("madmom", help="Run madmom onset detection on tracks with stems")
    p_mad.add_argument("--limit", type=int, default=None)
    p_mad.add_argument("--priority", default=None, help="Comma-separated artist substrings to run first")
    p_mad.add_argument("--force", action="store_true", help="Re-run even if madmom_onsets.json already exists")
    p_mad.add_argument("--ids", default=None, help="Restrict to these track IDs. Value is a file path OR comma-separated list.")
    p_mad.add_argument("--fast", action="store_true", help="Only compute drums_low_strict.superflux — ~5-10× faster")
    p_mad.set_defaults(func=cmd_madmom)

    p_pri = sub.add_parser("prioritize", help="Insert track IDs at the front of the running analyze/madmom queue")
    p_pri.add_argument("ids_or_paths", nargs="+", help="Spotify track IDs, comma-separated lists, or paths to newline-delimited files")
    p_pri.set_defaults(func=cmd_prioritize)

    p_unp = sub.add_parser("unprioritize", help="Clear the priority-jump file, or drop specific IDs")
    p_unp.add_argument("ids_or_paths", nargs="*", help="Optional IDs to remove; default: clear all")
    p_unp.set_defaults(func=cmd_unprioritize)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
