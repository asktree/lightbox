import { useState, useEffect, useRef } from 'react';
import { Spectrum } from './components/Spectrum';
import { SpectrumPulse } from './components/SpectrumPulse';
import { OnsetTimeline, type MadmomOnsets } from './components/OnsetTimeline';
import { EnvelopeTimeline } from './components/EnvelopeTimeline';
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

// Empirical-CDF percentile lookup. `sorted` is a presorted Float32Array;
// returns the fraction of entries < `v` (i.e., rank / N). Used to remap
// per-stem energy/chroma to a uniform [0,1] over the track so binding
// brightness averages 50% regardless of mix loudness.
function valueToPercentile(sorted: Float32Array, v: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo / sorted.length;
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
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try { await refreshQueue(); }
      finally { inFlight = false; }
    };
    tick();
    const t = window.setInterval(tick, 2000);
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
  // Drag-to-reorder. Optimistically reorder locally, then PUT the move;
  // reconcile with the server's response (or refetch on failure).
  const dragIndexRef = useRef<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const apiMove = async (from: number, to: number) => {
    if (from === to) return;
    setQueueState(prev => {
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
    try {
      const r = await fetch('/api/queue/move', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to }),
      });
      if (r.ok) setQueueState(await r.json());
      else refreshQueue();
    } catch { refreshQueue(); }
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

  // Push current playback state to musicbox server so external consumers
  // (twinklybox) can follow what's playing. Event-driven only — server
  // interpolates position between pushes based on elapsed wall time.
  const pushPlayback = (partial: { trackId?: string | null; position?: number; playing?: boolean }) => {
    // Visible in browser devtools so we can confirm the push fires on
    // pause/play/seek. Cheap; one log per real user action.
    console.log('[playback push]', partial);
    fetch('/api/playback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    }).catch((e) => console.error('[playback push] failed:', e));
  };
  // Per-stem output gain (0..1). Replaces the old mute toggle — 0 = silent
  // (same as the old mute), 1 = full. Applied via each stem's GainNode.
  const [stemGain, setStemGain] = useState<Record<Stem, number>>({
    drums: 1, bass: 1, vocals: 1, other: 1,
  });

  // Per-render-frame analysis state (React state, re-renders at rAF rate)
  const [stemSpectrum, setStemSpectrum] = useState<Record<Stem, number[]>>({
    drums: EMPTY_ARR, bass: EMPTY_ARR, vocals: EMPTY_ARR, other: EMPTY_ARR,
  });

  // Track-change & play/pause pushes. Position pushes happen in onSeeked
  // below since seek is the only other user action that jumps position.
  useEffect(() => {
    pushPlayback({ trackId: selected?.id ?? null, position: 0, playing: false });
  }, [selected?.id]);
  // Playback edge push, delayed by the user's effective offset so the
  // playing=true/false transition lands at audible time rather than at the
  // moment the user clicks play/pause. Without this, on AirPlay (which
  // buffers ~2s of audio before/after the click):
  //
  //   - Hitting PAUSE freezes external consumers (twinklybox) instantly,
  //     while speakers continue draining the buffer for ~2s. Lights stop
  //     while you're still hearing music.
  //   - Hitting PLAY animates lights instantly, while speakers stay silent
  //     for ~2s waiting for the buffer to fill. Lights dance before any
  //     sound emerges.
  //
  // Delaying the edge push by `effectiveOffsetMs` lines the transitions up
  // with what the listener actually experiences.
  //
  // Subtleties handled below:
  //  · PAUSE: master.currentTime is frozen at the pause moment, so we
  //    capture it NOW (closure) and push that value when the timeout
  //    fires. firePositionRef would otherwise carry the audible-time
  //    formula (master − offset) and be 2s behind the actual stop point.
  //  · PLAY:  master.currentTime keeps advancing, so we read
  //    firePositionRef.current AT the moment the timeout fires — by then
  //    it equals (master at T+offset) − offset ≈ position the listener is
  //    just starting to hear. No need to capture early.
  //  · Rapid toggle (play→pause→play within offsetMs) cancels the pending
  //    timeout via cleanup and reschedules from the new state, so micro-
  //    fiddling doesn't cause spurious mid-buffer pushes.
  //  · effOffMs <= 0 falls through to an immediate push (matches old
  //    behavior; no point in setTimeout(0)).
  useEffect(() => {
    const effOffMs = effectiveOffsetMsRef.current ?? 0;
    // Snapshot the pause point at click moment (master.currentTime freezes
    // when paused; firePositionRef would lag it by the offset).
    const pausePosCaptured = playing
      ? NaN
      : (audioElsRef.current.drums?.currentTime ?? firePositionRef.current);
    const fire = () => {
      const pos = playing ? firePositionRef.current : pausePosCaptured;
      pushPlayback({ position: pos, playing });
    };
    if (effOffMs <= 0) { fire(); return; }
    const t = window.setTimeout(fire, effOffMs);
    return () => window.clearTimeout(t);
  }, [playing]);
  const [triggers, setTriggers] = useState({ low: false, high: false });


  // Audio context + per-stem audio element and analyser references. Populated
  // by <StemTrack> children via callbacks — see the useAudioAnalyser hook.
  const [audioCtx, setAudioCtx] = useState<AudioContext | null>(null);
  const audioElsRef = useRef<Partial<Record<Stem, HTMLAudioElement>>>({});
  const analyzersRef = useRef<Partial<Record<Stem, AnalyserNode>>>({});

  // ---- Master EQ ----
  //
  // 3-band shelving EQ inserted between the stem outputs and the speakers:
  //   stems → eqInput → bass(lowshelf) → mid(peaking) → treble(highshelf) → destination
  // Persisted via localStorage so settings survive refresh. Filter nodes are
  // created alongside the AudioContext (see effect below) so eqInputRef is
  // populated *before* setAudioCtx commits — that way useStemAudioGraph
  // wires to the EQ input on its first run, no race.
  const [eqBass, setEqBass] = useState(() => {
    try { const v = localStorage.getItem('musicbox:eq.bass'); return v == null ? 0 : +v; } catch { return 0; }
  });
  const [eqMid, setEqMid] = useState(() => {
    try { const v = localStorage.getItem('musicbox:eq.mid'); return v == null ? 0 : +v; } catch { return 0; }
  });
  const [eqTreble, setEqTreble] = useState(() => {
    try { const v = localStorage.getItem('musicbox:eq.treble'); return v == null ? 0 : +v; } catch { return 0; }
  });
  const eqInputRef = useRef<GainNode | null>(null);
  const eqBassRef = useRef<BiquadFilterNode | null>(null);
  const eqMidRef = useRef<BiquadFilterNode | null>(null);
  const eqTrebleRef = useRef<BiquadFilterNode | null>(null);
  useEffect(() => { try { localStorage.setItem('musicbox:eq.bass', String(eqBass)); } catch {} }, [eqBass]);
  useEffect(() => { try { localStorage.setItem('musicbox:eq.mid', String(eqMid)); } catch {} }, [eqMid]);
  useEffect(() => { try { localStorage.setItem('musicbox:eq.treble', String(eqTreble)); } catch {} }, [eqTreble]);
  // Push live slider values to the filter nodes whenever they change.
  useEffect(() => { if (eqBassRef.current) eqBassRef.current.gain.value = eqBass; }, [eqBass]);
  useEffect(() => { if (eqMidRef.current) eqMidRef.current.gain.value = eqMid; }, [eqMid]);
  useEffect(() => { if (eqTrebleRef.current) eqTrebleRef.current.gain.value = eqTreble; }, [eqTreble]);
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
  // Parallel ref carrying robust min-max (p2..p98) normalized energy. Lets
  // each binding choose which normalization fits its stem on the current
  // song without us having to switch globally. See bindings rAF for the
  // pick site. Same lifecycle as stemEnergyRef.
  const stemEnergyMinMaxRef = useRef<Record<Stem, number>>({ drums: 0, bass: 0, vocals: 0, other: 0 });
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

  // Precomputed per-stem envelopes for the WHOLE track, sampled at
  // ENVELOPE_SR Hz. Lets EnvelopeTimeline show future (incoming) values
  // the same way OnsetTimeline shows future onsets — both are "the entire
  // track's analysis, indexed by time." Populated once per track via
  // decodeAudioData + per-chunk RMS (energy) and zero-crossing rate
  // (chroma proxy, since high-frequency content drives ZCR up). ~400KB
  // per envelope per 7-min track, two envelopes ≈ 800KB total.
  const ENVELOPE_SR = 60;
  // `sorted` is a sorted copy of `samples` used for percentile-rank lookup
  // (empirical CDF). Letting bindings read percentile rather than raw
  // amplitude makes brightness average to 50% over the track regardless
  // of mix loudness — see binding-side rAF below for the actual mapping.
  type Envelope = { samples: Float32Array; sorted: Float32Array; sr: number; max: number };
  const energyEnvelopesRef = useRef<Partial<Record<Stem, Envelope>>>({});
  const chromaEnvelopesRef = useRef<Partial<Record<Stem, Envelope>>>({});
  // Bump on track change so the timelines re-read. We don't pass the
  // envelopes as state because they'd cause heavy re-renders; the ref
  // is read inside the rAF render loop.
  const [envelopeVersion, setEnvelopeVersion] = useState(0);

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
    let inFlight = false;
    const LIGHTBOX = 'http://localhost:3001';
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const r = await fetch(`${LIGHTBOX}/api/audio-latency`);
        const j = await r.json();
        if (cancelled) return;
        if (typeof j.output_latency_ms === 'number') setOutputLatencyMs(j.output_latency_ms);
      } catch { /* ignore */ }
      finally { inFlight = false; }
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

    // Build the master EQ chain BEFORE committing audioCtx state. That way
    // when useStemAudioGraph sees the new audioCtx on the next render,
    // eqInputRef.current is already populated and stems wire directly to
    // the EQ input on their first connection — no late-rewiring needed.
    const input = ctx.createGain();
    const bass = ctx.createBiquadFilter();
    bass.type = 'lowshelf';
    bass.frequency.value = 200;
    bass.gain.value = eqBass;
    const mid = ctx.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = 1000;
    mid.Q.value = 0.7;
    mid.gain.value = eqMid;
    const treble = ctx.createBiquadFilter();
    treble.type = 'highshelf';
    treble.frequency.value = 4000;
    treble.gain.value = eqTreble;
    input.connect(bass);
    bass.connect(mid);
    mid.connect(treble);
    treble.connect(ctx.destination);
    eqInputRef.current = input;
    eqBassRef.current = bass;
    eqMidRef.current = mid;
    eqTrebleRef.current = treble;

    setAudioCtx(ctx);
  }, [selected, audioCtx]);

  // Precompute per-stem energy + chroma envelopes for the whole track.
  // Fetches each stem's audio, decodes it, walks chunks computing both
  // RMS (amplitude → energy) and ZCR (zero-crossing rate → pitch-height
  // proxy) in a single pass. ~50-200ms per stem. Aborted via `cancelled`
  // if the user changes tracks before decode finishes.
  useEffect(() => {
    if (!selected || !audioCtx) return;
    let cancelled = false;
    energyEnvelopesRef.current = {};
    chromaEnvelopesRef.current = {};
    setEnvelopeVersion(v => v + 1);
    (async () => {
      for (const stem of STEMS) {
        try {
          const r = await fetch(`/api/library/${selected.id}/stem/${stem}`);
          if (!r.ok) continue;
          const buf = await r.arrayBuffer();
          if (cancelled) return;
          const audioBuf = await audioCtx.decodeAudioData(buf);
          if (cancelled) return;
          const ch = audioBuf.getChannelData(0);
          const samplesPerChunk = Math.max(1, Math.round(audioBuf.sampleRate / ENVELOPE_SR));
          const numChunks = Math.ceil(ch.length / samplesPerChunk);
          const energyOut = new Float32Array(numChunks);
          const chromaOut = new Float32Array(numChunks);
          let eMax = 0, cMax = 0;
          for (let i = 0; i < numChunks; i++) {
            const s = i * samplesPerChunk;
            const e = Math.min(ch.length, s + samplesPerChunk);
            const n = Math.max(1, e - s);
            let sumSq = 0;
            let zc = 0;
            let prev = s > 0 ? ch[s - 1] : 0;
            for (let j = s; j < e; j++) {
              const v = ch[j];
              sumSq += v * v;
              // Sign change = zero crossing. Skip exact zeros to avoid
              // counting them twice on noisy approach.
              if ((prev >= 0) !== (v >= 0)) zc++;
              prev = v;
            }
            const rms = Math.sqrt(sumSq / n);
            const zcr = zc / n;
            energyOut[i] = rms;
            chromaOut[i] = zcr;
            if (rms > eMax) eMax = rms;
            if (zcr > cMax) cMax = zcr;
          }
          if (cancelled) return;
          // Sort copies for percentile-rank queries (empirical CDF).
          // `.slice()` so the visualization keeps the time-ordered array.
          const energySorted = energyOut.slice();
          energySorted.sort();
          const chromaSorted = chromaOut.slice();
          chromaSorted.sort();
          energyEnvelopesRef.current[stem] = { samples: energyOut, sorted: energySorted, sr: ENVELOPE_SR, max: eMax };
          chromaEnvelopesRef.current[stem] = { samples: chromaOut, sorted: chromaSorted, sr: ENVELOPE_SR, max: cMax };
          setEnvelopeVersion(v => v + 1);
        } catch {
          // Stem missing / decode failure — silently skip; the row will
          // just stay empty.
        }
      }
    })();
    return () => { cancelled = true; };
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

        // Keep the play/pause button in sync with reality. The event-based
        // approach (onPlay/onPause on <audio>) misses cases like a track
        // unmounting while "playing" was true, leaving the button stale.
        setPlaying(prev => (prev !== !master.paused ? !master.paused : prev));

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

          // Per-stem normalization for binding values. Two views computed
          // simultaneously so each binding can pick which suits its stem:
          //   stemEnergyRef       = empirical-CDF rank (percentile). Uniform
          //                         on [0,1], song-average ≈ 0.5. Good for
          //                         dense songs; lifts noise floor on songs
          //                         with long silent stretches.
          //   stemEnergyMinMaxRef = robust min-max using p2..p98 bounds.
          //                         Silence (≤p2) → 0, peaks (≥p98) → 1,
          //                         outlier-immune at both ends. No
          //                         auto-50% guarantee but handles songs
          //                         with sparse stems cleanly.
          // Falls back to ring values during the brief decode window after
          // track select.
          const firePosSec = firePositionRef.current;
          for (const stem of STEMS) {
            const eEnv = energyEnvelopesRef.current[stem];
            if (eEnv && eEnv.sorted.length > 0) {
              const i = Math.min(eEnv.samples.length - 1, Math.max(0, Math.floor(firePosSec * eEnv.sr)));
              const raw = eEnv.samples[i];
              stemEnergyRef.current[stem] = valueToPercentile(eEnv.sorted, raw);
              // Robust min-max with p2/p98 bounds.
              const n = eEnv.sorted.length;
              const lo = eEnv.sorted[Math.floor(0.02 * n)];
              const hi = eEnv.sorted[Math.min(n - 1, Math.floor(0.98 * n))];
              const span = hi - lo;
              stemEnergyMinMaxRef.current[stem] = span > 1e-9 ? Math.max(0, Math.min(1, (raw - lo) / span)) : 0;
            }
            // Chroma stays percentile-mapped (it's already bounded in a
            // meaningful range; min-max stretching it has no real win).
            const cEnv = chromaEnvelopesRef.current[stem];
            if (cEnv && cEnv.sorted.length > 0) {
              const i = Math.min(cEnv.samples.length - 1, Math.max(0, Math.floor(firePosSec * cEnv.sr)));
              stemChromaRef.current[stem] = valueToPercentile(cEnv.sorted, cEnv.samples[i]);
            }
          }
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
                draggable
                onDragStart={(e) => { dragIndexRef.current = i; e.dataTransfer.effectAllowed = 'move'; }}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragOverIdx !== i) setDragOverIdx(i); }}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = dragIndexRef.current;
                  if (from !== null) apiMove(from, i);
                  dragIndexRef.current = null;
                  setDragOverIdx(null);
                }}
                onDragEnd={() => { dragIndexRef.current = null; setDragOverIdx(null); }}
                className={`group flex items-center gap-2 px-3 py-1.5 border-b text-xs hover:bg-zinc-900
                  ${dragOverIdx === i ? 'border-t-2 border-t-purple-500 border-b-zinc-900/50' : 'border-b-zinc-900/50'}`}
              >
                <span className="cursor-grab active:cursor-grabbing text-zinc-700 hover:text-zinc-400 select-none" title="Drag to reorder">⠿</span>
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

        {/* Master 3-band EQ — bass (200 Hz lowshelf) / mid (1 kHz peaking,
            Q=0.7) / treble (4 kHz highshelf). Each slider ±15 dB. Applies
            to all stems before they hit the speakers. Click a label to
            reset that band to 0; click "EQ" to reset all three. */}
        <div className="border-t border-zinc-800 px-3 py-2 space-y-1.5">
          <div className="flex items-center justify-between">
            <button
              onClick={() => { setEqBass(0); setEqMid(0); setEqTreble(0); }}
              className="text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300 font-mono"
              title="Reset all bands to 0 dB"
            >EQ</button>
            <span className="text-[9px] text-zinc-700 font-mono">±15 dB</span>
          </div>
          {([
            { label: 'bass',   value: eqBass,   set: setEqBass   },
            { label: 'mid',    value: eqMid,    set: setEqMid    },
            { label: 'treble', value: eqTreble, set: setEqTreble },
          ] as const).map((band) => (
            <div key={band.label} className="flex items-center gap-2 text-[10px] font-mono">
              <button
                onClick={() => band.set(0)}
                className="w-10 text-left text-zinc-500 hover:text-zinc-300"
                title={`Reset ${band.label} to 0 dB`}
              >{band.label}</button>
              <input type="range" min={-15} max={15} step={0.5}
                value={band.value}
                onChange={(e) => band.set(+e.target.value)}
                className="flex-1 accent-zinc-400" />
              <span className={`w-9 text-right tabular-nums ${band.value === 0 ? 'text-zinc-600' : band.value > 0 ? 'text-emerald-400' : 'text-amber-400'}`}>
                {band.value > 0 ? '+' : ''}{band.value.toFixed(1)}
              </span>
            </div>
          ))}
        </div>
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
                volume={stemGain[stem]}
                audioCtx={audioCtx}
                audioDest={eqInputRef.current}
                // No auto-repeat — when a track ends and the queue is empty,
                // playback just stops. Queue head advance still works.
                loop={false}
                onAudio={(el) => { audioElsRef.current[stem] = el ?? undefined; }}
                onAnalyser={(a) => { analyzersRef.current[stem] = a ?? undefined; }}
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
                  // Push the offset-corrected position, matching what
                  // [playing] does — so external followers stay in sync
                  // with what the user is actually hearing post-offset.
                  const effOffMs = effectiveOffsetMsRef.current ?? 0;
                  pushPlayback({ position: Math.max(0, t - effOffMs / 1000), playing });
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
                        volume={stemGain[stem]}
                        onVolumeChange={(v) => setStemGain(g => ({ ...g, [stem]: v }))}
                      />
                    ))}
                  </div>
                </SpectrumPulse>
              </div>

              {/* Onset timeline gets its own flex share; the precomputed
                  envelope charts below are shrink-0 siblings so they don't
                  compete with the onset rows for the same vertical budget. */}
              <div className="flex-[2] min-h-0 border-t border-zinc-800/50">
                {madmom ? (
                  <OnsetTimeline data={madmom} positionRef={positionRef} beats={analysis.beats} />
                ) : (
                  <div className="h-full flex items-center justify-center text-[11px] text-zinc-600 font-mono">
                    no madmom_onsets.json for this track
                  </div>
                )}
              </div>

              {/* Per-stem precomputed envelopes — energy (RMS) above,
                  chroma (ZCR proxy for pitch height) below. Both align
                  with the onset timeline (same time axis + label gutter)
                  so future values scroll in just like upcoming onsets. */}
              <div className="shrink-0 border-t border-zinc-800/50">
                <div className="text-[9px] font-mono uppercase tracking-wider text-zinc-600 px-2 py-0.5 border-b border-zinc-800/30">energy</div>
                <EnvelopeTimeline
                  envelopesRef={energyEnvelopesRef}
                  positionRef={positionRef}
                  version={envelopeVersion}
                />
              </div>
              <div className="shrink-0 border-t border-zinc-800/50">
                <div className="text-[9px] font-mono uppercase tracking-wider text-zinc-600 px-2 py-0.5 border-b border-zinc-800/30">chroma</div>
                <EnvelopeTimeline
                  envelopesRef={chromaEnvelopesRef}
                  positionRef={positionRef}
                  version={envelopeVersion}
                />
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
          stemEnergyMinMaxRef={stemEnergyMinMaxRef}
          stemChromaRef={stemChromaRef}
        />
      </main>
    </div>
    </div>
  );
}

