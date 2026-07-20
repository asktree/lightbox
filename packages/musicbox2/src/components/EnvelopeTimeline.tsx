import { useEffect, useRef } from 'react';

// Per-stem precomputed envelopes as scrolling area charts. Mirrors
// OnsetTimeline: same 8s window, same 20%-from-left playhead, same
// LABEL_W gutter — so when stacked the two views are pixel-aligned and
// you can see future envelope values the same way you see future onsets.
//
// Generic over what the envelope MEANS — App.tsx renders one instance for
// per-stem RMS energy and another for per-stem zero-crossing-rate (a
// cheap proxy for spectral centroid / pitch height). The component just
// max-normalizes per stem so each row fills the available height.

type Stem = 'drums' | 'bass' | 'vocals' | 'other';

interface Envelope { samples: Float32Array; sr: number; max: number }

const WINDOW_SEC = 8;
const PLAYHEAD_FRAC = 0.2;
const LABEL_W = 120;
const ROW_H = 32; // 4 rows × 32 = 128px per chart

const STEM_COLOR: Record<Stem, string> = {
  drums: '#10b981',  // emerald — matches OnsetTimeline drums lane
  bass:  '#a855f7',  // purple  — matches bass_strict lane
  vocals: '#f59e0b', // amber
  other:  '#94a3b8', // slate
};

const STEMS: Stem[] = ['drums', 'bass', 'vocals', 'other'];

export function EnvelopeTimeline({
  envelopesRef, positionRef, version,
}: {
  envelopesRef: { current: Partial<Record<Stem, Envelope>> };
  positionRef: { current: number };
  // Bumped by the parent when envelopes change so this effect can rebind
  // even though `envelopesRef` itself is a stable ref object.
  version: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    const dpr = window.devicePixelRatio || 1;

    const resize = () => {
      const { width, height } = canvas.getBoundingClientRect();
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const render = () => {
      const pos = positionRef.current;
      const { width: W, height: H } = canvas.getBoundingClientRect();
      const plotX0 = LABEL_W;
      const plotW = W - plotX0;
      const playheadX = plotX0 + plotW * PLAYHEAD_FRAC;
      const tLeft = pos - PLAYHEAD_FRAC * WINDOW_SEC;
      const secPerPx = WINDOW_SEC / plotW;

      ctx.clearRect(0, 0, W, H);

      for (let i = 0; i < STEMS.length; i++) {
        const stem = STEMS[i];
        const yTop = i * ROW_H;
        const yBot = yTop + ROW_H;
        const color = STEM_COLOR[stem];

        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '10px ui-monospace, monospace';
        ctx.textBaseline = 'middle';
        ctx.fillText(stem, 6, yTop + ROW_H / 2);

        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(plotX0, yBot - 0.5);
        ctx.lineTo(W, yBot - 0.5);
        ctx.stroke();

        const env = envelopesRef.current[stem];
        if (!env || env.samples.length === 0) continue;

        // Per-stem normalization by the track's own max RMS so each row's
        // dynamics fill the available height regardless of mix levels.
        // Floor at a small value so a silent stem doesn't divide-by-zero.
        const denom = Math.max(env.max, 1e-6);
        const innerH = ROW_H - 1;

        // Walk pixel-by-pixel across the plot area. For each pixel column,
        // look up the closest envelope sample (or peak across the pixel's
        // sub-second span if zoomed-out) and draw a vertical bar from the
        // baseline up to the energy height. Filled polygon for area look.
        ctx.fillStyle = hexToRgba(color, 0.35);
        ctx.beginPath();
        let started = false;
        const samplesPerPx = secPerPx * env.sr;
        for (let px = 0; px <= plotW; px++) {
          const t = tLeft + px * secPerPx;
          if (t < 0) {
            // Before track start — keep baseline.
            if (started) ctx.lineTo(plotX0 + px, yBot);
            continue;
          }
          // Peak-pick across the pixel's worth of samples so high-rate
          // detail isn't aliased away when the window is wide.
          const i0 = Math.floor(t * env.sr);
          const i1 = Math.min(env.samples.length, Math.ceil(i0 + Math.max(1, samplesPerPx)));
          if (i0 >= env.samples.length) {
            if (started) ctx.lineTo(plotX0 + px, yBot);
            continue;
          }
          let m = 0;
          for (let k = i0; k < i1; k++) {
            const v = env.samples[k];
            if (v > m) m = v;
          }
          const e = Math.min(1, m / denom);
          const x = plotX0 + px;
          const y = yBot - e * innerH;
          if (!started) {
            ctx.moveTo(x, yBot);
            ctx.lineTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
        if (started) {
          ctx.lineTo(plotX0 + plotW, yBot);
          ctx.closePath();
          ctx.fill();
        }

        // Top outline for crispness. Skip future portion of the line to
        // make "incoming" energy read as slightly lighter than past.
        const playheadT = pos;
        for (const phase of ['past', 'future'] as const) {
          ctx.strokeStyle = phase === 'past' ? color : hexToRgba(color, 0.6);
          ctx.lineWidth = 1;
          ctx.beginPath();
          let drawing = false;
          for (let px = 0; px <= plotW; px++) {
            const t = tLeft + px * secPerPx;
            if (phase === 'past' && t > playheadT) break;
            if (phase === 'future' && t < playheadT) continue;
            if (t < 0) continue;
            const i0 = Math.floor(t * env.sr);
            const i1 = Math.min(env.samples.length, Math.ceil(i0 + Math.max(1, samplesPerPx)));
            if (i0 >= env.samples.length) break;
            let m = 0;
            for (let k = i0; k < i1; k++) {
              const v = env.samples[k];
              if (v > m) m = v;
            }
            const e = Math.min(1, m / denom);
            const x = plotX0 + px;
            const y = yBot - e * innerH;
            if (!drawing) { ctx.moveTo(x, y); drawing = true; }
            else ctx.lineTo(x, y);
          }
          if (drawing) ctx.stroke();
        }
      }

      // Playhead
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, H);
      ctx.stroke();

      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [envelopesRef, positionRef, version]);

  return (
    <div className="w-full bg-zinc-950/80" style={{ height: STEMS.length * ROW_H }}>
      <canvas ref={canvasRef} className="w-full h-full block" />
    </div>
  );
}

function hexToRgba(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
