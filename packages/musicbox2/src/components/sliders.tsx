import { useRef } from 'react';

// Two small pointer-driven controls: a dual-notch range slider (brightness
// floor/ceiling on one track) and a hue-arc bar (S/E handles on a hue
// gradient with a wrap-aware highlighted arc).

function useTrackDrag(onValue: (frac: number) => void) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const fracFromEvent = (e: PointerEvent | React.PointerEvent): number => {
    const el = trackRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    onValue(fracFromEvent(e));
    const move = (ev: PointerEvent) => onValue(fracFromEvent(ev));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return { trackRef, onPointerDown };
}

// One track, two notches; dragging grabs the nearest notch.
export function DualSlider({ lo, hi, onChange }: {
  lo: number; hi: number; // 0..1
  onChange: (lo: number, hi: number) => void;
}) {
  const grabbed = useRef<'lo' | 'hi' | null>(null);
  const { trackRef, onPointerDown } = useTrackDrag((f) => {
    if (grabbed.current === null) {
      grabbed.current = Math.abs(f - lo) <= Math.abs(f - hi) ? 'lo' : 'hi';
    }
    if (grabbed.current === 'lo') onChange(Math.min(f, hi), hi);
    else onChange(lo, Math.max(f, lo));
  });
  return (
    <div
      ref={trackRef}
      onPointerDown={(e) => { grabbed.current = null; onPointerDown(e); }}
      className="relative h-4 flex-1 cursor-pointer select-none touch-none"
    >
      <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 rounded bg-zinc-800" />
      <div
        className="absolute top-1/2 -translate-y-1/2 h-1 rounded bg-cyan-400/60"
        style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%` }}
      />
      {([['lo', lo], ['hi', hi]] as const).map(([k, v]) => (
        <div
          key={k}
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2.5 h-2.5 rounded-full bg-zinc-200 border border-zinc-500"
          style={{ left: `${v * 100}%` }}
        />
      ))}
    </div>
  );
}

const HUE_GRADIENT = `linear-gradient(to right, ${
  Array.from({ length: 13 }, (_, i) => `hsl(${i * 30},100%,50%) ${(i / 12) * 100}%`).join(', ')
})`;

// Hue arc: S and E handles on a 0-360 gradient. The highlighted arc runs
// from S to E in the chosen direction, wrapping through 360. `dir` toggles
// increment vs decrement traversal.
export function HueBar({ start, end, dir, onChange }: {
  start: number; end: number; dir: 'up' | 'down';
  onChange: (patch: { hueStart?: number; hueEnd?: number; hueDir?: 'up' | 'down' }) => void;
}) {
  const grabbed = useRef<'S' | 'E' | null>(null);
  const { trackRef, onPointerDown } = useTrackDrag((f) => {
    const hue = f * 360;
    if (grabbed.current === null) {
      // Nearest handle by circular distance.
      const d = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
      grabbed.current = d(hue, start) <= d(hue, end) ? 'S' : 'E';
    }
    onChange(grabbed.current === 'S' ? { hueStart: hue } : { hueEnd: hue });
  });

  // Arc segments (percent of track) from S toward E in `dir`, wrap-aware.
  const arc: Array<[number, number]> = (() => {
    const a = start / 360, b = end / 360;
    if (dir === 'up') {
      return a <= b ? [[a, b]] : [[a, 1], [0, b]];
    }
    return a >= b ? [[b, a]] : [[0, a], [b, 1]];
  })();

  return (
    <div className="flex items-center gap-2 min-w-0">
      <div
        ref={trackRef}
        onPointerDown={(e) => { grabbed.current = null; onPointerDown(e); }}
        className="relative h-5 flex-1 cursor-pointer select-none touch-none rounded overflow-hidden"
      >
        <div className="absolute inset-0 opacity-30" style={{ background: HUE_GRADIENT }} />
        {arc.map(([a, b], i) => (
          <div
            key={i}
            className="absolute inset-y-0 opacity-90"
            style={{ left: `${a * 100}%`, width: `${(b - a) * 100}%`, background: HUE_GRADIENT, backgroundSize: `${100 / Math.max(0.001, b - a)}% 100%`, backgroundPosition: `${(a / Math.max(0.001, 1 - (b - a))) * 100}% 0` }}
          />
        ))}
        {([['S', start], ['E', end]] as const).map(([label, v]) => (
          <div
            key={label}
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 rounded-full bg-zinc-950 border border-zinc-300 flex items-center justify-center text-[8px] font-mono font-bold text-zinc-200 pointer-events-none"
            style={{ left: `${(v / 360) * 100}%` }}
          >{label}</div>
        ))}
      </div>
      <label
        className="flex items-center gap-1 text-[9px] font-mono text-zinc-500 cursor-pointer select-none shrink-0"
        title="traversal direction: unchecked = S→E incrementing hue, checked = decrementing (wraps either way)"
      >
        <input
          type="checkbox"
          checked={dir === 'down'}
          onChange={(e) => onChange({ hueDir: e.target.checked ? 'down' : 'up' })}
          className="accent-cyan-400"
        />
        −dir
      </label>
    </div>
  );
}
