"""Offline analysis pipeline.

For each track:
  1. Demucs → separate into drums/bass/vocals/other stems (saved as OGG)
  2. essentia RhythmExtractor2013 → BPM + beat grid
  3. essentia KeyExtractor → key/mode
  4. Peak-pick low/high-band onsets on the drums stem → timestamp arrays
  5. Write analysis.json (beats + onset peaks + song-level metadata, ~30KB)

The client computes per-frame spectrum, chroma, energy bands, etc. at
playback time via Web Audio's AnalyserNode on the stem audio elements.
Those features are cheap to compute on the fly and would otherwise bloat
analysis.json to ~46MB per song. We only pre-compute things that genuinely
need look-ahead (beats) or ML (eventually, downbeats + onsets).
"""
from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

import numpy as np

SAMPLE_RATE = 44100
FFT_SIZE = 2048
HOP_SIZE = 1024

DEMUCS_MODEL = "htdemucs"
DEMUCS_STEMS = ["drums", "bass", "vocals", "other"]


# ---- Demucs ----

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


# ---- essentia sidecar ----

ESSENTIA_PYTHON = Path(__file__).parents[1] / ".venv-essentia" / "bin" / "python"
ESSENTIA_HELPER = Path(__file__).parent / "essentia_helper.py"


def run_essentia(audio_path: Path) -> dict:
    """Call essentia (different venv, numpy<2) for BPM + key."""
    proc = subprocess.run(
        [str(ESSENTIA_PYTHON), str(ESSENTIA_HELPER), str(audio_path)],
        capture_output=True, text=True, timeout=300,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"essentia helper failed: {proc.stderr[-400:]}")
    return json.loads(proc.stdout.strip().split("\n")[-1])


# ---- Onset peak picking on drums stem ----
#
# Only thing we still need frame-level computation for. We compute a flux
# curve internally, find peaks, and throw away the curve — only the peak
# timestamps are saved.

def _hann(size: int) -> np.ndarray:
    return 0.5 * (1 - np.cos(2 * np.pi * np.arange(size) / (size - 1)))


def _drums_flux(y: np.ndarray, sr: int, lo_hz: float, hi_hz: float) -> np.ndarray:
    """Log-compressed positive spectral flux in a frequency band, over time."""
    import librosa
    stft = np.abs(librosa.stft(y, n_fft=FFT_SIZE, hop_length=HOP_SIZE))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=FFT_SIZE)
    bin_width = sr / FFT_SIZE
    lo = max(1, int(lo_hz / bin_width))
    hi = min(stft.shape[0] - 1, int(np.ceil(hi_hz / bin_width)))
    band = stft[lo:hi + 1]
    log_mag = np.log1p(band * 1000.0 / FFT_SIZE)
    diff = np.diff(log_mag, axis=1)
    flux = np.sum(np.maximum(0, diff), axis=0)
    return np.concatenate([[0.0], flux])


def _normalize_curve(curve: np.ndarray, pct: float = 99.5, floor: float = 1e-6) -> np.ndarray:
    peak = max(float(np.percentile(curve, pct)), floor)
    return np.clip(curve / peak, 0, 1)


def pick_peaks(curve: np.ndarray, fps: float,
               min_gap_ms: float = 80.0,
               threshold_mult: float = 2.5,
               absolute_floor: float = 0.12,
               window_s: float = 1.0) -> list[float]:
    """Adaptive peak picker with median+MAD threshold. Returns peak times in seconds."""
    n = len(curve)
    if n < 3:
        return []
    window = int(fps * window_s)
    min_gap_frames = max(1, int(min_gap_ms * fps / 1000))
    peaks: list[float] = []
    last_peak_frame = -min_gap_frames

    for i in range(1, n - 1):
        if i - last_peak_frame < min_gap_frames:
            continue
        v = curve[i]
        if v < absolute_floor:
            continue
        if v <= curve[i - 1] or v <= curve[i + 1]:
            continue
        lo = max(0, i - window)
        hi = min(n, i + 1)
        local = curve[lo:hi]
        med = float(np.median(local))
        mad = float(np.median(np.abs(local - med))) + 1e-6
        if v > med + threshold_mult * mad:
            peaks.append(round(i / fps, 3))
            last_peak_frame = i

    return peaks


# ---- Main ----

def analyze_track(audio_path: Path, analysis_path: Path, demucs_device: str = "mps") -> dict:
    """Run the full pipeline on one track. Writes analysis.json, returns the dict."""
    import librosa

    # essentia first — if it fails we avoid wasting time on Demucs
    essentia_out = run_essentia(audio_path)

    track_dir = analysis_path.parent
    stems_dir = track_dir / "stems"

    # Separate into stems, persist as OGG, load drums into memory for onset picking.
    # The other stems are saved to disk but not loaded — we don't analyze them
    # server-side; the client does per-frame stuff via Web Audio at playback.
    with tempfile.TemporaryDirectory(prefix="demucs-") as tmp:
        stems = run_demucs(audio_path, Path(tmp), device=demucs_device)

        for name, wav_path in stems.items():
            ogg_path = stems_dir / f"{name}.ogg"
            transcode_stem_to_ogg(wav_path, ogg_path)

        # Drums only — for onset detection
        y_drums, _ = librosa.load(str(stems["drums"]), sr=SAMPLE_RATE, mono=True)

    duration = float(len(y_drums) / SAMPLE_RATE)
    fps = SAMPLE_RATE / HOP_SIZE

    # Low band (20-500Hz → kicks) and high band (500-16kHz → snares/hats)
    low_flux = _drums_flux(y_drums, SAMPLE_RATE, 20, 500)
    high_flux = _drums_flux(y_drums, SAMPLE_RATE, 500, 16000)
    low_norm = _normalize_curve(low_flux)
    high_norm = _normalize_curve(high_flux)

    onset_low_peaks = pick_peaks(low_norm, fps,
                                 min_gap_ms=100, threshold_mult=2.0, absolute_floor=0.18)
    onset_high_peaks = pick_peaks(high_norm, fps,
                                  min_gap_ms=60, threshold_mult=2.0, absolute_floor=0.12)

    analysis = {
        "version": 4,
        "duration": round(duration, 3),
        **essentia_out,                  # bpm, bpmConfidence, beats, key, mode, keyStrength
        "onsetLowPeaks": onset_low_peaks,
        "onsetHighPeaks": onset_high_peaks,
    }

    analysis_path.write_text(json.dumps(analysis, separators=(",", ":")))
    return analysis
