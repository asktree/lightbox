import { useEffect, useRef, useState } from 'react';

// Test harness for the WiZ UDP driver. JSON-over-UDP, no entertainment
// stream. Pulses are server-side ramps; strobe is client-driven via the
// fire-and-forget /set endpoint to feel the rate ceiling.

interface WizLight { id: string; mac: string; ip: string; reachable: boolean }

async function api(path: string, body?: any) {
  const res = await fetch(`/api${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// HSV (h: 0-360, s/v: 0-1) → RGB byte triple
function hsvToRgb8(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const hp = (h / 60) % 6;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = v - c;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

export function WizTest() {
  const [lights, setLights] = useState<WizLight[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [hue, setHue] = useState(0);
  const [sat, setSat] = useState(1);
  const [peakDim, setPeakDim] = useState(100);
  const [floorDim, setFloorDim] = useState(10);
  const [decayMs, setDecayMs] = useState(400);
  const [strobeHz, setStrobeHz] = useState(10);
  const strobeTimer = useRef<number | null>(null);

  const refresh = async () => {
    try {
      const { lights } = await api('/wiz/lights');
      setLights(lights);
      if (!selected && lights[0]) setSelected(lights[0].id);
    } catch (e) { console.error(e); }
  };

  useEffect(() => { refresh(); }, []);
  useEffect(() => () => { if (strobeTimer.current) window.clearInterval(strobeTimer.current); }, []);

  const [r, g, b] = hsvToRgb8(hue, sat, 1);

  const set = () =>
    selected && api('/wiz/set', { deviceId: selected, state: true, r, g, b, dimming: peakDim }).catch(console.error);
  const off = () =>
    selected && api('/wiz/set', { deviceId: selected, state: false }).catch(console.error);
  const pulse = () =>
    selected && api('/wiz/pulse', { deviceId: selected, r, g, b, peakDim, floorDim, decayMs }).catch(console.error);

  const toggleStrobe = () => {
    if (strobeTimer.current) {
      window.clearInterval(strobeTimer.current);
      strobeTimer.current = null;
      return;
    }
    if (!selected) return;
    let on = false;
    const period = Math.max(20, Math.round(1000 / (strobeHz * 2)));
    strobeTimer.current = window.setInterval(() => {
      on = !on;
      // Strobe via dimming, not state on/off — WiZ's state toggles take
      // ~150ms and clip the high-rate end. Dimming changes are visible
      // sub-frame.
      api('/wiz/set', {
        deviceId: selected,
        state: true,
        r, g, b,
        dimming: on ? peakDim : Math.max(10, floorDim),
      }).catch(() => {});
    }, period);
  };

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div className="flex items-center gap-4">
        <button onClick={refresh} className="text-zinc-400 text-sm hover:text-white">refresh</button>
        <span className="text-sm text-zinc-500">{lights.length} bulb{lights.length === 1 ? '' : 's'}</span>
      </div>

      {/* Bulb picker */}
      <div className="bg-zinc-900 rounded-lg p-4">
        <div className="text-sm text-zinc-400 mb-3">Bulbs</div>
        {lights.length === 0 ? (
          <div className="text-sm text-zinc-500">No WiZ bulbs found.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {lights.map((l) => {
              const isSel = selected === l.id;
              return (
                <button
                  key={l.id}
                  onClick={() => setSelected(l.id)}
                  className={`flex items-center gap-2 rounded px-3 py-2 text-left ${
                    isSel ? 'bg-purple-700' : 'bg-zinc-800 hover:bg-zinc-700'
                  }`}
                >
                  <div className={`w-2 h-2 rounded-full ${l.reachable ? 'bg-green-500' : 'bg-zinc-600'}`} />
                  <span className="flex-1 text-sm truncate">{l.mac}</span>
                  <span className="text-xs text-zinc-500 font-mono">{l.ip}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Color */}
      <div className="bg-zinc-900 rounded-lg p-4 flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <span className="w-16 text-sm text-zinc-400">hue</span>
          <input type="range" min={0} max={360} value={hue} onChange={(e) => setHue(+e.target.value)} className="flex-1" />
          <span className="w-12 text-sm text-zinc-500 text-right">{hue}°</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="w-16 text-sm text-zinc-400">sat</span>
          <input type="range" min={0} max={100} value={Math.round(sat * 100)} onChange={(e) => setSat(+e.target.value / 100)} className="flex-1" />
          <span className="w-12 text-sm text-zinc-500 text-right">{Math.round(sat * 100)}%</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded" style={{ backgroundColor: `rgb(${r},${g},${b})` }} />
          <span className="text-xs font-mono text-zinc-500">rgb: {r} {g} {b}</span>
        </div>
      </div>

      {/* Pulse params */}
      <div className="bg-zinc-900 rounded-lg p-4 flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <span className="w-20 text-sm text-zinc-400">peak dim</span>
          <input type="range" min={10} max={100} value={peakDim} onChange={(e) => setPeakDim(+e.target.value)} className="flex-1" />
          <span className="w-12 text-sm text-zinc-500 text-right">{peakDim}%</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="w-20 text-sm text-zinc-400">floor dim</span>
          <input type="range" min={10} max={100} value={floorDim} onChange={(e) => setFloorDim(+e.target.value)} className="flex-1" />
          <span className="w-12 text-sm text-zinc-500 text-right">{floorDim}%</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="w-20 text-sm text-zinc-400">decay ms</span>
          <input type="range" min={50} max={2000} step={10} value={decayMs} onChange={(e) => setDecayMs(+e.target.value)} className="flex-1" />
          <span className="w-12 text-sm text-zinc-500 text-right">{decayMs}</span>
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        <button onClick={set} disabled={!selected} className="px-3 py-1.5 bg-zinc-700 rounded text-sm disabled:opacity-40">Set</button>
        <button onClick={off} disabled={!selected} className="px-3 py-1.5 bg-zinc-700 rounded text-sm disabled:opacity-40">Off</button>
        <button onClick={pulse} disabled={!selected} className="px-3 py-1.5 bg-teal-700 rounded text-sm disabled:opacity-40">Pulse</button>
      </div>

      {/* Strobe */}
      <div className="flex items-center gap-3">
        <button
          onClick={toggleStrobe}
          disabled={!selected}
          className={`px-3 py-1.5 rounded text-sm disabled:opacity-40 ${strobeTimer.current ? 'bg-red-600' : 'bg-amber-600'}`}
        >
          {strobeTimer.current ? 'Stop strobe' : 'Start strobe'}
        </button>
        <span className="text-xs text-zinc-500">rate</span>
        <input type="range" min={1} max={25} value={strobeHz} onChange={(e) => setStrobeHz(+e.target.value)} className="w-40" />
        <span className="text-xs text-zinc-500">{strobeHz} Hz</span>
      </div>
    </div>
  );
}
