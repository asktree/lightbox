import { useCallback, useEffect, useRef, useState } from 'react';

// Curtains tab: pick the igled boxes' native routine and tune its
// parameters. Talks to /api/curtains on the lightbox server, which
// persists the soap/twinkle settings and forwards to the boxes.

type Kind = 'off' | 'solid' | 'twinkle' | 'soap';

interface Routine {
  kind: Kind;
  hue: number; sat: number; val: number;
  density: number; periodMs: number; hueJitter: number; cut: boolean;
  speed: number; smoothness: number; palette: string;
  useRgb: boolean; rgb: { r: number; g: number; b: number };
}

interface CurtainsInfo {
  hosts: string[];
  boxes: Record<string, { online: boolean; routine?: Routine }>;
  palettes: string[];
  paletteStops: Record<string, string[]>;
  mode: 'color' | 'normal';
  soap: { speed: number; smoothness: number; palette: string; black: number; bri: number };
  twinkle: { kelvin: number; val: number; periodMs: number; cut: boolean };
}

// FastLED's CRGBPalette16 blends linearly between 16 stops and wraps, so
// a gradient through the stops (plus the first again) is a true preview.
// The black slider is previewed by sampling the blend at 64 points and
// applying the firmware's black curve to each sample.
function paletteCss(stops: string[] | undefined, black = 0): string {
  if (!stops || stops.length === 0) return '#444';
  const rgb = stops.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
  const n = 64, T = Math.min(240, black), cols: string[] = [];
  for (let k = 0; k <= n; k++) {
    const pos = (k / n) * rgb.length;
    const i = Math.floor(pos) % rgb.length, j = (i + 1) % rgb.length, f = pos - Math.floor(pos);
    let c = rgb[i].map((a, ch) => a + (rgb[j][ch] - a) * f);
    const m = Math.max(...c);
    if (T && m > 0) {
      // same curve as the firmware: peak' = 255 * (peak/255)^(1 + black/32)
      const np = 255 * Math.pow(m / 255, 1 + T / 32);
      c = c.map((a) => (a * np) / m);
    }
    cols.push(`rgb(${c.map(Math.round).join(',')})`);
  }
  return `linear-gradient(90deg, ${cols.join(', ')})`;
}

