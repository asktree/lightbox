"""Spotify Web API wrapper via spotipy. Used for listing liked songs,
reading playlists, and fetching rich track metadata."""
from __future__ import annotations

from typing import Iterator

import spotipy
from spotipy.oauth2 import SpotifyOAuth

from .config import Config, REDIRECT_URI, SPOTIPY_CACHE


SCOPES = [
    "user-library-read",        # /me/tracks (liked)
    "user-read-recently-played",
    "playlist-read-private",
]


def make_client(cfg: Config) -> spotipy.Spotify:
    """Create an authenticated Spotify client. First run opens a browser
    for OAuth; subsequent runs use the cached token at SPOTIPY_CACHE."""
    SPOTIPY_CACHE.parent.mkdir(parents=True, exist_ok=True)
    auth = SpotifyOAuth(
        client_id=cfg.spotify.client_id,
        client_secret=cfg.spotify.client_secret,
        redirect_uri=REDIRECT_URI,
        scope=" ".join(SCOPES),
        cache_path=str(SPOTIPY_CACHE),
        open_browser=True,
    )
    return spotipy.Spotify(auth_manager=auth)


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
