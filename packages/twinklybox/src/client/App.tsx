import { useEffect, useState } from 'react';
import { DeviceViewer } from './components/DeviceViewer';
import { useMicSource } from './useMicSource';

// Persisted state — same shape as useState but writes to localStorage so
// slider settings survive a refresh. Key is scoped to twinklybox so it
// won't collide with other apps on the same dev origin.
function usePersistedState<T>(key: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const fullKey = `twinklybox:${key}`;
  const [state, setState] = useState<T>(() => {
    if (typeof window === 'undefined') return initial;
    try {
      const raw = localStorage.getItem(fullKey);
      if (raw === null) return initial;
      return JSON.parse(raw) as T;
    } catch { return initial; }
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try { localStorage.setItem(fullKey, JSON.stringify(state)); } catch { /* quota / private mode */ }
  }, [fullKey, state]);
  return [state, setState];
}

// Twinklybox test page. All compute lives on the server — we just shape
// pattern params and push them via /api/pattern. The server drives the
// UDP frame loop.

type PatternKind = 'solid' | 'gradient' | 'perlin' | 'planes' | 'strobe' | 'megadrome';
type Axis = 'x' | 'y' | 'z' | 'index';

type DriverKind = 'twinkly' | 'wled' | 'serial';
interface DeviceInfo {
  kind: DriverKind;
  host: string;
  connected?: boolean;
  name: string;
  numLeds: number;
  ledProfile: string;
  bytesPerLed: number;
  hasLayout: boolean;
  layoutSource: string | null;
  matrix?: { w: number; h: number } | null;
}

interface StreamStats { running: boolean; hz: number; frameCount: number; patternKind: PatternKind | null }

interface AudioState {
  energy: { drums: number; bass: number; vocals: number; other: number };
  energyMinMax: { drums: number; bass: number; vocals: number; other: number };
  bands?: number[];
  bandsMinMax?: number[];
  trackId: string | null;
  trackName: string | null;
  position: number;
  playing: boolean;
  lastUpdate: number;
}