async function api(path: string, body?: unknown) {
  const res = await fetch(`/api/curtains${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

const KINDS: { kind: Kind; label: string }[] = [
  { kind: 'soap', label: 'Soap' },
  { kind: 'twinkle', label: 'Twinkle' },
  { kind: 'solid', label: 'Solid' },
  { kind: 'off', label: 'Off' },
];

function Slider(props: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void }) {
  const { label, value, min, max, step = 1, unit = '', onChange } = props;
  return (
    <label className="flex items-center gap-3 text-sm">
      <span className="w-28 text-zinc-400">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} className="flex-1" />
      <span className="w-16 text-right tabular-nums text-zinc-300">{value}{unit}</span>
    </label>
  );
}

export function Curtains() {
  const [info, setInfo] = useState<CurtainsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<'all' | string>('all');
  const [kind, setKind] = useState<Kind>('soap');
  // Local copies of the parameters so sliders feel instant.
  const [soap, setSoap] = useState({ speed: 32, smoothness: 200, palette: 'default', black: 0, bri: 255 });
  const [twinkle, setTwinkle] = useState({ kelvin: 2900, val: 200, periodMs: 6000, density: 13, cut: true });
  const [solid, setSolid] = useState({ hue: 30, sat: 255, val: 200 });

  const refresh = useCallback(async () => {
    try {
      const i: CurtainsInfo = await api('');
      setInfo(i);
      setError(null);
      const live = Object.values(i.boxes).find((b) => b.online && b.routine)?.routine;
      if (live) {
        setKind(live.kind);
        setSolid({ hue: live.hue, sat: live.sat, val: live.val });
        setTwinkle((t) => ({ ...t, density: live.density }));
      }
      setSoap(i.soap);
      setTwinkle((t) => ({ ...t, kelvin: i.twinkle.kelvin, val: i.twinkle.val, periodMs: i.twinkle.periodMs, cut: i.twinkle.cut }));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Coalesce slider drags into ~8 POSTs/s; the latest body wins.
  const pending = useRef<Record<string, unknown> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const send = useCallback((body: Record<string, unknown>) => {
    pending.current = { ...(pending.current ?? {}), ...body };
    if (timer.current) return;
    timer.current = setTimeout(async () => {
      const b = pending.current; pending.current = null; timer.current = null;
      if (!b) return;
      try {
        await api('/routine', { ...b, hosts: target === 'all' ? undefined : [target] });
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      }
    }, 120);
  }, [target]);

  const hostsBody = target === 'all' ? {} : { hosts: [target] };

  async function switchKind(k: Kind) {
    setKind(k);
    const body: Record<string, unknown> = { kind: k, ...hostsBody };
    if (k === 'solid') Object.assign(body, solid);
    try { await api('/routine', body); setError(null); } catch (e) { setError((e as Error).message); }
    void refresh();
  }

  const shortName = (h: string) => h.replace('.local', '');

  return (
    <div className="max-w-2xl mx-auto flex flex-col gap-6 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Curtains</h2>
        <button onClick={() => void refresh()} className="px-3 py-1 text-sm rounded-md bg-zinc-800 text-zinc-400 hover:text-white">Refresh</button>
      </div>

      {error && <div className="text-sm text-red-400 bg-red-950/40 rounded-md px-3 py-2">{error}</div>}

      {/* Boxes + target */}
      <div className="flex flex-wrap gap-2 items-center">
        <span className="text-sm text-zinc-400 mr-1">Apply to</span>
        <button onClick={() => setTarget('all')} className={`px-3 py-1 text-sm rounded-full ${target === 'all' ? 'bg-purple-600 text-white' : 'bg-zinc-800 text-zinc-400'}`}>both</button>
        {(info?.hosts ?? []).map((h) => {
          const box = info?.boxes[h];
          return (
            <button key={h} onClick={() => setTarget(h)} className={`px-3 py-1 text-sm rounded-full flex items-center gap-2 ${target === h ? 'bg-purple-600 text-white' : 'bg-zinc-800 text-zinc-400'}`}>
              <span className={`w-2 h-2 rounded-full ${box?.online ? 'bg-green-500' : 'bg-red-500'}`} />
              {shortName(h)}
              {box?.routine && <span className="text-xs opacity-70">{box.routine.kind}</span>}
            </button>
          );
        })}
        {info && <span className="text-xs text-zinc-500 ml-auto">mode: {info.mode}</span>}
      </div>

      {/* Routine picker */}
      <div className="flex bg-zinc-800 rounded-lg p-1 self-start">
        {KINDS.map((k) => (
          <button key={k.kind} onClick={() => void switchKind(k.kind)} className={`px-4 py-1.5 text-sm rounded-md transition-all ${kind === k.kind ? 'bg-zinc-600 text-white' : 'text-zinc-400'}`}>
            {k.label}
          </button>
        ))}
      </div>

      {kind === 'soap' && (
        <div className="flex flex-col gap-4 bg-zinc-900 rounded-xl p-4">
          <div className="text-sm text-zinc-400">Palette</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {(info?.palettes ?? []).map((p) => (
              <button
                key={p}
                onClick={() => { setSoap((s) => ({ ...s, palette: p })); send({ palette: p }); }}
                className={`rounded-lg overflow-hidden border-2 ${soap.palette === p ? 'border-purple-500' : 'border-transparent'} bg-zinc-800`}
              >
                <div className="h-6" style={{ background: paletteCss(info?.paletteStops[p], soap.black) }} />
                <div className="text-xs py-1 text-zinc-300">{p}</div>
              </button>
            ))}
          </div>
          <Slider label="Speed" value={soap.speed} min={0} max={255} onChange={(v) => { setSoap((s) => ({ ...s, speed: v })); send({ speed: v }); }} />
          <Slider label="Smoothness" value={soap.smoothness} min={0} max={255} onChange={(v) => { setSoap((s) => ({ ...s, smoothness: v })); send({ smoothness: v }); }} />
          <Slider label="Black" value={soap.black} min={0} max={240} onChange={(v) => { setSoap((s) => ({ ...s, black: v })); send({ black: v }); }} />
          <Slider label="Brightness" value={soap.bri} min={0} max={255} onChange={(v) => { setSoap((s) => ({ ...s, bri: v })); send({ bri: v }); }} />
        </div>
      )}

      {kind === 'twinkle' && (
        <div className="flex flex-col gap-4 bg-zinc-900 rounded-xl p-4">
          <Slider label="Color" value={twinkle.kelvin} min={1000} max={6500} step={50} unit="K" onChange={(v) => { setTwinkle((t) => ({ ...t, kelvin: v })); send({ kelvin: v }); }} />
          <Slider label="Brightness" value={twinkle.val} min={0} max={255} onChange={(v) => { setTwinkle((t) => ({ ...t, val: v })); send({ val: v }); }} />
          <Slider label="Fade period" value={twinkle.periodMs} min={500} max={20000} step={100} unit="ms" onChange={(v) => { setTwinkle((t) => ({ ...t, periodMs: v })); send({ periodMs: v }); }} />
          <Slider label="Density" value={twinkle.density} min={0} max={80} onChange={(v) => { setTwinkle((t) => ({ ...t, density: v })); send({ density: v }); }} />
          <label className="flex items-center gap-3 text-sm">
            <span className="w-28 text-zinc-400">Cut tails</span>
            <input type="checkbox" checked={twinkle.cut} onChange={(e) => { setTwinkle((t) => ({ ...t, cut: e.target.checked })); send({ cut: e.target.checked }); }} />
          </label>
        </div>
      )}

      {kind === 'solid' && (
        <div className="flex flex-col gap-4 bg-zinc-900 rounded-xl p-4">
          <div className="h-6 rounded-md" style={{ background: `hsl(${Math.round(solid.hue / 255 * 360)}, ${Math.round(solid.sat / 2.55)}%, ${Math.round(25 + solid.val / 255 * 30)}%)` }} />
          <Slider label="Hue" value={solid.hue} min={0} max={255} onChange={(v) => { setSolid((s) => ({ ...s, hue: v })); send({ hue: v }); }} />
          <Slider label="Saturation" value={solid.sat} min={0} max={255} onChange={(v) => { setSolid((s) => ({ ...s, sat: v })); send({ sat: v }); }} />
          <Slider label="Brightness" value={solid.val} min={0} max={255} onChange={(v) => { setSolid((s) => ({ ...s, val: v })); send({ val: v }); }} />
        </div>
      )}

      <p className="text-xs text-zinc-500">
        Soap and twinkle settings persist. The ambience toggle on the panel replays them (soap in color mode, twinkle in normal mode).
        A running twinklybox stream is stopped when you switch routine.
      </p>
    </div>
  );
}
