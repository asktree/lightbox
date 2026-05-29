// Server-side stem envelope compute + cache. Decodes each stem with ffmpeg
// (subprocess) on first request, chunks to a per-stem RMS Float32Array at
// ENVELOPE_HZ samples per second, caches the result in memory keyed by
// track id. Consumers (twinklybox, musicbox client eventually) fetch the
// serialized envelope via /api/library/:id/envelope.
//
// Cache is in-memory only — server restart re-decodes on first request
// (~1-2s per track for 4 stems on modern hardware). Trivial to swap to
// an on-disk sidecar later if cold-start becomes annoying.

import { spawn } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';

const LIBRARY_DIR = process.env.MUSICBOX_LIBRARY ?? join(homedir(), 'music-library');
const TRACKS_DIR = join(LIBRARY_DIR, 'tracks');
const STEMS = ['drums', 'bass', 'vocals', 'other'] as const;
type Stem = typeof STEMS[number];

// Decode rate (mono PCM out of ffmpeg). 48kHz is standard for Twinkly
// audio applications and matches what most browser AudioContexts pick.
const DECODE_SR = 48000;
// Envelope sample rate — one RMS value per 1/60s of audio. Matches the
// musicbox-client browser compute so values stay aligned conceptually.
export const ENVELOPE_HZ = 60;

// FFT for the band-EQ envelope (12 log-spaced bands on the equal-weighted
// sum of stems). 1024-point because chunk size is 48000/60 = 800 samples
// → next pow-of-2 = 1024, zero-padded. We get 512 magnitude bins (DC
// excluded), log-binned down to 12 bands.
const FFT_SIZE = 1024;
export const NUM_BANDS = 12;

export interface StemEnvelope {
  samples: Float32Array;
  max: number;
}

export interface BandsEnvelope {
  // Row-major [chunk][band] → flat Float32Array length = numSamples × NUM_BANDS.
  // For chunk i, band b → samples[i * NUM_BANDS + b].
  samples: Float32Array;
}

export interface EnvelopePack {
  trackId: string;
  sr: number;        // envelope Hz
  numSamples: number; // per stem (all stems padded to same length)
  stems: Record<Stem, StemEnvelope>;
  // 12-band FFT envelope of the equal-weighted sum of all stems. Used by
  // megadrome's eq12 band mode (the original megadrome algorithm with
  // proportionalCumOctaveMap over N frequency bands).
  bands: BandsEnvelope;
}

// Promise cache so concurrent first-time requests share one decode.
const cache = new Map<string, Promise<EnvelopePack>>();

export function getEnvelope(trackId: string): Promise<EnvelopePack> {
  let cached = cache.get(trackId);
  if (!cached) {
    cached = computeEnvelope(trackId);
    cache.set(trackId, cached);
    // Drop on failure so next request retries instead of returning a
    // permanently-rejected promise.
    cached.catch(() => { cache.delete(trackId); });
  }
  return cached;
}

export function envelopeStats() {
  return { cachedTracks: cache.size };
}

