# Gravestone: the onset-detection paradigm

*Interred 2026-07-20. Cause of death: continuous stem energy looked better on
every light, with a tenth of the pipeline.*

This documents what the onset/analysis pipeline was, why it existed, and what
replaced it — enough detail to resurrect any piece if it's ever missed.
Removed in the musicbox-v2 transition; see the v2 design doc for the living
architecture.

## The paradigm

v1's bet: detect discrete musical events (kick drums, snare hits) offline,
then fire light *pulses* when the playhead crosses an event timestamp.
It worked, but:

- Discrete triggers fight latency — a pulse that lands 150ms late reads as
  wrong; a continuous level that's 150ms late reads as fine.
- Onsets misfire or vanish on non-percussive music.
- The pipeline was heavy: ~3-5 min/track across three ML stacks and two
  incompatible venvs, all to produce timestamp arrays.
- Nothing beat "demucs stem RMS → brightness" visually.

## The deceased

### `scraper/madmom_onsets.py` — madmom onset detection
Per-source onset timestamp arrays written to `{track}/madmom_onsets.json`.
Sources: band-filtered drum stems (`drums_low`, `drums_mid`, `drums_high`,
each with a `_strict` variant), `bass`, `non_drums`, `full` — each run
through two detectors: madmom's `CNNOnsetProcessor` and
`SuperFluxProcessor`. The `--fast` flag computed only
`drums_low_strict.superflux` (autopilot's default trigger source).
madmom was installed from git (`pip install Cython
git+https://github.com/CPJKU/madmom.git`) and never in requirements.txt.
**madmom is no longer needed in the venv.**

### `scraper/analyzer.py` (the analysis half) — essentia + librosa
`analyze_track()` wrote `{track}/analysis.json` (~30KB): BPM + beat grid +
key/mode via essentia (`RhythmExtractor2013`, `KeyExtractor`, run in the
`.venv-essentia` sidecar because essentia needs numpy<2), plus low/high-band
spectral-flux onset peaks picked from the drums stem via librosa STFT +
median/MAD adaptive thresholding (`pick_peaks`). The demucs half of the file
(stem separation) lives on — it's the whole pipeline now.
**The `.venv-essentia` sidecar venv is orphaned and can be deleted from disk.**

### `scraper/structure.py` — Allin1 structural segmentation
An experiment that never shipped: song sections (intro/verse/chorus…),
beats/downbeats via the `allin1` package (torch + NATTEN, CPU-only,
~150-200s/track). Wrote `{track}/structure.json`. At burial, zero
structure.json files existed in the library and nothing read them.

### Autopilot's pulse-firing half
The original autopilot fired REST pulses (`/api/hue-stream/rest-pulse`) when
the interpolated playhead crossed `madmom_onsets.json` peaks — cursor
re-seating on every Spotify poll, 150ms re-fire guard, EMA'd bridge RTT.
Died twice over: onsets (this gravestone) and REST-for-audioreactivity
(banned; see memory). The playhead/ingest half of autopilot lives on as the
brain feeding stem-sync.

### v1 UI onset surfaces
`OnsetTimeline` (scrolling madmom onset rows + beat grid), the peak-source
dropdown in `LightPulseBindings` (18 peak sources), SpectrumPulse's
kick/hat glow triggers from `drums_low`/`drums_high` CNN peaks. v1 keeps
rendering whatever `madmom_onsets.json` / `analysis.json` files already
exist on disk; they just stop being produced.

### CLI surface removed from `scraper`
`analyze`, `madmom`, `prioritize`, `unprioritize` subcommands and the
priority-jump file (`/tmp/scraper-priority-ids`). `ingest` lost its
`--fast`/`--stems-only` flags — stems-only is now the only pipeline.

## What was NOT madmom (common confusions)

- **Chroma**: musicbox's per-stem "chroma" was a client-side spectral
  centroid (ZCR-flavored proxy for pitch height) computed in the browser
  from Web Audio — no server pipeline, no madmom. It dies with v1's local
  playback but is trivially recreatable in v2's client-side stem DSP.
- **The 12-band envelope** driving twinklybox's eq12/megadrome mode: FFT of
  the stem sum, computed by musicbox's envelope service. Alive and well.

## Data left on disk

`madmom_onsets.json`, `analysis.json` files remain in
`~/music-library/tracks/*/` (a few KB each, harmless, v1 still reads them).
Delete freely if reclaiming space; nothing in the living system needs them.
