# Bassbed

Bassbed sends the bass of the system audio to bass shakers on the bed.

Audio path: BlackHole in → low-pass → gain → limiter → per side (low cut,
delay, trim, polarity, per-frequency ceiling) → headphone jack out.

## One-time setup

1. Install BlackHole: `brew install blackhole-2ch`.
2. Open Audio MIDI Setup. Make a Multi-Output Device named `bass test`.
   Tick the speakers you listen on and `BlackHole 2ch`.
   Tick "Drift Correction" on BlackHole.
3. Set `bass test` as the system output.
4. Connect the shaker amp to the headphone jack.
5. Run `pnpm --filter @lightbox/bassbed setup`.

## Run it

Start it from a Terminal window on the Mac itself, not over ssh.
macOS blocks audio input to processes started over ssh (TCC).

```bash
pnpm bassbed
```

Then open http://127.0.0.1:8765. The page has the sliders, test tones,
and per-frequency calibration.

Settings and limits save to `bassbed_settings.json` (gitignored).

## Safety

If the headphone jack is removed, macOS moves the stream to the default
output. That output feeds BlackHole, so the audio loops and howls.
Bassbed watches CoreAudio. When the output device goes away, it
mutes at once and the page shows "OUTPUT DEVICE UNPLUGGED".
Plug the jack back in and restart Bassbed.

`shakereq.py` is the first, simpler version (fixed settings, no page).
