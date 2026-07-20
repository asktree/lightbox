import { useEffect, useState } from 'react';

// Audio→light alignment offset. Standalone — knows nothing about autopilot
// beyond the fact that autopilot is currently the only consumer (we POST
// to /api/autopilot/set-offset). Lives independently so the slider stays
// visible and the value is owned regardless of autopilot lifecycle.
//
// Suggested = output_latency − bridge_rtt:
//   output_latency: how late audio is vs. the playhead (AirPlay ≈ 2000ms,
//                   speakers ≈ 30ms). Sourced from /api/audio-latency,
//                   which spawns CoreAudio probe in Python on demand —
//                   no autopilot needed.
//   bridge_rtt:     server-side EMA of Hue REST pulse round-trips. Stays
//                   null on a pure WiZ/Tuya / energy-only setup.
// Both are best-effort polls — when either is unmeasured, the bar
// degrades to a manual slider with a hardcoded default.

const LIGHTBOX_URL = `http://${window.location.hostname}:3001`;
const STORAGE_KEY = 'lightbox:offsetMs';
const LEGACY_AUTOPILOT_KEY = 'autopilot:offsetMs'; // migrate from old key
const BRIDGE_RTT_DEFAULT_MS = 150;

function loadStoredOffset(): number | null {
  if (typeof window === 'undefined') return null;
  const v = localStorage.getItem(STORAGE_KEY);
  if (v !== null) return parseInt(v, 10);
  // One-time migration: pull the value out of the old autopilot-scoped key
  // if it exists, then write under the new key for next time.
  const legacy = localStorage.getItem(LEGACY_AUTOPILOT_KEY);
  if (legacy !== null) {
    localStorage.setItem(STORAGE_KEY, legacy);
    return parseInt(legacy, 10);
  }
  return null;
}

