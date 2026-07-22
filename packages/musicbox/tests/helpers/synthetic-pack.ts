// Deterministic synthetic envelope pack used by the ENV2 contract test and
// by the golden-fixture generator (write-fixture.ts). Values are small
// integers (exact in float32) and deliberately non-monotonic per stem/band
// (via the (i*7)%16 permutation) so the consumers' sorted arrays genuinely
// differ from the raw sample order.
import { NUM_BANDS, type EnvelopePack } from '../../src/server/envelope.js';

export const PACK_STEMS = ['drums', 'bass', 'vocals', 'other'] as const;
export const PACK_NUM_SAMPLES = 16;
export const PACK_SR = 60;

// Permutation of 0..15 (gcd(7,16)=1).
export const perm = (i: number): number => (i * 7) % PACK_NUM_SAMPLES;

// Stem si, sample j → si*100 + perm(j). Distinct across stems and samples.
export const stemValue = (si: number, j: number): number => si * 100 + perm(j);

// Band b, chunk c → 2000 + b*100 + perm(c). Distinct across bands/chunks.
export const bandValue = (b: number, c: number): number => 2000 + b * 100 + perm(c);

export function makeSyntheticPack(): EnvelopePack {
  const numSamples = PACK_NUM_SAMPLES;
  const stems = {} as EnvelopePack['stems'];
  const chroma = {} as EnvelopePack['chroma'];
  PACK_STEMS.forEach((s, si) => {
    const samples = new Float32Array(numSamples);
    let max = 0;
    for (let j = 0; j < numSamples; j++) {
      samples[j] = stemValue(si, j);
      if (samples[j] > max) max = samples[j];
    }
    stems[s] = { samples, max };
    // Chroma is NOT part of the ENV2 wire format — zeros keep the pack
    // structurally valid for serializeEnvelope's input type.
    chroma[s] = { samples: new Float32Array(numSamples), max: 0 };
  });
  // Row-major [chunk][band].
  const bandSamples = new Float32Array(numSamples * NUM_BANDS);
  for (let c = 0; c < numSamples; c++) {
    for (let b = 0; b < NUM_BANDS; b++) {
      bandSamples[c * NUM_BANDS + b] = bandValue(b, c);
    }
  }
  return {
    trackId: 'synthetic-test-track',
    sr: PACK_SR,
    numSamples,
    stems,
    chroma,
    bands: { samples: bandSamples },
  };
}
