import { useEffect, useRef, useState } from 'react';
import { STEMS, type Stem, type AutopilotState } from '../types';
import type { PlayheadRef } from '../playhead';
import { fft, hannWindow, aWeight } from '../dsp/fft';
import { peekStemData, stemDataStatus, DECODE_SR } from '../dsp/stems';
import { Spectrum } from './Spectrum';
import { EnvelopeTimeline } from './EnvelopeTimeline';

// v1's beloved surfaces, refit to v2 data: the four Spectrum panes get
// their 128 bars from FFTs over client-decoded stem PCM (instead of live
// AnalyserNodes), and EnvelopeTimeline gets precomputed RMS envelopes from
// the same PCM. Both are swept by the smooth playhead clock.

const FFT_SIZE = 2048;
const NUM_BARS = 128;
const MIN_HZ = 30;
const MAX_HZ = 15500;
const SHARED_PEAK_DECAY = 0.9995; // v1's shared slow-decay normalization

const BIN_W = DECODE_SR / FFT_SIZE;
const BAR_BINS: Array<[number, number]> = (() => {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < NUM_BARS; i++) {
    const fLo = MIN_HZ * (MAX_HZ / MIN_HZ) ** (i / NUM_BARS);
    const fHi = MIN_HZ * (MAX_HZ / MIN_HZ) ** ((i + 1) / NUM_BARS);
    const lo = Math.max(1, Math.floor(fLo / BIN_W));
    out.push([lo, Math.min(FFT_SIZE / 2 - 1, Math.max(lo + 1, Math.ceil(fHi / BIN_W)))]);
  }
  return out;
})();
const A_WEIGHTS: Float32Array = (() => {
  const ref = aWeight(1000);
  const w = new Float32Array(FFT_SIZE / 2);
  for (let i = 0; i < FFT_SIZE / 2; i++) w[i] = aWeight(i * BIN_W) / ref;
  return w;
})();
const HANN = hannWindow(FFT_SIZE);

const STEM_LABEL: Record<Stem, string> = {
  drums: 'Drums', bass: 'Bass', vocals: 'Vocals', other: 'Other',
};

const EMPTY_BARS: number[] = new Array(NUM_BARS).fill(0);

// v1's StemPane, minus the volume slider (there's no local audio to mix).
function StemPane({ label, data }: { label: string; data: number[] }) {
  return (
    <div className="relative min-w-0 min-h-0 border border-zinc-900/50">
      <div className="absolute top-1 left-2 z-10 text-[10px] uppercase tracking-wider text-zinc-400 font-mono select-none">
        {label}
      </div>
      <Spectrum data={data} />
    </div>
  );
}

interface TimelineEnvelope { samples: Float32Array; sr: number; max: number }

