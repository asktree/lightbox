import { useEffect, useRef, useState, useMemo } from 'react';

// A scrolling timeline of onset peaks. The playhead is anchored near the
// left edge and time flows rightward — so you can see what's coming up and
// ~1s of already-played context for orientation.
//
// Lanes are organized by (source × detector), grouped visually:
//   broadband sources (drums / non_drums / full) × (cnn / superflux)
//   drums per-band (low / mid / high) × cnn only
//
// Beats are drawn as a faint vertical tick across every lane as musical
// reference lines.

export interface MadmomOnsets {
  drums?: { cnn?: number[]; superflux?: number[] };
  non_drums?: { cnn?: number[]; superflux?: number[] };
  full?: { cnn?: number[]; superflux?: number[] };
  drums_strict?: { cnn?: number[]; superflux?: number[] };
  non_drums_strict?: { cnn?: number[]; superflux?: number[] };
  drums_low?: { cnn?: number[]; superflux?: number[] };
  drums_mid?: { cnn?: number[]; superflux?: number[] };
  drums_high?: { cnn?: number[]; superflux?: number[] };
  drums_low_strict?: { cnn?: number[]; superflux?: number[] };
  drums_mid_strict?: { cnn?: number[]; superflux?: number[] };
  drums_high_strict?: { cnn?: number[]; superflux?: number[] };
  bass_strict?: { cnn?: number[]; superflux?: number[] };
}

interface Lane {
  key: string;
  label: string;
  detector: 'cnn' | 'superflux';
  color: string;
  peaks: number[];
}

const GROUPS: Array<{ label: string; lanes: Array<{ key: keyof MadmomOnsets; color: string }> }> = [
  { label: 'broadband', lanes: [
    { key: 'drums', color: '#10b981' },            // emerald
    { key: 'non_drums', color: '#3b82f6' },        // blue
    { key: 'full', color: '#a1a1aa' },             // zinc
  ]},
  { label: 'broadband / strict', lanes: [
    { key: 'drums_strict', color: '#059669' },     // deeper emerald
    { key: 'non_drums_strict', color: '#1d4ed8' }, // deeper blue
  ]},
  { label: 'drums / band', lanes: [
    { key: 'drums_low', color: '#f97316' },        // orange
    { key: 'drums_mid', color: '#eab308' },        // yellow
    { key: 'drums_high', color: '#22d3ee' },       // cyan
  ]},
  { label: 'drums / band / strict', lanes: [
    { key: 'drums_low_strict', color: '#c2410c' },  // deeper orange
    { key: 'drums_mid_strict', color: '#a16207' },  // deeper yellow
    { key: 'drums_high_strict', color: '#0e7490' }, // deeper cyan
  ]},
  { label: 'bass', lanes: [
    { key: 'bass_strict', color: '#a855f7' },  // purple — bass-stem strict onsets
  ]},
];

function buildLanes(data: MadmomOnsets): Lane[] {
  const lanes: Lane[] = [];
  for (const group of GROUPS) {
    for (const { key, color } of group.lanes) {
      const entry = data[key] as { cnn?: number[]; superflux?: number[] } | undefined;
      if (!entry) continue;
      if (entry.cnn) {
        lanes.push({ key: `${key}/cnn`, label: `${key} · cnn`, detector: 'cnn', color, peaks: entry.cnn });
      }
      if (entry.superflux) {
        lanes.push({ key: `${key}/sf`, label: `${key} · superflux`, detector: 'superflux', color, peaks: entry.superflux });
      }
    }
  }
  return lanes;
}

const WINDOW_SEC = 8;           // total visible span (past + future)
const PLAYHEAD_FRAC = 0.2;      // playhead sits 20% from left edge
const LANE_H = 18;
const LABEL_W = 120;
const FLASH_MS = 120;

export function OnsetTimeline({
  data, positionRef, beats,
}: {
  data: MadmomOnsets | null;
  positionRef: { current: number };
  beats?: number[];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lanesRef = useRef<Lane[]>([]);
  // Track lane count in React state so the canvas container grows vertically
  // to fit all lanes, making overflow-y-auto actually scroll.
  const lanes = useMemo(() => (data ? buildLanes(data) : []), [data]);
  const [canvasHeight, setCanvasHeight] = useState(0);
  useEffect(() => {
    lanesRef.current = lanes;
    setCanvasHeight(lanes.length * LANE_H);
  }, [lanes]);

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
      const lanes = lanesRef.current;
      const { width: W, height: H } = canvas.getBoundingClientRect();
      const plotX0 = LABEL_W;
      const plotW = W - plotX0;
      const playheadX = plotX0 + plotW * PLAYHEAD_FRAC;
      const pxPerSec = plotW / WINDOW_SEC;
      const tLeft = pos - PLAYHEAD_FRAC * WINDOW_SEC;
      const tRight = tLeft + WINDOW_SEC;

      ctx.clearRect(0, 0, W, H);

      // Beat grid — faint verticals behind lanes
      if (beats && beats.length) {
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const b of beats) {
          if (b < tLeft || b > tRight) continue;
          const x = plotX0 + (b - tLeft) * pxPerSec;
          ctx.moveTo(x, 0);
          ctx.lineTo(x, H);
        }
        ctx.stroke();
      }

      // Lane rows
      for (let i = 0; i < lanes.length; i++) {
        const lane = lanes[i];
        const yTop = i * LANE_H;
        const yMid = yTop + LANE_H / 2;

        // Row separator + label
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '10px ui-monospace, monospace';
        ctx.textBaseline = 'middle';
        ctx.fillText(lane.label, 6, yMid);

        // Lane baseline
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.beginPath();
        ctx.moveTo(plotX0, yMid);
        ctx.lineTo(W, yMid);
        ctx.stroke();

        // Ticks for peaks in the visible window
        ctx.strokeStyle = lane.color;
        ctx.lineWidth = lane.detector === 'superflux' ? 1 : 1.5;
        const tickH = lane.detector === 'superflux' ? 5 : 7;
        ctx.beginPath();
        // Linear scan is fine for a few thousand peaks
        for (const p of lane.peaks) {
          if (p < tLeft) continue;
          if (p > tRight) break;
          const x = plotX0 + (p - tLeft) * pxPerSec;
          ctx.moveTo(x, yMid - tickH);
          ctx.lineTo(x, yMid + tickH);
        }
        ctx.stroke();

        // Flash the whole row briefly when a peak just crossed the playhead —
        // opacity decays linearly over FLASH_MS
        const lastPeak = findLastPeakBefore(lane.peaks, pos);
        if (lastPeak >= 0) {
          const agePx = (pos - lastPeak) / (FLASH_MS / 1000);
          if (agePx < 1) {
            ctx.fillStyle = hexToRgba(lane.color, 0.2 * (1 - agePx));
            ctx.fillRect(plotX0, yTop, plotW, LANE_H);
          }
        }
      }

      // Playhead
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, lanes.length * LANE_H);
      ctx.stroke();

      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [positionRef, beats]);

  return (
    <div className="w-full h-full min-h-0 bg-zinc-950/80 overflow-y-auto">
      <canvas
        ref={canvasRef}
        className="w-full block"
        style={{ height: canvasHeight || '100%' }}
      />
    </div>
  );
}

function findLastPeakBefore(peaks: number[], t: number): number {
  let lo = 0, hi = peaks.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (peaks[mid] <= t) { ans = peaks[mid]; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

function hexToRgba(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
