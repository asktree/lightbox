"""Durable Spotify listen log (MEW-170).

Spotify keeps only the last 50 plays. This job reads /me/player/recently-played
and appends every play to a SQLite table, so no play is lost while the job runs
more often than 50 plays take (launchd runs it every 30 min).

It does not depend on the autopilot daemon, which is off by default and only
runs when the lights UI asks for it.

Sentinel (no silent failures, ADM-131): if the poll has not succeeded for 48 h,
the job files one Ledger card for hearth-iggymanager. When the poll works again,
it logs the recovery on that card and clears the flag.

Usage:
    python -m scraper.listen_log            # one poll
    python -m scraper.listen_log --stats    # print counts, no poll
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(os.environ.get("LISTEN_LOG_DB", str(Path.home() / "music-library" / "listens.db")))
STATE_PATH = Path(os.environ.get(
    "LISTEN_LOG_STATE", str(Path.home() / ".local" / "state" / "lightbox" / "listen-log.json")))
LEDGER_URL = os.environ.get("LEDGER_URL", "https://ledger-production-dee7.up.railway.app")
AGENT = "hearth-iggymanager"
STALE_S = 48 * 3600

SCHEMA = """
CREATE TABLE IF NOT EXISTS listens (
    played_at   TEXT PRIMARY KEY,   -- ISO UTC from Spotify; one play per instant
    track_id    TEXT,
    track_name  TEXT,
    artists     TEXT,               -- comma-separated names
    album       TEXT,
    duration_ms INTEGER,
    context_uri TEXT,
    raw         TEXT,               -- the full Spotify item as JSON
    logged_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS listens_track ON listens(track_id);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def open_db(path: Path = DB_PATH) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(path))
    db.executescript(SCHEMA)
    return db


def insert_plays(db: sqlite3.Connection, items: list[dict]) -> int:
    """Insert recently-played items; returns how many were new."""
    before = db.total_changes
    stamp = now_iso()
    for it in items:
        track = it.get("track") or {}
        played_at = it.get("played_at")
        if not played_at:
            continue
        db.execute(
            "INSERT OR IGNORE INTO listens VALUES (?,?,?,?,?,?,?,?,?)",
            (
                played_at,
                track.get("id"),
                track.get("name"),
                ", ".join(a.get("name", "") for a in track.get("artists") or []),
                (track.get("album") or {}).get("name"),
                track.get("duration_ms"),
                (it.get("context") or {}).get("uri"),
                json.dumps(it, separators=(",", ":")),
                stamp,
            ),
        )
    db.commit()
    return db.total_changes - before


def load_state() -> dict:
    try:
        return json.loads(STATE_PATH.read_text())
    except (OSError, ValueError):
        return {}


def save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(STATE_PATH.parent), prefix=".listen-log.")
    with os.fdopen(fd, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE_PATH)


def ledger_token() -> str:
    t = os.environ.get("LEDGER_TOKEN", "")
    if t:
        return t
    envf = Path.home() / ".hearth" / "ledger.env"
    try:
        for line in envf.read_text().splitlines():
            k, _, v = line.strip().partition("=")
            if k.strip() in ("LEDGER_TOKEN", "export LEDGER_TOKEN"):
                return v.strip().strip("'\"")
    except OSError:
        pass
    try:
        cfg = json.loads((Path.home() / ".claude.json").read_text())
    except (OSError, ValueError):
        return ""
    groups = [cfg.get("mcpServers") or {}] + [
        (p or {}).get("mcpServers") or {} for p in (cfg.get("projects") or {}).values()]
    for group in groups:
        for s in group.values():
            if "ledger-production" in str(s.get("url", "")):
                h = (s.get("headers") or {}).get("Authorization", "")
                if h.lower().startswith("bearer "):
                    return h[7:].strip()
    return ""


def ledger(tool: str, body: dict) -> dict:
    tok = ledger_token()
    if not tok:
        raise RuntimeError("no Ledger token")
    req = urllib.request.Request(
        LEDGER_URL.rstrip("/") + "/api/" + tool, data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"},
        method="POST")
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


def check_sentinel(state: dict, now: float, notify=ledger) -> None:
    """File one Ledger card when the poll has failed for STALE_S."""
    last_ok = next((state[k] for k in ("last_success_ts", "first_run_ts")
                    if state.get(k) is not None), now)
    if now - last_ok < STALE_S or state.get("alert_item"):
        return
    hours = int((now - last_ok) / 3600)
    body = (
        f"The hearth Spotify listen log (lightbox `scraper.listen_log`, launchd "
        f"`com.lightbox.listen-log`) has not polled Spotify for {hours} h. Spotify keeps only "
        f"the last 50 plays, so plays are being lost.\n\nLast error: {state.get('last_error')}\n\n"
        f"Check `~/.local/state/lightbox/listen-log.log` on hearth. If the error is auth, the "
        f"Spotify token needs `pnpm spotify:reauth` in the lightbox repo. Built in MEW-170.")
    res = notify("create_item", {
        "agent": AGENT, "title": f"Spotify listen log on hearth stopped {hours} h ago",
        "body": body, "project": "Home AI", "kind": "task", "assignee": AGENT,
        "want": "Iggy (PEB-184): all her Spotify listens logged on hearth, \"unless the logger "
                "isnt functioning, which would make me sad\".",
    })
    item = (res.get("item") or res).get("id")
    state["alert_item"] = item
    print(f"sentinel: filed {item}")


def poll(state: dict, notify=ledger) -> int:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from scraper.config import load_config
    from scraper.spotify_api import make_client

    cfg = load_config()
    sp = make_client(cfg, open_browser=False, retries=0, status_retries=0, requests_timeout=15)
    db = open_db()
    # Always the newest 50; INSERT OR IGNORE on played_at removes repeats.
    res = sp.current_user_recently_played(limit=50)
    items = res.get("items") or []
    new = insert_plays(db, items)
    total = db.execute("SELECT COUNT(*) FROM listens").fetchone()[0]
    db.close()
    if state.get("alert_item"):
        try:
            notify("log", {"agent": AGENT, "id": state["alert_item"],
                           "text": f"listen_log recovered at {now_iso()}: poll works again."})
        except Exception as e:  # noqa: BLE001 - recovery note is best effort
            print(f"recovery log failed: {e}")
        state.pop("alert_item", None)
    print(f"{now_iso()} fetched={len(items)} new={new} total={total}")
    return new


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stats", action="store_true")
    args = ap.parse_args(argv)
    if args.stats:
        db = open_db()
        n, first, last = db.execute(
            "SELECT COUNT(*), MIN(played_at), MAX(played_at) FROM listens").fetchone()
        print(f"listens={n} first={first} last={last}")
        print(json.dumps(load_state(), indent=2))
        return 0

    state = load_state()
    now = time.time()
    state.setdefault("first_run_ts", now)
    state["last_run_ts"] = now
    rc = 0
    try:
        poll(state)
        state["last_success_ts"] = now
        state.pop("last_error", None)
    except BaseException as e:  # noqa: BLE001 - SystemExit from load_config too
        state["last_error"] = f"{type(e).__name__}: {e}"[:500]
        print(f"{now_iso()} poll failed: {state['last_error']}")
        rc = 1
    try:
        check_sentinel(state, now)
    except Exception as e:  # noqa: BLE001
        print(f"sentinel failed: {e}")
    save_state(state)
    return rc


if __name__ == "__main__":
    sys.exit(main())
