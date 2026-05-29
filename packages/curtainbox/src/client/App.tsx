import { useEffect, useState } from 'react';

// Curtainbox test harness UI. Walks the H70B6 protocol experiment:
//   1. Scan → find + select the device
//   2. Basic LAN sanity check (whole-device color) — confirms reachability
//   3. Activate razer stream mode
//   4. Ramp segment count, send test patterns, observe where it breaks

type HeaderMode = 'dreams' | 'chroma' | 'govee';
type Pattern = 'rainbow' | 'ruler' | 'solid';

interface Device { ip: string; device: string; sku: string }
interface State {
  selectedIp: string | null;
  deviceCount: number;
  animating: boolean;
  anim: { segments: number; hz: number; mode: HeaderMode; stretch: boolean; pattern: Pattern };
  maxSingleByteSegments: number;
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method: body !== undefined ? 'POST' : 'GET',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

const SEGMENT_PRESETS = [20, 50, 100, 200, 250];

export default function App() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedIp, setSelectedIp] = useState<string | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [scanning, setScanning] = useState(false);
  const [lastResult, setLastResult] = useState<string>('');

  const [segments, setSegments] = useState(50);
  const [mode, setMode] = useState<HeaderMode>('dreams');
  const [pattern, setPattern] = useState<Pattern>('ruler');
  const [stretch, setStretch] = useState(false);
  const [animHz, setAnimHz] = useState(10);

  useEffect(() => {
    api<{ devices: Device[]; selectedIp: string | null }>('/devices')
      .then((r) => { setDevices(r.devices); setSelectedIp(r.selectedIp); })
      .catch(() => {});
    const t = setInterval(() => { api<State>('/state').then(setState).catch(() => {}); }, 1000);
    return () => clearInterval(t);
  }, []);

  const scan = async () => {
    setScanning(true);
    try {
      const r = await api<{ devices: Device[]; selectedIp: string | null }>('/scan', {});
      setDevices(r.devices); setSelectedIp(r.selectedIp);
      setLastResult(`found ${r.devices.length} device(s)`);
    } catch (e) { setLastResult(`scan failed: ${e}`); }
    setScanning(false);
  };

  const select = (ip: string) => { api('/select', { ip }).then(() => setSelectedIp(ip)).catch(() => {}); };
  const basic = (body: unknown) => api('/basic', body).then(() => {}).catch(() => {});
  const sendFrame = async () => {
    const r = await api<{ sentSegments: number; clamped: boolean; note?: string }>('/frame', { segments, pattern, mode, stretch });
    setLastResult(`sent ${r.sentSegments} segments${r.clamped ? ` (clamped — ${r.note})` : ''}`);
  };
  const animate = (on: boolean) =>
    api('/animate', { on, segments, hz: animHz, mode, stretch, pattern: pattern === 'ruler' ? 'rainbow' : pattern })
      .then(() => {}).catch(() => {});

  return (
    <div className="min-h-screen p-6 max-w-2xl mx-auto space-y-5">
      <header className="border-b border-zinc-800 pb-3">
        <h1 className="text-lg font-mono">curtainbox · H70B6 protocol test</h1>
        <p className="text-[11px] text-zinc-500 font-mono mt-1">
          razer/DreamView per-segment streaming. Enable <span className="text-zinc-300">LAN Control</span> for
          the curtain in the Govee app first.
        </p>
      </header>

      {/* 1 — Scan + select */}
      <section className="bg-zinc-900 rounded p-3 space-y-2">
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono text-zinc-400 w-20">1 · device</span>
          <button onClick={scan} disabled={scanning}
            className="px-3 py-1.5 rounded text-xs font-mono bg-blue-600 hover:bg-blue-500 disabled:opacity-40">
            {scanning ? 'scanning…' : 'scan LAN'}
          </button>
          <span className="text-[11px] text-zinc-500 font-mono">{devices.length} found</span>
        </div>
        {devices.length > 0 && (
          <div className="space-y-1">
            {devices.map((d) => (
              <button key={d.device} onClick={() => select(d.ip)}
                className={`w-full text-left px-2 py-1 rounded text-[11px] font-mono ${selectedIp === d.ip ? 'bg-emerald-700' : 'bg-zinc-800 hover:bg-zinc-700'}`}>
                {d.sku} · {d.ip} · {d.device}
              </button>
            ))}
          </div>
        )}
      </section>

      {/* 2 — Basic LAN sanity check */}
      <section className="bg-zinc-900 rounded p-3 space-y-2">
        <div className="text-xs font-mono text-zinc-400">2 · basic LAN check (whole-device)</div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => basic({ on: true })} className="px-2 py-1 rounded text-[11px] font-mono bg-zinc-800 hover:bg-zinc-700">on</button>
          <button onClick={() => basic({ on: false })} className="px-2 py-1 rounded text-[11px] font-mono bg-zinc-800 hover:bg-zinc-700">off</button>
          <button onClick={() => basic({ brightness: 100 })} className="px-2 py-1 rounded text-[11px] font-mono bg-zinc-800 hover:bg-zinc-700">100%</button>
          <button onClick={() => basic({ color: { r: 255, g: 0, b: 0 } })} className="px-2 py-1 rounded text-[11px] font-mono bg-red-700 hover:bg-red-600">red</button>
          <button onClick={() => basic({ color: { r: 0, g: 255, b: 0 } })} className="px-2 py-1 rounded text-[11px] font-mono bg-green-700 hover:bg-green-600">green</button>
          <button onClick={() => basic({ color: { r: 0, g: 0, b: 255 } })} className="px-2 py-1 rounded text-[11px] font-mono bg-blue-700 hover:bg-blue-600">blue</button>
        </div>
        <p className="text-[10px] text-zinc-600 font-mono">If these work, the device is reachable. If even these don't, LAN Control isn't on / wrong network.</p>
      </section>

      {/* 3 — Stream mode */}
      <section className="bg-zinc-900 rounded p-3 space-y-2">
        <div className="text-xs font-mono text-zinc-400">3 · razer stream mode</div>
        <div className="flex gap-2">
          <button onClick={() => api('/stream/activate', {})} className="px-3 py-1.5 rounded text-xs font-mono bg-purple-600 hover:bg-purple-500">activate stream</button>
          <button onClick={() => api('/stream/deactivate', {})} className="px-3 py-1.5 rounded text-xs font-mono bg-zinc-800 hover:bg-zinc-700">deactivate</button>
        </div>
      </section>

      {/* 4 — Segment ramp test */}
      <section className="bg-zinc-900 rounded p-3 space-y-3">
        <div className="text-xs font-mono text-zinc-400">4 · per-segment test</div>

        <div className="flex items-center gap-2 text-[11px] font-mono">
          <span className="w-16 text-zinc-500">segments</span>
          <input type="range" min={1} max={state?.maxSingleByteSegments ?? 255} step={1} value={segments}
            onChange={(e) => setSegments(+e.target.value)} className="flex-1" />
          <span className="w-10 text-right">{segments}</span>
        </div>
        <div className="flex gap-1 flex-wrap">
          {SEGMENT_PRESETS.map((n) => (
            <button key={n} onClick={() => setSegments(n)}
              className={`px-2 py-0.5 rounded text-[10px] font-mono ${segments === n ? 'bg-purple-600' : 'bg-zinc-800 hover:bg-zinc-700'}`}>{n}</button>
          ))}
        </div>

        <div className="flex items-center gap-2 text-[11px] font-mono">
          <span className="w-16 text-zinc-500">header</span>
          <div className="flex gap-1">
            {(['dreams', 'chroma', 'govee'] as HeaderMode[]).map((m) => (
              <button key={m} onClick={() => setMode(m)}
                className={`px-2 py-0.5 rounded text-[10px] ${mode === m ? 'bg-purple-600' : 'bg-zinc-800 hover:bg-zinc-700'}`}>{m}</button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 text-[11px] font-mono">
          <span className="w-16 text-zinc-500">pattern</span>
          <div className="flex gap-1">
            {(['ruler', 'rainbow', 'solid'] as Pattern[]).map((p) => (
              <button key={p} onClick={() => setPattern(p)}
                className={`px-2 py-0.5 rounded text-[10px] ${pattern === p ? 'bg-purple-600' : 'bg-zinc-800 hover:bg-zinc-700'}`}>{p}</button>
            ))}
          </div>
          <label className="ml-auto flex items-center gap-1 text-zinc-500">
            <input type="checkbox" checked={stretch} onChange={(e) => setStretch(e.target.checked)} /> stretch
          </label>
        </div>

        <div className="flex gap-2">
          <button onClick={sendFrame} className="px-3 py-1.5 rounded text-xs font-mono bg-emerald-600 hover:bg-emerald-500">send 1 frame</button>
          {state?.animating
            ? <button onClick={() => animate(false)} className="px-3 py-1.5 rounded text-xs font-mono bg-red-600 hover:bg-red-500">stop animate</button>
            : <button onClick={() => animate(true)} className="px-3 py-1.5 rounded text-xs font-mono bg-amber-600 hover:bg-amber-500">animate</button>}
          <label className="ml-auto flex items-center gap-2 text-[11px] font-mono text-zinc-500">
            Hz <input type="range" min={1} max={30} value={animHz} onChange={(e) => setAnimHz(+e.target.value)} className="w-24" />
            <span className="w-5">{animHz}</span>
          </label>
        </div>

        <p className="text-[10px] text-zinc-600 font-mono leading-relaxed">
          <span className="text-zinc-400">ruler</span> = seg 0 red, every 10th green, rest dim blue — count how many respond.
          The documented packet caps at <span className="text-zinc-400">{state?.maxSingleByteSegments ?? 255}</span> segments (single-byte count).
          Beyond that needs an undocumented multi-packet variant.
        </p>
      </section>

      <div className="text-[11px] font-mono text-zinc-500">
        {selectedIp ? <>selected: <span className="text-emerald-400">{selectedIp}</span></> : <span className="text-amber-400">no device selected</span>}
        {lastResult && <> · {lastResult}</>}
      </div>
    </div>
  );
}
