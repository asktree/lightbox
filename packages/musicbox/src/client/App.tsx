import { useState, useEffect, useRef } from 'react';
import { Spectrum } from './components/Spectrum';
import { SpectrumPulse } from './components/SpectrumPulse';
import { EnergyBands } from './components/EnergyBands';
import { Chroma } from './components/Chroma';
import { OnsetIndicators } from './components/OnsetIndicators';

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

const BAND_DEFS: Record<keyof Bands, [number, number]> = {
  subBass: [20, 60],
  bass:    [60, 250],
  lowMid:  [250, 500],
  mid:     [500, 2000],
  highMid: [2000, 4000],
  high:    [4000, 20000],
};

interface Bands {
  subBass: number; bass: number; lowMid: number;
  mid: number; highMid: number; high: number;
}

const EMPTY_BANDS: Bands = { subBass: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, high: 0 };
const EMPTY_ARR: number[] = [];

// ---- DSP helpers (ported from the Python analyzer) ----

// A-weighting curve to flatten the perceptual bass dominance for visualization
function aWeight(freq: number): number {
  if (freq < 1) return 0;
  const f2 = freq * freq;
  const num = 12194 ** 2 * f2 * f2;
  const den =
    (f2 + 20.6 ** 2) *
    Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) *
    (f2 + 12194 ** 2);
  if (den === 0) return 0;
  return num / den;
}

function buildAWeights(bins: number, sampleRate: number): Float32Array {
  // Normalize so 1kHz = 1
  const ref = aWeight(1000);
  const w = new Float32Array(bins);
  for (let i = 0; i < bins; i++) {
    const f = (i * sampleRate) / (bins * 2);
    w[i] = aWeight(f) / ref;
  }
  return w;
}

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

function buildBandBinMap(bins: number, sampleRate: number): Record<keyof Bands, [number, number]> {
  const binWidth = sampleRate / (bins * 2);
  const out = {} as Record<keyof Bands, [number, number]>;
  for (const [name, [lo, hi]] of Object.entries(BAND_DEFS)) {
    out[name as keyof Bands] = [
      Math.max(1, Math.floor(lo / binWidth)),
      Math.min(bins - 1, Math.ceil(hi / binWidth)),
    ];
  }
  return out;
}

// Chroma: 12 pitch classes. Accumulate power into the nearest semitone bucket.
function computeChroma(mag: Float32Array, freqs: Float32Array): number[] {
  const chroma = new Array(12).fill(0);
  for (let i = 0; i < mag.length; i++) {
    const f = freqs[i];
    if (f < 100 || f > 5000 || mag[i] < 1e-4) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    chroma[pc] += mag[i];
  }
  const m = Math.max(...chroma);
  if (m > 0) for (let i = 0; i < 12; i++) chroma[i] /= m;
  return chroma;
}

function buildFreqTable(bins: number, sampleRate: number): Float32Array {
  const out = new Float32Array(bins);
  for (let i = 0; i < bins; i++) out[i] = (i * sampleRate) / (bins * 2);
  return out;
}

// Convert dB values (AnalyserNode gives dBFS, typically -100 to 0) to linear 0-1
function dbToMag(db: number): number {
  // -100 dB → 0, 0 dB → 1, above 0 clipped
  if (db <= -100) return 0;
  return Math.min(1, Math.pow(10, db / 20));
}

// ---- App ----

