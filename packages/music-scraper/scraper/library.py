"""Library layout: a directory + SQLite index that tracks what's
downloaded, what's analyzed, and what's failed."""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .config import Config


SCHEMA = """
CREATE TABLE IF NOT EXISTS tracks (
    id              TEXT PRIMARY KEY,      -- Spotify track ID
    name            TEXT NOT NULL,
    artists         TEXT NOT NULL,         -- JSON array
    album           TEXT,
    duration_ms     INTEGER,
    isrc            TEXT,
    added_at        TEXT,                  -- when user liked it (ISO8601)
    status          TEXT NOT NULL,         -- 'queued' | 'downloaded' | 'analyzed' | 'failed'
    error           TEXT,                  -- last error message, if any
    queued_at       TEXT,
    analyzed_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_status ON tracks(status);
"""


class Library:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self._ensure_schema()

    def _ensure_schema(self):
        with self._conn() as c:
            c.executescript(SCHEMA)

    @contextmanager
    def _conn(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(str(self.cfg.index_db))
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    # ---- Track directory layout ----

    def track_dir(self, track_id: str) -> Path:
        return self.cfg.tracks_dir / track_id

    def audio_path(self, track_id: str) -> Path:
        return self.track_dir(track_id) / "audio.ogg"

    def meta_path(self, track_id: str) -> Path:
        return self.track_dir(track_id) / "meta.json"

    def analysis_path(self, track_id: str) -> Path:
        return self.track_dir(track_id) / "analysis.json"

    def stem_path(self, track_id: str, stem: str) -> Path:
        return self.track_dir(track_id) / "stems" / f"{stem}.ogg"

    # ---- Index ops ----

    def enqueue(self, tracks: list[dict]) -> tuple[int, int]:
        """Insert tracks as 'queued'. Returns (added, already_present)."""
        added = 0
        skipped = 0
        with self._conn() as c:
            for t in tracks:
                cur = c.execute(
                    """INSERT INTO tracks (id, name, artists, album, duration_ms, isrc, added_at, status, queued_at)
                       VALUES (?,?,?,?,?,?,?, 'queued', datetime('now'))
                       ON CONFLICT(id) DO NOTHING""",
                    (
                        t["id"], t["name"],
                        json.dumps(t.get("artists", [])),
                        t.get("album"), t.get("duration_ms"),
                        t.get("isrc"), t.get("added_at"),
                    ),
                )
                if cur.rowcount > 0:
                    added += 1
                else:
                    skipped += 1
        return added, skipped

    def mark_status(self, track_id: str, status: str, error: str | None = None):
        with self._conn() as c:
            if status == "analyzed":
                c.execute(
                    "UPDATE tracks SET status=?, error=NULL, analyzed_at=datetime('now') WHERE id=?",
                    (status, track_id),
                )
            else:
                c.execute(
                    "UPDATE tracks SET status=?, error=? WHERE id=?",
                    (status, error, track_id),
                )

    def pending(self, limit: int | None = None) -> list[sqlite3.Row]:
        sql = "SELECT * FROM tracks WHERE status IN ('queued', 'failed') ORDER BY queued_at"
        if limit:
            sql += f" LIMIT {int(limit)}"
        with self._conn() as c:
            return c.execute(sql).fetchall()

    def counts(self) -> dict[str, int]:
        with self._conn() as c:
            rows = c.execute("SELECT status, COUNT(*) n FROM tracks GROUP BY status").fetchall()
        return {r["status"]: r["n"] for r in rows}