async function decodeStemToMonoF32(stemPath: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let stderr = '';
    const proc = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-i', stemPath,
      '-f', 'f32le',
      '-ac', '1',
      '-ar', String(DECODE_SR),
      'pipe:1',
    ]);
    proc.stdout.on('data', (c: Buffer) => chunks.push(c));
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg ${code}: ${stderr.slice(0, 300)}`));
        return;
      }
      const buf = Buffer.concat(chunks);
      const n = Math.floor(buf.length / 4);
      // Wrap the same memory rather than copying — ffmpeg's stdout buffer
      // is already a contiguous f32le payload.
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + n * 4);
      resolve(new Float32Array(ab));
    });
  });
}

function computeRMSEnvelope(pcm: Float32Array, srAudio: number, srEnv: number): StemEnvelope {
  const samplesPerChunk = Math.max(1, Math.round(srAudio / srEnv));
  const numChunks = Math.ceil(pcm.length / samplesPerChunk);
  const out = new Float32Array(numChunks);
  let max = 0;
  for (let i = 0; i < numChunks; i++) {
    const s = i * samplesPerChunk;
    const e = Math.min(pcm.length, s + samplesPerChunk);
    let sumSq = 0;
    for (let j = s; j < e; j++) sumSq += pcm[j] * pcm[j];
    const rms = Math.sqrt(sumSq / Math.max(1, e - s));
    out[i] = rms;
    if (rms > max) max = rms;
  }
  return { samples: out, max };
}

// ---- FFT (radix-2 Cooley-Tukey, in-place) ----
//
// Used once per chunk per track at decode time, so it doesn't need to be
// blazing fast. 1024-point is ~ms on Node; whole-track band envelope for
// a 7-min track is well under a second.
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  // Bit reversal permutation.
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  // Iterative butterflies.
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angleStep = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const a = angleStep * k;
        const wr = Math.cos(a);
        const wi = Math.sin(a);
        const tr = re[i + k + half] * wr - im[i + k + half] * wi;
        const ti = re[i + k + half] * wi + im[i + k + half] * wr;
        re[i + k + half] = re[i + k] - tr;
        im[i + k + half] = im[i + k] - ti;
        re[i + k] += tr;
        im[i + k] += ti;
      }
    }
  }
}

// Compute the per-chunk 12-band magnitude envelope of `combined` (mono
// PCM). Each chunk = srAudio/srEnv samples, Hann-windowed and zero-padded
// to FFT_SIZE before FFT. Bands are log-spaced from bin 1 to FFT_SIZE/2
// (skipping DC) — each band's value is RMS magnitude in its bin range.
function computeBandsEnvelope(
  combined: Float32Array,
  srAudio: number,
  srEnv: number,
): BandsEnvelope {
  const samplesPerChunk = Math.max(1, Math.round(srAudio / srEnv));
  const numChunks = Math.ceil(combined.length / samplesPerChunk);
  const out = new Float32Array(numChunks * NUM_BANDS);

  // Precompute Hann window for `samplesPerChunk` samples.
  const win = new Float32Array(samplesPerChunk);
  if (samplesPerChunk > 1) {
    for (let j = 0; j < samplesPerChunk; j++) {
      win[j] = 0.5 * (1 - Math.cos((2 * Math.PI * j) / (samplesPerChunk - 1)));
    }
  } else win[0] = 1;

  // Log-spaced band edges (bin indices). Bin 1 .. FFT_SIZE/2 over NUM_BANDS
  // geometric steps.
  const lo = 1;
  const hi = FFT_SIZE / 2;
  const edges = new Int32Array(NUM_BANDS + 1);
  for (let b = 0; b <= NUM_BANDS; b++) {
    edges[b] = Math.max(lo, Math.min(hi, Math.round(lo * Math.pow(hi / lo, b / NUM_BANDS))));
  }
  // Ensure strictly non-decreasing (rounding can collide adjacent edges).
  for (let b = 1; b <= NUM_BANDS; b++) if (edges[b] <= edges[b - 1]) edges[b] = edges[b - 1] + 1;

  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);

  for (let c = 0; c < numChunks; c++) {
    const start = c * samplesPerChunk;
    const end = Math.min(combined.length, start + samplesPerChunk);
    // Load chunk × window into re; zero-pad rest.
    let i = 0;
    for (; i < end - start; i++) re[i] = combined[start + i] * win[i];
    for (; i < FFT_SIZE; i++) re[i] = 0;
    im.fill(0);
    fft(re, im);
    // Band RMS magnitudes.
    for (let b = 0; b < NUM_BANDS; b++) {
      const a = edges[b];
      const z = Math.min(FFT_SIZE / 2, edges[b + 1]);
      let sumSq = 0;
      let n = 0;
      for (let k = a; k < z; k++) {
        const mr = re[k], mi = im[k];
        sumSq += mr * mr + mi * mi;
        n++;
      }
      out[c * NUM_BANDS + b] = n > 0 ? Math.sqrt(sumSq / n) : 0;
    }
  }
  return { samples: out };
}

async function computeEnvelope(trackId: string): Promise<EnvelopePack> {
  if (!/^[a-zA-Z0-9_-]+$/.test(trackId)) throw new Error('invalid trackId');
  const stemsDir = join(TRACKS_DIR, trackId, 'stems');
  if (!existsSync(stemsDir)) throw new Error(`no stems for ${trackId}`);
  // Decode all four in parallel — ffmpeg is single-threaded per stem, but
  // four subprocesses cut wall time roughly 4x on a multi-core machine.
  // Keep the raw PCM around (alongside the per-stem RMS) so we can sum
  // for the band-FFT below.
  const decoded = await Promise.all(STEMS.map(async (stem) => {
    const path = join(stemsDir, `${stem}.ogg`);
    if (!existsSync(path)) throw new Error(`stem missing: ${stem}`);
    const pcm = await decodeStemToMonoF32(path);
    return { stem, pcm, rms: computeRMSEnvelope(pcm, DECODE_SR, ENVELOPE_HZ) } as const;
  }));
  // Pad shorter stems up to the longest. Demucs output is usually identical
  // length but firmware versions / re-encodes have drifted in the past.
  let numSamples = 0;
  for (const d of decoded) if (d.rms.samples.length > numSamples) numSamples = d.rms.samples.length;
  const stems = {} as Record<Stem, StemEnvelope>;
  for (const d of decoded) {
    const env = d.rms;
    if (env.samples.length < numSamples) {
      const padded = new Float32Array(numSamples);
      padded.set(env.samples);
      stems[d.stem] = { samples: padded, max: env.max };
    } else {
      stems[d.stem] = env;
    }
  }

  // Equal-weighted sum of stem PCM. Length = longest stem's pcm; pad
  // shorter ones with zeros via the additive loop.
  let combinedLen = 0;
  for (const d of decoded) if (d.pcm.length > combinedLen) combinedLen = d.pcm.length;
  const combined = new Float32Array(combinedLen);
  for (const d of decoded) {
    const pcm = d.pcm;
    for (let i = 0; i < pcm.length; i++) combined[i] += pcm[i];
  }
  // Don't divide by 4 — leaving it as a sum gives more headroom into the
  // FFT, percentile-normalization on the consumer side handles scaling.
  const bands = computeBandsEnvelope(combined, DECODE_SR, ENVELOPE_HZ);
  return { trackId, sr: ENVELOPE_HZ, numSamples, stems, bands };
}

// Binary serialization for HTTP transport. Format v2 — adds a per-chunk
// 12-band FFT envelope (computed on the equal-weighted sum of stems) so
// megadrome's eq12 mode can use real frequency bands instead of the four
// stems. Wire size for a 7-min track: ~225 KB stems + ~691 KB bands ≈ 1 MB.
//
//   magic       'ENV2'           (4 bytes)
//   num_stems   uint8            (1)
//   num_bands   uint8            (1)
//   sr          uint16 LE        (2)
//   num_samples uint32 LE        (4)
//                                = 12-byte header (4-byte aligned)
//   stems block:
//     for each stem in [drums, bass, vocals, other]:
//       float32[num_samples] samples (LE)
//   bands block:
//     float32[num_samples × num_bands] samples (LE), row-major
//     (chunk c, band b → index c * num_bands + b)
//
// We do NOT ship sorted/percentile arrays; the consumer sorts once on
// receipt (cheap, 14k values × 12 bands takes a few ms).
export const STEM_ORDER: readonly Stem[] = STEMS;
const ENV_MAGIC = 'ENV2';

export function serializeEnvelope(pack: EnvelopePack): Buffer {
  const headerSize = 4 + 1 + 1 + 2 + 4; // 12, 4-byte aligned
  const stemBytes = pack.numSamples * 4 * STEM_ORDER.length;
  const bandBytes = pack.numSamples * NUM_BANDS * 4;
  const buf = Buffer.alloc(headerSize + stemBytes + bandBytes);
  let off = 0;
  buf.write(ENV_MAGIC, off, 'ascii'); off += 4;
  buf.writeUInt8(STEM_ORDER.length, off); off += 1;
  buf.writeUInt8(NUM_BANDS, off); off += 1;
  buf.writeUInt16LE(pack.sr, off); off += 2;
  buf.writeUInt32LE(pack.numSamples, off); off += 4;
  for (const stem of STEM_ORDER) {
    const samples = pack.stems[stem].samples;
    const stemBytes = Buffer.from(samples.buffer, samples.byteOffset, pack.numSamples * 4);
    stemBytes.copy(buf, off);
    off += pack.numSamples * 4;
  }
  const bandSamples = pack.bands.samples;
  const bandsBuf = Buffer.from(bandSamples.buffer, bandSamples.byteOffset, bandBytes);
  bandsBuf.copy(buf, off);
  return buf;
}