// ---- Stem spectrum pane ----

function StemPane({ label, data, volume, onVolumeChange }: {
  label: string; data: number[]; volume: number; onVolumeChange: (v: number) => void;
}) {
  // Fade the pane toward silent as the stem is turned down (full at 1,
  // floor at ~0.3 opacity so the spectrum's still visible when muted).
  const opacity = 0.3 + 0.7 * volume;
  return (
    <div className="relative min-w-0 min-h-0 border border-zinc-900/50" style={{ opacity }}>
      <div className="absolute top-1 left-2 z-10 flex items-center gap-2 text-[10px] uppercase tracking-wider text-zinc-400 font-mono select-none">
        <span className="w-12">{label}</span>
        <input
          type="range" min={0} max={1} step={0.01} value={volume}
          onChange={(e) => onVolumeChange(+e.target.value)}
          className="w-20 accent-zinc-400 cursor-pointer"
          title={`${label} volume — ${Math.round(volume * 100)}%`}
        />
        <span className="w-7 text-right tabular-nums text-zinc-500">{Math.round(volume * 100)}</span>
      </div>
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
  audioCtx: AudioContext | null,
  // Where the stem's gain output feeds. Pass the master-EQ input here so
  // every stem's audio flows through the shared filter chain on its way to
  // the speakers. If null/undefined, falls back to audioCtx.destination.
  destination: AudioNode | null | undefined,
): { analyser: AnalyserNode | null; gain: GainNode | null } {
  const [nodes, setNodes] = useState<{ analyser: AnalyserNode | null; gain: GainNode | null }>({
    analyser: null, gain: null,
  });

  useEffect(() => {
    if (!audioEl || !audioCtx) return;
    let entry = MEDIA_GRAPH.get(audioEl);
    const dest = destination ?? audioCtx.destination;
    if (!entry) {
      try {
        const source = audioCtx.createMediaElementSource(audioEl);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = FFT_SIZE;
        analyser.smoothingTimeConstant = 0.3;
        const gain = audioCtx.createGain();
        source.connect(analyser);
        analyser.connect(gain);
        gain.connect(dest);
        entry = { source, analyser, gain };
        MEDIA_GRAPH.set(audioEl, entry);
      } catch (err) {
        console.error('useStemAudioGraph: setup failed', err);
        return;
      }
    } else {
      // Re-pointing the existing graph at a new destination (e.g. when the
      // EQ chain is rebuilt). Disconnect prior wiring; reconnect to the
      // new sink. Safe to call even if not previously connected.
      try { entry.gain.disconnect(); } catch { /* ignore */ }
      entry.gain.connect(dest);
    }
    setNodes({ analyser: entry.analyser, gain: entry.gain });
    return () => setNodes({ analyser: null, gain: null });
  }, [audioEl, audioCtx, destination]);

  return nodes;
}

function StemTrack({
  url, volume, audioCtx, audioDest, onAudio, onAnalyser, onEnded, onSeeked, loop,
}: {
  url: string;
  volume: number;
  audioCtx: AudioContext | null;
  // Shared master-EQ input node from App. Stems plug into this instead of
  // audioCtx.destination so they pass through the bass/mid/treble filters.
  audioDest: AudioNode | null;
  onAudio: (el: HTMLAudioElement | null) => void;
  onAnalyser: (a: AnalyserNode | null) => void;
  // Play/pause state is polled in the rAF tick (setPlaying ←
  // !master.paused) so we no longer wire onPlay/onPause through.
  // onEnded stays because queue-advance wants a one-shot event, not a
  // boolean poll.
  onEnded?: () => void;
  onSeeked?: (t: number) => void;
  loop?: boolean;
}) {
  const [el, setEl] = useState<HTMLAudioElement | null>(null);
  const { analyser, gain } = useStemAudioGraph(el, audioCtx, audioDest);

  // Expose element and analyser upward. Refs are kept in sync via these.
  useEffect(() => { onAudio(el); }, [el, onAudio]);
  useEffect(() => { onAnalyser(analyser); }, [analyser, onAnalyser]);

  // Volume via the GainNode rather than el.volume — keeps the analyser fed,
  // so the spectrum stays alive in the UI even at zero output.
  useEffect(() => {
    if (gain) gain.gain.value = volume;
  }, [gain, volume]);

  return (
    <audio
      key={url}            // remount audio on URL change so the graph rebuilds cleanly
      ref={setEl}
      src={url}
      preload="auto"
      loop={loop}
      onEnded={onEnded}
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
