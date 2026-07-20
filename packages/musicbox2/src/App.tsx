import { useEffect, useRef } from 'react';
import { useAutopilot, useStemSync, useRestLights, useNow, LIGHTBOX_URL } from './api';
import type { AutopilotState } from './types';
import { usePlayhead } from './playhead';
import { loadStemData } from './dsp/stems';
import { NowPlaying } from './components/NowPlaying';
import { Queue } from './components/Queue';
import { DriveRail } from './components/DriveRail';
import { Diagnostics } from './components/Diagnostics';
import { StemViz } from './components/StemViz';

// Musicbox v2 — one screen, four zones (design doc §06):
//   top: now playing (read-only) · main: stem spectrographs + energy timeline
//   right: drive rail + queue · foot: diagnostics
// Spotify owns transport; the server owns the lights; this page is glass.
export default function App() {
  const [ap, apAt] = useAutopilot();
  const [drive] = useStemSync();
  const lights = useRestLights();
  const now = useNow(500);

  // Latest state in a ref for the 60fps canvas loop (no re-render churn).
  const apRef = useRef<AutopilotState>(ap);
  useEffect(() => { apRef.current = ap; }, [ap]);
  // The one true playhead: server age-corrects, this slews, and the value
  // is from the listener's-ears perspective (minus the MEASURED output
  // latency; residual playback buffering awaits the mic+webcam
  // calibration — never a manual nudge). Every moving surface (scrubber,
  // panes, timeline, meters) reads it per-frame.
  const playhead = usePlayhead(apRef, apAt);

  // Kick off stem decode for the current track as soon as it's ready, and
  // prefetch the up-next track so the panes light up on its first beat.
  useEffect(() => {
    if (ap.track_id && ap.track_status === 'ready') {
      loadStemData(ap.track_id).catch(() => {});
    }
    const next = (ap.queue ?? [])[0];
    if (next?.id && next.status === 'ready') {
      loadStemData(next.id).catch(() => {});
    }
  }, [ap.track_id, ap.track_status, ap.queue]);

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Top: now playing */}
      <header className="shrink-0 border-b border-zinc-800 px-4 py-3 flex items-center gap-4">
        <span className="font-mono text-xs font-semibold tracking-widest text-zinc-400 shrink-0">musicbox<span className="text-cyan-400">2</span></span>
        <div className="flex-1 min-w-0">
          <NowPlaying state={ap} playhead={playhead} now={now} />
        </div>
        {!ap.running && (
          <button
            onClick={() => fetch(`${LIGHTBOX_URL}/api/autopilot/start`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ autoIngest: true }),
            }).catch(() => {})}
            className="shrink-0 px-3 py-1 rounded font-mono text-xs font-semibold bg-green-600 hover:bg-green-500"
          >start autopilot</button>
        )}
      </header>

      <div className="flex-1 flex min-h-0">
        {/* Main column: spectrographs + energy timeline */}
        <main className="flex-1 min-w-0 p-2">
          <StemViz apRef={apRef} playhead={playhead} />
        </main>

        {/* Right rail: drive + queue */}
        <aside className="w-80 shrink-0 border-l border-zinc-800 overflow-y-auto p-3 flex flex-col gap-5">
          <DriveRail status={drive} lights={lights} apRef={apRef} playhead={playhead} />
          <Queue state={ap} now={now} />
        </aside>
      </div>

      {/* Foot: diagnostics */}
      <footer className="shrink-0 border-t border-zinc-800 px-4 py-2">
        <Diagnostics ap={ap} drive={drive} now={now} />
      </footer>
    </div>
  );
}
