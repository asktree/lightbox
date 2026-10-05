import { describe, expect, it } from 'vitest';
import { ShadeTap, TAP_FRESH_MS } from '../src/services/shade-tap.js';

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
    expect(t.tap(0, 0, null)).toEqual({ kind: 'go', open: 100 });       // full travel, about 33 s
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

  it('pauses on a first tap after 3 minutes if the board says that the blind moves', () => {
    const t = new ShadeTap();
    expect(t.tap(0, 0, false)).toEqual({ kind: 'go', open: 100 });
    // Another control moves the blind down 4 minutes later.
    expect(t.tap(4 * 60 * S, 70, true, -1)).toEqual({ kind: 'stop' });
    // The next tap goes opposite to the move that the tap stopped.
    expect(t.tap(4 * 60 * S + 2 * S, 70, false)).toEqual({ kind: 'go', open: 100 });
    expect(t.tap(4 * 60 * S + 4 * S, 75, true)).toEqual({ kind: 'stop' });
    expect(t.tap(4 * 60 * S + 6 * S, 75, false)).toEqual({ kind: 'go', open: 0 });
  });

  it('uses the position rule after that pause when the board gives no direction', () => {
    const t = new ShadeTap();
    expect(t.tap(0, 0, false)).toEqual({ kind: 'go', open: 100 });   // our last direction: up
    expect(t.tap(4 * 60 * S, 30, true)).toEqual({ kind: 'stop' });
    // Mostly down, so up. Our old direction (up) would give down.
    expect(t.tap(4 * 60 * S + 2 * S, 30, false)).toEqual({ kind: 'go', open: 100 });
    const u = new ShadeTap();
    expect(u.tap(0, 80, true, 0)).toEqual({ kind: 'stop' });          // very first tap, blind moves
    expect(u.tap(2 * S, 80, false)).toEqual({ kind: 'go', open: 0 }); // mostly up, so down
  });

  it('does not pause on a first tap after 3 minutes from its own old estimate', () => {
    const t = new ShadeTap();
    expect(t.tap(0, 0, null)).toEqual({ kind: 'go', open: 100 });
    // No fresh board state 4 minutes later: the blind is taken as stopped.
    expect(t.tap(4 * 60 * S, 70, null)).toEqual({ kind: 'go', open: 0 });
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

  it('uses the travel time that the board gives', () => {
    const t = new ShadeTap();
    t.setTravelMs(10_000);
    expect(t.tap(0, 0, null)).toEqual({ kind: 'go', open: 100 });       // 10 s travel + margin
    expect(t.tap(13 * S, null, null)).toEqual({ kind: 'go', open: 0 }); // over, so reverse
    const u = new ShadeTap();
    u.setTravelMs(0);                                                   // not known: keep the default
    expect(u.tap(0, 0, null)).toEqual({ kind: 'go', open: 100 });
    expect(u.tap(13 * S, null, null)).toEqual({ kind: 'stop' });
  });

  it('picks a direction when the position is not known', () => {
    const t = new ShadeTap();
    expect(t.tap(0, null, null)).toEqual({ kind: 'go', open: 100 });
  });
});