export default function App() {
  const [library, setLibrary] = useState<LibraryTrack[]>([]);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<LibraryTrack | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [muted, setMuted] = useState<Record<Stem, boolean>>({
    drums: false, bass: false, vocals: false, other: false,
  });

  // Per-render-frame analysis state (React state, re-renders at rAF rate)
  const [stemSpectrum, setStemSpectrum] = useState<Record<Stem, number[]>>({
    drums: EMPTY_ARR, bass: EMPTY_ARR, vocals: EMPTY_ARR, other: EMPTY_ARR,
  });
  const [bands, setBands] = useState<Bands>(EMPTY_BANDS);
  const [chroma, setChroma] = useState<number[]>([]);
  const [centroid, setCentroid] = useState(0);
  const [onsetStrength, setOnsetStrength] = useState({ low: 0, high: 0 });
  const [triggers, setTriggers] = useState({ beat: false, low: false, high: false });

  const audioRefs = useRef<Record<Stem, HTMLAudioElement | null>>({
    drums: null, bass: null, vocals: null, other: null,
  });

  // Web Audio graph — one AnalyserNode per stem, created once when the track loads
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyzersRef = useRef<Record<Stem, AnalyserNode | null>>({
    drums: null, bass: null, vocals: null, other: null,
  });
  const sourcesRef = useRef<Record<Stem, MediaElementAudioSourceNode | null>>({
    drums: null, bass: null, vocals: null, other: null,
  });
  // Scratch buffers reused every frame (avoid allocation)
  const scratchDb = useRef(new Float32Array(FREQ_BINS));
  const scratchMag = useRef(new Float32Array(FREQ_BINS));
  const aWeightsRef = useRef<Float32Array | null>(null);
  const freqTableRef = useRef<Float32Array | null>(null);
  const barBinMapRef = useRef<Array<[number, number]> | null>(null);
  const bandBinMapRef = useRef<Record<keyof Bands, [number, number]> | null>(null);

  // Cursors into the beat / onset peak arrays
  const lastBeatIdx = useRef(-1);
  const lastLowPeakIdx = useRef(-1);
  const lastHighPeakIdx = useRef(-1);

  // ---- Library + analysis loading ----

  useEffect(() => {
    fetch('/api/library').then(r => r.json()).then(setLibrary).catch(() => {});
  }, []);

  useEffect(() => {
    if (!selected) { setAnalysis(null); return; }
    setLoading(true);
    lastBeatIdx.current = -1;
    lastLowPeakIdx.current = -1;
    lastHighPeakIdx.current = -1;
    fetch(`/api/library/${selected.id}/analysis`)
      .then(r => r.json())
      .then((a: Analysis) => { setAnalysis(a); setLoading(false); })
      .catch(() => setLoading(false));
  }, [selected]);

  // ---- Web Audio setup once per track ----

  useEffect(() => {
    if (!selected) return;
    // Lazy-create the AudioContext on first use (browsers require user gesture,
    // but just creating it is OK — resume() is called on play)
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      const sr = audioCtxRef.current.sampleRate;
      aWeightsRef.current = buildAWeights(FREQ_BINS, sr);
      freqTableRef.current = buildFreqTable(FREQ_BINS, sr);
      barBinMapRef.current = buildBarBinMap(NUM_BARS, FREQ_BINS, sr);
      bandBinMapRef.current = buildBandBinMap(FREQ_BINS, sr);
    }

    // Re-wire analyser graph for the new set of audio elements
    for (const stem of STEMS) {
      const el = audioRefs.current[stem];
      if (!el || !audioCtxRef.current) continue;
      // An HTMLMediaElement can only have ONE MediaElementAudioSourceNode ever.
      // If we swap tracks, we'd need to recreate the <audio> element.
      // Since we key each <audio> by track+stem, React will create fresh ones.
      if (!sourcesRef.current[stem]) {
        try {
          const src = audioCtxRef.current.createMediaElementSource(el);
          const analyser = audioCtxRef.current.createAnalyser();
          analyser.fftSize = FFT_SIZE;
          analyser.smoothingTimeConstant = 0.3;   // small smoothing; peak-hold is on the client viz
          src.connect(analyser);
          analyser.connect(audioCtxRef.current.destination);
          sourcesRef.current[stem] = src;
          analyzersRef.current[stem] = analyser;
        } catch (err) {
          console.error('Failed to create analyser for', stem, err);
        }
      }
    }
  }, [selected]);

  // ---- Apply mute changes ----

  useEffect(() => {
    for (const stem of STEMS) {
      const el = audioRefs.current[stem];
      if (el) el.muted = muted[stem];
    }
  }, [muted]);

  // ---- rAF render loop ----

  useEffect(() => {
    let raf: number;

    const tick = () => {
      const master = audioRefs.current.drums;
      const an = analysis;
      const ctx = audioCtxRef.current;

      if (master && an && ctx) {
        const posSec = master.currentTime;
        setPosition(posSec);

        // --- Trigger streams (timestamp crossings from the analysis data) ---
        const crossed = (arr: number[] | undefined, ref: { current: number }): boolean => {
          if (!arr) return false;
          let fired = false;
          for (let i = ref.current + 1; i < arr.length; i++) {
            if (arr[i] <= posSec) { fired = true; ref.current = i; }
            else break;
          }
          return fired;
        };
        const beatTrigger = crossed(an.beats, lastBeatIdx);
        const lowTrigger = crossed(an.onsetLowPeaks, lastLowPeakIdx);
        const highTrigger = crossed(an.onsetHighPeaks, lastHighPeakIdx);
        setTriggers({ beat: beatTrigger, low: lowTrigger, high: highTrigger });

        // --- Per-frame from Web Audio (only when playing) ---
        if (!master.paused) {
          const aw = aWeightsRef.current!;
          const freqs = freqTableRef.current!;
          const barMap = barBinMapRef.current!;
          const bandMap = bandBinMapRef.current!;
          const db = scratchDb.current;
          const mag = scratchMag.current;

          // Compute per-stem spectrum
          const nextStemSpectrum: Record<Stem, number[]> = {
            drums: EMPTY_ARR, bass: EMPTY_ARR, vocals: EMPTY_ARR, other: EMPTY_ARR,
          };

          for (const stem of STEMS) {
            const analyser = analyzersRef.current[stem];
            if (!analyser) continue;
            analyser.getFloatFrequencyData(db);

            // Convert dB → linear magnitude, apply A-weighting
            for (let i = 0; i < FREQ_BINS; i++) {
              mag[i] = dbToMag(db[i]) * aw[i];
            }

            // Log-spaced RMS bars
            const bars = new Array<number>(NUM_BARS);
            let barMax = 1e-4;
            for (let b = 0; b < NUM_BARS; b++) {
              const [lo, hi] = barMap[b];
              let sumSq = 0;
              const count = hi - lo + 1;
              for (let i = lo; i <= hi; i++) sumSq += mag[i] * mag[i];
              const v = Math.sqrt(sumSq / Math.max(1, count));
              bars[b] = v;
              if (v > barMax) barMax = v;
            }
            // Normalize this stem's bars to its own current peak
            for (let b = 0; b < NUM_BARS; b++) bars[b] = Math.min(1, bars[b] / barMax);
            nextStemSpectrum[stem] = bars;
          }
          setStemSpectrum(nextStemSpectrum);

          // Bands + chroma: use drums + other combined (approx full-mix energy)
          // Actually simpler — use whatever the drums analyser has, which is enough
          // to drive the band meters. For chroma prefer the "other" stem.
          const drumsAnalyser = analyzersRef.current.drums;
          const otherAnalyser = analyzersRef.current.other;

          if (drumsAnalyser) {
            drumsAnalyser.getFloatFrequencyData(db);
            for (let i = 0; i < FREQ_BINS; i++) mag[i] = dbToMag(db[i]) * aw[i];
            // We'll compute bands off the mix — sum drums + other + bass + vocals
            // The above mag is just drums; let's accumulate all four.
          }

          // Sum magnitudes across all stems for band meters
          const combined = new Float32Array(FREQ_BINS);
          for (const stem of STEMS) {
            const an2 = analyzersRef.current[stem];
            if (!an2) continue;
            an2.getFloatFrequencyData(db);
            for (let i = 0; i < FREQ_BINS; i++) combined[i] += dbToMag(db[i]) * aw[i];
          }

          // Per-band RMS with per-band normalization (each band has its own peak tracker)
          const newBands = { ...EMPTY_BANDS };
          let peakAll = 1e-5;
          for (const k of Object.keys(newBands) as (keyof Bands)[]) {
            const [lo, hi] = bandMap[k];
            let sumSq = 0;
            const n = hi - lo + 1;
            for (let i = lo; i <= hi; i++) sumSq += combined[i] * combined[i];
            const v = Math.sqrt(sumSq / Math.max(1, n));
            newBands[k] = v;
            if (v > peakAll) peakAll = v;
          }
          for (const k of Object.keys(newBands) as (keyof Bands)[]) {
            newBands[k] = Math.min(1, newBands[k] / peakAll);
          }
          setBands(newBands);

          // Chroma on the 'other' stem (melodic content)
          if (otherAnalyser) {
            otherAnalyser.getFloatFrequencyData(db);
            for (let i = 0; i < FREQ_BINS; i++) mag[i] = dbToMag(db[i]);
            setChroma(computeChroma(mag, freqs));
          }

          // Spectral centroid on combined
          let magSum = 0, weightedSum = 0;
          for (let i = 0; i < FREQ_BINS; i++) {
            magSum += combined[i];
            weightedSum += combined[i] * freqs[i];
          }
          setCentroid(magSum > 0 ? weightedSum / magSum : 0);

          // Onset strength read (approximate — just recent drums energy change)
          // For the continuous meter; the actual trigger fires from the peak timestamps.
          const drumsE = analyzersRef.current.drums
            ? (() => {
                const a = analyzersRef.current.drums!;
                a.getFloatFrequencyData(db);
                let sum = 0;
                // low = 20-500Hz ish, high = 2-16kHz ish
                const lowHi = bandMap.lowMid[1];
                const highLo = bandMap.highMid[0];
                let low = 0, high = 0;
                for (let i = 1; i < lowHi; i++) low += dbToMag(db[i]);
                for (let i = highLo; i < FREQ_BINS; i++) high += dbToMag(db[i]);
                return { low: Math.min(1, low / 20), high: Math.min(1, high / 20), sum };
              })()
            : { low: 0, high: 0 };
          setOnsetStrength({ low: drumsE.low, high: drumsE.high });
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [analysis]);

  const filtered = library.filter(t => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return t.name.toLowerCase().includes(q) || t.artists.some(a => a.toLowerCase().includes(q));
  });

  const togglePlay = async () => {
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state === 'suspended') await ctx.resume();
    const allRefs = STEMS.map(s => audioRefs.current[s]).filter(Boolean) as HTMLAudioElement[];
    const shouldPlay = allRefs.some(a => a.paused);
    if (shouldPlay) await Promise.allSettled(allRefs.map(a => a.play()));
    else allRefs.forEach(a => a.pause());
  };

  const analyzedCount = library.filter(t => t.analyzed).length;
  const hasStems = analysis != null && analysis.version >= 3;

  return (
    <div className="h-screen bg-zinc-950 text-white flex overflow-hidden">
      <aside className="w-80 shrink-0 border-r border-zinc-800 flex flex-col">
        <div className="px-3 py-2 border-b border-zinc-800">
          <h1 className="text-sm font-semibold text-zinc-200 mb-1">musicbox</h1>
          <div className="text-[10px] text-zinc-500 mb-2">{analyzedCount} / {library.length} analyzed</div>
          <input
            type="search"
            placeholder="filter..."
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="w-full bg-zinc-900 text-xs px-2 py-1 rounded border border-zinc-800 placeholder-zinc-600"
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {filtered.map(t => (
            <button
              key={t.id}
              onClick={() => t.analyzed && setSelected(t)}
              disabled={!t.analyzed}
              className={`w-full text-left px-3 py-2 border-b border-zinc-900/50 text-xs transition-colors
                ${selected?.id === t.id ? 'bg-zinc-800' : 'hover:bg-zinc-900'}
                ${t.analyzed ? 'text-zinc-200' : 'text-zinc-600 cursor-not-allowed'}`}
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
          ))}
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
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
                <button
                  onClick={togglePlay}
                  className="bg-zinc-700 hover:bg-zinc-600 rounded px-3 py-1 font-medium text-white"
                >
                  {playing ? 'Pause' : 'Play'}
                </button>
              </div>
            </header>

            {STEMS.map(stem => (
              <audio
                key={`${selected.id}-${stem}`}
                ref={el => { audioRefs.current[stem] = el; }}
                src={hasStems ? `/api/library/${selected.id}/stem/${stem}` : `/api/library/${selected.id}/audio`}
                onPlay={stem === 'drums' ? () => setPlaying(true) : undefined}
                onPause={stem === 'drums' ? () => setPlaying(false) : undefined}
                onEnded={stem === 'drums' ? () => setPlaying(false) : undefined}
                onSeeked={stem === 'drums' ? () => {
                  if (!analysis || !audioRefs.current.drums) return;
                  const t = audioRefs.current.drums.currentTime;
                  lastBeatIdx.current = (analysis.beats ?? []).filter(p => p <= t).length - 1;
                  lastLowPeakIdx.current = (analysis.onsetLowPeaks ?? []).filter(p => p <= t).length - 1;
                  lastHighPeakIdx.current = (analysis.onsetHighPeaks ?? []).filter(p => p <= t).length - 1;
                } : undefined}
                preload="auto"
                crossOrigin="anonymous"
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

              <div className="flex-[1.5] min-h-0 border-t border-zinc-800/50 flex">
                <div className="flex-1">
                  <EnergyBands bands={bands} />
                </div>
                <div className="w-56 border-l border-zinc-800/50">
                  <Chroma data={chroma} centroid={centroid} />
                </div>
                <div className="w-56 border-l border-zinc-800/50">
                  <OnsetIndicators
                    beatTrigger={triggers.beat}
                    lowStrength={onsetStrength.low}
                    lowTrigger={triggers.low}
                    highStrength={onsetStrength.high}
                    highTrigger={triggers.high}
                    bpm={analysis.bpm}
                  />
                </div>
              </div>
            </div>

            <Scrubber
              position={position}
              duration={analysis.duration}
              onSeek={(t) => {
                for (const stem of STEMS) {
                  const el = audioRefs.current[stem];
                  if (el) el.currentTime = t;
                }
              }}
            />
          </>
        )}
      </main>
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