interface SourceState {
  musicboxReachable: boolean;
  currentTrackId: string | null;
  trackName: string | null;
  cachedTracks: string[];
  inferredPosition: number;
  playing: boolean;
  micActive?: boolean;
  micFresh?: boolean;
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

export default function App() {
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [stats, setStats] = useState<StreamStats>({ running: false, hz: 25, frameCount: 0, patternKind: null });
  const [kind, setKind] = usePersistedState<PatternKind>('kind', 'gradient');
  const [hz, setHz] = usePersistedState('hz', 25);
  const [gamma, setGamma] = usePersistedState('gamma', 2.2);

  // Solid
  const [solidHue, setSolidHue] = usePersistedState('solid.hue', 0);
  const [solidSat, setSolidSat] = usePersistedState('solid.sat', 1);
  const [solidVal, setSolidVal] = usePersistedState('solid.val', 0.8);

  // Gradient
  const [gradAxis, setGradAxis] = usePersistedState<Axis>('grad.axis', 'x');
  const [gradHueStart, setGradHueStart] = usePersistedState('grad.hueStart', 0);
  const [gradHueEnd, setGradHueEnd] = usePersistedState('grad.hueEnd', 360);
  const [gradSpeed, setGradSpeed] = usePersistedState('grad.speed', 0.1);
  const [gradVal, setGradVal] = usePersistedState('grad.val', 0.8);

  // Perlin
  const [perlinScale, setPerlinScale] = usePersistedState('perlin.scale', 3);
  const [perlinSpeed, setPerlinSpeed] = usePersistedState('perlin.speed', 0.3);
  const [perlinHueRange, setPerlinHueRange] = usePersistedState('perlin.hueRange', 120);
  const [perlinHueCenter, setPerlinHueCenter] = usePersistedState('perlin.hueCenter', 200);
  const [perlinVal, setPerlinVal] = usePersistedState('perlin.val', 0.8);

  // Planes
  const [planesDirection, setPlanesDirection] = usePersistedState<'up' | 'random'>('planes.direction', 'up');
  const [planesHue, setPlanesHue] = usePersistedState('planes.hue', 200);
  const [planesVal, setPlanesVal] = usePersistedState('planes.val', 0.8);
  const [planesSpeed, setPlanesSpeed] = usePersistedState('planes.speed', 0.3);
  const [planesSpawnRate, setPlanesSpawnRate] = usePersistedState('planes.spawnRate', 0.5);
  const [planesThickness, setPlanesThickness] = usePersistedState('planes.thickness', 0.08);
  const [planesSoftness, setPlanesSoftness] = usePersistedState('planes.softness', 0.6);

  // Megadrome. Default scalars are ~50× larger than megadrome2.js because
  // our LED coords are normalized to [0,1] per axis (span ~1 per axis),
  // whereas megadrome was tuned for a 43×66 pixel canvas (span ~60). Same
  // ratio of "noise cells per LED-space span" preserved.
  const [mdOriginX, setMdOriginX] = usePersistedState('md.originX', 0.5);
  const [mdOriginY, setMdOriginY] = usePersistedState('md.originY', 0.5);
  const [mdOriginZ, setMdOriginZ] = usePersistedState('md.originZ', 0.5);
  const [mdRotation, setMdRotation] = usePersistedState('md.rotation', 5);
  const [mdD, setMdD] = usePersistedState('md.d', 5);
  const [mdD2, setMdD2] = usePersistedState('md.d2', 5);
  const [mdNoise2Pos, setMdNoise2Pos] = usePersistedState('md.noise2pos', 3);
  const [mdNoise2, setMdNoise2] = usePersistedState('md.noise2', 5);
  const [mdPulse, setMdPulse] = usePersistedState('md.pulse', 2);
  const [mdHueOffset, setMdHueOffset] = usePersistedState('md.hueOffset', 0);
  const [mdHueRange, setMdHueRange] = usePersistedState('md.hueRange', 180);
  const [mdSat, setMdSat] = usePersistedState('md.sat', 1);
  const [mdVal, setMdVal] = usePersistedState('md.val', 0.8);
  const [mdBaseline, setMdBaseline] = usePersistedState('md.baseline', 0);
  const [mdPropGain, setMdPropGain] = usePersistedState('md.propGain', 0);
  const [mdPropDeadzone, setMdPropDeadzone] = usePersistedState('md.propDeadzone', 0);
  const [mdNormMode, setMdNormMode] = usePersistedState<'percentile' | 'robust-minmax'>('md.normMode', 'robust-minmax');
  const [mdBandMode, setMdBandMode] = usePersistedState<'stems' | 'eq12'>('md.bandMode', 'stems');
  const [mdMinMaxGain, setMdMinMaxGain] = usePersistedState('md.minMaxGain', 1);

  // Audio source state
  const [audio, setAudio] = useState<AudioState | null>(null);
  const [sourceState, setSourceState] = useState<SourceState | null>(null);

  // Live mic source. When on, the browser captures the machine's mic, FFTs
  // it, and streams 12-band frames to the server (useMicSource). megadrome
  // needs eq12 band mode to consume it (stems aren't recoverable from FFT),
  // so flipping mic on also flips band mode to eq12.
  const [micOn, setMicOn] = useState(false);
  useMicSource(micOn);
  const enableMic = (on: boolean) => {
    setMicOn(on);
    if (on) setMdBandMode('eq12');
  };

  // WLED timecode buffer (jitter absorption on-box). Persisted + re-asserted on
  // load so it survives server restarts, which rebuild the driver buffer-off.
  const [bufferOn, setBufferOn] = usePersistedState('wled.buffer', false);
  useEffect(() => { api('/buffer', { on: bufferOn }).catch(() => {}); }, [bufferOn]);

  // Live system-audio sync — captures the Mac output mix and drives megadrome
  // on a delay matched to playback (AirPlay) latency. Needs eq12 like mic.
  const [syscapOn, setSyscapOn] = useState(false);
  const [syscapDelay, setSyscapDelay] = usePersistedState('syscap.delayMs', 1500);
  const enableSyscap = (on: boolean) => {
    setSyscapOn(on);
    if (on) setMdBandMode('eq12');
    api('/source/syscap', { active: on, delayMs: syscapDelay }).catch(() => {});
  };
  useEffect(() => {
    if (syscapOn) api('/source/syscap', { active: true, delayMs: syscapDelay }).catch(() => {});
  }, [syscapDelay]); // eslint-disable-line react-hooks/exhaustive-deps

  // Audio-bus smoothing — split into attack (α applied when rising) and
  // decay (when falling). Persisted in localStorage; the push-on-change
  // effect below runs on mount with the persisted values, so the server
  // picks them up at startup (server only holds smoothing in memory and
  // resets to 0/0 on restart -- we don't want to round-trip and inherit
  // its blank state).
  const [attackSmoothing, setAttackSmoothing] = usePersistedState('bus.attack', 0);
  const [decaySmoothing, setDecaySmoothing] = usePersistedState('bus.decay', 0);
  useEffect(() => {
    api('/source/smoothing', { attack: attackSmoothing, decay: decaySmoothing }).catch(() => {});
  }, [attackSmoothing, decaySmoothing]);

  // Push gamma to server when it changes.
  useEffect(() => {
    api('/gamma', { gamma }).catch(() => {});
  }, [gamma]);

  // Strobe
  const [strobeHue, setStrobeHue] = usePersistedState('strobe.hue', 0);
  const [strobeHzVal, setStrobeHzVal] = usePersistedState('strobe.hz', 4);
  const [strobeDuty, setStrobeDuty] = usePersistedState('strobe.duty', 0.1);
  const [strobeVal, setStrobeVal] = usePersistedState('strobe.val', 1);

  // Target selector — what the server is driving. Server auto-connects on
  // boot to the first known target; the UI lets you switch to a different
  // kind+host without restarting.
  const [targetKind, setTargetKind] = usePersistedState<DriverKind>('target.kind', 'wled');
  const [targetHost, setTargetHost] = usePersistedState('target.host', '192.168.0.220');
  const [connecting, setConnecting] = useState(false);

  const connect = async (kind: DriverKind, host: string) => {
    setConnecting(true);
    try {
      const r = await api<{ ok: boolean; device: DeviceInfo; error?: string }>('/connect', { kind, host });
      if (r.ok) setDevice(r.device);
      else console.error(r.error);
    } catch (e) { console.error(e); }
    setConnecting(false);
  };

  // Initial state poll. Server already auto-connected to its first known
  // target on boot; we just discover what it picked.
  useEffect(() => {
    (async () => {
      try {
        const r = await api<{ devices: DeviceInfo[] }>('/devices');
        const d = (r.devices ?? []).find((x) => x.connected);
        if (d) {
          setDevice(d);
          setTargetKind(d.kind);
          setTargetHost(d.host);
        }
      } catch (e) { console.error(e); }
      try { setStats(await api<StreamStats>('/stream/state')); } catch {}
    })();
    const t = setInterval(async () => {
      try { setStats(await api<StreamStats>('/stream/state')); } catch {}
      try { setSourceState(await api<SourceState>('/source')); } catch {}
    }, 500);
    // Audio bus polled faster so the 12-band meter stays lively.
    const ta = setInterval(async () => {
      try { setAudio(await api<AudioState>('/audio')); } catch {}
    }, 100);
    return () => { clearInterval(t); clearInterval(ta); };
  }, []);

  // Push pattern updates to the server whenever any param changes.
  useEffect(() => {
    const p = buildPattern();
    api('/pattern', p).catch(console.error);
  }, [
    kind,
    solidHue, solidSat, solidVal,
    gradAxis, gradHueStart, gradHueEnd, gradSpeed, gradVal,
    perlinScale, perlinSpeed, perlinHueRange, perlinHueCenter, perlinVal,
    planesDirection, planesHue, planesVal, planesSpeed, planesSpawnRate, planesThickness, planesSoftness,
    mdOriginX, mdOriginY, mdOriginZ, mdRotation, mdD, mdD2, mdNoise2Pos, mdNoise2, mdPulse, mdHueOffset, mdHueRange, mdSat, mdVal, mdBaseline, mdPropGain, mdPropDeadzone, mdNormMode, mdMinMaxGain, mdBandMode,
    strobeHue, strobeHzVal, strobeDuty, strobeVal,
  ]);

  function buildPattern() {
    switch (kind) {
      case 'solid':    return { kind, hue: solidHue, sat: solidSat, val: solidVal };
      case 'gradient': return { kind, axis: gradAxis, hueStart: gradHueStart, hueEnd: gradHueEnd, sat: 1, val: gradVal, speed: gradSpeed };
      case 'perlin':   return { kind, scale: perlinScale, speed: perlinSpeed, hueRange: perlinHueRange, hueCenter: perlinHueCenter, sat: 1, val: perlinVal };
      case 'planes':    return { kind, direction: planesDirection, hue: planesHue, sat: 1, val: planesVal, speed: planesSpeed, spawnRate: planesSpawnRate, thickness: planesThickness, softness: planesSoftness };
      case 'megadrome': return {
        kind, originX: mdOriginX, originY: mdOriginY, originZ: mdOriginZ,
        rotationScalar: mdRotation, dScalar: mdD, d2Scalar: mdD2,
        noise2PosScalar: mdNoise2Pos, noise2Scalar: mdNoise2,
        pulseSize: mdPulse, hueOffset: mdHueOffset, hueRange: mdHueRange,
        sat: mdSat, val: mdVal, baseline: mdBaseline,
        propGain: mdPropGain, propDeadzone: mdPropDeadzone, normMode: mdNormMode, bandMode: mdBandMode,
        minMaxGain: mdMinMaxGain,
      };
      case 'strobe':    return { kind, hue: strobeHue, sat: 1, val: strobeVal, hz: strobeHzVal, duty: strobeDuty };
    }
  }

  const start = () => api('/stream/start', {}).then((s) => setStats(s as StreamStats));
  const stop  = () => api('/stream/stop', {}).then((s) => setStats(s as StreamStats));
  const pushHz = (n: number) => { setHz(n); api('/hz', { hz: n }).then((s) => setStats(s as StreamStats)); };

  return (
    <div className="min-h-screen p-6 max-w-5xl mx-auto space-y-6">
      <header className="flex items-center justify-between border-b border-zinc-800 pb-3 gap-3 flex-wrap">
        <h1 className="text-lg font-mono">twinklybox · test page</h1>
        <div className="text-xs text-zinc-400 font-mono">
          {device ? (
            <>
              <span className="text-zinc-200">{device.name}</span>
              {' · '}<span className="text-zinc-500">{device.kind}@{device.host}</span>
              {' · '}{device.numLeds} {device.ledProfile}
              {' · '}{device.hasLayout
                ? <span className="text-emerald-400">layout ({device.layoutSource}{device.matrix ? ` ${device.matrix.w}×${device.matrix.h}` : ''})</span>
                : <span className="text-amber-400">strand-only</span>}
            </>
          ) : (
            <span className="text-amber-400">connecting…</span>
          )}
        </div>
      </header>

      {/* Driver target selector. Switching kind+host hot-swaps the LED
          target (server tears down the old driver and stands up a new
          one). Pattern + audio bus + viewer are driver-agnostic. */}
      <section className="bg-zinc-900 rounded p-3 flex items-center gap-2 flex-wrap text-xs font-mono">
        <span className="text-zinc-400">target</span>
        <div className="flex gap-1">
          {(['serial', 'wled', 'twinkly'] as DriverKind[]).map((k) => (
            <button key={k}
              onClick={() => setTargetKind(k)}
              className={`px-2 py-1 rounded ${targetKind === k ? 'bg-purple-600 text-white' : 'bg-zinc-800 hover:bg-zinc-700'}`}
            >{k}</button>
          ))}
        </div>
        <input
          value={targetHost}
          onChange={(e) => setTargetHost(e.target.value)}
          placeholder="IP / host"
          className="bg-zinc-800 rounded px-2 py-1 text-xs w-36"
        />
        <button
          onClick={() => connect(targetKind, targetHost)}
          disabled={connecting}
          className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white"
        >{connecting ? 'connecting…' : 'connect'}</button>
        <span className="text-[10px] text-zinc-500 ml-auto">
          {device?.kind === targetKind && device?.host === targetHost
            ? <span className="text-emerald-400">● this is the active target</span>
            : <span className="text-zinc-500">○ not active — hit connect</span>}
        </span>
      </section>

      <section className="flex items-center gap-3">
        <button
          onClick={stats.running ? stop : start}
          disabled={!device}
          className={`px-3 py-1.5 rounded text-sm font-mono ${stats.running ? 'bg-red-600 hover:bg-red-500' : 'bg-emerald-600 hover:bg-emerald-500'} disabled:opacity-40`}
        >{stats.running ? 'Stop stream' : 'Start stream'}</button>
        <div className="text-xs text-zinc-500 font-mono">
          {stats.running ? <span className="text-emerald-400">streaming</span> : 'idle'}
          {' · '}frames: {stats.frameCount}
        </div>
        <label className="ml-auto text-xs text-zinc-500 font-mono flex items-center gap-2"
          title="Perceptual gamma applied to every output byte. ~2.2 ≈ sRGB; lower lifts dim values, higher crushes them. Helps when the LEDs look 'binary' (mostly off or full bright).">
          γ
          <input type="range" min={1} max={10} step={0.05} value={gamma} onChange={(e) => setGamma(+e.target.value)} className="w-24" />
          <span className="w-8 text-right">{gamma.toFixed(2)}</span>
        </label>
        <label className="text-xs text-zinc-500 font-mono flex items-center gap-2">
          Hz
          <input type="range" min={5} max={50} step={1} value={hz} onChange={(e) => pushHz(+e.target.value)} className="w-32" />
          <span className="w-6 text-right">{hz}</span>
        </label>
      </section>

      <section className="bg-zinc-900 rounded p-3 space-y-2">
        <div className="flex gap-2">
          {(['solid', 'gradient', 'perlin', 'planes', 'megadrome', 'strobe'] as PatternKind[]).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={`px-3 py-1.5 rounded text-xs font-mono ${kind === k ? 'bg-purple-600' : 'bg-zinc-800 hover:bg-zinc-700'}`}
            >{k}</button>
          ))}
        </div>

