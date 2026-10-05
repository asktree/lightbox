import { describe, expect, it } from 'vitest';
import { ShadeTap, TAP_FRESH_MS } from './shade-tap.js';

const S = 1000;

describe('ShadeTap', () => {
  it('goes up on the first tap when the blind is mostly down', () => {
    const t = new ShadeTap();
    expect(t.tap(0, 10, null)).toEqual({ kind: 'go', open: 100 });
  });

  it('goes down on the first tap when the blind is mostly up', () => {
    const t = new ShadeTap();
    expect(t.tap(0, 80, null)).toEqual({ kind: 'go', open: 0 });
  });

  it('alternates pause and reverse on the next taps', () => {
    const t = new ShadeTap();
    expect(t.tap(0, 0, false)).toEqual({ kind: 'go', open: 100 });      // up
    expect(t.tap(3 * S, 15, true)).toEqual({ kind: 'stop' });           // pause
    expect(t.tap(5 * S, 15, false)).toEqual({ kind: 'go', open: 0 });   // reverse: down
    expect(t.tap(6 * S, 10, true)).toEqual({ kind: 'stop' });           // pause
    expect(t.tap(8 * S, 10, false)).toEqual({ kind: 'go', open: 100 }); // reverse: up
    expect(t.tap(9 * S, 15, true)).toEqual({ kind: 'stop' });           // pause
  });

  it('reverses and does not pause when the blind is at the end already', () => {
    const t = new ShadeTap();
    expect(t.tap(0, 0, false)).toEqual({ kind: 'go', open: 100 });
    // 60 s later the blind is at the top and does not move.
    expect(t.tap(60 * S, 100, false)).toEqual({ kind: 'go', open: 0 });
  });

  it('uses its own time estimate when the board state is not fresh', () => {
    const t = new ShadeTap();
    expect(t.tap(0, 0, null)).toEqual({ kind: 'go', open: 100 });       // full travel, about 22 s
    expect(t.tap(10 * S, null, null)).toEqual({ kind: 'stop' });        // still in the travel time
    expect(t.tap(12 * S, null, null)).toEqual({ kind: 'go', open: 0 }); // paused, so reverse
    const u = new ShadeTap();
    expect(u.tap(0, 0, null)).toEqual({ kind: 'go', open: 100 });
    expect(u.tap(40 * S, null, null)).toEqual({ kind: 'go', open: 0 }); // travel time is over
  });

  it('starts from the position rule again after 3 minutes with no use', () => {
    const t = new ShadeTap();
    expect(t.tap(0, 0, false)).toEqual({ kind: 'go', open: 100 });
    expect(t.tap(5 * S, 25, true)).toEqual({ kind: 'stop' });
    // The blind stays at 25 %: mostly down. A reverse would send it down;
    // the position rule sends it up.
    expect(t.tap(5 * S + TAP_FRESH_MS + 1, 25, false)).toEqual({ kind: 'go', open: 100 });
  });

  it('does not pause on a first tap after 3 minutes, even if the blind moves', () => {
    const t = new ShadeTap();
    expect(t.tap(0, 0, false)).toEqual({ kind: 'go', open: 100 });
    // Something else (the remote) moves the blind 4 minutes later.
    expect(t.tap(4 * 60 * S, 70, true)).toEqual({ kind: 'go', open: 0 });
  });

  it('counts a dial move as use and as the last direction', () => {
    const t = new ShadeTap();
    t.noteMove(0, 20, 60);                                              // the dial sends it up
    expect(t.tap(2 * S, 30, true)).toEqual({ kind: 'stop' });           // pause
    expect(t.tap(4 * S, 30, false)).toEqual({ kind: 'go', open: 0 });   // reverse: down
    const u = new ShadeTap();
    u.noteMove(0, 80, 60);                                              // the dial sends it down
    expect(u.tap(30 * S, 60, false)).toEqual({ kind: 'go', open: 100 }); // stopped, so reverse: up
  });

  it('picks a direction when the position is not known', () => {
    const t = new ShadeTap();
    expect(t.tap(0, null, null)).toEqual({ kind: 'go', open: 100 });
  });
});
