// ENV2 binary envelope parsing — extracted verbatim from
// musicbox-follower.ts so the wire-format contract (shared with musicbox's
// serializeEnvelope and lightbox-server's parser) can be unit-tested
// without pulling in the mic/syscap sources. Pure: no I/O, no module state.

import { type Stem, STEMS, NUM_BANDS } from './audio-bus.js';

export interface StemEnvelope { samples: Float32Array; sorted: Float32Array }
export interface BandEnvelope { samples: Float32Array; sorted: Float32Array } // per band
export interface EnvelopePack {
  sr: number;
  numSamples: number;
  numBands: number;
  stems: Record<Stem, StemEnvelope>;
  bands: BandEnvelope[]; // length = numBands; samples[chunk] for that band only
}

// Layout (matches musicbox/src/server/envelope.ts, format ENV2):
//   magic 'ENV2' (4)
//   num_stems u8 (1)
//   num_bands u8 (1)
//   sr u16 LE (60)
//   num_samples u32 LE
//                          = 12-byte header (4-byte aligned)
//   stems block: num_stems × num_samples × float32 LE
//   bands block: num_samples × num_bands × float32 LE (row-major)
export function parseEnvelope(buf: ArrayBuffer): EnvelopePack {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'ENV2') throw new Error(`bad envelope magic: ${magic} (need ENV2 — musicbox may need restart)`);
  const numStems = dv.getUint8(4);
  const numBands = dv.getUint8(5);
  if (numStems !== 4) throw new Error(`unexpected stem count: ${numStems}`);
  if (numBands !== NUM_BANDS) throw new Error(`unexpected band count: ${numBands} (expected ${NUM_BANDS})`);
  const sr = dv.getUint16(6, true);
  const numSamples = dv.getUint32(8, true);
  const headerSize = 12;
  const bytesPerStem = numSamples * 4;
  const srcBytes = new Uint8Array(buf);

  const stems = {} as Record<Stem, StemEnvelope>;
  for (let i = 0; i < STEMS.length; i++) {
    const stem = STEMS[i];
    const offset = headerSize + i * bytesPerStem;
    const alignedAb = new ArrayBuffer(bytesPerStem);
    new Uint8Array(alignedAb).set(srcBytes.subarray(offset, offset + bytesPerStem));
    const samples = new Float32Array(alignedAb);
    const sorted = new Float32Array(samples);
    sorted.sort();
    stems[stem] = { samples, sorted };
  }

  // Bands block: row-major [chunk][band]. We want column-major for fast
  // lookup (one Float32Array per band, so percentile sort is per-band).
  // Copy out NUM_BANDS arrays of length numSamples.
  const bandsBlockOffset = headerSize + STEMS.length * bytesPerStem;
  const bandsBlock = new ArrayBuffer(numSamples * numBands * 4);
  new Uint8Array(bandsBlock).set(srcBytes.subarray(bandsBlockOffset, bandsBlockOffset + numSamples * numBands * 4));
  const interleaved = new Float32Array(bandsBlock);
  const bands: BandEnvelope[] = [];
  for (let b = 0; b < numBands; b++) {
    const samples = new Float32Array(numSamples);
    for (let c = 0; c < numSamples; c++) samples[c] = interleaved[c * numBands + b];
    const sorted = new Float32Array(samples);
    sorted.sort();
    bands.push({ samples, sorted });
  }
  return { sr, numSamples, numBands, stems, bands };
}
