import { useState, useEffect, useRef } from 'react';
import { Spectrum } from './components/Spectrum';
import { SpectrumPulse } from './components/SpectrumPulse';
import { OnsetTimeline, type MadmomOnsets } from './components/OnsetTimeline';
import { LightPulseBindings } from './components/LightPulseBindings';
import { AutopilotBar } from './components/AutopilotBar';
import { OffsetBar } from './components/OffsetBar';

const STEMS = ['drums', 'bass', 'vocals', 'other'] as const;
type Stem = (typeof STEMS)[number];

const STEM_LABEL: Record<Stem, string> = {
  drums: 'Drums', bass: 'Bass', vocals: 'Vocals', other: 'Other',
};

// ---- Types ----

interface LibraryTrack {
  id: string;
  name: string;
  artists: string[];
  album?: string;
  duration_ms?: number;
  analyzed: boolean;
  bpm?: number;
  key?: string;
  mode?: string;
}

interface Analysis {
  version: number;
  duration: number;
  bpm: number;
  bpmConfidence?: number;
  key: string;
  mode: string;
  keyStrength?: number;
  beats: number[];
  onsetLowPeaks?: number[];
  onsetHighPeaks?: number[];
}

// ---- Web Audio constants ----

const FFT_SIZE = 2048;                    // matches analyser's default musical bin resolution
const FREQ_BINS = FFT_SIZE / 2;           // 1024 positive bins from AnalyserNode
const NUM_BARS = 128;

const EMPTY_ARR: number[] = [];

// ---- DSP helpers (ported from the Python analyzer) ----

// Precompute bin ranges for the log-spaced bars, reused every frame
function buildBarBinMap(numBars: number, bins: number, sampleRate: number): Array<[number, number]> {
  const minFreq = 20, maxFreq = 20000;
  const binWidth = sampleRate / (bins * 2);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < numBars; i++) {
    const fLo = minFreq * (maxFreq / minFreq) ** (i / numBars);
    const fHi = minFreq * (maxFreq / minFreq) ** ((i + 1) / numBars);
    out.push([
      Math.max(1, Math.floor(fLo / binWidth)),
      Math.min(bins - 1, Math.ceil(fHi / binWidth)),
    ]);
  }
  return out;
}

// AnalyserNode outputs dBFS. Convert to linear magnitude.
function dbToLinear(db: number): number {
  if (db <= -100) return 0;
  return Math.pow(10, db / 20);
}

// A-weighting — perceptual loudness curve. Attenuates freq ranges that human
// hearing is less sensitive to (heavy rolloff below 500Hz, mild above 6kHz).
// Applied as a linear multiplier per bin so bass drums don't visually
// dominate just because they have more physical energy.
function aWeight(freq: number): number {
  if (freq < 1) return 0;
  const f2 = freq * freq;
  const num = 12194 ** 2 * f2 * f2;
  const den =
    (f2 + 20.6 ** 2) *
    Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) *
    (f2 + 12194 ** 2);
  return den === 0 ? 0 : num / den;
}

// Precomputed A-weight table. The curve is smooth enough that 44.1kHz vs
// 48kHz produces imperceptible differences, so we pick one and bake it.
const A_WEIGHTS: Float32Array = (() => {
  const SR = 48000;   // assume the common browser sample rate
  const ref = aWeight(1000);
  const w = new Float32Array(FREQ_BINS);
  for (let i = 0; i < FREQ_BINS; i++) {
    const f = (i * SR) / (FREQ_BINS * 2);
    w[i] = aWeight(f) / ref;
  }
  return w;
})();

// ---- App ----

