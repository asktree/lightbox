import { describe, it, expect } from 'vitest';
import { moveTimeMs } from '../src/services/shade.js';

describe('moveTimeMs', () => {
  it('gives a short time after a stop', () => {
    expect(moveTimeMs({ kind: 'stop' }, { open: 40, travelMs: 32_099 })).toBe(2_000);
  });

  it('uses the distance and the travel time of the motor', () => {
    // 0 % to 63 % of 32.099 s, plus the settle time.
    expect(moveTimeMs({ kind: 'go', open: 63 }, { open: 0, travelMs: 32_099 })).toBeCloseTo(0.63 * 32_099 + 2_500, 5);
    expect(moveTimeMs({ kind: 'open' }, { open: 61, travelMs: 32_099 })).toBeCloseTo(0.39 * 32_099 + 2_500, 5);
    expect(moveTimeMs({ kind: 'close' }, { open: 61, travelMs: 20_000 })).toBeCloseTo(0.61 * 20_000 + 2_500, 5);
  });

  it('gives only the settle time when the blind is at the target', () => {
    expect(moveTimeMs({ kind: 'go', open: 50 }, { open: 50, travelMs: 32_099 })).toBe(2_500);
  });

  it('uses the full travel when the position is not known', () => {
    expect(moveTimeMs({ kind: 'open' }, { open: -1, travelMs: 30_000 })).toBe(32_500);
    expect(moveTimeMs({ kind: 'close' }, null)).toBe(34_500);
  });

  it('uses the default travel time when the motor gives none or a bad one', () => {
    expect(moveTimeMs({ kind: 'open' }, { open: 0 })).toBe(34_500);
    expect(moveTimeMs({ kind: 'open' }, { open: 0, travelMs: 5 })).toBe(34_500);
    expect(moveTimeMs({ kind: 'open' }, { open: 0, travelMs: 'x' })).toBe(34_500);
  });

  it('keeps a target that is out of range inside 0 to 100', () => {
    expect(moveTimeMs({ kind: 'go', open: 140 }, { open: 0, travelMs: 10_000 })).toBe(12_500);
    expect(moveTimeMs({ kind: 'go', open: -20 }, { open: 100, travelMs: 10_000 })).toBe(12_500);
  });
});