        {kind === 'solid' && (
          <div className="space-y-2 pt-2">
            <Slider label="hue" min={0} max={360} step={1} value={solidHue} onChange={setSolidHue} />
            <Slider label="sat" min={0} max={1} step={0.01} value={solidSat} onChange={setSolidSat} />
            <Slider label="val" min={0} max={1} step={0.01} value={solidVal} onChange={setSolidVal} />
          </div>
        )}

        {kind === 'gradient' && (
          <div className="space-y-2 pt-2">
            <div className="flex items-center gap-2 text-xs text-zinc-400 font-mono">
              <span className="w-16">axis</span>
              <select value={gradAxis} onChange={(e) => setGradAxis(e.target.value as Axis)} className="bg-zinc-800 rounded px-2 py-0.5 text-xs">
                <option value="x">x (spatial)</option>
                <option value="y">y (spatial)</option>
                <option value="z">z (spatial)</option>
                <option value="index">index (strand)</option>
              </select>
              {!device?.hasLayout && gradAxis !== 'index' && (
                <span className="text-amber-400 text-[10px]">no layout — falls back to strand</span>
              )}
            </div>
            <Slider label="hue start" min={0} max={360} step={1} value={gradHueStart} onChange={setGradHueStart} />
            <Slider label="hue end" min={0} max={360} step={1} value={gradHueEnd} onChange={setGradHueEnd} />
            <Slider label="speed" min={-1} max={1} step={0.01} value={gradSpeed} onChange={setGradSpeed} />
            <Slider label="val" min={0} max={1} step={0.01} value={gradVal} onChange={setGradVal} />
          </div>
        )}

