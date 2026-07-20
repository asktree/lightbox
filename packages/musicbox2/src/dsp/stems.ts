// Client-side stem PCM: fetch the four stem OGGs, decode once, keep mono
// Float32 PCM + a precomputed energy envelope per stem. This is
// decode-without-playback — no <audio> elements, no transport; PCM as data.
//
// Decoded at 32kHz mono (panes top out at ~15.5kHz visually) to keep a
// 4-minute track around ~120MB across 4 stems. Cache holds the current
// track + up-next prefetch; older entries are evicted.

import { STEMS, type Stem } from '../types';

export const DECODE_SR = 32000;
export const ENERGY_HZ = 30;
const CACHE_MAX = 3;

export interface StemData {
  trackId: string;
  sampleRate: number;
  duration: number; // seconds (longest stem)
  pcm: Record<Stem, Float32Array>;
  energy: Record<Stem, { samples: Float32Array; max: number }>;
  energyHz: number;
}

type LoadStatus = 'loading' | 'ready' | 'error';

const pending = new Map<string, Promise<StemData>>();
const ready = new Map<string, StemData>();
const errors = new Map<string, string>();

export function stemDataStatus(trackId: string): LoadStatus | 'none' {
  if (ready.has(trackId)) return 'ready';
  if (pending.has(trackId)) return 'loading';
  if (errors.has(trackId)) return 'error';
  return 'none';
}

export function peekStemData(trackId: string): StemData | null {
  return ready.get(trackId) ?? null;
}

function toMono(buf: AudioBuffer): Float32Array {
  const ch0 = buf.getChannelData(0);
  if (buf.numberOfChannels === 1) return Float32Array.from(ch0);
  const out = new Float32Array(buf.length);
  const n = buf.numberOfChannels;
  for (let c = 0; c < n; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < ch.length; i++) out[i] += ch[i] / n;
  }
  return out;
}

function computeEnergy(pcm: Float32Array, sr: number): { samples: Float32Array; max: number } {
  const per = Math.max(1, Math.round(sr / ENERGY_HZ));
  const n = Math.ceil(pcm.length / per);
  const out = new Float32Array(n);
  let max = 0;
  for (let i = 0; i < n; i++) {
    const s = i * per;
    const e = Math.min(pcm.length, s + per);
    let sum = 0;
    for (let j = s; j < e; j++) sum += pcm[j] * pcm[j];
    const rms = Math.sqrt(sum / Math.max(1, e - s));
    out[i] = rms;
    if (rms > max) max = rms;
  }
  return { samples: out, max };
}

function evict(current: string) {
  if (ready.size <= CACHE_MAX) return;
  for (const key of ready.keys()) {
    if (key !== current && ready.size > CACHE_MAX) ready.delete(key);
  }
}

export function loadStemData(trackId: string): Promise<StemData> {
  const done = ready.get(trackId);
  if (done) return Promise.resolve(done);
  const inFlight = pending.get(trackId);
  if (inFlight) return inFlight;
  errors.delete(trackId);

  const p = (async (): Promise<StemData> => {
    // OfflineAudioContext both decodes AND resamples to its own rate.
    // A throwaway 1-frame context per decode is the documented pattern.
    const decode = async (stem: Stem): Promise<Float32Array> => {
      const r = await fetch(`/api/library/${trackId}/stem/${stem}`);
      if (!r.ok) throw new Error(`stem ${stem}: ${r.status}`);
      const bytes = await r.arrayBuffer();
      const ctx = new OfflineAudioContext(1, 1, DECODE_SR);
      const buf = await ctx.decodeAudioData(bytes);
      return toMono(buf);
    };
    const decoded = await Promise.all(STEMS.map((s) => decode(s)));
    const pcm = {} as Record<Stem, Float32Array>;
    const energy = {} as Record<Stem, { samples: Float32Array; max: number }>;
    let maxLen = 0;
    STEMS.forEach((s, i) => {
      pcm[s] = decoded[i];
      energy[s] = computeEnergy(decoded[i], DECODE_SR);
      if (decoded[i].length > maxLen) maxLen = decoded[i].length;
    });
    const data: StemData = {
      trackId,
      sampleRate: DECODE_SR,
      duration: maxLen / DECODE_SR,
      pcm,
      energy,
      energyHz: ENERGY_HZ,
    };
    ready.set(trackId, data);
    evict(trackId);
    return data;
  })();

  pending.set(trackId, p);
  p.catch((e) => { errors.set(trackId, String(e)); })
    .finally(() => { pending.delete(trackId); });
  return p;
}
