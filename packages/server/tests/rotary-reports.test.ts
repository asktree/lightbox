import { describe, it, expect } from 'vitest';
import { RotaryReports, ROTARY_OLD_MS, ROTARY_TURN_GAP_MS } from '../src/services/rotary-reports.js';

const ID = 'dial-1';
const T0 = Date.parse('2026-10-05T05:38:59.000Z');
const stamp = (ms: number) => new Date(T0 + ms).toISOString();

describe('RotaryReports', () => {
  it('lets a stream report act one time', () => {
    const r = new RotaryReports();
    expect(r.accept(ID, stamp(0), 'stream', T0 + 120)).toEqual({ act: true, firstOfTurn: true });
    expect(r.accept(ID, stamp(0), 'stream', T0 + 130)).toMatchObject({ act: false, why: 'duplicate' });
  });

  it('ignores the read of a report that the stream gave', () => {
    const r = new RotaryReports();
    r.accept(ID, stamp(0), 'stream', T0 + 120);
    expect(r.accept(ID, stamp(0), 'read', T0 + 140)).toEqual({ act: false, why: 'duplicate', firstVia: 'stream', afterMs: 20 });
  });

  it('lets a read act first, then ignores the late stream item', () => {
    const r = new RotaryReports();
    r.accept(ID, stamp(0), 'stream', T0 + 120);
    expect(r.accept(ID, stamp(400), 'read', T0 + 460)).toEqual({ act: true, firstOfTurn: false });
    expect(r.accept(ID, stamp(400), 'stream', T0 + 1100)).toEqual({ act: false, why: 'duplicate', firstVia: 'read', afterMs: 640 });
  });

  it('lets a stream item act when the read did not see that report', () => {
    const r = new RotaryReports();
    r.accept(ID, stamp(0), 'stream', T0 + 120);
    r.accept(ID, stamp(800), 'read', T0 + 860);
    expect(r.accept(ID, stamp(400), 'stream', T0 + 1100)).toMatchObject({ act: true });
  });

  it('does not act on the first read of a resource', () => {
    const r = new RotaryReports();
    expect(r.accept(ID, stamp(0), 'read', T0 + 30)).toEqual({ act: false, why: 'baseline' });
    expect(r.accept(ID, stamp(400), 'read', T0 + 430)).toEqual({ act: true, firstOfTurn: true });
  });

  it('does not act on an old report in a read', () => {
    const r = new RotaryReports();
    r.accept(ID, stamp(0), 'stream', T0 + 120);
    // The stream lost this report. A read finds it one minute later.
    expect(r.accept(ID, stamp(400), 'read', T0 + 60_000)).toEqual({ act: false, why: 'old' });
    // It is recorded, so it stays without effect.
    expect(r.accept(ID, stamp(400), 'read', T0 + 60_050)).toMatchObject({ act: false, why: 'duplicate' });
    expect(r.accept(ID, stamp(400 + ROTARY_OLD_MS), 'read', T0 + 400 + 2 * ROTARY_OLD_MS + 1)).toEqual({ act: false, why: 'old' });
  });

  it('does not act on a read with no stamp, and acts on a stream item with no stamp', () => {
    const r = new RotaryReports();
    expect(r.accept(ID, undefined, 'read', T0)).toEqual({ act: false, why: 'no-stamp' });
    expect(r.accept(ID, undefined, 'stream', T0)).toEqual({ act: true, firstOfTurn: true });
    expect(r.accept(ID, undefined, 'stream', T0 + 400)).toEqual({ act: true, firstOfTurn: false });
  });

  it('does not act on a read with a stamp that is not a date', () => {
    const r = new RotaryReports();
    r.accept(ID, stamp(0), 'stream', T0 + 120);
    expect(r.accept(ID, 'not a date', 'read', T0 + 500)).toEqual({ act: false, why: 'old' });
  });

  it('marks the first report after a pause as the start of a turn', () => {
    const r = new RotaryReports();
    expect(r.accept(ID, stamp(0), 'stream', T0 + 120)).toMatchObject({ firstOfTurn: true });
    expect(r.accept(ID, stamp(400), 'read', T0 + 450)).toMatchObject({ firstOfTurn: false });
    const later = 450 + ROTARY_TURN_GAP_MS + 1;
    expect(r.accept(ID, stamp(later - 50), 'read', T0 + later)).toMatchObject({ act: true, firstOfTurn: true });
  });

  it('keeps two dials apart', () => {
    const r = new RotaryReports();
    r.accept(ID, stamp(0), 'stream', T0 + 120);
    expect(r.accept('dial-2', stamp(0), 'stream', T0 + 130)).toMatchObject({ act: true });
    // The first read of the second dial has a known last report already.
    expect(r.accept('dial-2', stamp(400), 'read', T0 + 430)).toMatchObject({ act: true });
  });

  it('forgets the oldest stamps', () => {
    const r = new RotaryReports();
    for (let i = 0; i < 40; i++) r.accept(ID, stamp(i * 400), 'stream', T0 + i * 400 + 100);
    // Stamp 0 is forgotten. The stream gives an item one time, so this is
    // a safe default for the stream. A read of it is too old to act.
    expect(r.accept(ID, stamp(0), 'read', T0 + 40 * 400)).toEqual({ act: false, why: 'old' });
    expect(r.accept(ID, stamp(39 * 400), 'read', T0 + 40 * 400)).toMatchObject({ act: false, why: 'duplicate' });
  });
});
