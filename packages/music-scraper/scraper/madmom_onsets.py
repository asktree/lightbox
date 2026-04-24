"""Onset detection comparison: CNN vs Superflux × drums / non-drums / full mix,
plus per-band CNN on the drums stem (low / mid / high).

For one or more track-ids, runs onset detectors on several audio sources
and writes the peak arrays to {library}/tracks/{id}/madmom_onsets.json.

Sources (require Demucs stems on disk):
  - drums      = drums stem alone
  - non_drums  = bass + vocals + other, summed
  - full       = original audio.ogg (no Demucs)
  - drums_low  = drums stem, <200 Hz  (kick band)
  - drums_mid  = drums stem, 200-2000 Hz (snare/tom band)
  - drums_high = drums stem, >2000 Hz (hat/cymbal band)

Detectors:
  - cnn        = madmom.features.onsets.CNNOnsetProcessor  (all sources)
  - superflux  = madmom.features.onsets.SpectralOnsetProcessor(onset_method='superflux')
                 (broadband sources only — bandpassed audio is already narrow)

Peak-picker: threshold=0.5 (CNN) / 1.25 (superflux — different activation scale),
             combine=50ms (kills double-triggers).

Writes:

  { "<source>": { "<detector>": [t, t, ...], ... }, ... }
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import librosa
from scipy.signal import butter, sosfiltfilt

from madmom.audio.signal import Signal
from madmom.audio.filters import LogarithmicFilterbank
from madmom.features.onsets import (
    CNNOnsetProcessor,
    SpectralOnsetProcessor,
    OnsetPeakPickingProcessor,
)

from .config import load_config

SR = 44100
COMBINE_MS = 50
CNN_THRESHOLD = 0.5
SUPERFLUX_THRESHOLD = 1.25

# Stricter thresholds — used for `*_strict` variants. Drums get a moderate bump
# (cleaner picks of the actually-hit events). Non-drums get a *much* bigger
# bump since broadband CNN fires on nearly every bass note / pad entry / vocal
# attack, which is too dense to be a useful light-event stream.
CNN_THRESHOLD_DRUMS_STRICT = 0.7
SUPERFLUX_THRESHOLD_DRUMS_STRICT = 2.0
CNN_THRESHOLD_NONDRUMS_STRICT = 0.85
SUPERFLUX_THRESHOLD_NONDRUMS_STRICT = 3.0

SOURCES = {
    "drums": ["drums"],
    "non_drums": ["bass", "vocals", "other"],
    "full": None,  # audio.ogg direct
}

STRICT_VARIANTS = {
    # source → (cnn_threshold, superflux_threshold)
    "drums": (CNN_THRESHOLD_DRUMS_STRICT, SUPERFLUX_THRESHOLD_DRUMS_STRICT),
    "non_drums": (CNN_THRESHOLD_NONDRUMS_STRICT, SUPERFLUX_THRESHOLD_NONDRUMS_STRICT),
}

BANDS = {
    "drums_low": ("lowpass", 200.0),
    "drums_mid": ("bandpass", (200.0, 2000.0)),
    "drums_high": ("highpass", 2000.0),
}

# Strict variants for per-band detectors on the drums stem. Reuses the
# same CNN/superflux activations, only the peak-picker threshold changes —
# so strict drops the sparser / louder hits (useful when the baseline stream
# is too dense for visible light events).
BAND_STRICT_THRESHOLDS = {
    # band → (cnn_threshold, superflux_threshold)
    "drums_low": (0.75, 2.0),
    "drums_mid": (0.75, 2.0),
    "drums_high": (0.75, 2.0),
}


def load_stem_sum(stems_dir: Path, names: list[str]) -> np.ndarray:
    acc: np.ndarray | None = None
    for n in names:
        path = stems_dir / f"{n}.ogg"
        if not path.exists():
            raise SystemExit(f"missing stem: {path}")
        y, _ = librosa.load(str(path), sr=SR, mono=True)
        acc = y if acc is None else acc + y
    return acc.astype(np.float32)


def bandpass(y: np.ndarray, kind: str, cutoff) -> np.ndarray:
    nyq = SR / 2
    if kind == "lowpass":
        sos = butter(4, cutoff / nyq, btype="lowpass", output="sos")
    elif kind == "highpass":
        sos = butter(4, cutoff / nyq, btype="highpass", output="sos")
    elif kind == "bandpass":
        lo, hi = cutoff
        sos = butter(4, [lo / nyq, hi / nyq], btype="bandpass", output="sos")
    else:
        raise ValueError(kind)
    return sosfiltfilt(sos, y).astype(np.float32)


def _stats(peaks: np.ndarray) -> str:
    if len(peaks) < 2:
        return f"n={len(peaks):4d}"
    ioi = np.diff(peaks)
    short_pct = (ioi < 0.05).sum() / len(ioi) * 100
    return f"n={len(peaks):4d}  median IOI={np.median(ioi) * 1000:.0f}ms  <50ms: {short_pct:.0f}%"


def analyze_track(track_id: str, fast: bool = False) -> dict:
    """If fast=True, compute only drums_low_strict.superflux. Skips all
    broadband sources, all cnn variants, and all other bands. Typical
    speedup is ~5-10× since we avoid loading 3 separate stem sums,
    running CNN activations, and bandpassing 3 bands."""
    cfg = load_config()
    track_dir = cfg.tracks_dir / track_id
    stems_dir = track_dir / "stems"
    audio_path = track_dir / "audio.ogg"
    if not stems_dir.is_dir():
        raise SystemExit(f"no stems at {stems_dir}")
    if not audio_path.exists():
        raise SystemExit(f"no audio at {audio_path}")

    # CNN processor is heavyweight; skip constructing it in fast mode.
    cnn_proc = None if fast else CNNOnsetProcessor()
    superflux_proc = SpectralOnsetProcessor(onset_method="superflux", fps=200,
                                            filterbank=LogarithmicFilterbank,
                                            num_bands=24, log=np.log10)

    def make_cnn_picker(threshold: float) -> OnsetPeakPickingProcessor:
        return OnsetPeakPickingProcessor(
            fps=100, threshold=threshold, smooth=0.07, combine=COMBINE_MS / 1000,
        )

    def make_sf_picker(threshold: float) -> OnsetPeakPickingProcessor:
        return OnsetPeakPickingProcessor(
            fps=200, threshold=threshold, pre_max=0.03, post_max=0.03,
            pre_avg=0.1, post_avg=0.07, combine=COMBINE_MS / 1000,
        )

    cnn_peak = None if fast else make_cnn_picker(CNN_THRESHOLD)
    superflux_peak = make_sf_picker(SUPERFLUX_THRESHOLD)

    result: dict = {}

    if fast:
        # Fast path: compute only the two onset streams the UI defaults to.
        # drums_low_strict.superflux — kick-band onsets on the drums stem.
        drums_y = load_stem_sum(stems_dir, ["drums"])
        kind, cutoff = BANDS["drums_low"]
        y_band = bandpass(drums_y, kind, cutoff)
        sig = Signal(y_band, sample_rate=SR)
        sf_act = superflux_proc(sig)
        _, sf_thr = BAND_STRICT_THRESHOLDS["drums_low"]
        sf_peaks_s = make_sf_picker(sf_thr)(sf_act)
        result["drums_low_strict"] = {
            "superflux": [round(float(t), 3) for t in sf_peaks_s],
        }
        print(f"  drums_low_strict   superflux {_stats(sf_peaks_s)}  thr={sf_thr} [fast]", flush=True)

        # bass_strict.superflux — bass-stem onsets (different groove from kicks).
        # Same strict threshold as other _strict variants; adjust later if noisy.
        try:
            bass_y = load_stem_sum(stems_dir, ["bass"])
            sig_b = Signal(bass_y, sample_rate=SR)
            sf_act_b = superflux_proc(sig_b)
            bass_thr = 2.0
            sf_peaks_b = make_sf_picker(bass_thr)(sf_act_b)
            result["bass_strict"] = {
                "superflux": [round(float(t), 3) for t in sf_peaks_b],
            }
            print(f"  bass_strict        superflux {_stats(sf_peaks_b)}  thr={bass_thr} [fast]", flush=True)
        except SystemExit as e:
            # No bass stem (rare; Demucs always produces one but belt-and-suspenders).
            print(f"  bass_strict skipped: {e}", flush=True)

        out_path = track_dir / "madmom_onsets.json"
        out_path.write_text(json.dumps(result, indent=2))
        print(f"  → wrote {out_path}")
        return result

    for source_name, stem_names in SOURCES.items():
        if source_name == "full":
            y, _ = librosa.load(str(audio_path), sr=SR, mono=True)
        else:
            y = load_stem_sum(stems_dir, stem_names)
        sig = Signal(y, sample_rate=SR)

        cnn_act = cnn_proc(sig)
        sf_act = superflux_proc(sig)
        cnn_peaks = cnn_peak(cnn_act)
        sf_peaks = superflux_peak(sf_act)

        result[source_name] = {
            "cnn": [round(float(t), 3) for t in cnn_peaks],
            "superflux": [round(float(t), 3) for t in sf_peaks],
        }
        print(f"  {source_name:15s} cnn       {_stats(cnn_peaks)}", flush=True)
        print(f"  {source_name:15s} superflux {_stats(sf_peaks)}", flush=True)

        # Strict-threshold variant (reuses the same activations — only the
        # peak picker's threshold differs)
        if source_name in STRICT_VARIANTS:
            cnn_thr, sf_thr = STRICT_VARIANTS[source_name]
            cnn_peaks_s = make_cnn_picker(cnn_thr)(cnn_act)
            sf_peaks_s = make_sf_picker(sf_thr)(sf_act)
            strict_key = f"{source_name}_strict"
            result[strict_key] = {
                "cnn": [round(float(t), 3) for t in cnn_peaks_s],
                "superflux": [round(float(t), 3) for t in sf_peaks_s],
            }
            print(f"  {strict_key:15s} cnn       {_stats(cnn_peaks_s)}  thr={cnn_thr}", flush=True)
            print(f"  {strict_key:15s} superflux {_stats(sf_peaks_s)}  thr={sf_thr}", flush=True)

    # Per-band detectors on drums stem (low / mid / high)
    drums_y = load_stem_sum(stems_dir, ["drums"])
    for band_name, (kind, cutoff) in BANDS.items():
        y_band = bandpass(drums_y, kind, cutoff)
        sig = Signal(y_band, sample_rate=SR)
        cnn_act = cnn_proc(sig)
        sf_act = superflux_proc(sig)
        cnn_peaks = cnn_peak(cnn_act)
        sf_peaks = superflux_peak(sf_act)
        result[band_name] = {
            "cnn": [round(float(t), 3) for t in cnn_peaks],
            "superflux": [round(float(t), 3) for t in sf_peaks],
        }
        print(f"  {band_name:18s} cnn       {_stats(cnn_peaks)}", flush=True)
        print(f"  {band_name:18s} superflux {_stats(sf_peaks)}", flush=True)

        # Strict variant — reuses activations, just a higher picker threshold.
        if band_name in BAND_STRICT_THRESHOLDS:
            cnn_thr, sf_thr = BAND_STRICT_THRESHOLDS[band_name]
            cnn_peaks_s = make_cnn_picker(cnn_thr)(cnn_act)
            sf_peaks_s = make_sf_picker(sf_thr)(sf_act)
            strict_key = f"{band_name}_strict"
            result[strict_key] = {
                "cnn": [round(float(t), 3) for t in cnn_peaks_s],
                "superflux": [round(float(t), 3) for t in sf_peaks_s],
            }
            print(f"  {strict_key:18s} cnn       {_stats(cnn_peaks_s)}  thr={cnn_thr}", flush=True)
            print(f"  {strict_key:18s} superflux {_stats(sf_peaks_s)}  thr={sf_thr}", flush=True)

    out_path = track_dir / "madmom_onsets.json"
    out_path.write_text(json.dumps(result, indent=2))
    print(f"  → wrote {out_path}")
    return result


def main():
    if len(sys.argv) < 2:
        print("usage: python -m scraper.madmom_onsets <track-id> [<track-id> ...]")
        sys.exit(1)
    for tid in sys.argv[1:]:
        print(f"== {tid} ==")
        analyze_track(tid)


if __name__ == "__main__":
    main()
