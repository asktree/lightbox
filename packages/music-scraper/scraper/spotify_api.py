"""Spotify Web API wrapper via spotipy. Used for listing liked songs,
reading playlists, and fetching rich track metadata."""
from __future__ import annotations

import json
import os
import tempfile
from typing import Iterator

import spotipy
from spotipy.cache_handler import CacheFileHandler
from spotipy.oauth2 import SpotifyOAuth

from .config import Config, REDIRECT_URI, SPOTIPY_CACHE


SCOPES = [
    "user-library-read",        # /me/tracks (liked)
    "user-read-recently-played",
    "playlist-read-private",
    "user-read-playback-state", # /me/player/currently-playing (autopilot)
]


class AtomicCacheFileHandler(CacheFileHandler):
    """The autopilot daemon and every ingest subprocess share one token
    cache. The stock handler writes it with a plain open('w'), so another
    process can read it half-written during a refresh — the suspected cause
    of the intermittent 401 "Access token missing" bursts despite a valid
    token. Write-to-temp + os.replace is atomic: readers see either the old
    token or the new one, never a torn file."""

    def save_token_to_cache(self, token_info):
        try:
            cache_dir = os.path.dirname(self.cache_path) or "."
            fd, tmp = tempfile.mkstemp(dir=cache_dir, prefix=".spotipy_cache.")
            with os.fdopen(fd, "w") as f:
                f.write(json.dumps(token_info))
            os.replace(tmp, self.cache_path)
        except OSError as e:
            print(f"Couldn't write token to cache at: {self.cache_path}: {e}")


def make_client(
    cfg: Config,
    *,
    open_browser: bool = True,
    retries: int = 5,
    status_retries: int | None = None,
    requests_timeout: int = 30,
) -> spotipy.Spotify:
    """Create an authenticated Spotify client. First run opens a browser
    for OAuth; subsequent runs use the cached token at SPOTIPY_CACHE.

    Daemons must pass open_browser=False, retries=0, status_retries=0,
    requests_timeout=10: retries=0/status_retries=0 disables urllib3's
    Retry-After sleeps (observed sleeping 13.5h inside a call on a 429),
    so every call returns/raises within ~the request timeout."""
    SPOTIPY_CACHE.parent.mkdir(parents=True, exist_ok=True)
    auth = SpotifyOAuth(
        client_id=cfg.spotify.client_id,
        client_secret=cfg.spotify.client_secret,
        redirect_uri=REDIRECT_URI,
        scope=" ".join(SCOPES),
        cache_handler=AtomicCacheFileHandler(cache_path=str(SPOTIPY_CACHE)),
        open_browser=open_browser,
    )
    kwargs: dict = {"requests_timeout": requests_timeout, "retries": retries}
    if status_retries is not None:
        # Only pass when explicitly requested — keeps spotipy's default for
        # existing (fragile) interactive callers.
        kwargs["status_retries"] = status_retries
    return spotipy.Spotify(auth_manager=auth, **kwargs)


def _track_to_dict(track: dict, added_at: str | None) -> dict | None:
    """Convert a Spotify track object to our simplified dict. Returns None
    for local/unavailable tracks with no id."""
    if not track or not track.get("id"):
        return None
    return {
        "id": track["id"],
        "name": track["name"],
        "artists": [a["name"] for a in track.get("artists", [])],
        "album": (track.get("album") or {}).get("name", ""),
        "duration_ms": track.get("duration_ms"),
        "added_at": added_at,
        "isrc": (track.get("external_ids") or {}).get("isrc"),
    }


def owned_playlists_since(client: spotipy.Spotify, since: str) -> Iterator[dict]:
    """Yield tracks from user-owned playlists whose earliest added_at is >= `since`
    (ISO8601, e.g. '2023-01-01'). Tracks are deduped by id across playlists."""
    me = client.me()
    user_id = me["id"]

    # Collect all owned playlists
    owned = []
    offset = 0
    while True:
        page = client.current_user_playlists(limit=50, offset=offset)
        items = page.get("items", [])
        if not items:
            break
        for p in items:
            if (p.get("owner") or {}).get("id") == user_id:
                owned.append(p)
        offset += len(items)
        if not page.get("next"):
            break

    seen: set[str] = set()
    for p in owned:
        pid = p["id"]
        pname = p["name"]
        # Walk items once, collecting both the earliest added_at (to gate
        # the playlist) and the track payloads (to emit if gate passes).
        tracks_buf: list[tuple[dict, str | None]] = []
        earliest: str | None = None
        off = 0
        while True:
            # Spotify's API sometimes returns the track under `item` instead of
            # `track` (appears to depend on client version/headers). Ask for both.
            tp = client.playlist_items(
                pid,
                fields="items(added_at,is_local,track(id,name,artists,album(name),duration_ms,external_ids),item(id,name,artists,album(name),duration_ms,external_ids)),next",
                limit=100,
                offset=off,
            )
            items = tp.get("items", [])
            if not items:
                break
            for it in items:
                if it.get("is_local"):
                    continue
                a = it.get("added_at")
                if a and (earliest is None or a < earliest):
                    earliest = a
                track_obj = it.get("track") or it.get("item") or {}
                tracks_buf.append((track_obj, a))
            off += len(items)
            if not tp.get("next"):
                break

        if not earliest or earliest < since:
            continue
        print(f"  {pname}: {len(tracks_buf)} items (earliest {earliest[:10]})", flush=True)
        for track, added_at in tracks_buf:
            d = _track_to_dict(track, added_at)
            if d is None or d["id"] in seen:
                continue
            seen.add(d["id"])
            yield d


def liked_tracks(client: spotipy.Spotify, limit: int | None = None) -> Iterator[dict]:
    """Yield liked tracks, most-recent first. Each yielded dict is a
    simplified track object (id, name, artist, album, duration_ms, added_at)."""
    batch = 50   # Spotify's max per page
    fetched = 0
    offset = 0

    while True:
        remaining = None if limit is None else max(0, limit - fetched)
        if remaining == 0:
            return
        this_page = batch if remaining is None else min(batch, remaining)

        page = client.current_user_saved_tracks(limit=this_page, offset=offset)
        items = page.get("items", [])
        if not items:
            return

        for item in items:
            track = item.get("track") or {}
            if not track.get("id"):
                continue
            yield {
                "id": track["id"],
                "name": track["name"],
                "artists": [a["name"] for a in track.get("artists", [])],
                "album": (track.get("album") or {}).get("name", ""),
                "duration_ms": track.get("duration_ms"),
                "added_at": item.get("added_at"),
                "isrc": (track.get("external_ids") or {}).get("isrc"),
            }
            fetched += 1
            if limit is not None and fetched >= limit:
                return

        offset += len(items)
