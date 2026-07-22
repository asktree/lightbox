// ENV2 parser test with a hand-built buffer (independent of the musicbox
// writer — the cross-package writer↔parser contract test lives in
// packages/musicbox/tests/env2-contract.test.ts).
import { describe, it, expect } from 'vitest';
import { parseEnvelope } from '../src/server/envelope-parse.js';
import { STEMS, NUM_BANDS } from '../src/server/audio-bus.js';

const NUM_SAMPLES = 8;

// Hand-rolled ENV2 encoder, straight from the documented layout.
function encode(opts?: { magic?: string; numStems?: number; numBands?: number }): ArrayBuffer {
  const { magic = 'ENV2', numStems = 4, numBands = NUM_BANDS } = opts ?? {};
  const ab = new ArrayBuffer(12 + numStems * NUM_SAMPLES * 4 + NUM_SAMPLES * numBands * 4);
  const dv = new DataView(ab);
  for (let i = 0; i < 4; i++) dv.setUint8(i, magic.charCodeAt(i));
  dv.setUint8(4, numStems);
  dv.setUint8(5, numBands);
  dv.setUint16(6, 60, true);
  dv.setUint32(8, NUM_SAMPLES, true);
  let off = 12;
  for (let si = 0; si < numStems; si++) {
    for (let j = 0; j < NUM_SAMPLES; j++) {
      // Non-monotonic per stem: (j*3)%8 is a permutation of 0..7.
      dv.setFloat32(off, si * 10 + ((j * 3) % 8), true);
      off += 4;
    }
  }
  for (let c = 0; c < NUM_SAMPLES; c++) {
    for (let b = 0; b < numBands; b++) {
      dv.setFloat32(off, 100 + b * 10 + ((c * 3) % 8), true);
      off += 4;
    }
  }
  return ab;
}

describe('twinklybox parseEnvelope', () => {
  it('parses header, stems (samples + sorted), and de-interleaves bands', () => {
    const pack = parseEnvelope(encode());
    expect(pack.sr).toBe(60);
    expect(pack.numSamples).toBe(NUM_SAMPLES);
    expect(pack.numBands).toBe(NUM_BANDS);
    STEMS.forEach((stem, si) => {
      for (let j = 0; j < NUM_SAMPLES; j++) {
        expect(pack.stems[stem].samples[j]).toBe(si * 10 + ((j * 3) % 8));
        expect(pack.stems[stem].sorted[j]).toBe(si * 10 + j); // permutation → 0..7 sorted
      }
    });
    for (let b = 0; b < NUM_BANDS; b++) {
      for (let c = 0; c < NUM_SAMPLES; c++) {
        expect(pack.bands[b].samples[c]).toBe(100 + b * 10 + ((c * 3) % 8));
        expect(pack.bands[b].sorted[c]).toBe(100 + b * 10 + c);
      }
    }
  });

  it('rejects wrong magic', () => {
    expect(() => parseEnvelope(encode({ magic: 'ENV1' }))).toThrow(/magic/);
  });

  it('rejects unexpected stem count', () => {
    expect(() => parseEnvelope(encode({ numStems: 5 }))).toThrow(/stem count/);
  });

  it('rejects unexpected band count', () => {
    expect(() => parseEnvelope(encode({ numBands: 8 }))).toThrow(/band count/);
  });
});
