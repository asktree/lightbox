// Tap logic for the blind button (Tap Dial button 2, pressed alone).
//
//   First tap after 3 minutes with no use: go to the far end. A blind that
//   is mostly down goes up; a blind that is mostly up goes down.
//   After that, each tap alternates: pause, then go in the opposite
//   direction, then pause, then the opposite direction again, and so on.
//   A tap while the board says that the blind moves is always a pause, also
//   for a move that another control started.
//
// This module has no I/O, so the rules can be tested without a blind.

export type TapAction = { kind: 'go'; open: 0 | 100 } | { kind: 'stop' };

// After this time with no use, a tap starts again from the position rule.
export const TAP_FRESH_MS = 3 * 60_000;
// Full travel between the limits, until the board gives the motor's own
// number (Tuya dp 10; 32.1 s with the limits of 2026-10-05).
const DEFAULT_TRAVEL_MS = 32_000;
// The motor ramps up and down, and its reports arrive late.
const TRAVEL_MARGIN_MS = 1_500;

export class ShadeTap {
  private lastUsedAt = Number.NEGATIVE_INFINITY;
  private dir: 1 | -1 | 0 = 0;   // last movement: 1 = up (open), -1 = down
  private movingUntil = 0;       // our own estimate of the end of that movement
  private travelMs = DEFAULT_TRAVEL_MS;

  /** The motor's time for a full travel, in ms, when the board knows it. */
  setTravelMs(ms: unknown): void {
    if (typeof ms === 'number' && ms >= 3_000 && ms <= 180_000) this.travelMs = ms;
  }

  /**
   * A tap at time `now` (ms). `open` is the last known position, 0 closed to
   * 100 open, or null. `moving` is the board's fresh "the blind moves" flag,
   * or null if no fresh state is available; then our own estimate is used.
   * `boardDir` is the board's direction of that move (1 up, -1 down), if known.
   */
  tap(now: number, open: number | null, moving: boolean | null, boardDir: number | null = null): TapAction {
    const fresh = now - this.lastUsedAt > TAP_FRESH_MS;
    this.lastUsedAt = now;

    if (moving === true || (!fresh && (moving ?? now < this.movingUntil))) {
      // After a long pause our own direction is old. Take the direction of
      // the move that this tap stops, so the next tap goes the opposite way.
      if (fresh) this.dir = boardDir === 1 || boardDir === -1 ? boardDir : 0;
      this.movingUntil = now;
      return { kind: 'stop' };
    }
    let dir: 1 | -1;
    if (!fresh && this.dir !== 0) dir = this.dir === 1 ? -1 : 1;   // reverse
    else if (open !== null) dir = open < 50 ? 1 : -1;              // go to the far end
    else dir = this.dir === 1 ? -1 : 1;                            // position not known
    const target = dir === 1 ? 100 : 0;
    this.started(now, dir, open, target);
    return { kind: 'go', open: target };
  }

  /** Another control (the dial) sent the blind from `open` towards `target`. */
  noteMove(now: number, open: number | null, target: number): void {
    this.lastUsedAt = now;
    if (open !== null && target === open) return;
    this.started(now, open === null || target > open ? 1 : -1, open, target);
  }

  private started(now: number, dir: 1 | -1, open: number | null, target: number): void {
    this.dir = dir;
    const distance = open === null ? 100 : Math.abs(target - open);
    this.movingUntil = now + (distance / 100) * this.travelMs + TRAVEL_MARGIN_MS;
  }
}
