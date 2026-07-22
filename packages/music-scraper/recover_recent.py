"""One-shot recovery (July 22 2026): the July 21 evening autopilot session
was wedged in a rate-limit sleep, so nothing played that night got
ingested. Poll recently-played until the app's rate limit lifts, then
ingest every recent track that's missing stems. Delete after use.

Run from the music-scraper package root:
    nohup .venv/bin/python recover_recent.py > /tmp/lightbox-recover.log 2>&1 &
"""
import subprocess
import sys
import time
from pathlib import Path

from scraper.config import load_config
from scraper.spotify_api import make_client

cfg = load_config()
# Same no-in-call-sleep client settings as the autopilot daemon.
sp = make_client(cfg, open_browser=False, retries=0, status_retries=0,
                 requests_timeout=15)

items = None
for attempt in range(18):  # up to ~3h at 10-min cadence
    try:
        items = sp.current_user_recently_played(limit=50).get("items") or []
        break
    except Exception as e:
        print(f"attempt {attempt + 1}: {str(e)[:120]}", flush=True)
        time.sleep(600)
if items is None:
    sys.exit("gave up waiting for the rate limit")

def has_stems(tid: str) -> bool:
    d = cfg.tracks_dir / tid / "stems"
    return all((d / f"{s}.ogg").exists() for s in ("drums", "bass", "vocals", "other"))

seen: set[str] = set()
todo: list[tuple[str, str, str]] = []
for it in items:
    t = it.get("track") or {}
    tid = t.get("id")
    if not tid or tid in seen:
        continue
    seen.add(tid)
    if has_stems(tid):
        continue
    todo.append((tid, t.get("name", "?"),
                 ", ".join(a.get("name", "") for a in (t.get("artists") or []))))

print(f"{len(todo)} tracks to ingest (of {len(seen)} recent)", flush=True)
pkg_root = Path(__file__).resolve().parent
fails = 0
for tid, name, artists in todo:
    print(f"→ ingest {tid}  {artists} — {name}", flush=True)
    rc = subprocess.run([sys.executable, "-m", "scraper", "ingest", tid],
                        cwd=str(pkg_root)).returncode
    print(f"  rc={rc}", flush=True)
    if rc != 0:
        fails += 1
        if fails >= 3:
            sys.exit("3 ingest failures — zotify may need attention; stopping")
print("done", flush=True)