export function StemViz({ apRef, playhead }: {
  apRef: React.MutableRefObject<AutopilotState>;
  playhead: PlayheadRef;
}) {
  const [stemSpectrum, setStemSpectrum] = useState<Record<Stem, number[]>>({
    drums: EMPTY_BARS, bass: EMPTY_BARS, vocals: EMPTY_BARS, other: EMPTY_BARS,
  });
  const [overlay, setOverlay] = useState<string | null>(null);
  // EnvelopeTimeline reads a stable ref; bump version to rebind on track change.
  const envelopesRef = useRef<Partial<Record<Stem, TimelineEnvelope>>>({});
  const [envelopeVersion, setEnvelopeVersion] = useState(0);
  const envelopeTrack = useRef<string | null>(null);
  // Playhead as a plain {current} ref view for the copied v1 component.
  const positionRef = useRef(0);

  useEffect(() => {
    let raf = 0;
    const re = new Float32Array(FFT_SIZE);
    const im = new Float32Array(FFT_SIZE);
    let sharedPeak = 1e-6;
    let lastComputeKey = '';

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const ap = apRef.current;
      const tid = ap.track_id ?? null;
      const data = tid ? peekStemData(tid) : null;
      const pos = playhead.current;
      positionRef.current = pos;

      // Overlay status (stable-string guard keeps React quiet).
      let msg: string | null = null;
      if (!ap.running) msg = 'autopilot stopped';
      else if (!tid) msg = 'waiting for playback';
      else if (!data) {
        const st = stemDataStatus(tid);
        msg = st === 'loading' ? 'decoding stems…'
          : st === 'error' ? 'stem decode failed'
          : ap.track_status === 'ingesting' ? 'ingesting — panes light up when stems land'
          : 'stems not ready';
      }
      setOverlay((cur) => (cur === msg ? cur : msg));

      // Feed the timeline's envelopes when track data (dis)appears.
      if (data && envelopeTrack.current !== data.trackId) {
        envelopeTrack.current = data.trackId;
        const packed: Partial<Record<Stem, TimelineEnvelope>> = {};
        for (const s of STEMS) {
          packed[s] = { samples: data.energy[s].samples, sr: data.energyHz, max: data.energy[s].max };
        }
        envelopesRef.current = packed;
        setEnvelopeVersion((v) => v + 1);
      } else if (!data && envelopeTrack.current !== null) {
        envelopeTrack.current = null;
        envelopesRef.current = {};
        setEnvelopeVersion((v) => v + 1);
      }

      // Spectrum bars — v1 semantics: A-weighted RMS per log bar,
      // normalized against a SHARED slow-decay peak across all stems.
      sharedPeak *= SHARED_PEAK_DECAY;
      let frameMax = sharedPeak;
      // Paused is a normal frame: the FFT is computed at the frozen
      // playhead, so the panes hold the paused instant's spectrum instead
      // of blanking. Only the playhead's motion stops. While frozen, skip
      // the recompute entirely (same pos → same bars; also freezes the
      // peak caps instead of letting them decay to nothing).
      const computeKey = `${tid}:${pos.toFixed(3)}:${data ? 1 : 0}`;
      if (computeKey === lastComputeKey) return;
      lastComputeKey = computeKey;
      const next: Record<Stem, number[]> = {
        drums: EMPTY_BARS, bass: EMPTY_BARS, vocals: EMPTY_BARS, other: EMPTY_BARS,
      };
      if (data) {
        const raw: Record<Stem, Float32Array> = {} as Record<Stem, Float32Array>;
        for (const stem of STEMS) {
          const pcm = data.pcm[stem];
          const end = Math.min(pcm.length, Math.floor(pos * data.sampleRate));
          const start = end - FFT_SIZE;
          const out = new Float32Array(NUM_BARS);
          if (start >= 0) {
            for (let i = 0; i < FFT_SIZE; i++) re[i] = pcm[start + i] * HANN[i];
            im.fill(0);
            fft(re, im);
            for (let b = 0; b < NUM_BARS; b++) {
              const [lo, hi] = BAR_BINS[b];
              let sum = 0;
              for (let k = lo; k < hi; k++) {
                const mag = Math.hypot(re[k], im[k]) * A_WEIGHTS[k];
                sum += mag * mag;
              }
              const v = Math.sqrt(sum / Math.max(1, hi - lo));
              out[b] = v;
              if (v > frameMax) frameMax = v;
            }
          }
          raw[stem] = out;
        }
        sharedPeak = Math.max(frameMax, 1e-6);
        for (const stem of STEMS) {
          next[stem] = Array.from(raw[stem], (v) => Math.min(1, v / sharedPeak));
        }
      }
      setStemSpectrum(next);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [apRef, playhead]);

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 relative">
        <div className="grid grid-cols-2 grid-rows-2 h-full w-full">
          {STEMS.map((stem) => (
            <StemPane key={stem} label={STEM_LABEL[stem]} data={stemSpectrum[stem]} />
          ))}
        </div>
        {overlay && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className="text-[11px] font-mono text-zinc-500 bg-zinc-950/70 px-3 py-1 rounded">{overlay}</span>
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-zinc-800/50">
        <div className="text-[9px] font-mono uppercase tracking-wider text-zinc-600 px-2 py-0.5 border-b border-zinc-800/30">energy</div>
        <EnvelopeTimeline envelopesRef={envelopesRef} positionRef={positionRef} version={envelopeVersion} />
      </div>
    </div>
  );
}
