import { useEffect, useRef, useState } from 'react';
import { useAutopilot, useLocalAutopilot, useStemSync, useRestLights, useNow, LIGHTBOX_URL } from './api';
import type { AutopilotState, PlayheadSource } from './types';
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
  const [spotAp, spotAt] = useAutopilot();
  const [drive] = useStemSync();
  const lights = useRestLights();
  const now = useNow(500);

  // Playhead source: the server (stem-sync config) owns it so the lights
  // and every open tab agree; the click applies an optimistic override
  // until the 500ms status poll confirms the switch.
  const serverSource: PlayheadSource = drive.config?.playheadSource ?? 'spotify';
  const [srcOverride, setSrcOverride] = useState<PlayheadSource | null>(null);
  const source = srcOverride ?? serverSource;
  useEffect(() => {
    if (srcOverride && serverSource === srcOverride) setSrcOverride(null);
  }, [serverSource, srcOverride]);
  const setSource = (s: PlayheadSource) => {
    setSrcOverride(s);
    fetch(`${LIGHTBOX_URL}/api/stem-sync/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playheadSource: s }),
    }).catch(() => {});
  };

  const [localAp, localAt] = useLocalAutopilot(source === 'local');
  const ap = source === 'local' ? localAp : spotAp;
  const apAt = source === 'local' ? localAt : spotAt;

  // Start-button state: never swallow a failure (409 "already running" was
  // invisible in prod — every error must reach the user).
  const [startBusy, setStartBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const callAutopilot = async (action: 'start' | 'stop') => {
    setStartBusy(true);
    try {
      const r = await fetch(`${LIGHTBOX_URL}/api/autopilot/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: action === 'start' ? JSON.stringify({ autoIngest: true }) : undefined,
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setStartError(j.error ?? `HTTP ${r.status}`);
      } else {
        setStartError(null);
      }
    } catch (e) {
      setStartError(String(e));
    } finally {
      setStartBusy(false);
    }
  };

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
        <div className="shrink-0 flex rounded overflow-hidden border border-zinc-700 font-mono text-[10px]">
          {(['spotify', 'local'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSource(s)}
              className={`px-2 py-1 ${source === s ? 'bg-cyan-600 text-white' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`}
            >{s}</button>
          ))}
        </div>
        {source === 'spotify' && (
          <div className="shrink-0 flex items-center gap-2 min-w-0">
            {/* exit_reason === 'auth' → starting will just fail again */}
            {!spotAp.running && spotAp.exit_reason === 'auth' && (
              <span className="text-amber-400 text-[10px] font-mono">spotify auth expired — re-auth on the server</span>
            )}
            {startError && (
              <span className="text-red-400 text-[10px] font-mono truncate max-w-48" title={startError}>{startError}</span>
            )}
            {!spotAp.running ? (
              <button
                onClick={() => callAutopilot('start')}
                disabled={startBusy}
                className="shrink-0 px-3 py-1 rounded font-mono text-xs font-semibold bg-green-600 hover:bg-green-500 disabled:opacity-50"
              >{startBusy ? '…' : 'start autopilot'}</button>
            ) : (
              <button
                onClick={() => callAutopilot('stop')}
                disabled={startBusy}
                className="shrink-0 px-3 py-1 rounded font-mono text-xs font-semibold bg-zinc-800 text-zinc-400 hover:bg-red-600 hover:text-white disabled:opacity-50"
              >{startBusy ? '…' : 'stop autopilot'}</button>
            )}
          </div>
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
