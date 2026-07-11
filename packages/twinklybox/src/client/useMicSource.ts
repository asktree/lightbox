// Browser Web Audio mic source. When enabled, grabs the machine's
// microphone, runs an FFT, folds the spectrum into 12 log-spaced bands
// (low → high), and POSTs raw band frames to the server at ~30 Hz. The
// server keeps a 30s rolling window and normalizes against it (see
// mic-source.ts); megadrome in eq12 mode consumes the result.
//
// All the heavy lifting (normalization, smoothing) is server-side — the
// client just produces a consistent per-band loudness vector.

import { useEffect } from 'react';

const NUM_BANDS = 12;
const F_LO = 40;      // Hz — bottom of the lowest band
const F_HI = 16000;   // Hz — top of the highest band
const POST_INTERVAL_MS = 33; // ~30 Hz upload rate

export function useMicSource(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;

    const tellServer = (active: boolean) =>
      fetch('/api/source/mic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      }).catch(() => {});

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          // Disable processing that would fight a music signal.
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }

        ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.5;
        src.connect(analyser);

        const bins = new Uint8Array(analyser.frequencyBinCount);
        const binHz = ctx.sampleRate / analyser.fftSize;
        // Log-spaced band edges in Hz → frequencyBin index ranges.
        const edges: number[] = [];
        for (let i = 0; i <= NUM_BANDS; i++) edges.push(F_LO * Math.pow(F_HI / F_LO, i / NUM_BANDS));

        await tellServer(true);

        let lastPost = 0;
        const loop = () => {
          if (cancelled) return;
          analyser.getByteFrequencyData(bins);
          const bands = new Array(NUM_BANDS).fill(0);
          for (let b = 0; b < NUM_BANDS; b++) {
            const i0 = Math.max(1, Math.floor(edges[b] / binHz));
            const i1 = Math.min(bins.length - 1, Math.ceil(edges[b + 1] / binHz));
            let sum = 0, cnt = 0;
            for (let i = i0; i <= i1; i++) { sum += bins[i]; cnt++; }
            bands[b] = cnt > 0 ? (sum / cnt) / 255 : 0;
          }
          const now = performance.now();
          if (now - lastPost >= POST_INTERVAL_MS) {
            lastPost = now;
            fetch('/api/source/mic/frame', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ bands }),
            }).catch(() => {});
          }
          raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
      } catch (e) {
        console.error('[mic] init failed:', e);
      }
    })();

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      ctx?.close().catch(() => {});
      tellServer(false);
    };
  }, [enabled]);
}