        {kind === 'perlin' && (
          <div className="space-y-2 pt-2">
            {!device?.hasLayout && (
              <div className="text-amber-400 text-[10px] font-mono">no layout — perlin falls back to 1D along strand</div>
            )}
            <Slider label="scale" min={0.5} max={10} step={0.1} value={perlinScale} onChange={setPerlinScale} />
            <Slider label="speed" min={0} max={2} step={0.01} value={perlinSpeed} onChange={setPerlinSpeed} />
            <Slider label="hue range" min={0} max={360} step={1} value={perlinHueRange} onChange={setPerlinHueRange} />
            <Slider label="hue center" min={0} max={360} step={1} value={perlinHueCenter} onChange={setPerlinHueCenter} accentHue={perlinHueCenter} />
            <Slider label="val" min={0} max={1} step={0.01} value={perlinVal} onChange={setPerlinVal} />
          </div>
        )}

        {kind === 'planes' && (
          <div className="space-y-2 pt-2">
            {!device?.hasLayout && (
              <div className="text-amber-400 text-[10px] font-mono">no layout — planes degenerate to strand-index waves</div>
            )}
            <div className="flex items-center gap-2 text-xs text-zinc-400 font-mono">
              <span className="w-16">direction</span>
              <div className="flex gap-1">
                {(['up', 'random'] as const).map((d) => (
                  <button
                    key={d}
                    onClick={() => setPlanesDirection(d)}
                    className={`px-2 py-0.5 rounded text-[11px] ${planesDirection === d ? 'bg-purple-600 text-white' : 'bg-zinc-800 hover:bg-zinc-700'}`}
                  >{d}</button>
                ))}
              </div>
              <span className="text-[10px] text-zinc-600">
                {planesDirection === 'up' ? 'all planes rise vertically' : 'each plane gets a random 3D normal at spawn'}
              </span>
            </div>
            <Slider label="hue" min={0} max={360} step={1} value={planesHue} onChange={setPlanesHue} accentHue={planesHue} />
            <Slider label="val" min={0} max={1} step={0.01} value={planesVal} onChange={setPlanesVal} />
            <Slider label="speed" min={0.05} max={2} step={0.01} value={planesSpeed} onChange={setPlanesSpeed} />
            <Slider label="spawn /s" min={0.05} max={5} step={0.05} value={planesSpawnRate} onChange={setPlanesSpawnRate} />
            <Slider label="thickness" min={0.01} max={0.3} step={0.01} value={planesThickness} onChange={setPlanesThickness} />
            <Slider label="softness" min={0} max={1} step={0.01} value={planesSoftness} onChange={setPlanesSoftness} />
          </div>
        )}