export default function App() {
  const [library, setLibrary] = useState<LibraryTrack[]>([]);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<LibraryTrack | null>(null);
  // Measured audio-output latency (ms) — how much the <audio> element's
  // currentTime runs ahead of what the user actually hears. Subtracted from
  // playhead so every visualization and every onset-crossing fires in
  // sync with audible sound. Polled from autopilot's state file (which gets
  // it from CoreAudio). Falls back to 0 if unavailable.
  const [outputLatencyMs, setOutputLatencyMs] = useState<number>(0);
  const outputLatencyMsRef = useRef(0);
  useEffect(() => { outputLatencyMsRef.current = outputLatencyMs; }, [outputLatencyMs]);
  // Effective offset (ms) — written by OffsetBar to localStorage on every
  // change. Read each rAF to apply uniformly across viz + bindings. We do
  // not own the value here; OffsetBar is the single source.
  const effectiveOffsetMsRef = useRef<number>(0);
  // Fire-time playhead = master.currentTime − effectiveOffsetMs/1000. Used
  // by LightPulseBindings for peak crossings, the same way autopilot's
  // pos_s = playhead - offset works. positionRef stays at audible time
  // for OnsetTimeline / Scrubber.
  const firePositionRef = useRef(0);
  // Queue of tracks to play after the current one ends. Advances FIFO.
  // Owned server-side (musicbox/src/server/index.ts) so curl / external
  // tools can enqueue. Local mirror is polled every ~2s; mutations go
  // through the API and use the response to update local state.
  const [queue, setQueueState] = useState<LibraryTrack[]>([]);
  const queueRef = useRef<LibraryTrack[]>([]);
  useEffect(() => { queueRef.current = queue; }, [queue]);
  const refreshQueue = async () => {
    try {
      const r = await fetch('/api/queue');
      if (!r.ok) return;
      setQueueState(await r.json());
    } catch { /* ignore */ }
  };
  useEffect(() => {
    refreshQueue();
    const t = window.setInterval(refreshQueue, 2000);
    return () => clearInterval(t);
  }, []);
  const apiEnqueue = async (trackId: string) => {
    try {
      const r = await fetch('/api/queue', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackId }),
      });
      if (r.ok) { const j = await r.json(); setQueueState(j.queue); }
    } catch { /* ignore */ }
  };
  const apiRemoveAt = async (idx: number) => {
    try {
      const r = await fetch(`/api/queue/${idx}`, { method: 'DELETE' });
      if (r.ok) setQueueState(await r.json());
    } catch { /* ignore */ }
  };
  const apiClearQueue = async () => {
    try {
      const r = await fetch('/api/queue', { method: 'DELETE' });
      if (r.ok) setQueueState(await r.json());
    } catch { /* ignore */ }
  };
  // Set to true when we advance to a track via the queue, so the effect on
  // `selected` knows to auto-play (can't call play() before the audio
  // element mounts with the new src).
  const autoPlayNextRef = useRef(false);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [madmom, setMadmom] = useState<MadmomOnsets | null>(null);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const positionRef = useRef(0);
  const [muted, setMuted] = useState<Record<Stem, boolean>>({
    drums: false, bass: false, vocals: false, other: false,
  });

  // Per-render-frame analysis state (React state, re-renders at rAF rate)
  const [stemSpectrum, setStemSpectrum] = useState<Record<Stem, number[]>>({
    drums: EMPTY_ARR, bass: EMPTY_ARR, vocals: EMPTY_ARR, other: EMPTY_ARR,
  });
  const [triggers, setTriggers] = useState({ low: false, high: false });


  // Audio context + per-stem audio element and analyser references. Populated
  // by <StemTrack> children via callbacks — see the useAudioAnalyser hook.
  const [audioCtx, setAudioCtx] = useState<AudioContext | null>(null);
  const audioElsRef = useRef<Partial<Record<Stem, HTMLAudioElement>>>({});
  const analyzersRef = useRef<Partial<Record<Stem, AnalyserNode>>>({});
  // Scratch buffers reused every frame (avoid allocation)
  const scratchDb = useRef(new Float32Array(FREQ_BINS));
  const scratchMag = useRef(new Float32Array(FREQ_BINS));
  const barBinMapRef = useRef<Array<[number, number]> | null>(null);
  // Shared slow-decay peak across ALL stems — so inter-stem relative loudness
  // is visible (drums' bass bar is tall, other's bass bar is shorter).
  const sharedPeakRef = useRef(1e-4);

  // Cursors into the madmom drums_low / drums_high peak arrays (for SpectrumPulse
  // low/high flashes — kick/hat stage-light analog)
  const lastLowPeakIdx = useRef(-1);
  const lastHighPeakIdx = useRef(-1);

  // Per-stem energy (mean of normalized bars). Used by LightPulseBindings
  // to drive continuous level-tracking (e.g. bass energy → bulb brightness).
  const stemEnergyRef = useRef<Record<Stem, number>>({ drums: 0, bass: 0, vocals: 0, other: 0 });
  // Per-stem chroma = spectral centroid (0-1) = "where in the spectrum the
  // stem's energy is centered right now". Roughly "how high or low" the
  // sound is. Used to map palette position from the stem's live timbre.
  const stemChromaRef = useRef<Record<Stem, number>>({ drums: 0.5, bass: 0.5, vocals: 0.5, other: 0.5 });

  // Per-stem ring buffer of recent {spectrum, energy, chroma, ts}. Sized
  // for ~3.3s @ 60fps so a 2-3s lookback (output_latency / offset on
  // AirPlay) can be served. Newest at the end. ~25 floats × 200 entries ×
  // 4 stems ≈ 80KB total — trivial.
  type RingFrame = { ts: number; spectrum: number[]; energy: number; chroma: number };
  const RING_SIZE = 200;
  const ringRef = useRef<Record<Stem, RingFrame[]>>({
    drums: [], bass: [], vocals: [], other: [],
  });

  // ---- Library + analysis loading ----

  useEffect(() => {
    fetch('/api/library').then(r => r.json()).then(setLibrary).catch(() => {});
  }, []);

  // Poll lightbox for the CoreAudio-measured output latency. The
  // /api/audio-latency endpoint spawns the CoreAudio probe directly (no
  // autopilot dependency) and caches; ?refresh=1 forces a remeasure
  // after switching output device. Without this correction, every viz
  // tracks the playhead while audio is delayed by output_latency, so
  // the user sees ~2s drift on AirPlay.
  useEffect(() => {
    let cancelled = false;
    const LIGHTBOX = 'http://localhost:3001';
    const tick = async () => {
      try {
        const r = await fetch(`${LIGHTBOX}/api/audio-latency`);
        const j = await r.json();
        if (cancelled) return;
        if (typeof j.output_latency_ms === 'number') setOutputLatencyMs(j.output_latency_ms);
      } catch { /* ignore */ }
    };
    tick();
    const t = window.setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  useEffect(() => {
    if (!selected) { setAnalysis(null); setMadmom(null); return; }
    setLoading(true);
    lastLowPeakIdx.current = -1;
    lastHighPeakIdx.current = -1;
    const id = selected.id;
    Promise.all([
      fetch(`/api/library/${id}/analysis`).then(r => r.ok ? r.json() : null),
      fetch(`/api/library/${id}/madmom-onsets`).then(r => r.ok ? r.json() : null),
    ]).then(([a, m]) => {
      setAnalysis(a);
      setMadmom(m);
      setLoading(false);
      // If we got here via queue advance, start playing the new track as
      // soon as its audio elements are ready.
      if (autoPlayNextRef.current) {
        autoPlayNextRef.current = false;
        // Defer past layout + <audio> mount; `canplay` would be more
        // correct but this is close enough in practice.
        setTimeout(() => {
          for (const stem of STEMS) audioElsRef.current[stem]?.play().catch(() => {});
        }, 200);
      }
    }).catch(() => setLoading(false));
  }, [selected]);

  // Build the AudioContext lazily on first track select (needs user gesture-ish)
  useEffect(() => {
    if (!selected || audioCtx) return;
    const ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new ctor();
    const sr = ctx.sampleRate;
    barBinMapRef.current = buildBarBinMap(NUM_BARS, FREQ_BINS, sr);
    setAudioCtx(ctx);
  }, [selected, audioCtx]);

  // (mute is applied inside <StemTrack>)

  // ---- rAF render loop ----

  useEffect(() => {
    let raf: number;

    const tick = () => {
      const master = audioElsRef.current.drums;
      const an = analysis;
      const ctx = audioCtx;

      if (master && ctx) {
        // Pull the latest effective offset written by OffsetBar. Single
        // source of truth for all latency-correction in the client.
        const rawOff = (typeof localStorage !== 'undefined') ? localStorage.getItem('lightbox:effectiveOffsetMs') : null;
        const effOffMs = rawOff != null ? Math.max(0, parseInt(rawOff, 10) || 0) : outputLatencyMsRef.current;
        effectiveOffsetMsRef.current = effOffMs;

        // positionRef = audible time (master − output_latency). Drives
        // OnsetTimeline / Scrubber. firePositionRef = master − offset,
        // matches autopilot's pos_s semantics so peak crossings fire at
        // the right moment for the slider's chosen offset.
        const posSec = Math.max(0, master.currentTime - outputLatencyMsRef.current / 1000);
        positionRef.current = posSec;
        setPosition(posSec);
        firePositionRef.current = Math.max(0, master.currentTime - effOffMs / 1000);

        // --- Trigger streams (for SpectrumPulse: kick glow + hat glow) ---
        // Driven by madmom drums_low / drums_high CNN peaks when available.
        const crossed = (arr: number[] | undefined, ref: { current: number }): boolean => {
          if (!arr) return false;
          let fired = false;
          for (let i = ref.current + 1; i < arr.length; i++) {
            if (arr[i] <= posSec) { fired = true; ref.current = i; }
            else break;
          }
          return fired;
        };
        const lowTrigger = crossed(madmom?.drums_low?.cnn, lastLowPeakIdx);
        const highTrigger = crossed(madmom?.drums_high?.cnn, lastHighPeakIdx);
        setTriggers({ low: lowTrigger, high: highTrigger });

        // --- Per-frame spectrum (only when playing, and only if analysis exists) ---
        if (!master.paused && an) {
          const barMap = barBinMapRef.current!;
          const db = scratchDb.current;
          const mag = scratchMag.current;

          // Spectrum: linear mags (A-weighted for perceptual balance), RMS per
          // log-spaced bar, normalized against a SHARED slow-decay peak so
          // inter-stem loudness is visible (bass stem's bars are genuinely
          // taller than other stem's bars when bass actually IS louder).
          const SHARED_DECAY = 0.9995;   // peak decays slowly (~5s time constant at 60fps)

          // First pass: compute raw RMS bars per stem, find the new max
          const rawStemBars: Record<Stem, number[]> = {
            drums: [], bass: [], vocals: [], other: [],
          };
          let frameMax = sharedPeakRef.current * SHARED_DECAY;
          for (const stem of STEMS) {
            const analyser = analyzersRef.current[stem];
            if (!analyser) continue;
            analyser.getFloatFrequencyData(db);
            // dB → linear, then A-weight
            for (let i = 0; i < FREQ_BINS; i++) mag[i] = dbToLinear(db[i]) * A_WEIGHTS[i];
            const bars = new Array<number>(NUM_BARS);
            for (let b = 0; b < NUM_BARS; b++) {
              const [lo, hi] = barMap[b];
              let sumSq = 0;
              const count = hi - lo + 1;
              for (let i = lo; i <= hi; i++) sumSq += mag[i] * mag[i];
              const v = Math.sqrt(sumSq / Math.max(1, count));
              bars[b] = v;
              if (v > frameMax) frameMax = v;
            }
            rawStemBars[stem] = bars;
          }
          sharedPeakRef.current = Math.max(frameMax, 1e-4);

          // Second pass: normalize against the shared peak, then push to
          // the ring buffer. Display + bindings read from the buffer at
          // lookback = effOffMs so all latency-correction is uniform.
          const peak = sharedPeakRef.current;
          const nowMs = performance.now();
          for (const stem of STEMS) {
            const raw = rawStemBars[stem];
            if (raw.length === 0) continue;
            const norm = new Array<number>(NUM_BARS);
            let sum = 0;
            // Spectral-centroid computation in the same pass: Σ(bar_index × energy) / Σ(energy).
            // Divided by (NUM_BARS - 1) gives a 0-1 value that's roughly
            // "pitch height" of the stem's current frame.
            let weighted = 0;
            for (let b = 0; b < NUM_BARS; b++) {
              norm[b] = Math.min(1, raw[b] / peak);
              sum += norm[b];
              weighted += b * norm[b];
            }
            const energy = sum / NUM_BARS;
            // Hold previous chroma if this frame is too quiet to estimate.
            const buf = ringRef.current[stem];
            const prev = buf.length > 0 ? buf[buf.length - 1] : null;
            const chroma = sum > 0.02 ? weighted / sum / (NUM_BARS - 1) : (prev?.chroma ?? 0.5);
            buf.push({ ts: nowMs, spectrum: norm, energy, chroma });
            if (buf.length > RING_SIZE) buf.shift();
          }

          // Read back at lookback. Bindings (energy/chroma) and display
          // (spectrum) all see the same delayed frame.
          const targetTs = nowMs - effOffMs;
          const nextStemSpectrum: Record<Stem, number[]> = {
            drums: EMPTY_ARR, bass: EMPTY_ARR, vocals: EMPTY_ARR, other: EMPTY_ARR,
          };
          for (const stem of STEMS) {
            const buf = ringRef.current[stem];
            if (buf.length === 0) { stemEnergyRef.current[stem] = 0; continue; }
            // Walk back from newest. Buffer is small (≤200) — linear scan is fine.
            let match: RingFrame | null = null;
            for (let i = buf.length - 1; i >= 0; i--) {
              if (buf[i].ts <= targetTs) { match = buf[i]; break; }
            }
            // If lookback exceeds buffer span (e.g. just selected a track),
            // fall back to oldest available so display isn't blank.
            if (!match) match = buf[0];
            nextStemSpectrum[stem] = match.spectrum;
            stemEnergyRef.current[stem] = match.energy;
            stemChromaRef.current[stem] = match.chroma;
          }
          setStemSpectrum(nextStemSpectrum);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [analysis, madmom, audioCtx]);

  const filtered = library.filter(t => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return t.name.toLowerCase().includes(q) || t.artists.some(a => a.toLowerCase().includes(q));
  });

  const togglePlay = async () => {
    const ctx = audioCtx;
    if (ctx && ctx.state === 'suspended') await ctx.resume();
    // Nothing selected yet but queue has items? Pop the head and play.
    // Lets the user enqueue a few tracks and hit play without manually
    // picking one from the library.
    if (!selected && queue.length > 0) {
      const [next] = queue;
      autoPlayNextRef.current = true;
      setSelected(next);
      apiRemoveAt(0);
      return;
    }
    const allRefs = STEMS.map(s => audioElsRef.current[s]).filter(Boolean) as HTMLAudioElement[];
    const shouldPlay = allRefs.some(a => a.paused);
    if (shouldPlay) await Promise.allSettled(allRefs.map(a => a.play()));
    else allRefs.forEach(a => a.pause());
  };

  // Abandon current track, advance to next in queue. If queue is empty, no-op.
  const skipNext = () => {
    if (queue.length === 0) return;
    const [next] = queue;
    autoPlayNextRef.current = true;
    setSelected(next);
    apiRemoveAt(0);
  };

  const analyzedCount = library.filter(t => t.analyzed).length;
  const hasStems = analysis != null && analysis.version >= 3;

  return (
    <div className="h-screen bg-zinc-950 text-white flex flex-col overflow-hidden">
    <AutopilotBar />
    <OffsetBar />
    <div className="flex-1 flex min-h-0 overflow-hidden">
      {/* Play queue panel. Sits to the left of the library so you can see
          what's lined up without hovering anything. Drag-to-reorder would
          be nice but not built yet — remove via the × and re-add from the
          library is fine for now. */}
      <aside className="w-56 shrink-0 border-r border-zinc-800 flex flex-col bg-zinc-950">
        <div className="px-3 py-2 border-b border-zinc-800 flex items-center gap-2">
          <button
            onClick={togglePlay}
            disabled={!selected && queue.length === 0}
            className="flex-1 px-2 py-1 text-xs font-mono rounded bg-green-700 hover:bg-green-600 disabled:opacity-40 disabled:cursor-not-allowed text-white"
            title={!selected && queue.length === 0 ? 'Enqueue a track first' : (playing ? 'Pause' : 'Play')}
          >{playing ? '❚❚' : '▶'}</button>
          <button
            onClick={skipNext}
            disabled={queue.length === 0}
            className="px-2 py-1 text-xs font-mono rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed text-white"
            title="Skip to next queued track"
          >⏭</button>
          <span className="text-[10px] text-zinc-600 font-mono">{queue.length}</span>
        </div>
        <div className="flex-1 overflow-y-auto">
          {queue.length === 0 ? (
            <div className="px-3 py-4 text-[11px] text-zinc-600">
              No tracks queued.<br />
              <span className="text-zinc-700">Click + next to a song.</span>
            </div>
          ) : (
            queue.map((t, i) => (
              <div
                key={`${t.id}-${i}`}
                className="group flex items-center gap-2 px-3 py-1.5 border-b border-zinc-900/50 text-xs hover:bg-zinc-900"
              >
                <span className="text-zinc-600 font-mono w-4 text-right">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="truncate text-zinc-200">{t.name}</div>
                  <div className="truncate text-zinc-500 text-[10px]">{t.artists.join(', ')}</div>
                </div>
                <button
                  onClick={() => apiRemoveAt(i)}
                  title="Remove from queue"
                  className="w-5 h-5 rounded text-[11px] font-mono flex items-center justify-center
                    bg-zinc-800 text-zinc-500 hover:bg-zinc-700 hover:text-white"
                >×</button>
              </div>
            ))
          )}
        </div>
        {queue.length > 0 && (
          <button
            onClick={apiClearQueue}
            className="text-[10px] font-mono px-3 py-1.5 border-t border-zinc-800 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
          >clear queue</button>
        )}
      </aside>

      <aside className="w-80 shrink-0 border-r border-zinc-800 flex flex-col">
        <div className="px-3 py-2 border-b border-zinc-800">
          <h1 className="text-sm font-semibold text-zinc-200 mb-1">musicbox</h1>
          <div className="text-[10px] text-zinc-500 mb-2">
            {analyzedCount} / {library.length} analyzed
          </div>
          <input
            type="search"
            placeholder="filter..."
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="w-full bg-zinc-900 text-xs px-2 py-1 rounded border border-zinc-800 placeholder-zinc-600"
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {filtered.map(t => {
            const inQueue = queue.some(q => q.id === t.id);
            return (
              <div
                key={t.id}
                className={`relative w-full border-b border-zinc-900/50 text-xs transition-colors group
                  ${selected?.id === t.id ? 'bg-zinc-800' : 'hover:bg-zinc-900'}
                  ${t.analyzed ? 'text-zinc-200' : 'text-zinc-600'}`}
              >
                <button
                  onClick={() => t.analyzed && setSelected(t)}
                  disabled={!t.analyzed}
                  className={`w-full text-left px-3 py-2 pr-10 ${t.analyzed ? '' : 'cursor-not-allowed'}`}
                >
                  <div className="truncate font-medium">{t.name}</div>
                  <div className="truncate text-zinc-500 text-[10px]">
                    {t.artists.join(', ')}
                    {t.analyzed && t.bpm != null && (
                      <> · {Math.round(t.bpm)} BPM · {t.key}{t.mode === 'minor' ? 'm' : ''}</>
                    )}
                    {!t.analyzed && ' · not analyzed'}
                  </div>
                </button>
                {t.analyzed && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const idx = queueRef.current.findIndex(x => x.id === t.id);
                      if (idx >= 0) apiRemoveAt(idx);
                      else apiEnqueue(t.id);
                    }}
                    title={inQueue ? 'Remove from queue' : 'Add to queue'}
                    className={`absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded text-xs font-mono
                      flex items-center justify-center
                      ${inQueue
                        ? 'bg-indigo-600 text-white'
                        : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white'}`}
                  >{inQueue ? '−' : '+'}</button>
                )}
              </div>
            );
          })}
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 flex flex-col min-h-0">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center text-zinc-500">Select a track</div>
        ) : loading || !analysis ? (
          <div className="flex-1 flex items-center justify-center text-zinc-500">Loading…</div>
        ) : (
          <>
            <header className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 shrink-0">
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate">{selected.name}</div>
                <div className="text-xs text-zinc-500 truncate">{selected.artists.join(', ')}</div>
              </div>
              <div className="flex items-center gap-3 text-xs text-zinc-400 shrink-0 ml-4">
                <span className="font-mono">{Math.round(analysis.bpm)} BPM</span>
                <span className="font-mono">{analysis.key}{analysis.mode === 'minor' ? 'm' : ''}</span>
              </div>
            </header>

            {STEMS.map(stem => (
              <StemTrack
                key={stem}
                url={hasStems ? `/api/library/${selected.id}/stem/${stem}` : `/api/library/${selected.id}/audio`}
                muted={muted[stem]}
                audioCtx={audioCtx}
                // No auto-repeat — when a track ends and the queue is empty,
                // playback just stops. Queue head advance still works.
                loop={false}
                onAudio={(el) => { audioElsRef.current[stem] = el ?? undefined; }}
                onAnalyser={(a) => { analyzersRef.current[stem] = a ?? undefined; }}
                onPlay={stem === 'drums' ? () => setPlaying(true) : undefined}
                onPause={stem === 'drums' ? () => setPlaying(false) : undefined}
                // Only the drums (master) stem drives queue advance to avoid
                // firing 4x per end. Pop head, set as selected, mark autoplay.
                onEnded={stem === 'drums' ? () => {
                  const next = queueRef.current[0];
                  if (!next) return;
                  autoPlayNextRef.current = true;
                  setSelected(next);
                  apiRemoveAt(0);
                } : undefined}
                onSeeked={stem === 'drums' ? (t) => {
                  lastLowPeakIdx.current = (madmom?.drums_low?.cnn ?? []).filter(p => p <= t).length - 1;
                  lastHighPeakIdx.current = (madmom?.drums_high?.cnn ?? []).filter(p => p <= t).length - 1;
                } : undefined}
              />
            ))}

            <div className="flex-1 flex flex-col min-h-0">
              <div className="flex-[3] min-h-0">
                <SpectrumPulse lowTrigger={triggers.low} highTrigger={triggers.high}>
                  <div className="grid grid-cols-2 grid-rows-2 h-full w-full">
                    {STEMS.map(stem => (
                      <StemPane
                        key={stem}
                        label={STEM_LABEL[stem]}
                        data={stemSpectrum[stem]}
                        muted={muted[stem]}
                        onToggleMute={() => setMuted(m => ({ ...m, [stem]: !m[stem] }))}
                      />
                    ))}
                  </div>
                </SpectrumPulse>
              </div>

              <div className="flex-[2] min-h-0 border-t border-zinc-800/50 flex flex-col">
                <div className="flex-1 min-h-0">
                  {madmom ? (
                    <OnsetTimeline data={madmom} positionRef={positionRef} beats={analysis.beats} />
                  ) : (
                    <div className="h-full flex items-center justify-center text-[11px] text-zinc-600 font-mono">
                      no madmom_onsets.json for this track
                    </div>
                  )}
                </div>
              </div>
            </div>

            <Scrubber
              position={position}
              duration={analysis.duration}
              onSeek={(t) => {
                for (const stem of STEMS) {
                  const el = audioElsRef.current[stem];
                  if (el) el.currentTime = t;
                }
              }}
            />
          </>
        )}
        </div>
        {/* Always-rendered so binding state (mode, sources, sliders) survives
            track changes, loading transitions, and "no track selected". */}
        <LightPulseBindings
          data={madmom}
          firePositionRef={firePositionRef}
          playing={playing}
          stemEnergyRef={stemEnergyRef}
          stemChromaRef={stemChromaRef}
        />
      </main>
    </div>
    </div>
  );
}

