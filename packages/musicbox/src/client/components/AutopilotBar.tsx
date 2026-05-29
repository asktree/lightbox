import { useEffect, useState } from 'react';

// Autopilot status bar. Spotify → Hue couch light pulses. Polls lightbox's
// /api/autopilot/state every ~1s, shows live track + fire count, and has a
// big green/red toggle. Self-contained — drop it anywhere.

const LIGHTBOX_URL = 'http://localhost:3001';

// Candidate lights for autopilot, keyed by the CLIP v2 rid the lightbox
// bridge uses. Each entry is a checkbox in the bar. Easy to extend: add
// more entries here.
const AUTOPILOT_LIGHTS: Array<{ rid: string; label: string }> = [
  { rid: '85b9455f-e2a2-4461-a6fe-6d8760eecf46', label: 'couch' },
  { rid: '391ee03a-ee66-41d7-8391-a8f67d4b2bad', label: 'iris' },
];

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
  // Which lights are enabled. Defaults to couch only.
  const [selectedRids, setSelectedRids] = useState<string[]>(() => {
    const s = typeof window !== 'undefined' ? localStorage.getItem('autopilot:lightRids') : null;
    if (s) try { const a = JSON.parse(s); if (Array.isArray(a)) return a; } catch {}
    return [AUTOPILOT_LIGHTS[0].rid];
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => { localStorage.setItem('autopilot:lightRids', JSON.stringify(selectedRids)); }, [selectedRids]);

  // Live-push selection to autopilot whenever checkbox changes (or on mount)
  // so it applies without needing to stop/start.
  useEffect(() => {
    fetch(`${LIGHTBOX_URL}/api/autopilot/set-lights`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lightRids: selectedRids }),
    }).catch(() => {});
  }, [selectedRids]);

  const toggleLight = (rid: string) => {
    setSelectedRids((cur) => cur.includes(rid) ? cur.filter((r) => r !== rid) : [...cur, rid]);
  };

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
    if (selectedRids.length === 0) {
      alert('pick at least one light'); return;
    }
    setBusy(true);
    try {
      // offsetMs is owned by OffsetBar (separate component) and persisted
      // via /api/autopilot/set-offset → autopilot's config file. Whatever
      // value OffsetBar last pushed wins; the spawn-time default is just a
      // brief placeholder that the autopilot loop overwrites on next read.
      const r = await fetch(`${LIGHTBOX_URL}/api/autopilot/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lightRids: selectedRids,
          source: 'drums_low_strict.superflux',
          autoIngest: true,
        }),
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

      <div className="flex items-center gap-2 text-[10px] font-mono">
        {AUTOPILOT_LIGHTS.map((l) => {
          const on = selectedRids.includes(l.rid);
          return (
            <label key={l.rid} className="flex items-center gap-1 cursor-pointer select-none text-zinc-300">
              <input
                type="checkbox"
                checked={on}
                onChange={() => toggleLight(l.rid)}
                className="accent-green-500"
              />
              <span className={on ? 'text-zinc-200' : 'text-zinc-500'}>{l.label}</span>
            </label>
          );
        })}
      </div>

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
            <span className="text-zinc-400" title="Onset source driving pulses">
              {state.source ?? '?'}
            </span>
            <span title="peak cursor / total peaks">
              peaks {state.cursor_idx ?? -1}/{state.peaks_total ?? 0}
            </span>
            <span title="total pulses fired this session">fires {state.fires_total ?? 0}</span>
            {ingestingCount > 0 && (
              <span className="text-amber-400" title="ingesting unknown tracks">
                ingest×{ingestingCount}
              </span>
            )}
            {(state.peaks_total ?? 0) === 0 && state.track_id && ingestingCount === 0 && (
              <span className="text-zinc-600">no peaks for this track</span>
            )}
            {state.last_error && (
              <span className="text-red-400 truncate max-w-[200px]" title={state.last_error}>
                err: {state.last_error.slice(0, 40)}
              </span>
            )}
          </div>
        </>
      ) : (
        <span className="flex-1 text-zinc-600">driven by Spotify · couch light · drums_low_strict·sf</span>
      )}

    </div>
  );
}
