import { useEffect, useRef, useState } from 'react';
import type { AutopilotState, StemSyncStatus, RestLight } from './types';

// Lightbox (engine) is hit directly — it listens on all interfaces with
// open CORS, so follow whatever host the page was loaded from.
export const LIGHTBOX_URL = `http://${window.location.hostname}:3001`;
// Musicbox server (library/stems/envelope) is reached via the vite proxy.

// Poll a JSON endpoint with an in-flight guard (slow responses must not
// stack sockets). Returns [data, receivedAtRef].
export function usePoll<T>(url: string, intervalMs: number): [T | null, React.MutableRefObject<number>] {
  const [data, setData] = useState<T | null>(null);
  const receivedAt = useRef(0);
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const r = await fetch(url);
        if (cancelled) return;
        setData(await r.json());
        receivedAt.current = Date.now();
      } catch { /* endpoint down; keep last data */ }
      finally { inFlight = false; }
    };
    tick();
    const t = setInterval(tick, intervalMs);
    return () => { cancelled = true; clearInterval(t); };
  }, [url, intervalMs]);
  return [data, receivedAt];
}

export function useAutopilot(): [AutopilotState, React.MutableRefObject<number>] {
  const [s, at] = usePoll<AutopilotState>(`${LIGHTBOX_URL}/api/autopilot/state`, 1000);
  return [s ?? { running: false }, at];
}

export function useStemSync(): [StemSyncStatus, React.MutableRefObject<number>] {
  const [s, at] = usePoll<StemSyncStatus>(`${LIGHTBOX_URL}/api/stem-sync/status`, 500);
  return [s ?? {}, at];
}

export function useRestLights(): RestLight[] {
  const [lights, setLights] = useState<RestLight[]>([]);
  useEffect(() => {
    fetch(`${LIGHTBOX_URL}/api/hue-stream/rest-lights`)
      .then((r) => r.json())
      .then((j) => setLights(j.lights ?? []))
      .catch(() => {});
  }, []);
  return lights;
}

// A 2Hz-updated wall clock for elapsed timers and playhead interpolation.
export function useNow(intervalMs = 500): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function fmtTime(sec: number | null | undefined): string {
  if (sec == null || !isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function fmtSecs(sec: number): string {
  if (sec < 90) return `${Math.round(sec)}s`;
  return `${Math.floor(sec / 60)}m${String(Math.round(sec % 60)).padStart(2, '0')}s`;
}
