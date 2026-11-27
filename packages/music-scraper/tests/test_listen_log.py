"""Unit tests for the listen log (MEW-170): dedupe and the 48 h sentinel. No network."""
from scraper import listen_log


def item(ts, tid="t1"):
    return {"played_at": ts, "track": {"id": tid, "name": "Song", "artists": [{"name": "A"}, {"name": "B"}],
                                       "album": {"name": "Al"}, "duration_ms": 1000}, "context": None}


def test_insert_dedupes(tmp_path):
    db = listen_log.open_db(tmp_path / "l.db")
    assert listen_log.insert_plays(db, [item("2026-01-01T00:00:00Z"), item("2026-01-01T00:05:00Z")]) == 2
    assert listen_log.insert_plays(db, [item("2026-01-01T00:05:00Z"), item("2026-01-01T00:09:00Z")]) == 1
    row = db.execute("SELECT artists FROM listens LIMIT 1").fetchone()
    assert row[0] == "A, B"


def test_sentinel_files_once_after_48h():
    calls = []
    notify = lambda tool, body: calls.append((tool, body)) or {"item": {"id": "X-1"}}
    st = {"last_success_ts": 0.0, "last_error": "boom"}
    listen_log.check_sentinel(st, 47 * 3600, notify)
    assert calls == []
    listen_log.check_sentinel(st, 49 * 3600, notify)
    assert len(calls) == 1 and calls[0][0] == "create_item" and st["alert_item"] == "X-1"
    listen_log.check_sentinel(st, 60 * 3600, notify)
    assert len(calls) == 1
