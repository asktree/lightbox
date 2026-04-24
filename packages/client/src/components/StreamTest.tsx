import { useEffect, useRef, useState } from 'react';

// Test harness for the Hue entertainment (DTLS streaming) driver. Lets you
// start/stop the stream, set a baseline color per channel, and fire pulses
// or a strobe to feel out latency and rate — same pattern we'll want for
// onset-driven music sync.

interface Channel { id: number; lightName: string }
interface StreamState { active: boolean; channels: Channel[]; error?: string }
interface RestLight { rid: string; name: string }

const U16_MAX = 65535;

// HSV (h: 0-360, s/v: 0-1) → uint16 RGB for the stream protocol.
function hsvToRgb16(h: number, s: number, v: number): [number, number, number] {
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
  return [
    Math.round((r + m) * U16_MAX),
    Math.round((g + m) * U16_MAX),
    Math.round((b + m) * U16_MAX),
  ];
}

async function api(path: string, body?: any) {
  const res = await fetch(`/api${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export function StreamTest() {
  const [state, setState] = useState<StreamState>({ active: false, channels: [] });
  const [restLights, setRestLights] = useState<RestLight[]>([]);
  const [hue, setHue] = useState(0);        // 0-360
  const [sat, setSat] = useState(1);        // 0-1
  const [val, setVal] = useState(1);        // 0-1
  const [flashMs, setFlashMs] = useState(100);
  const [strobeHz, setStrobeHz] = useState(10);
  const [attackMs, setAttackMs] = useState(30);
  const [decayMs, setDecayMs] = useState(600);
  const [busy, setBusy] = useState(false);
  const strobeTimer = useRef<number | null>(null);

  const refresh = async () => {
    try { setState(await api('/hue-stream/state')); } catch {}
    try { setRestLights((await api('/hue-stream/rest-lights')).lights); } catch {}
  };

  useEffect(() => { refresh(); }, []);
  useEffect(() => () => { if (strobeTimer.current) window.clearInterval(strobeTimer.current); }, []);

  const start = async () => {
    setBusy(true);
    try { setState(await api('/hue-stream/start', {})); }
    catch (e) { alert(`Start failed: ${e}`); }
    finally { setBusy(false); }
  };

  const stop = async () => {
    setBusy(true);
    if (strobeTimer.current) { window.clearInterval(strobeTimer.current); strobeTimer.current = null; }
    try { setState(await api('/hue-stream/stop', {})); }
    catch (e) { alert(`Stop failed: ${e}`); }
    finally { setBusy(false); }
  };

  const [r, g, b] = hsvToRgb16(hue, sat, val);

  const setAll = () => api('/hue-stream/set', { r, g, b }).catch(console.error);
  const setBlack = () => api('/hue-stream/set', { r: 0, g: 0, b: 0 }).catch(console.error);
  const pulseAll = () => api('/hue-stream/flash', { r, g, b, durationMs: flashMs }).catch(console.error);
  const pulseChannel = (id: number) =>
    api('/hue-stream/flash', { channelId: id, r, g, b, durationMs: flashMs }).catch(console.error);
  const fadedPulseAll = () => api('/hue-stream/pulse', { r, g, b, attackMs, decayMs }).catch(console.error);
  const fadedPulseChannel = (id: number) =>
    api('/hue-stream/pulse', { channelId: id, r, g, b, attackMs, decayMs }).catch(console.error);
  const restPulse = () =>
    api('/hue-stream/rest-pulse', { r, g, b, brightness: Math.round(val * 100), decayMs }).catch(console.error);
  const restPulseLight = (lightId: string) =>
    api('/hue-stream/rest-pulse', { lightId, r, g, b, brightness: Math.round(val * 100), decayMs }).catch(console.error);
  const setChannel = (id: number) =>
    api('/hue-stream/set', { channelId: id, r, g, b }).catch(console.error);

  const toggleStrobe = () => {
    if (strobeTimer.current) {
      window.clearInterval(strobeTimer.current);
      strobeTimer.current = null;
      return;
    }
    // Alternate full color / black at the chosen rate.
    let on = false;
    const period = Math.max(20, Math.round(1000 / (strobeHz * 2)));
    strobeTimer.current = window.setInterval(() => {
      on = !on;
      api('/hue-stream/set', on ? { r, g, b } : { r: 0, g: 0, b: 0 }).catch(() => {});
    }, period);
  };

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div className="flex items-center gap-4">
        <button
          onClick={state.active ? stop : start}
          disabled={busy}
          className={`px-4 py-2 rounded-lg text-sm font-medium ${
            state.active ? 'bg-red-600 hover:bg-red-500' : 'bg-green-600 hover:bg-green-500'
          } disabled:opacity-50`}
        >
          {busy ? '...' : state.active ? 'Stop stream' : 'Start stream'}
        </button>
        <button onClick={refresh} className="text-zinc-400 text-sm hover:text-white">refresh</button>
        <span className="text-sm text-zinc-500">
          {state.channels.length} channel{state.channels.length === 1 ? '' : 's'}
        </span>
        {state.error && <span className="text-sm text-red-400">{state.error}</span>}
      </div>

      {/* Color pickers */}
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
          <span className="w-16 text-sm text-zinc-400">val</span>
          <input type="range" min={0} max={100} value={Math.round(val * 100)} onChange={(e) => setVal(+e.target.value / 100)} className="flex-1" />
          <span className="w-12 text-sm text-zinc-500 text-right">{Math.round(val * 100)}%</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded" style={{ backgroundColor: `hsl(${hue}, ${Math.round(sat*100)}%, ${Math.round(val*50)}%)` }} />
          <span className="text-xs font-mono text-zinc-500">rgb16: {r} {g} {b}</span>
        </div>
      </div>

      {/* Global actions */}
      <div className="flex flex-wrap gap-2">
        <button onClick={setAll} disabled={!state.active} className="px-3 py-1.5 bg-zinc-700 rounded text-sm disabled:opacity-40">Set all</button>
        <button onClick={setBlack} disabled={!state.active} className="px-3 py-1.5 bg-zinc-700 rounded text-sm disabled:opacity-40">All off</button>
        <button onClick={pulseAll} disabled={!state.active} className="px-3 py-1.5 bg-purple-700 rounded text-sm disabled:opacity-40">Pulse all</button>
        <button onClick={fadedPulseAll} disabled={!state.active} className="px-3 py-1.5 bg-indigo-700 rounded text-sm disabled:opacity-40">Faded pulse all</button>
        <button onClick={restPulse} disabled={state.active} title={state.active ? 'Stop streaming first — bridge ignores REST while stream is active' : ''} className="px-3 py-1.5 bg-teal-700 rounded text-sm disabled:opacity-40">REST faded pulse</button>
        <div className="flex items-center gap-2 ml-2">
          <span className="text-xs text-zinc-500">flash ms</span>
          <input type="number" min={10} max={2000} value={flashMs} onChange={(e) => setFlashMs(+e.target.value)} className="w-20 bg-zinc-800 text-sm rounded px-2 py-1" />
        </div>
        <div className="flex items-center gap-2 ml-2">
          <span className="text-xs text-zinc-500">attack ms</span>
          <input type="number" min={0} max={1000} value={attackMs} onChange={(e) => setAttackMs(+e.target.value)} className="w-20 bg-zinc-800 text-sm rounded px-2 py-1" />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500">decay ms</span>
          <input type="number" min={10} max={5000} value={decayMs} onChange={(e) => setDecayMs(+e.target.value)} className="w-20 bg-zinc-800 text-sm rounded px-2 py-1" />
        </div>
      </div>

      {/* Strobe */}
      <div className="flex items-center gap-3">
        <button
          onClick={toggleStrobe}
          disabled={!state.active}
          className={`px-3 py-1.5 rounded text-sm disabled:opacity-40 ${strobeTimer.current ? 'bg-red-600' : 'bg-amber-600'}`}
        >
          {strobeTimer.current ? 'Stop strobe' : 'Start strobe'}
        </button>
        <span className="text-xs text-zinc-500">rate</span>
        <input type="range" min={1} max={25} value={strobeHz} onChange={(e) => setStrobeHz(+e.target.value)} className="w-40" />
        <span className="text-xs text-zinc-500">{strobeHz} Hz</span>
      </div>

      {/* Per-light REST pulse (works without the stream) */}
      <div className="bg-zinc-900 rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm text-zinc-400">REST lights</div>
          <div className="text-xs text-zinc-600">
            {state.active ? 'stop stream to use REST' : `${restLights.length} lights`}
          </div>
        </div>
        {restLights.length === 0 ? (
          <div className="text-sm text-zinc-500">No color-capable lights found.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {restLights.map((l) => (
              <div key={l.rid} className="flex items-center gap-2 bg-zinc-800 rounded px-3 py-2">
                <span className="flex-1 text-sm truncate">{l.name}</span>
                <button
                  onClick={() => restPulseLight(l.rid)}
                  disabled={state.active}
                  title={state.active ? 'Stop streaming first' : ''}
                  className="px-2 py-1 bg-teal-700 rounded text-xs disabled:opacity-40"
                >
                  REST pulse
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Per-channel controls */}
      <div className="bg-zinc-900 rounded-lg p-4">
        <div className="text-sm text-zinc-400 mb-3">Channels</div>
        {state.channels.length === 0 ? (
          <div className="text-sm text-zinc-500">No channels. Start the stream to create / fetch the entertainment configuration.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {state.channels.map((c) => (
              <div key={c.id} className="flex items-center gap-2 bg-zinc-800 rounded px-3 py-2">
                <span className="text-xs text-zinc-500 w-8">#{c.id}</span>
                <span className="flex-1 text-sm truncate">{c.lightName}</span>
                <button onClick={() => setChannel(c.id)} disabled={!state.active} className="px-2 py-1 bg-zinc-700 rounded text-xs disabled:opacity-40">Set</button>
                <button onClick={() => pulseChannel(c.id)} disabled={!state.active} className="px-2 py-1 bg-purple-700 rounded text-xs disabled:opacity-40">Pulse</button>
                <button onClick={() => fadedPulseChannel(c.id)} disabled={!state.active} className="px-2 py-1 bg-indigo-700 rounded text-xs disabled:opacity-40">Fade</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
