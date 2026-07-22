import { useEffect, useMemo, useRef, useState } from 'react';
import type { AutopilotState, QueueItem, StemSyncStatus, RestLight } from './types';

// Lightbox (engine) is hit directly — it listens on all interfaces with
// open CORS, so follow whatever host the page was loaded from.
export const LIGHTBOX_URL = `http://${window.location.hostname}:3001`;
// Musicbox server (library/stems/envelope) is reached via the vite proxy,
// except the local-playhead hooks below which hit it directly (open CORS).
export const MUSICBOX_URL = `http://${window.location.hostname}:3002`;

// Poll a JSON endpoint with an in-flight guard (slow responses must not
// stack sockets). Returns [data, receivedAtRef]. A null url polls nothing
// (used to disable the inactive playhead source's hooks).
export function usePoll<T>(url: string | null, intervalMs: number): [T | null, React.MutableRefObject<number>] {
  const [data, setData] = useState<T | null>(null);
  const receivedAt = useRef(0);
  useEffect(() => {
    if (!url) return;
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

// Synthesized AutopilotState from the thin local player (musicbox 3002):
// /api/playback + queue + per-track meta, mapped into the same shape the
// rest of the app already consumes. output_latency_ms is 0 because the
// player pushes ear-time positions (it subtracts the measured latency
// itself before every push).
const META_CACHE = new Map<string, { name?: string; artists?: string[]; album?: string; duration_ms?: number }>();

export function useLocalAutopilot(enabled: boolean): [AutopilotState, React.MutableRefObject<number>] {
  const [pb, at] = usePoll<{ trackId: string | null; position: number; playing: boolean }>(
    enabled ? `${MUSICBOX_URL}/api/playback` : null, 1000);
  const [q] = usePoll<Array<{ id: string; name: string; artists?: string[]; album?: string; duration_ms?: number; hasStems?: boolean }>>(
    enabled ? `${MUSICBOX_URL}/api/queue` : null, 2000);
  const [meta, setMeta] = useState<{ name?: string; artists?: string[]; album?: string; duration_ms?: number } | null>(null);
  const tid = pb?.trackId ?? null;

  useEffect(() => {
    if (!enabled || !tid) { setMeta(null); return; }
    const cached = META_CACHE.get(tid);
    if (cached) { setMeta(cached); return; }
    let cancelled = false;
    fetch(`${MUSICBOX_URL}/api/library/${tid}/meta`)
      .then((r) => r.json())
      .then((j) => { if (!cancelled) { META_CACHE.set(tid, j); setMeta(j); } })
      .catch(() => { if (!cancelled) setMeta(null); });
    return () => { cancelled = true; };
  }, [enabled, tid]);

  const state = useMemo<AutopilotState>(() => {
    if (!enabled || !pb) return { running: false };
    const queue: QueueItem[] = (q ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      artists: t.artists ?? [],
      album: t.album,
      duration_s: t.duration_ms ? Math.round(t.duration_ms / 100) / 10 : undefined,
      art_url: null,
      status: t.hasStems ? 'ready' : 'pending',
    }));
    return {
      running: true,
      track_id: pb.trackId,
      track_name: meta?.name ?? (pb.trackId ? '…' : undefined),
      artists: meta?.artists ?? [],
      album: meta?.album,
      art_url: null,
      duration_s: meta?.duration_ms ? Math.round(meta.duration_ms / 100) / 10 : null,
      track_status: 'ready',
      playing: pb.playing,
      position_s: pb.position,
      position_live: pb.position,
      output_latency_ms: 0,
      queue,
    };
  }, [enabled, pb, meta, q]);

  return [state, at];
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