        {kind === 'megadrome' && (
          <div className="space-y-2 pt-2">
            {!device?.hasLayout && (
              <div className="text-amber-400 text-[10px] font-mono">no layout — megadrome degenerates to 1D along strand</div>
            )}
            <div className="text-[10px] text-zinc-500 font-mono">audio-reactive — needs musicbox playback or a manual override (audio source panel below)</div>
            <div className="flex items-center gap-2 text-xs text-zinc-400 font-mono">
              <span className="w-16">band mode</span>
              <div className="flex gap-1">
                {(['stems', 'eq12'] as const).map((m) => (
                  <button key={m}
                    onClick={() => setMdBandMode(m)}
                    className={`px-2 py-0.5 rounded text-[11px] ${mdBandMode === m ? 'bg-purple-600 text-white' : 'bg-zinc-800 hover:bg-zinc-700'}`}
                    title={
                      m === 'stems'
                        ? '4 buckets = drums/bass/vocals/other stems. Our adaptation — bass pulse uses the real bass stem.'
                        : '12 buckets = log-spaced FFT bands on the equal-weighted stem sum. Original megadrome algorithm. Bass pulse = weighted sum of low bands.'
                    }
                  >{m}</button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-zinc-400 font-mono">
              <span className="w-16">norm mode</span>
              <div className="flex gap-1">
                {(['percentile', 'robust-minmax'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMdNormMode(m)}
                    className={`px-2 py-0.5 rounded text-[11px] ${mdNormMode === m ? 'bg-purple-600 text-white' : 'bg-zinc-800 hover:bg-zinc-700'}`}
                    title={
                      m === 'percentile'
                        ? 'Empirical-CDF rank against the whole track. Every song lights up the same average amount; quiet sections still register because they\'re relative to the song\'s own distribution.'
                        : 'Robust min-max bounded by p2..p98. Preserves relative loudness — a quiet intro really does look quiet, and bass-heavy songs really do look bass-heavy.'
                    }
                  >{m}</button>
                ))}
              </div>
            </div>

            {/* Gain dial + live meters — only relevant in robust-minmax mode.
                Bars show the gained value the pattern is actually consuming
                so you can see whether you've dialed in enough headroom. In
                stems mode there are 4 bars (drums/bass/vocals/other); in
                eq12 mode there are 12 (log-spaced FFT bands, low → high). */}
            {mdNormMode === 'robust-minmax' && (() => {
              // Pull raw min-max values from the audio bus for the active
              // band source. Falls back to zeros while the bus is warming
              // up after a track switch (envelope still streaming in).
              const labels: string[] = mdBandMode === 'eq12'
                ? Array.from({ length: 12 }, (_, i) => `b${i}`)
                : ['drums', 'bass', 'vocals', 'other'];
              const rawVals: number[] = mdBandMode === 'eq12'
                ? (audio?.bandsMinMax ?? new Array(12).fill(0))
                : (['drums', 'bass', 'vocals', 'other'] as const).map((s) => audio?.energyMinMax?.[s] ?? 0);
              const gridCols = mdBandMode === 'eq12' ? 'grid-cols-6' : 'grid-cols-4';
              return (
                <div className="bg-zinc-950 rounded p-2 space-y-1.5">
                  <Slider label="minmax gain" min={0.1} max={5} step={0.05} value={mdMinMaxGain} onChange={setMdMinMaxGain} />
                  <div className={`grid ${gridCols} gap-1.5`}>
                    {labels.map((label, i) => {
                      const raw = rawVals[i] ?? 0;
                      const gained = Math.min(1, raw * mdMinMaxGain);
                      const clipping = raw * mdMinMaxGain >= 0.999;
                      return (
                        <div key={label} className="text-[10px] font-mono">
                          <div className="flex justify-between text-zinc-500">
                            <span>{label}</span>
                            <span className={clipping ? 'text-red-400' : 'text-zinc-400'}>{gained.toFixed(2)}</span>
                          </div>
                          <div className="relative h-1.5 bg-zinc-900 rounded mt-0.5 overflow-hidden">
                            {/* raw (pre-gain) shown faded behind the gained bar */}
                            <div className="absolute inset-y-0 left-0 bg-zinc-700" style={{ width: `${raw * 100}%` }} />
                            <div className={`absolute inset-y-0 left-0 ${clipping ? 'bg-red-500' : 'bg-emerald-500'}`} style={{ width: `${gained * 100}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="text-[9px] text-zinc-600 font-mono">
                    faded = raw min-max · solid = ×gain (red = clipped at 1.0)
                    {mdBandMode === 'eq12' && ' · b0 = lowest FFT band, b11 = highest'}
                  </div>
                </div>
              );
            })()}

            <Slider label="originX" min={0} max={1} step={0.01} value={mdOriginX} onChange={setMdOriginX} />
            <Slider label="originY" min={0} max={1} step={0.01} value={mdOriginY} onChange={setMdOriginY} />
            <Slider label="originZ" min={0} max={1} step={0.01} value={mdOriginZ} onChange={setMdOriginZ} />
            <Slider label="rotation" min={0} max={20} step={0.1} value={mdRotation} onChange={setMdRotation} />
            <Slider label="D" min={0} max={20} step={0.1} value={mdD} onChange={setMdD} />
            <Slider label="D2" min={0} max={20} step={0.1} value={mdD2} onChange={setMdD2} />
            <Slider label="noise2pos" min={0} max={20} step={0.1} value={mdNoise2Pos} onChange={setMdNoise2Pos} />
            <Slider label="noise2" min={0} max={20} step={0.1} value={mdNoise2} onChange={setMdNoise2} />
            <Slider label="pulse" min={0} max={10} step={0.05} value={mdPulse} onChange={setMdPulse} />
            <Slider label="hue offset" min={0} max={360} step={1} value={mdHueOffset} onChange={setMdHueOffset} accentHue={mdHueOffset} />
            <Slider label="hue range" min={-360} max={360} step={1} value={mdHueRange} onChange={setMdHueRange} />
            <Slider label="sat" min={0} max={1} step={0.01} value={mdSat} onChange={setMdSat} />
            <Slider label="val" min={0} max={1} step={0.01} value={mdVal} onChange={setMdVal} />
            <Slider label="baseline" min={0} max={0.5} step={0.01} value={mdBaseline} onChange={setMdBaseline} />
            <Slider label="prop gain" min={-1} max={1} step={0.01} value={mdPropGain} onChange={setMdPropGain} />
            <Slider label="deadzone" min={0} max={2} step={0.01} value={mdPropDeadzone} onChange={setMdPropDeadzone} />
          </div>
        )}

        {kind === 'strobe' && (
          <div className="space-y-2 pt-2">
            <Slider label="hue" min={0} max={360} step={1} value={strobeHue} onChange={setStrobeHue} />
            <Slider label="hz" min={0.5} max={20} step={0.5} value={strobeHzVal} onChange={setStrobeHzVal} />
            <Slider label="duty" min={0.02} max={0.98} step={0.02} value={strobeDuty} onChange={setStrobeDuty} />
            <Slider label="val" min={0} max={1} step={0.01} value={strobeVal} onChange={setStrobeVal} />
          </div>
        )}
      </section>

      {/* Audio source — what's feeding the audio-reactive patterns. */}
      <section className="bg-zinc-900 rounded p-3 space-y-2">
        <div className="flex items-center justify-between text-xs font-mono">
          <span className="text-zinc-400">audio source</span>
          <span className="text-[10px] text-zinc-500">
            {sourceState?.micActive
              ? (sourceState?.micFresh
                  ? <span className="text-emerald-400">● mic input (live)</span>
                  : <span className="text-amber-400">mic on — no signal</span>)
              : sourceState?.musicboxReachable
                ? <span className="text-emerald-400">following musicbox</span>
                : <span className="text-zinc-600">no source</span>}
          </span>
        </div>

        {/* Live mic toggle. Grabs the browser mic, FFTs in the client, and
            streams 12-band frames to the server, which normalizes against a
            30s rolling window. Overrides musicbox while on. */}
        <div className="flex items-center gap-2 text-[11px] font-mono">
          <button
            onClick={() => enableMic(!micOn)}
            className={`px-2 py-1 rounded ${micOn ? 'bg-rose-600 text-white' : 'bg-zinc-800 hover:bg-zinc-700'}`}
            title="Use this computer's microphone as the audio source. megadrome runs in eq12 band mode on mic; normalization adapts over a rolling 30s window (give it ~30s to settle)."
          >{micOn ? '🎤 mic on' : '🎤 mic off'}</button>
          <span className="text-[10px] text-zinc-600">
            {micOn
              ? 'browser mic → eq12 bands · normalization warms up over ~30s'
              : 'use the machine mic as the audio source (overrides musicbox)'}
          </span>
        </div>

        {/* WLED timecode buffer — routes frames through the on-box 500ms jitter
            buffer (timecode_buffer usermod, UDP 4049). Needs the usermod firmware. */}
        <div className="flex items-center gap-2 text-[11px] font-mono">
          <button
            onClick={() => setBufferOn(!bufferOn)}
            className={`px-2 py-1 rounded ${bufferOn ? 'bg-indigo-600 text-white' : 'bg-zinc-800 hover:bg-zinc-700'}`}
            title="Route frames through the on-box 500ms jitter buffer (timecode_buffer usermod, UDP 4049). Smooths choppy WiFi. Only works on a box flashed with the usermod (Ubert)."
          >{bufferOn ? '🪣 buffer on' : '🪣 buffer off'}</button>
          <span className="text-[10px] text-zinc-600">
            {bufferOn ? 'frames buffered 500ms on-box — jitter-free' : 'immediate DDP — no jitter buffer'}
          </span>
        </div>

        {/* Live system-audio sync — captures the Mac output mix (ScreenCaptureKit)
            and drives megadrome on a delay matched to playback latency. */}
        <div className="flex flex-col gap-1 text-[11px] font-mono">
          <div className="flex items-center gap-2">
            <button
              onClick={() => enableSyscap(!syscapOn)}
              className={`px-2 py-1 rounded ${syscapOn ? 'bg-cyan-600 text-white' : 'bg-zinc-800 hover:bg-zinc-700'}`}
              title="Capture this Mac's audio output and drive megadrome in sync with what you hear. ScreenCaptureKit; runs megadrome in eq12; works alongside AirPlay."
            >{syscapOn ? '🔊 sync on' : '🔊 sync off'}</button>
            <span className="text-[10px] text-zinc-600">
              {syscapOn ? 'system audio → eq12, delayed to match output latency' : 'sync lights to computer audio output'}
            </span>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-zinc-500"
            title="How long to hold light frames so they line up with delayed audio (AirPlay ~2s). Total light latency = this + 500ms box buffer. Raise if lights LEAD the sound; lower if they LAG.">
            <span className="w-16">sync delay</span>
            <input type="range" min={0} max={4000} step={50} value={syscapDelay}
              onChange={(e) => setSyscapDelay(+e.target.value)} className="flex-1" />
            <span className="w-16 text-right">{syscapDelay}ms</span>
          </div>
        </div>

        {/* 12-band spectrum meter — live view of whatever source is active. */}
        <BandMeter bands={audio?.bands} minMax={audio?.bandsMinMax} />

        {/* Audio-bus smoothing — asymmetric EMA (attack ≠ decay). */}
        <div className="flex items-center gap-2 text-[10px] text-zinc-500 font-mono"
          title="EMA α when a stem's value RISES. 0 = instant attack (snaps up); closer to 1 = soft attack (slow rise).">
          <span className="w-16">attack</span>
          <input type="range" min={0} max={0.99} step={0.01} value={attackSmoothing}
            onChange={(e) => setAttackSmoothing(+e.target.value)}
            className="flex-1" />
          <span className="w-12 text-right">{attackSmoothing.toFixed(2)}</span>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-zinc-500 font-mono"
          title="EMA α when a stem's value FALLS. 0 = instant fall; closer to 1 = long tail / slow release.">
          <span className="w-16">decay</span>
          <input type="range" min={0} max={0.99} step={0.01} value={decaySmoothing}
            onChange={(e) => setDecaySmoothing(+e.target.value)}
            className="flex-1" />
          <span className="w-12 text-right">{decaySmoothing.toFixed(2)}</span>
        </div>
        <div className="text-[10px] font-mono text-zinc-500">
          track: <span className="text-zinc-300">{audio?.trackName ?? audio?.trackId ?? '—'}</span>
          {' · '}position: <span className="text-zinc-300">{audio ? audio.position.toFixed(2) : '—'}s</span>
          {' · '}playing: <span className="text-zinc-300">{audio?.playing ? 'yes' : 'no'}</span>
        </div>
        {audio && (
          <div className="grid grid-cols-4 gap-2 pt-1">
            {(['drums','bass','vocals','other'] as const).map((stem) => (
              <div key={stem} className="bg-zinc-950 rounded px-2 py-1 text-[10px] font-mono">
                <div className="text-zinc-500">{stem}</div>
                <div className="h-1 bg-zinc-800 rounded mt-1 overflow-hidden">
                  <div className="h-full bg-purple-500" style={{ width: `${audio.energy[stem] * 100}%` }} />
                </div>
                <div className="text-right text-zinc-400 mt-0.5">{audio.energy[stem].toFixed(2)}</div>
              </div>
            ))}
          </div>
        )}

      </section>

      {/* 3D viewer — mirrors the LED frame going out the UDP wire. */}
      <section className="bg-zinc-900 rounded p-3 space-y-2">
        <div className="flex items-center justify-between text-xs font-mono">
          <span className="text-zinc-400">device viewer</span>
          <span className="text-[10px] text-zinc-500">{device ? `${device.numLeds} ${device.ledProfile} · ${device.hasLayout ? `layout ${device.layoutSource}` : 'strand-only'}` : '—'}</span>
        </div>
        <DeviceViewer
          height={420}
          origin={kind === 'megadrome' ? { x: mdOriginX, y: mdOriginY, z: mdOriginZ } : null}
        />
      </section>
    </div>
  );
}

// Compact always-on 12-band spectrum meter. Reads the audio bus's `bands`
// (percentile, solid bar) with `bandsMinMax` (robust-minmax) faded behind.
// Reflects whatever source is active — musicbox eq12, synth, or mic — since
// every source populates these. Bars are hue-coded low→high.
function BandMeter({ bands, minMax }: { bands?: number[]; minMax?: number[] }) {
  const vals = bands && bands.length ? bands : new Array(12).fill(0);
  const mm = minMax && minMax.length ? minMax : [];
  return (
    <div className="space-y-0.5">
      <div className="flex items-end gap-0.5 h-10">
        {vals.map((v, i) => (
          <div key={i} className="relative flex-1 h-full bg-zinc-950 rounded-sm overflow-hidden" title={`band ${i}`}>
            <div className="absolute bottom-0 inset-x-0 bg-zinc-700" style={{ height: `${(mm[i] ?? 0) * 100}%` }} />
            <div className="absolute bottom-0 inset-x-0" style={{ height: `${(v ?? 0) * 100}%`, backgroundColor: `hsl(${(i / 12) * 280}, 75%, 55%)` }} />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[9px] text-zinc-600 font-mono">
        <span>low</span>
        <span>12-band · solid = percentile · faded = min-max</span>
        <span>high</span>
      </div>
    </div>
  );
}

function Slider({ label, min, max, step, value, onChange, accentHue }: {
  label: string; min: number; max: number; step: number; value: number;
  onChange: (n: number) => void;
  // When set, the label and the native slider track/thumb tint to this
  // hue. Used so the "hue center" knob shows you the color you're picking.
  accentHue?: number;
}) {
  const labelColor = accentHue != null ? `hsl(${accentHue}, 80%, 60%)` : undefined;
  const accentColor = accentHue != null ? `hsl(${accentHue}, 80%, 50%)` : undefined;
  return (
    <div className="flex items-center gap-2 text-xs text-zinc-400 font-mono">
      <span className="w-16" style={labelColor ? { color: labelColor } : undefined}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(+e.target.value)}
        className="flex-1"
        style={accentColor ? { accentColor } : undefined} />
      <span className="w-14 text-right">{typeof value === 'number' ? value.toFixed(step < 1 ? 2 : 0) : ''}</span>
    </div>
  );
}