export function OffsetBar() {
  const [userOffsetMs, setUserOffsetMs] = useState<number | null>(loadStoredOffset);
  const [outputLatencyMs, setOutputLatencyMs] = useState<number | null>(null);
  const [outputDeviceName, setOutputDeviceName] = useState<string | null>(null);
  const [bridgeRttMs, setBridgeRttMs] = useState<number | null>(null);
  const [hueStreamActive, setHueStreamActive] = useState(false);
  const [releasing, setReleasing] = useState(false);

  useEffect(() => {
    if (userOffsetMs === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, String(userOffsetMs));
  }, [userOffsetMs]);

  // Poll the two measured inputs. /api/audio-latency caches its measurement
  // server-side after first request, so this is cheap; ?refresh=1 forces a
  // remeasure (e.g. on output device change).
  const refreshAudioLatency = async (force: boolean) => {
    try {
      const url = force ? `${LIGHTBOX_URL}/api/audio-latency?refresh=1` : `${LIGHTBOX_URL}/api/audio-latency`;
      const r = await fetch(url).then(r => r.json());
      if (typeof r?.output_latency_ms === 'number') setOutputLatencyMs(r.output_latency_ms);
      if (typeof r?.output_device_name === 'string') setOutputDeviceName(r.output_device_name);
    } catch { /* ignore */ }
  };
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const [rttRes, streamRes] = await Promise.all([
          fetch(`${LIGHTBOX_URL}/api/hue-stream/bridge-rtt`).then(r => r.json()).catch(() => ({})),
          fetch(`${LIGHTBOX_URL}/api/hue-stream/state`).then(r => r.json()).catch(() => ({})),
        ]);
        if (cancelled) return;
        if (typeof rttRes?.bridge_rtt_ms === 'number') setBridgeRttMs(rttRes.bridge_rtt_ms);
        setHueStreamActive(!!streamRes?.active);
      } catch { /* ignore */ }
      finally { inFlight = false; }
    };
    refreshAudioLatency(false);
    tick();
    const t = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  // Forcibly stop any active Hue entertainment stream. Useful when bulbs
  // get stuck in entertainment mode (DTLS handshake errors, lifecycle
  // bug, browser tab closed without heartbeat) — releases the bridge so
  // REST/palette control resumes. Safe to call when no stream is up.
  const releaseHueStream = async () => {
    setReleasing(true);
    // Suppress LightPulseBindings' auto-reconcile so it doesn't immediately
    // restart the stream. Cleared there when bindings next change. Without
    // this the release "bounces" — stream stops, reconcile sees active=false
    // with energy bindings still present, and re-starts it.
    try { localStorage.setItem('lightbox:hueStreamSuppressed', '1'); } catch {}
    try {
      await fetch(`${LIGHTBOX_URL}/api/hue-stream/stop`, { method: 'POST' });
      setHueStreamActive(false);
    } catch { /* ignore */ }
    finally { setReleasing(false); }
  };

  const bridgeRttForCalc = Math.round(bridgeRttMs ?? BRIDGE_RTT_DEFAULT_MS);
  const suggestedOffsetMs: number | null =
    typeof outputLatencyMs === 'number' ? outputLatencyMs - bridgeRttForCalc : null;
  const effectiveOffsetMs: number = userOffsetMs ?? (suggestedOffsetMs ?? 0);

  // Push to autopilot AND mirror to localStorage so other client components
  // (App.tsx's ring-buffered viz, LightPulseBindings' fire timing) can read
  // the same effective value without prop-drilling. localStorage write is
  // a few microseconds; cross-component fan-out via DOM is heavier.
  useEffect(() => {
    fetch(`${LIGHTBOX_URL}/api/autopilot/set-offset`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offsetMs: effectiveOffsetMs }),
    }).catch(() => {});
    try { localStorage.setItem('lightbox:effectiveOffsetMs', String(effectiveOffsetMs)); }
    catch { /* private mode / quota */ }
  }, [effectiveOffsetMs]);

  return (
    <div className="shrink-0 bg-zinc-900 border-b border-zinc-800 px-3 py-1.5 flex items-center gap-3 text-xs">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono">offset</span>

      <label className="flex items-center gap-1.5 text-[10px] text-zinc-500 font-mono"
        title={`Delay light events to align with audio. Default = output_latency − bridge_rtt (${
          suggestedOffsetMs !== null ? suggestedOffsetMs + 'ms' : 'not yet measured'
        }). Drag to override.`}>
        <input type="range" min={-500} max={3000} step={25} value={effectiveOffsetMs}
          onChange={(e) => setUserOffsetMs(+e.target.value)}
          className="w-32" />
        <span className="w-12 text-right">{effectiveOffsetMs >= 0 ? '+' : ''}{effectiveOffsetMs}ms</span>
        <span className="text-zinc-600">{userOffsetMs === null ? '(auto)' : ''}</span>
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
        title={`Measured audio output latency for ${outputDeviceName ?? '?'} (CoreAudio device + stream + buffer + safety offset). Cached server-side; click to remeasure after switching output device.`}
      >audio {typeof outputLatencyMs === 'number'
        ? <span className={outputLatencyMs > 500 ? 'text-amber-400' : 'text-zinc-300'}>
            {outputLatencyMs}ms
            {outputDeviceName ? <span className="text-zinc-600"> ({outputDeviceName})</span> : null}
          </span>
        : <span className="text-zinc-600">—</span>
      }</span>
      <button
        onClick={() => refreshAudioLatency(true)}
        className="px-1 py-0.5 text-[10px] font-mono rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-500"
        title="Remeasure CoreAudio output latency. Use after switching output device (AirPlay → speakers, etc)."
      >↻</button>

      <span
        className="text-[10px] font-mono text-zinc-500"
        title="EMA of round-trip time for every Hue REST pulse the server sends. Source-agnostic. Subtracted from audio latency when computing the suggested offset."
      >bridge {typeof bridgeRttMs === 'number'
        ? <span className="text-zinc-300">{Math.round(bridgeRttMs)}ms</span>
        : <span className="text-zinc-600">—</span>
      }</span>

      <button
        onClick={releaseHueStream}
        disabled={releasing}
        className={`ml-auto px-2 py-0.5 text-[10px] font-mono rounded disabled:opacity-40 ${
          hueStreamActive ? 'bg-amber-700 hover:bg-amber-600 text-white' : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-400'
        }`}
        title="Forcibly stop the Hue entertainment stream. Use when bulbs get stuck in entertainment mode (handshake errors, abandoned tab, etc) and won't respond to REST/palette."
      >{releasing ? '…' : hueStreamActive ? 'release Hue stream' : 'release Hue stream (idle)'}</button>
    </div>
  );
}
