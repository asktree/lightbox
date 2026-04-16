"""Sidecar script that runs in .venv-essentia/ (numpy<2).

Takes an audio file path, outputs JSON with beat tracking + key info.
Called as a subprocess from the main analyzer (which lives in numpy>=2
because of torch/demucs incompatibility).

Usage:
  .venv-essentia/bin/python -m scraper.essentia_helper <audio_path>

Output (stdout, JSON):
  {"bpm": 120.0, "bpmConfidence": 0.85,
   "beats": [0.5, 1.0, ...],
   "key": "C", "mode": "major", "keyStrength": 0.72}
"""
import json
import sys
import essentia.standard as es


def main():
    if len(sys.argv) != 2:
        print(json.dumps({"error": "usage: essentia_helper.py <audio_path>"}))
        sys.exit(1)

    path = sys.argv[1]

    # essentia's MonoLoader returns float32 mono samples at the requested SR
    y = es.MonoLoader(filename=path, sampleRate=44100)()

    # Beat tracking (dynamic programming over onset strength, looks at whole song)
    bpm, beats, confidence, _, _ = es.RhythmExtractor2013(method="multifeature")(y)

    # Key / scale
    key, scale, key_strength = es.KeyExtractor()(y)

    out = {
        "bpm": round(float(bpm), 2),
        "bpmConfidence": round(float(confidence), 3),
        "beats": [round(float(t), 3) for t in beats],
        "key": key,
        "mode": scale,
        "keyStrength": round(float(key_strength), 3),
    }
    print(json.dumps(out))


if __name__ == "__main__":
    main()
