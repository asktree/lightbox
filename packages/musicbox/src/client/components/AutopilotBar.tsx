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
  // If the user has manually set an offset, we honor that value.
  // Otherwise we auto-follow the suggested = outputLatency - bridgeRtt.
  const [userOffsetMs, setUserOffsetMs] = useState<number | null>(() => {
    const s = typeof window !== 'undefined' ? localStorage.getItem('autopilot:offsetMs') : null;
    return s !== null ? parseInt(s, 10) : null;
  });
  // Which lights are enabled. Defaults to couch only.
  const [selectedRids, setSelectedRids] = useState<string[]>(() => {
    const s = typeof window !== 'undefined' ? localStorage.getItem('autopilot:lightRids') : null;
    if (s) try { const a = JSON.parse(s); if (Array.isArray(a)) return a; } catch {}
    return [AUTOPILOT_LIGHTS[0].rid];
  });
  const [busy, setBusy] = useState(false);
  // Source-agnostic bridge RTT — measured on the Node server for every
  // /rest-pulse call. Declared early so the offset calculation can reference
  // it below without a temporal dead zone trap.
  const [serverBridgeRttMs, setServerBridgeRttMs] = useState<number | null>(null);

  useEffect(() => {
    if (userOffsetMs === null) localStorage.removeItem('autopilot:offsetMs');
    else localStorage.setItem('autopilot:offsetMs', String(userOffsetMs));
  }, [userOffsetMs]);
  useEffect(() => { localStorage.setItem('autopilot:lightRids', JSON.stringify(selectedRids)); }, [selectedRids]);

  // Suggested offset = output_latency − bridge_rtt.
  //  output_latency: how late audio is vs. playhead (AirPlay ≈ 2000ms, speakers ≈ 30ms)
  //  bridge_rtt:     how late the bulb flashes vs. when we POST the pulse
  // We want the bulb to flash when audio is audible, so we fire early by
  // bridge_rtt and late by output_latency. Can be negative (speakers: fire
  // before the peak so the bridge delay catches up to the ~instant audio).
  //
  // If bridge_rtt hasn't been measured yet (autopilot idle / no lights
  // bound), use an observed typical of 150ms rather than a magic 300.
  const BRIDGE_RTT_DEFAULT_MS = 150;
  // Prefer the source-agnostic server measurement; fall back to autopilot's
  // self-measurement, then the hardcoded default.
  const effectiveBridgeRtt =
    typeof serverBridgeRttMs === 'number' ? serverBridgeRttMs
    : typeof state.bridge_rtt_ms === 'number' ? state.bridge_rtt_ms
    : BRIDGE_RTT_DEFAULT_MS;
  const bridgeRttForCalc = Math.round(effectiveBridgeRtt);
  const suggestedOffsetMs: number | null =
    typeof state.output_latency_ms === 'number'
      ? state.output_latency_ms - bridgeRttForCalc
      : null;

  const effectiveOffsetMs: number = userOffsetMs ?? (suggestedOffsetMs ?? 0);

  // Push the effective offset to autopilot whenever it changes.
  useEffect(() => {
    fetch(`${LIGHTBOX_URL}/api/autopilot/set-offset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offsetMs: effectiveOffsetMs }),
    }).catch(() => {});
  }, [effectiveOffsetMs]);

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

  // Poll state. Light while alive, slow while dead.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const [stateRes, rttRes] = await Promise.all([
          fetch(`${LIGHTBOX_URL}/api/autopilot/state`).then(r => r.json()),
          fetch(`${LIGHTBOX_URL}/api/hue-stream/bridge-rtt`).then(r => r.json()).catch(() => ({})),
        ]);
        if (cancelled) return;
        setState(stateRes);
        if (typeof rttRes?.bridge_rtt_ms === 'number') setServerBridgeRttMs(rttRes.bridge_rtt_ms);
      } catch { /* ignore */ }
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
      const r = await fetch(`${LIGHTBOX_URL}/api/autopilot/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lightRids: selectedRids,
          source: 'drums_low_strict.superflux',
          offsetMs: effectiveOffsetMs,
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

      <label className="flex items-center gap-1.5 text-[10px] text-zinc-500 font-mono"
        title={`Delay light events to align with audio. Default = output_latency − bridge_rtt (${
          suggestedOffsetMs !== null ? suggestedOffsetMs + 'ms' : 'not yet measured'
        }). Drag to override.`}>
        offset
        <input type="range" min={-500} max={3000} step={25} value={effectiveOffsetMs}
          onChange={(e) => setUserOffsetMs(+e.target.value)}
          className="w-24" />
        <span className="w-12 text-right">{effectiveOffsetMs >= 0 ? '+' : ''}{effectiveOffsetMs}ms</span>
        <span className="text-zinc-600">
          {userOffsetMs === null ? '(auto)' : ''}
        </span>
      </label>
      {userOffsetMs !== null && (
        <button
          onClick={() => setUserOffsetMs(null)}
          className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-zinc-800 hover:bg-zinc-700"
          title="Return to auto (output_latency − bridge_rtt)"
        >auto</button>
      )}
      <span
        className="text-[10px] font-mono text-zinc-500"
        title={`Measured audio output latency for ${state.output_device_name ?? '?'} (CoreAudio device + stream + buffer + safety offset).`}
      >audio {typeof state.output_latency_ms === 'number'
        ? <span className={state.output_latency_ms > 500 ? 'text-amber-400' : 'text-zinc-300'}>
            {state.output_latency_ms}ms
            {state.output_device_name ? <span className="text-zinc-600"> ({state.output_device_name})</span> : null}
          </span>
        : <span className="text-zinc-600">—</span>
      }</span>
      <span
        className="text-[10px] font-mono text-zinc-500"
        title="EMA of round-trip time for every pulse the server sends to the Hue bridge. Source-agnostic: updates from musicbox pulses, autopilot, or any other caller. Subtracted from audio latency when computing the default offset."
      >bridge {typeof serverBridgeRttMs === 'number'
        ? <span className="text-zinc-300">{Math.round(serverBridgeRttMs)}ms</span>
        : typeof state.bridge_rtt_ms === 'number'
          ? <span className="text-zinc-300">{Math.round(state.bridge_rtt_ms)}ms</span>
          : <span className="text-zinc-600">—</span>
      }</span>
    </div>
  );
}