// ---- Stem spectrum pane ----

function StemPane({ label, data, muted, onToggleMute }: {
  label: string; data: number[]; muted: boolean; onToggleMute: () => void;
}) {
  return (
    <div className={`relative min-w-0 min-h-0 border border-zinc-900/50 ${muted ? 'opacity-35' : ''}`}>
      <label className="absolute top-1 left-2 z-10 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-400 font-mono cursor-pointer select-none">
        <input type="checkbox" checked={!muted} onChange={onToggleMute} className="accent-zinc-400" />
        {label}
      </label>
      <Spectrum data={data} />
    </div>
  );
}

// ---- Self-contained audio stem component ----
//
// Owns one <audio> element and its Web Audio analyser graph. The audio
// element is keyed by `url` so any URL change (track switch) fully unmounts
// and remounts it — which fires the effect cleanup and fresh setup, with
// no stale refs to manage in the parent.
//
// createMediaElementSource can only be called once per <audio> element, so
// we memoize in a WeakMap keyed by the element. This makes the effect
// idempotent under React.StrictMode's double-run-in-dev.

const MEDIA_GRAPH = new WeakMap<
  HTMLAudioElement,
  { source: MediaElementAudioSourceNode; analyser: AnalyserNode; gain: GainNode }
>();

/**
 * Wires up Web Audio for an <audio> element.
 *   source → analyser → gain → destination
 * The GainNode lets us "mute" output without starving the analyser of data,
 * so muted stems can still render their spectrum (faded).
 */
