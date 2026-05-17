"""Structural analysis: section boundaries + functional labels via Allin1.

Writes {library}/tracks/{id}/structure.json with:
  {
    "bpm": int,
    "beats": [t, ...],
    "downbeats": [t, ...],
    "segments": [{ "start": s, "end": s, "label": "intro|verse|chorus|..." }, ...]
  }

Runs on CPU (NATTEN doesn't support MPS yet). ~150-200s per ~3-4min track,
so this is a long-tail batch. Demixing happens internally — allin1 doesn't
trust externally-provided stems because their stem format must match what
the model was trained on (htdemucs).
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

# Lazy import of allin1: keeps `scraper status`/`scraper run` fast for users
# who never invoke structure analysis.
def _load_analyze():
    from allin1 import analyze  # heavy: pulls in torch + natten + demucs
    return analyze


def analyze_track(
    track_id: str,
    *,
    library_root: Optional[Path] = None,
    demix_dir: Optional[Path] = None,
    spec_dir: Optional[Path] = None,
    overwrite: bool = False,
) -> dict:
    """Run allin1 on a track's audio.ogg and write structure.json. Returns
    the parsed result dict. Raises SystemExit if audio is missing."""
    from .config import load_config
    cfg = load_config()
    track_dir = (library_root or cfg.tracks_dir) / track_id
    audio_path = track_dir / "audio.ogg"
    out_path = track_dir / "structure.json"
    if not audio_path.exists():
        raise SystemExit(f"no audio at {audio_path}")
    if out_path.exists() and not overwrite:
        return json.loads(out_path.read_text())

    analyze = _load_analyze()
    # demix_dir / spec_dir: cache directories shared across tracks so we
    # don't repeat the demix step for tracks we've already processed once.
    # Default is cwd-relative which is fine when invoked from the package.
    r = analyze(
        str(audio_path),
        device="cpu",  # NATTEN doesn't support mps yet
        demix_dir=str(demix_dir) if demix_dir else "./demix",
        spec_dir=str(spec_dir) if spec_dir else "./spec",
        keep_byproducts=False,  # clean up demixed stems after we're done
        multiprocess=False,     # avoid stray semaphores when batching
        overwrite=overwrite,
    )
    payload = {
        "bpm": int(r.bpm) if r.bpm is not None else None,
        "beats": [round(float(t), 3) for t in (r.beats or [])],
        "downbeats": [round(float(t), 3) for t in (r.downbeats or [])],
        "segments": [
            {"start": round(float(s.start), 3), "end": round(float(s.end), 3), "label": s.label}
            for s in (r.segments or [])
        ],
    }
    out_path.write_text(json.dumps(payload, indent=2))
    return payload


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("usage: python -m scraper.structure <track-id> [<track-id> ...]")
        sys.exit(1)
    for tid in sys.argv[1:]:
        print(f"== {tid} ==")
        result = analyze_track(tid)
        print(f"  {len(result['segments'])} segments, bpm={result['bpm']}")
