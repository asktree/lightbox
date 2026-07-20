// Smooth client playhead.
//
// The raw samples (autopilot state, ~1Hz poll) each carry position_live —
// age-corrected on the server, which shares a clock with the autopilot —
// so a sample's only error is network latency. But naively resetting the
// playhead on every sample still visibly snaps. This clock instead
// advances every frame at 1×, and *slews* toward each fresh sample:
// small errors are absorbed over ~quarter second, big jumps (seeks,
// track changes) snap immediately.

import { useMemo, useRef } from 'react';
import type { AutopilotState } from './types';

const SNAP_THRESHOLD_S = 0.75; // bigger error than this = a real seek; snap
const SLEW_PER_FRAME = 0.08;   // fraction of remaining error absorbed per frame

export interface PlayheadRef {
  readonly current: number;
  readonly playing: boolean;
}

// The clock returns the playhead from the LISTENER'S-EARS perspective:
// Spotify's reported position leads audible sound by the output chain, so
// we subtract the MEASURED CoreAudio output latency (autopilot probes it).
// Any remaining lead (Spotify's own playback buffering) is a known
// calibration target for the mic+webcam measurement system — never a
// manual nudge. Until measured, it stays uncorrected.
export function usePlayhead(
  apRef: React.MutableRefObject<AutopilotState>,
  receivedAt: React.MutableRefObject<number>,
): PlayheadRef {
  const display = useRef(0);
  const lastFrameMs = useRef(0);
  const lastTrack = useRef<string | null>(null);

  return useMemo<PlayheadRef>(() => ({
    get playing() { return !!apRef.current.playing; },
    get current() {
      const now = performance.now();
      // Several rAF consumers read the clock each frame; only the first
      // read per frame advances/slews, the rest see the cached value.
      if (now - lastFrameMs.current < 4) return display.current;
      const dtS = lastFrameMs.current ? Math.min(0.25, (now - lastFrameMs.current) / 1000) : 0;
      lastFrameMs.current = now;

      const ap = apRef.current;
      const base = (ap as AutopilotState & { position_live?: number }).position_live ?? ap.position_s ?? 0;
      const earLagS = (ap.output_latency_ms ?? 0) / 1000;
      const target = base + (ap.playing ? (Date.now() - receivedAt.current) / 1000 : 0) - earLagS;

      if (ap.track_id !== lastTrack.current) {
        lastTrack.current = ap.track_id ?? null;
        display.current = target;
        return display.current;
      }
      if (ap.playing) display.current += dtS;
      const err = target - display.current;
      if (Math.abs(err) > SNAP_THRESHOLD_S) display.current = target;
      else display.current += err * SLEW_PER_FRAME;
      return display.current;
    },
  }), [apRef, receivedAt]);
}
