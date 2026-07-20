import { useEffect, useRef } from 'react';
import type { AutopilotState } from '../types';
import type { PlayheadRef } from '../playhead';
import { fmtTime } from '../api';
import { Art, StatusBadge } from './badges';
import { IngestStepper } from './IngestStepper';

// Top strip: what Spotify is playing, read-only. The playhead bar is a
// display, not a scrubber — and it's driven per-frame from the smooth
// playhead clock via direct DOM writes (no React churn, no snapping).
export function NowPlaying({ state, playhead, now }: {
  state: AutopilotState;
  playhead: PlayheadRef;
  now: number;
}) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const timeRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const pos = playhead.current;
      const dur = state.duration_s ?? 0;
      if (barRef.current) {
        barRef.current.style.width = dur > 0 ? `${Math.min(100, (pos / dur) * 100)}%` : '0%';
      }
      if (timeRef.current) {
        const t = fmtTime(pos);
        if (timeRef.current.textContent !== t) timeRef.current.textContent = t;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playhead, state.duration_s]);

  const status = state.track_status ?? 'unknown';

  if (!state.running) {
    return <div className="text-sm text-zinc-500">autopilot is stopped — nothing to follow</div>;
  }
  if (!state.track_id) {
    return <div className="text-sm text-zinc-500">waiting for Spotify playback…</div>;
  }

  return (
    <div className="flex items-center gap-4 min-w-0">
      <Art url={state.art_url} size="w-14 h-14" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold truncate">{state.track_name}</span>
          <span className="text-zinc-500 text-sm truncate">{(state.artists ?? []).join(', ')}</span>
          <StatusBadge status={status} />
        </div>
        <div className="mt-1.5 flex items-center gap-2 text-[10px] font-mono text-zinc-500">
          <span>{state.playing ? '▶' : '⏸'}</span>
          <span ref={timeRef} className="tabular-nums">0:00</span>
          <div className="flex-1 h-1.5 rounded bg-zinc-800 overflow-hidden">
            <div ref={barRef} className="h-full bg-zinc-400 rounded" />
          </div>
          <span className="tabular-nums">{state.duration_s ? fmtTime(state.duration_s) : '–:––'}</span>
        </div>
        {status === 'ingesting' && state.track_id && (
          <div className="mt-1.5">
            <IngestStepper progress={state.ingest_progress?.[state.track_id]} now={now} />
          </div>
        )}
      </div>
    </div>
  );
}
