"""Stem separation — the entire processing pipeline.

For each track: Demucs → drums/bass/vocals/other stems, saved as OGG.
That's it. Energy envelopes are computed downstream from the stems by
musicbox's envelope service (/api/library/:id/envelope); nothing else is
precomputed.

(The former analysis pipeline — essentia BPM/key, librosa onset picking,
madmom onsets, allin1 structure — is dead. See GRAVESTONE.md at repo root.)
"""
from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

DEMUCS_MODEL = "htdemucs"
DEMUCS_STEMS = ["drums", "bass", "vocals", "other"]


def run_demucs(audio_path: Path, out_dir: Path, device: str = "mps") -> dict[str, Path]:
    venv_python = Path(__file__).parents[1] / ".venv" / "bin" / "python"
    cmd = [
        str(venv_python), "-m", "demucs",
        "-n", DEMUCS_MODEL,
        "-d", device,
        "-o", str(out_dir),
        str(audio_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    if proc.returncode != 0:
        raise RuntimeError(f"demucs failed: {proc.stderr[-500:]}")

    stem_parent = out_dir / DEMUCS_MODEL / audio_path.stem
    stems = {}
    for s in DEMUCS_STEMS:
        p = stem_parent / f"{s}.wav"
        if not p.exists():
            raise RuntimeError(f"demucs did not produce {p}")
        stems[s] = p
    return stems


def transcode_stem_to_ogg(wav_path: Path, ogg_path: Path, quality: int = 5) -> None:
    """Transcode a WAV stem to OGG Vorbis via ffmpeg. quality=5 is ~160kbps."""
    # ffmpeg 8.x dropped libvorbis; use the native vorbis encoder, which is
    # still marked experimental and requires -strict -2.
    ogg_path.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(wav_path),
        "-c:a", "vorbis", "-strict", "-2", "-q:a", str(quality),
        str(ogg_path),
    ], capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {proc.stderr[-300:]}")


def separate_stems(audio_path: Path, stems_dir: Path, device: str = "mps") -> None:
    """Demucs → four OGG stems on disk.

    Stems are transcoded into a .partial dir and renamed into place so
    readers never observe a half-written stem set."""
    import shutil
    partial = stems_dir.parent / (stems_dir.name + ".partial")
    if partial.exists():
        shutil.rmtree(partial)
    with tempfile.TemporaryDirectory(prefix="demucs-") as tmp:
        stems = run_demucs(audio_path, Path(tmp), device=device)
        for name, wav_path in stems.items():
            transcode_stem_to_ogg(wav_path, partial / f"{name}.ogg")
    if stems_dir.exists():
        shutil.rmtree(stems_dir)
    partial.rename(stems_dir)


def stems_present(stems_dir: Path) -> bool:
    return all((stems_dir / f"{s}.ogg").exists() for s in DEMUCS_STEMS)