function useStemAudioGraph(
  audioEl: HTMLAudioElement | null,
  audioCtx: AudioContext | null
): { analyser: AnalyserNode | null; gain: GainNode | null } {
  const [nodes, setNodes] = useState<{ analyser: AnalyserNode | null; gain: GainNode | null }>({
    analyser: null, gain: null,
  });

  useEffect(() => {
    if (!audioEl || !audioCtx) return;
    let entry = MEDIA_GRAPH.get(audioEl);
    if (!entry) {
      try {
        const source = audioCtx.createMediaElementSource(audioEl);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = FFT_SIZE;
        analyser.smoothingTimeConstant = 0.3;
        const gain = audioCtx.createGain();
        source.connect(analyser);
        analyser.connect(gain);
        gain.connect(audioCtx.destination);
        entry = { source, analyser, gain };
        MEDIA_GRAPH.set(audioEl, entry);
      } catch (err) {
        console.error('useStemAudioGraph: setup failed', err);
        return;
      }
    }
    setNodes({ analyser: entry.analyser, gain: entry.gain });
    return () => setNodes({ analyser: null, gain: null });
  }, [audioEl, audioCtx]);

  return nodes;
}

function StemTrack({
  url, muted, audioCtx, onAudio, onAnalyser, onPlay, onPause, onEnded, onSeeked, loop,
}: {
  url: string;
  muted: boolean;
  audioCtx: AudioContext | null;
  onAudio: (el: HTMLAudioElement | null) => void;
  onAnalyser: (a: AnalyserNode | null) => void;
  onPlay?: () => void;
  onPause?: () => void;
  onEnded?: () => void;
  onSeeked?: (t: number) => void;
  loop?: boolean;
}) {
  const [el, setEl] = useState<HTMLAudioElement | null>(null);
  const { analyser, gain } = useStemAudioGraph(el, audioCtx);

  // Expose element and analyser upward. Refs are kept in sync via these.
  useEffect(() => { onAudio(el); }, [el, onAudio]);
  useEffect(() => { onAnalyser(analyser); }, [analyser, onAnalyser]);

  // Mute via the GainNode rather than el.muted — keeps the analyser fed,
  // which keeps the faded spectrum alive in the UI.
  useEffect(() => {
    if (gain) gain.gain.value = muted ? 0 : 1;
  }, [gain, muted]);

  return (
    <audio
      key={url}            // remount audio on URL change so the graph rebuilds cleanly
      ref={setEl}
      src={url}
      preload="auto"
      loop={loop}
      onPlay={onPlay}
      onPause={onPause}
      onEnded={onEnded ?? onPause}
      onSeeked={onSeeked ? (e) => onSeeked((e.currentTarget as HTMLAudioElement).currentTime) : undefined}
    />
  );
}

