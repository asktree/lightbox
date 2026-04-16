"""Wraps zotify CLI to download tracks into our library layout.

zotify's native output template uses {album_artist}/{album}/... which is great
for a user-browsable library but wrong for us — we want
~/music-library/tracks/<id>/audio.ogg, indexed by Spotify track ID.

Strategy: run zotify with a temp output dir, find the produced .ogg, move it
to the canonical location. Works regardless of zotify's internal naming.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sqlite3
import tempfile
from pathlib import Path

from .config import Config


ZOTIFY_CREDENTIALS = Path.home() / "Library/Application Support/Zotify/credentials.json"


class DownloadError(Exception):
    pass


def ensure_authenticated() -> None:
    """Raise if zotify hasn't completed OAuth yet."""
    if not ZOTIFY_CREDENTIALS.exists():
        raise DownloadError(
            f"No zotify credentials at {ZOTIFY_CREDENTIALS}. "
            f"Run one interactive OAuth first (see README)."
        )


def download_track(cfg: Config, track_id: str, meta: sqlite3.Row) -> Path:
    """Download a single track. Writes audio.ogg + meta.json into the
    library, returns the audio path. Raises DownloadError on failure."""
    ensure_authenticated()

    target_dir = cfg.tracks_dir / track_id
    target_dir.mkdir(parents=True, exist_ok=True)
    audio_path = target_dir / "audio.ogg"

    if audio_path.exists():
        return audio_path

    with tempfile.TemporaryDirectory(prefix="zotify-") as tmp:
        cmd = [
            str(Path(__file__).parents[1] / ".venv/bin/python"),
            "-u",
            str(Path(__file__).parents[1] / ".venv/bin/zotify"),
            "--username", "agrippakellum@gmail.com",
            "--credentials", str(ZOTIFY_CREDENTIALS),
            "--library", tmp,
            "--audio-format", "vorbis",
            "--download-quality", "very_high",
            "--print-errors",
            f"https://open.spotify.com/track/{track_id}",
        ]
        env = {"PYTHONUNBUFFERED": "1"}
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=180,
            env={**__import__("os").environ, **env},
        )
        if proc.returncode != 0:
            raise DownloadError(
                f"zotify exited {proc.returncode}. stderr: {proc.stderr[-400:]}"
            )

        # Find the produced .ogg — zotify's template creates nested dirs
        produced = list(Path(tmp).rglob("*.ogg"))
        if not produced:
            raise DownloadError(f"zotify produced no .ogg in {tmp}")
        if len(produced) > 1:
            # Multiple matches shouldn't happen for a single-track download
            # but pick the largest just in case
            produced.sort(key=lambda p: p.stat().st_size, reverse=True)

        shutil.move(str(produced[0]), audio_path)

    # Write metadata sidecar
    meta_path = target_dir / "meta.json"
    meta_path.write_text(json.dumps({
        "id": meta["id"],
        "name": meta["name"],
        "artists": json.loads(meta["artists"]),
        "album": meta["album"],
        "duration_ms": meta["duration_ms"],
        "isrc": meta["isrc"],
        "added_at": meta["added_at"],
    }, indent=2))

    return audio_path
