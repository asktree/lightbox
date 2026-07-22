// ENV2 wire-format contract test.
//
// Three parties share this binary format:
//   writer:  packages/musicbox/src/server/envelope.ts   (serializeEnvelope)
//   reader:  packages/server/src/services/envelope-parse.ts (Hue stem-sync)
//   reader:  packages/twinklybox/src/server/envelope-parse.ts (twinkly follower)
//
// The test serializes a synthetic pack, checks the bytes against a
// checked-in golden fixture (so a writer change trips it), and feeds both
// the freshly-serialized buffer and the fixture to BOTH independent
// parsers (so a parser change trips it too).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { serializeEnvelope, NUM_BANDS } from '../src/server/envelope.js';
import { parseEnvelope as parseServerEnvelope } from '../../server/src/services/envelope-parse.js';
import { parseEnvelope as parseTwinklyEnvelope } from '../../twinklybox/src/server/envelope-parse.js';
import {
  makeSyntheticPack, PACK_STEMS, PACK_NUM_SAMPLES, PACK_SR, stemValue, bandValue,
} from './helpers/synthetic-pack.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/env2-golden.bin');

const serialized: Buffer = serializeEnvelope(makeSyntheticPack());
const golden: Buffer = readFileSync(FIXTURE);

// Buffer → standalone ArrayBuffer (twinkly parser takes ArrayBuffer, and
// Buffer's pool means .buffer can't be used directly).
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

describe('ENV2 writer (musicbox serializeEnvelope)', () => {
  it('produces the documented header layout', () => {
    expect(serialized.toString('ascii', 0, 4)).toBe('ENV2');
    expect(serialized.readUInt8(4)).toBe(4);            // num_stems
    expect(serialized.readUInt8(5)).toBe(NUM_BANDS);    // num_bands
    expect(serialized.readUInt16LE(6)).toBe(PACK_SR);   // sr
    expect(serialized.readUInt32LE(8)).toBe(PACK_NUM_SAMPLES); // num_samples
    expect(serialized.length).toBe(
      12 + 4 * PACK_NUM_SAMPLES * 4 + PACK_NUM_SAMPLES * NUM_BANDS * 4,
    );
  });

  it('writes stems then bands as float32 LE at the documented offsets', () => {
    // stem si, sample j at 12 + (si*numSamples + j)*4
    expect(serialized.readFloatLE(12)).toBe(stemValue(0, 0));
    expect(serialized.readFloatLE(12 + (1 * PACK_NUM_SAMPLES + 3) * 4)).toBe(stemValue(1, 3));
    expect(serialized.readFloatLE(12 + (3 * PACK_NUM_SAMPLES + 15) * 4)).toBe(stemValue(3, 15));
    // bands row-major: chunk c, band b at bandsOff + (c*NUM_BANDS + b)*4
    const bandsOff = 12 + 4 * PACK_NUM_SAMPLES * 4;
    expect(serialized.readFloatLE(bandsOff)).toBe(bandValue(0, 0));
    expect(serialized.readFloatLE(bandsOff + (5 * NUM_BANDS + 7) * 4)).toBe(bandValue(7, 5));
  });

  it('is byte-identical to the checked-in golden fixture', () => {
    // If this fails, the wire format changed: BOTH parsers (lightbox-server
    // stem-sync + twinklybox follower) must be updated in lockstep, then
    // regenerate the fixture with tests/helpers/write-fixture.ts.
    expect(serialized.equals(golden)).toBe(true);
  });
});

// Run every parser assertion against both the live writer output and the
// golden fixture — catches writer drift and parser drift independently.
const sources: Array<[string, Buffer]> = [
  ['freshly serialized', serialized],
  ['golden fixture', golden],
];

describe.each(sources)('lightbox-server parser (%s)', (_name, buf) => {
  it('recovers header, per-stem samples, and per-stem max', () => {
    const env = parseServerEnvelope('track-x', buf);
    expect(env.trackId).toBe('track-x');
    expect(env.sr).toBe(PACK_SR);
    expect(env.numSamples).toBe(PACK_NUM_SAMPLES);
    PACK_STEMS.forEach((stem, si) => {
      const s = env.stems[stem];
      expect(s.samples.length).toBe(PACK_NUM_SAMPLES);
      for (let j = 0; j < PACK_NUM_SAMPLES; j++) {
        expect(s.samples[j]).toBe(stemValue(si, j));
      }
      // perm covers 0..15, so max = si*100 + 15
      expect(s.max).toBe(si * 100 + PACK_NUM_SAMPLES - 1);
    });
  });

  it('rejects a bad magic', () => {
    const bad = Buffer.from(buf);
    bad.write('NOPE', 0, 'ascii');
    expect(() => parseServerEnvelope('track-x', bad)).toThrow(/magic/);
  });

  it('rejects a truncated stems block', () => {
    expect(() => parseServerEnvelope('track-x', buf.subarray(0, 12 + 7))).toThrow(/truncated/);
  });
});

describe.each(sources)('twinklybox parser (%s)', (_name, buf) => {
  const ab = toArrayBuffer(buf);

  it('recovers header and per-stem samples + sorted arrays', () => {
    const pack = parseTwinklyEnvelope(ab);
    expect(pack.sr).toBe(PACK_SR);
    expect(pack.numSamples).toBe(PACK_NUM_SAMPLES);
    expect(pack.numBands).toBe(NUM_BANDS);
    PACK_STEMS.forEach((stem, si) => {
      const s = pack.stems[stem];
      for (let j = 0; j < PACK_NUM_SAMPLES; j++) {
        expect(s.samples[j]).toBe(stemValue(si, j));
      }
      // Values are si*100 + perm(j) with perm a permutation of 0..15, so
      // the sorted array must be exactly si*100 + [0..15] — this genuinely
      // exercises the sort because perm is non-monotonic.
      for (let j = 0; j < PACK_NUM_SAMPLES; j++) {
        expect(s.sorted[j]).toBe(si * 100 + j);
      }
    });
  });

  it('de-interleaves the row-major bands block into per-band arrays', () => {
    const pack = parseTwinklyEnvelope(ab);
    expect(pack.bands.length).toBe(NUM_BANDS);
    for (let b = 0; b < NUM_BANDS; b++) {
      const band = pack.bands[b];
      expect(band.samples.length).toBe(PACK_NUM_SAMPLES);
      for (let c = 0; c < PACK_NUM_SAMPLES; c++) {
        expect(band.samples[c]).toBe(bandValue(b, c));
      }
      // Sorted per band: 2000 + b*100 + [0..15].
      for (let c = 0; c < PACK_NUM_SAMPLES; c++) {
        expect(band.sorted[c]).toBe(2000 + b * 100 + c);
      }
    }
  });

  it('rejects a bad magic', () => {
    const bad = Buffer.from(buf);
    bad.write('ENV1', 0, 'ascii');
    expect(() => parseTwinklyEnvelope(toArrayBuffer(bad))).toThrow(/magic/);
  });
});

describe('cross-parser agreement', () => {
  it('both parsers see identical stem samples from the same buffer', () => {
    const a = parseServerEnvelope('t', golden);
    const b = parseTwinklyEnvelope(toArrayBuffer(golden));
    for (const stem of PACK_STEMS) {
      expect(Array.from(a.stems[stem].samples)).toEqual(Array.from(b.stems[stem].samples));
    }
  });
});
