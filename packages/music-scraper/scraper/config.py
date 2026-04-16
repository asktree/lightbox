"""Configuration and credentials loader."""
import json
import os
from dataclasses import dataclass
from pathlib import Path


CREDENTIALS_PATH = Path.home() / ".config" / "musicbox" / "credentials.json"
DEFAULT_LIBRARY_DIR = Path.home() / "music-library"
SPOTIPY_CACHE = CREDENTIALS_PATH.parent / ".spotipy_cache"
REDIRECT_URI = "http://127.0.0.1:8888/callback"


@dataclass
class SpotifyCredentials:
    sp_dc: str
    sp_key: str
    client_id: str
    client_secret: str


@dataclass
class Config:
    spotify: SpotifyCredentials
    library_dir: Path

    @property
    def tracks_dir(self) -> Path:
        return self.library_dir / "tracks"

    @property
    def index_db(self) -> Path:
        return self.library_dir / "index.db"


def load_config() -> Config:
    if not CREDENTIALS_PATH.exists():
        raise SystemExit(
            f"Missing credentials file at {CREDENTIALS_PATH}. "
            f"See packages/music-scraper/README.md for expected format."
        )

    with open(CREDENTIALS_PATH) as f:
        data = json.load(f)

    sp = data.get("spotify") or {}
    required = ("sp_dc", "sp_key", "client_id", "client_secret")
    missing = [k for k in required if not sp.get(k)]
    if missing:
        raise SystemExit(f"credentials.json is missing: {', '.join(missing)}")

    library = Path(os.environ.get("MUSICBOX_LIBRARY", str(DEFAULT_LIBRARY_DIR))).expanduser()
    library.mkdir(parents=True, exist_ok=True)
    (library / "tracks").mkdir(exist_ok=True)

    return Config(
        spotify=SpotifyCredentials(
            sp_dc=sp["sp_dc"],
            sp_key=sp["sp_key"],
            client_id=sp["client_id"],
            client_secret=sp["client_secret"],
        ),
        library_dir=library,
    )