// ---- Scrubber ----

function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function Scrubber({ position, duration, onSeek }: {
  position: number; duration: number; onSeek: (t: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const dragging = useRef(false);
  const lastSeek = useRef(0);

  const seekFromClientX = (clientX: number, force = false) => {
    const el = trackRef.current;
    if (!el) return;
    const now = performance.now();
    if (!force && now - lastSeek.current < 60) return;
    lastSeek.current = now;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    onSeek(ratio * duration);
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => { if (dragging.current) seekFromClientX(e.clientX); };
    const onUp = (e: MouseEvent) => {
      if (!dragging.current) return;
      dragging.current = false;
      seekFromClientX(e.clientX, true);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration]);

  const progressPct = duration > 0 ? (position / duration) * 100 : 0;
  const hoverPct = hoverX != null && trackRef.current
    ? (hoverX / trackRef.current.getBoundingClientRect().width) * 100
    : null;
  const hoverTime = hoverPct != null ? (hoverPct / 100) * duration : null;

  return (
    <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-t border-zinc-800 bg-zinc-950">
      <span className="text-[10px] text-zinc-500 font-mono tabular-nums w-10 text-right">
        {formatTime(position)}
      </span>
      <div
        ref={trackRef}
        onMouseDown={(e) => { dragging.current = true; seekFromClientX(e.clientX, true); }}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setHoverX(e.clientX - rect.left);
        }}
        onMouseLeave={() => setHoverX(null)}
        className="flex-1 h-2 bg-zinc-800 rounded-full cursor-pointer relative group"
      >
        <div className="h-full bg-zinc-400 rounded-full pointer-events-none" style={{ width: `${progressPct}%` }} />
        {hoverX != null && (
          <>
            <div className="absolute top-0 bottom-0 w-px bg-zinc-500 pointer-events-none" style={{ left: `${hoverPct}%` }} />
            <div className="absolute -top-6 bg-zinc-800 text-zinc-300 text-[10px] font-mono px-1.5 py-0.5 rounded pointer-events-none -translate-x-1/2 whitespace-nowrap" style={{ left: `${hoverPct}%` }}>
              {formatTime(hoverTime ?? 0)}
            </div>
          </>
        )}
        <div className="absolute top-1/2 w-3 h-3 rounded-full bg-white shadow pointer-events-none -translate-y-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity" style={{ left: `${progressPct}%` }} />
      </div>
      <span className="text-[10px] text-zinc-500 font-mono tabular-nums w-10">
        {formatTime(duration)}
      </span>
    </div>
  );
}
