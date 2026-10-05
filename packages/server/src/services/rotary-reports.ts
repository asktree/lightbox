// Which rotary reports of the Tap Dial act.
//
// The same report can come two ways: on the Hue EventStream, and from a
// direct read of the `relative_rotary` resource. The bridge holds stream
// items back: a report came 0.1 s to 0.85 s after its time stamp (measured,
// 2026-10-05). A direct read shows the report at once. So tap-dial.ts reads
// the resource in a fast loop while the dial turns, and this class makes
// sure that each report acts one time only.
//
// A report is known by its resource id and its `rotary_report.updated` stamp.

export type RotarySource = 'stream' | 'read';

export type RotaryVerdict =
  | { act: true; firstOfTurn: boolean }
  | {
      act: false;
      why: 'duplicate' | 'old' | 'baseline' | 'no-stamp';
      // For a duplicate: the source that had the report first, and how long ago.
      firstVia?: RotarySource;
      afterMs?: number;
    };

// A report in a read that is older than this is from an earlier turn.
export const ROTARY_OLD_MS = 1500;
// No report for this long: the next report starts a new turn.
export const ROTARY_TURN_GAP_MS = 1500;
const KEEP = 32;

export class RotaryReports {
  private seen = new Map<string, { at: number; via: RotarySource }>();
  // Resources with a known last report. The first read of a resource only
  // shows what was there before; it must not act.
  private known = new Set<string>();
  private lastActAt = Number.NEGATIVE_INFINITY;

  accept(id: string, updated: unknown, via: RotarySource, now: number): RotaryVerdict {
    if (typeof updated !== 'string') {
      // No stamp: a read cannot tell if the report is new. The stream sends
      // an item one time, so it acts.
      if (via === 'read') return { act: false, why: 'no-stamp' };
      return this.acted(now);
    }
    const key = `${id}|${updated}`;
    const first = this.seen.get(key);
    if (first) return { act: false, why: 'duplicate', firstVia: first.via, afterMs: now - first.at };
    this.seen.set(key, { at: now, via });
    if (this.seen.size > KEEP) this.seen.delete(this.seen.keys().next().value as string);

    const wasKnown = this.known.has(id);
    this.known.add(id);
    if (via === 'read') {
      if (!wasKnown) return { act: false, why: 'baseline' };
      const age = now - Date.parse(updated);
      if (!(age <= ROTARY_OLD_MS)) return { act: false, why: 'old' };
    }
    return this.acted(now);
  }

  private acted(now: number): RotaryVerdict {
    const firstOfTurn = now - this.lastActAt > ROTARY_TURN_GAP_MS;
    this.lastActAt = now;
    return { act: true, firstOfTurn };
  }
}
