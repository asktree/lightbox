import { useEffect, useState } from 'react';

// Autopilot status bar. Autopilot is the Spotify playhead + ingest brain —
// it drives NO lights (lights are stem-sync's job, server-side over the
// entertainment stream; REST is never used for audio reactivity). Polls
// lightbox's /api/autopilot/state every ~1s, shows live track + ingest
// status, and has an on/off toggle. Self-contained — drop it anywhere.

const LIGHTBOX_URL = `http://${window.location.hostname}:3001`;

interface AutopilotState {
  running?: boolean;
  pid?: number;
  track_id?: string | null;
  track_name?: string;
  artists?: string[];
  playing?: boolean;
  position_s?: number;
  peaks_total?: number;
  cursor_idx?: number;
  fires_total?: number;
  source?: string;
  offset_ms?: number;
  light_rids?: string[];
  drift_ms?: number | null;
  output_latency_ms?: number | null;
  output_device_name?: string | null;
  bridge_rtt_ms?: number | null;
  ingesting?: string[];
  last_error?: string | null;
  updated_at?: number;
  stale?: boolean;
}

function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function AutopilotBar() {
  const [state, setState] = useState<AutopilotState>({ running: false });
  const [busy, setBusy] = useState(false);

  // Poll autopilot state. In-flight guard prevents stacking when the
  // server lags — without it, slow responses pile up sockets and
  // eventually trigger Chrome's ERR_INSUFFICIENT_RESOURCES across the tab.
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const r = await fetch(`${LIGHTBOX_URL}/api/autopilot/state`);
        if (cancelled) return;
        setState(await r.json());
      } catch { /* ignore */ }
      finally { inFlight = false; }
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  const start = async () => {
    setBusy(true);
    try {
      // No lightRids — autopilot never drives lights (that's stem-sync).
      const r = await fetch(`${LIGHTBOX_URL}/api/autopilot/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lightRids: [], autoIngest: true }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(`start failed: ${j.error ?? r.status}`);
      }
    } catch (e) { alert(`start failed: ${e}`); }
    finally { setBusy(false); }
  };
  const stop = async () => {
    setBusy(true);
    try { await fetch(`${LIGHTBOX_URL}/api/autopilot/stop`, { method: 'POST' }); }
    catch { /* ignore */ }
    finally { setBusy(false); }
  };

  const running = !!state.running && !state.stale;
  const ingestingCount = (state.ingesting ?? []).length;
  const artistLine = (state.artists ?? []).join(', ');

  return (
    <div className="shrink-0 bg-zinc-900 border-b border-zinc-800 px-3 py-2 flex items-center gap-3 text-xs">
      <button
        onClick={running ? stop : start}
        disabled={busy}
        className={`px-3 py-1 rounded font-mono font-semibold ${
          running ? 'bg-red-600 hover:bg-red-500 text-white' : 'bg-green-600 hover:bg-green-500 text-white'
        } disabled:opacity-50`}
      >{busy ? '…' : running ? 'autopilot: ON' : 'autopilot: OFF'}</button>

      {running ? (
        <>
          <div className="flex-1 min-w-0">
            {state.track_id ? (
              <div className="flex items-center gap-2">
                <span className="text-zinc-400 font-mono text-[10px]">{state.playing ? '▶' : '⏸'}</span>
                <span className="truncate">
                  <span className="text-zinc-200">{state.track_name}</span>
                  <span className="text-zinc-500"> — {artistLine}</span>
                </span>
                <span className="text-zinc-600 font-mono">{fmtTime(state.position_s ?? 0)}</span>
              </div>
            ) : (
              <span className="text-zinc-500">waiting for Spotify…</span>
            )}
          </div>
          <div className="flex items-center gap-3 text-zinc-500 font-mono text-[10px] whitespace-nowrap">
            {ingestingCount > 0 && (
              <span className="text-amber-400" title="ingesting unknown tracks">
                ingest×{ingestingCount}
              </span>
            )}
            {state.last_error && (
              <span className="text-red-400 truncate max-w-[200px]" title={state.last_error}>
                err: {state.last_error.slice(0, 40)}
              </span>
            )}
          </div>
        </>
      ) : (
        <span className="flex-1 text-zinc-600">spotify playhead + auto-ingest · lights via stem drive (dashboard)</span>
      )}

      <a
        href="#/autopilot"
        className="text-zinc-500 hover:text-zinc-300 font-mono text-[10px] whitespace-nowrap"
        title="full autopilot dashboard"
      >dashboard ⤢</a>
    </div>
  );
}
