import { useEffect, useMemo, useRef, useState } from 'react';

// Full-page autopilot dashboard: now playing (art + progress), up-next queue
// with per-track readiness, live ingest pipeline progress, and sync
// diagnostics. Standalone page at #/autopilot — components are written to be
// liftable into other UIs later.

// Lightbox listens on all interfaces with open CORS, so follow whatever host
// the page was loaded from (localhost, LAN IP, or Tailscale address).
const LIGHTBOX_URL = `http://${window.location.hostname}:3001`;

// ---- Types mirrored from scraper/autopilot.py write_state() ----

interface IngestStage {
  started_at?: number;
  secs?: number;
}

interface IngestProgress {
  stage?: string; // metadata | download | analyze | madmom | done | failed
  stages?: Record<string, IngestStage>;
  error?: string | null;
  updated_at?: number;
}

interface QueueItem {
  id: string | null;
  name: string;
  artists: string[];
  album?: string;
  duration_s?: number;
  art_url?: string | null;
  status: 'ready' | 'ingesting' | 'pending' | 'failed' | 'unknown';
}

interface HistoryItem {
  id: string;
  name?: string | null;
  artists?: string[];
  ok: boolean;
  rc: number;
  secs: number;
  at: number;
}

interface AutopilotState {
  running?: boolean;
  pid?: number;
  track_id?: string | null;
  track_name?: string;
  artists?: string[];
  album?: string;
  art_url?: string | null;
  duration_s?: number | null;
  track_status?: string;
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
  ingest_started?: Record<string, number>;
  ingest_progress?: Record<string, IngestProgress | null>;
  ingest_history?: HistoryItem[];
  queue?: QueueItem[];
  auto_ingest?: boolean;
  prefetch?: number;
  blacklist?: string[];
  last_error?: string | null;
  updated_at?: number;
  stale?: boolean;
}

interface RestLight { rid: string; lmId: string; name: string }

const DRIVE_STEMS = ['drums', 'bass', 'vocals', 'other'] as const;
type DriveStem = (typeof DRIVE_STEMS)[number];

interface StemSyncStatus {
  active?: boolean;
  streamActive?: boolean;
  config?: { offsetMs: number; gamma: number; attack: number; decay: number; tickMs: number };
  playhead?: { trackId: string | null; posS: number; playing: boolean };
  envelope?: { trackId: string; sr: number; numSamples: number } | null;
  envelopeError?: string | null;
  channels?: Array<{
    rid: string; light: string | null; stems: DriveStem[];
    streamChannelId: number | null; value: number; level: number; lastError: string | null;
  }>;
  error?: string | null;
}

// ---- Small helpers ----

function fmtTime(sec: number | null | undefined): string {
  if (sec == null || !isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function fmtSecs(sec: number): string {
  if (sec < 90) return `${Math.round(sec)}s`;
  return `${Math.floor(sec / 60)}m${String(Math.round(sec % 60)).padStart(2, '0')}s`;
}

const STATUS_BADGE: Record<QueueItem['status'], { label: string; cls: string }> = {
  ready: { label: '✓ ready', cls: 'bg-green-900/60 text-green-300 border-green-700/50' },
  ingesting: { label: '⟳ ingesting', cls: 'bg-amber-900/50 text-amber-300 border-amber-700/50' },
  pending: { label: '· pending', cls: 'bg-zinc-800 text-zinc-400 border-zinc-700' },
  failed: { label: '✗ failed', cls: 'bg-red-900/50 text-red-300 border-red-700/50' },
  unknown: { label: '?', cls: 'bg-zinc-800 text-zinc-500 border-zinc-700' },
};

function StatusBadge({ status }: { status: QueueItem['status'] }) {
  const b = STATUS_BADGE[status] ?? STATUS_BADGE.unknown;
  return (
    <span className={`px-1.5 py-0.5 rounded border text-[10px] font-mono whitespace-nowrap ${b.cls}`}>
      {b.label}
    </span>
  );
}

// Pipeline stepper. Stage list is dynamic: the stems-only pipeline is
// download → demucs, but legacy in-flight ingests may carry analyze/madmom
// stages — render whatever the progress file actually contains, in
// canonical order. Metadata is subsecond and elided.
const STAGE_ORDER = ['download', 'demucs', 'analyze', 'madmom'];
// Rough typical durations (secs) for progress estimation within a stage.
const STAGE_TYPICAL: Record<string, number> = { download: 10, demucs: 60, analyze: 90, madmom: 25 };

function IngestStepper({ progress, now }: { progress: IngestProgress | null | undefined; now: number }) {
  const stage = progress?.stage;
  const stages = progress?.stages ?? {};
  const present = STAGE_ORDER.filter((s) => s in stages || s === stage);
  const pipeline = present.length > 0 ? present : ['download', 'demucs'];
  const activeIdx = stage ? pipeline.indexOf(stage) : -1;
  return (
    <div className="flex items-center gap-x-1.5 gap-y-0.5 flex-wrap min-w-0">
      {pipeline.map((s, i) => {
        const info = stages[s];
        const isActive = stage === s;
        // Done: recorded a duration, a later stage is running, or the whole
        // pipeline finished. Skipped stages (already on disk) never appear
        // in `stages` and just render as done once a later stage runs.
        const isDone = !!info?.secs || stage === 'done' || (activeIdx > i);
        // On failure the stage that started but never closed out is the culprit.
        const isFailed = stage === 'failed' && !!info && info.secs == null;
        const elapsed = isActive && info?.started_at ? now / 1000 - info.started_at : null;
        const typical = STAGE_TYPICAL[s] ?? 60;
        const pct = elapsed != null ? Math.min(95, (elapsed / typical) * 100) : isDone ? 100 : 0;
        return (
          <div key={s} className="flex items-center gap-1.5 min-w-0">
            {i > 0 && <span className="text-zinc-700 text-[9px]">→</span>}
            <div className="flex flex-col gap-0.5 w-[72px] shrink">
              <div className="flex items-baseline justify-between gap-1">
                <span className={`text-[9px] font-mono truncate ${
                  isFailed ? 'text-red-400' : isActive ? 'text-amber-300' : isDone ? 'text-green-400' : 'text-zinc-600'
                }`}>
                  {s}
                </span>
                <span className="text-[9px] font-mono text-zinc-500 whitespace-nowrap">
                  {info?.secs != null ? fmtSecs(info.secs) : elapsed != null ? fmtSecs(elapsed) : ''}
                </span>
              </div>
              <div className="h-1 rounded bg-zinc-800 overflow-hidden">
                <div
                  className={`h-full rounded transition-all duration-500 ${
                    isFailed ? 'bg-red-500' : isActive ? 'bg-amber-400 animate-pulse' : isDone ? 'bg-green-500' : ''
                  }`}
                  style={{ width: `${info?.secs != null ? 100 : pct}%` }}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Art({ url, size, label }: { url?: string | null; size: string; label?: string }) {
  return url ? (
    <img src={url} alt="" className={`${size} rounded object-cover bg-zinc-900 shrink-0`} />
  ) : (
    <div className={`${size} rounded bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-700 shrink-0`}>
      {label ?? '♪'}
    </div>
  );
}

// ---- Page ----

export function AutopilotPage() {
  const [state, setState] = useState<AutopilotState>({ running: false });
  const [lights, setLights] = useState<RestLight[]>([]);
  // Stem drive: rid → set of stems feeding that light. The ONLY light path
  // here — entertainment stream via the server's stem-sync service. (The
  // legacy REST-pulse light picker was removed on purpose; REST is never
  // used for audio reactivity.)
  //
  // THE SERVER IS THE SOURCE OF TRUTH: the map is seeded from
  // /api/stem-sync/status on load and pushed only on user clicks. (An
  // earlier version pushed localStorage on mount — a fresh browser would
  // clobber the server's bindings with [] and silently kill the show.)
  const [stemMap, setStemMap] = useState<Record<string, DriveStem[]>>({});
  const stemMapSeeded = useRef(false);
  const [driveStatus, setDriveStatus] = useState<StemSyncStatus>({});
  const [driveBusy, setDriveBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  // Local clock tick so elapsed timers / playhead advance between 1s polls.
  const [now, setNow] = useState(() => Date.now());
  const stateReceivedAt = useRef(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    fetch(`${LIGHTBOX_URL}/api/hue-stream/rest-lights`)
      .then((r) => r.json())
      .then((j) => setLights(j.lights ?? []))
      .catch(() => {});
  }, []);

  // Push binding changes on user interaction only (never on mount). The
  // server applies stem-set changes live and transparently bounces the
  // stream when the light set itself changes.
  const pushStemMap = (next: Record<string, DriveStem[]>) => {
    setStemMap(next);
    const bindings = Object.entries(next)
      .filter(([, stems]) => stems.length > 0)
      .map(([rid, stems]) => ({ rid, stems }));
    fetch(`${LIGHTBOX_URL}/api/stem-sync/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bindings }),
    }).catch(() => {});
  };

  // Poll stem-sync status at 500ms for live level meters. First response
  // seeds the local stem map from the server's persisted bindings.
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const r = await fetch(`${LIGHTBOX_URL}/api/stem-sync/status`);
        if (cancelled) return;
        const j = await r.json();
        setDriveStatus(j);
        if (!stemMapSeeded.current && Array.isArray(j.bindings)) {
          stemMapSeeded.current = true;
          const m: Record<string, DriveStem[]> = {};
          for (const b of j.bindings) if (b?.rid) m[b.rid] = b.stems ?? [];
          setStemMap(m);
        }
      } catch { /* ignore */ }
      finally { inFlight = false; }
    };
    tick();
    const t = setInterval(tick, 500);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

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
        stateReceivedAt.current = Date.now();
      } catch { /* server down; keep last */ }
      finally { inFlight = false; }
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  const running = !!state.running && !state.stale;

  const start = async () => {
    setBusy(true);
    try {
      // No lightRids on purpose: autopilot is the playhead + ingest brain.
      // Lights are driven exclusively by stem-sync (entertainment stream).
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
    try { await fetch(`${LIGHTBOX_URL}/api/autopilot/stop`, { method: 'POST' }); } catch {}
    finally { setBusy(false); }
  };

  // Interpolated playhead: advance position_s by wall-clock since the state
  // arrived (only while playing).
  const position = useMemo(() => {
    const base = state.position_s ?? 0;
    if (!state.playing) return base;
    return base + (now - stateReceivedAt.current) / 1000;
  }, [state, now]);
  const duration = state.duration_s ?? null;
  const progressPct = duration ? Math.min(100, (position / duration) * 100) : 0;

  const queue = state.queue ?? [];
  const ingesting = state.ingesting ?? [];
  const history = state.ingest_history ?? [];
  const trackStatus = (state.track_status ?? 'unknown') as QueueItem['status'];
  const stateAge = state.updated_at ? Math.max(0, now / 1000 - state.updated_at) : null;

  // Meta lookup for ingesting tids: queue entries + current track.
  const metaFor = (tid: string): { name: string; artists: string[]; art_url?: string | null } => {
    if (tid === state.track_id) {
      return { name: state.track_name ?? tid, artists: state.artists ?? [], art_url: state.art_url };
    }
    const q = queue.find((x) => x.id === tid);
    if (q) return { name: q.name, artists: q.artists, art_url: q.art_url };
    const h = history.find((x) => x.id === tid);
    if (h?.name) return { name: h.name, artists: h.artists ?? [] };
    return { name: tid, artists: [] };
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-zinc-950/95 backdrop-blur border-b border-zinc-800 px-4 py-2.5 flex items-center gap-3">
        <a href="#/" className="text-zinc-500 hover:text-zinc-300 text-sm font-mono">← musicbox</a>
        <h1 className="text-sm font-semibold tracking-wide">Autopilot</h1>
        <span className={`flex items-center gap-1.5 text-[11px] font-mono ${running ? 'text-green-400' : 'text-zinc-500'}`}>
          <span className={`w-2 h-2 rounded-full ${running ? 'bg-green-400 animate-pulse' : 'bg-zinc-600'}`} />
          {running ? `running · pid ${state.pid ?? '?'}` : 'stopped'}
        </span>
        {stateAge != null && stateAge > 3 && running && (
          <span className="text-[10px] font-mono text-amber-400">state {stateAge.toFixed(0)}s old</span>
        )}
        <div className="flex-1" />
        <button
          onClick={running ? stop : start}
          disabled={busy}
          className={`px-3 py-1 rounded font-mono text-xs font-semibold disabled:opacity-50 ${
            running ? 'bg-red-600 hover:bg-red-500' : 'bg-green-600 hover:bg-green-500'
          }`}
        >{busy ? '…' : running ? 'stop' : 'start'}</button>
      </div>

      <div className="p-4 grid gap-4 lg:grid-cols-[1fr_360px] max-w-6xl mx-auto">
        {/* ---- Left column ---- */}
        <div className="flex flex-col gap-4 min-w-0">
          {/* Now playing */}
          <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="text-[10px] font-mono uppercase tracking-widest text-zinc-500 mb-3">Now playing</div>
            {state.track_id ? (
              <div className="flex gap-4">
                <Art url={state.art_url} size="w-28 h-28" />
                <div className="flex-1 min-w-0 flex flex-col">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-lg font-semibold truncate leading-tight">{state.track_name}</div>
                      <div className="text-sm text-zinc-400 truncate">{(state.artists ?? []).join(', ')}</div>
                      {state.album && <div className="text-xs text-zinc-600 truncate">{state.album}</div>}
                    </div>
                    <StatusBadge status={trackStatus} />
                  </div>
                  <div className="flex-1" />
                  {/* Playhead */}
                  <div className="flex items-center gap-2 text-[10px] font-mono text-zinc-500">
                    <span>{state.playing ? '▶' : '⏸'}</span>
                    <span>{fmtTime(position)}</span>
                    <div className="flex-1 h-1.5 rounded bg-zinc-800 overflow-hidden">
                      <div className="h-full bg-zinc-400 rounded transition-all duration-500" style={{ width: `${progressPct}%` }} />
                    </div>
                    <span>{duration ? fmtTime(duration) : '–:––'}</span>
                  </div>
                  {trackStatus === 'ingesting' && (
                    <div className="mt-2">
                      <IngestStepper progress={state.ingest_progress?.[state.track_id!]} now={now} />
                    </div>
                  )}
                  {trackStatus === 'pending' && (
                    <div className="mt-1 text-[10px] font-mono text-zinc-600">stems not ready — lights at floor for this track</div>
                  )}
                  {trackStatus === 'failed' && (
                    <div className="mt-1 text-[10px] font-mono text-red-400 truncate">
                      ingest failed{state.ingest_progress?.[state.track_id!]?.error ? `: ${state.ingest_progress[state.track_id!]!.error}` : ''}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-zinc-500 text-sm py-6 text-center">
                {running ? 'waiting for Spotify playback…' : 'autopilot is stopped'}
              </div>
            )}
          </section>

          {/* Processing */}
          <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="text-[10px] font-mono uppercase tracking-widest text-zinc-500 mb-3">
              Processing
              {state.auto_ingest === false && <span className="ml-2 text-amber-500 normal-case">(auto-ingest off)</span>}
              {!!state.prefetch && <span className="ml-2 text-zinc-600 normal-case">prefetch {state.prefetch}</span>}
            </div>
            {ingesting.length === 0 ? (
              <div className="text-zinc-600 text-xs font-mono">idle — nothing ingesting</div>
            ) : (
              <div className="flex flex-col gap-3">
                {ingesting.map((tid) => {
                  const m = metaFor(tid);
                  const started = state.ingest_started?.[tid];
                  const elapsed = started ? Math.max(0, now / 1000 - started) : null;
                  return (
                    <div key={tid} className="flex items-center gap-3">
                      <Art url={m.art_url} size="w-10 h-10" label="⟳" />
                      <div className="min-w-0 w-44">
                        <div className="text-xs truncate">{m.name}</div>
                        <div className="text-[10px] text-zinc-500 truncate">{m.artists.join(', ')}</div>
                        {elapsed != null && <div className="text-[9px] font-mono text-zinc-600">{fmtSecs(elapsed)} elapsed</div>}
                      </div>
                      <IngestStepper progress={state.ingest_progress?.[tid]} now={now} />
                    </div>
                  );
                })}
              </div>
            )}
            {history.length > 0 && (
              <div className="mt-4 border-t border-zinc-800 pt-3">
                <div className="text-[10px] font-mono text-zinc-600 mb-1.5">recent</div>
                <div className="flex flex-col gap-1">
                  {history.slice(0, 6).map((h) => (
                    <div key={`${h.id}-${h.at}`} className="flex items-center gap-2 text-[11px] font-mono">
                      <span className={h.ok ? 'text-green-400' : 'text-red-400'}>{h.ok ? '✓' : '✗'}</span>
                      <span className="text-zinc-300 truncate">{h.name ?? h.id}</span>
                      {h.artists && h.artists.length > 0 && <span className="text-zinc-600 truncate">— {h.artists.join(', ')}</span>}
                      <span className="flex-1" />
                      <span className="text-zinc-500">{fmtSecs(h.secs)}</span>
                      {!h.ok && <span className="text-red-500">rc={h.rc}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {(state.blacklist ?? []).length > 0 && (
              <div className="mt-2 text-[10px] font-mono text-red-400/70">
                blacklisted this session: {(state.blacklist ?? []).length}
              </div>
            )}
          </section>

          {/* Diagnostics */}
          <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="text-[10px] font-mono uppercase tracking-widest text-zinc-500 mb-3">Sync diagnostics</div>
            <div className="grid grid-cols-3 gap-3 text-center">
              {[
                { label: 'drift', value: state.drift_ms != null ? `${state.drift_ms > 0 ? '+' : ''}${state.drift_ms}ms` : '–', title: 'Spotify clock vs our interpolation (EMA)' },
                { label: 'drive offset', value: driveStatus.config ? `${driveStatus.config.offsetMs}ms` : '–', title: 'stem-sync light delay vs playhead (negative = fire early)' },
                { label: 'audio out', value: state.output_latency_ms != null ? `${state.output_latency_ms}ms` : '–', title: state.output_device_name ?? 'output device latency' },
              ].map((d) => (
                <div key={d.label} title={d.title} className="rounded bg-zinc-900 border border-zinc-800 py-2 px-1">
                  <div className="text-sm font-mono text-zinc-200">{d.value}</div>
                  <div className="text-[9px] font-mono uppercase tracking-wider text-zinc-600 mt-0.5">{d.label}</div>
                </div>
              ))}
            </div>
            {state.output_device_name && (
              <div className="mt-2 text-[10px] font-mono text-zinc-600 text-center">output: {state.output_device_name}</div>
            )}
            {state.last_error && (
              <div className="mt-2 text-[10px] font-mono text-red-400 truncate" title={state.last_error}>
                spotify: {state.last_error}
              </div>
            )}
          </section>
        </div>

        {/* ---- Right column ---- */}
        <div className="flex flex-col gap-4 min-w-0">
          {/* Up next */}
          <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="text-[10px] font-mono uppercase tracking-widest text-zinc-500 mb-3">Up next</div>
            {queue.length === 0 ? (
              <div className="text-zinc-600 text-xs font-mono">queue empty (or not polled yet)</div>
            ) : (
              <div className="flex flex-col gap-2.5">
                {queue.map((q, i) => (
                  <div key={`${q.id}-${i}`} className="flex flex-col gap-1 min-w-0">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="text-[10px] font-mono text-zinc-700 w-3 text-right shrink-0">{i + 1}</span>
                      <Art url={q.art_url} size="w-9 h-9" />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs truncate">{q.name}</div>
                        <div className="text-[10px] text-zinc-500 truncate">{q.artists.join(', ')}</div>
                      </div>
                      <span className="text-[10px] font-mono text-zinc-600 shrink-0">{q.duration_s ? fmtTime(q.duration_s) : ''}</span>
                      <StatusBadge status={q.status} />
                    </div>
                    {q.status === 'ingesting' && q.id && (
                      <div className="pl-[62px] pr-1 min-w-0">
                        <IngestStepper progress={state.ingest_progress?.[q.id]} now={now} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Stem drive */}
          <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Stem drive</div>
              <span className={`w-1.5 h-1.5 rounded-full ${driveStatus.active ? 'bg-green-400 animate-pulse' : 'bg-zinc-700'}`} />
              <div className="flex-1" />
              <button
                onClick={async () => {
                  setDriveBusy(true);
                  try {
                    const r = await fetch(`${LIGHTBOX_URL}/api/stem-sync/${driveStatus.active ? 'stop' : 'start'}`, { method: 'POST' });
                    setDriveStatus(await r.json());
                  } catch { /* status poll will catch up */ }
                  finally { setDriveBusy(false); }
                }}
                disabled={driveBusy}
                className={`px-2 py-0.5 rounded font-mono text-[10px] font-semibold disabled:opacity-50 ${
                  driveStatus.active ? 'bg-red-600 hover:bg-red-500' : 'bg-green-600 hover:bg-green-500'
                }`}
              >{driveBusy ? '…' : driveStatus.active ? 'stop' : 'start'}</button>
            </div>
            {lights.length === 0 ? (
              <div className="text-zinc-600 text-xs font-mono">no color lights found</div>
            ) : (
              <div className="flex flex-col gap-2">
                {lights.map((l) => {
                  const stems = stemMap[l.rid] ?? [];
                  const ch = (driveStatus.channels ?? []).find((c) => c.rid === l.rid);
                  return (
                    <div key={l.rid} className="flex flex-col gap-1">
                      <div className="flex items-center gap-2 text-xs">
                        <span className={stems.length > 0 ? 'text-zinc-200' : 'text-zinc-500'}>{l.name}</span>
                        {ch?.lastError && <span className="text-[9px] text-red-400 truncate" title={ch.lastError}>!</span>}
                        <div className="flex-1" />
                        <div className="flex gap-1">
                          {DRIVE_STEMS.map((s) => {
                            const on = stems.includes(s);
                            return (
                              <button
                                key={s}
                                onClick={() => pushStemMap({
                                  ...stemMap,
                                  [l.rid]: on ? stems.filter((x) => x !== s) : [...stems, s],
                                })}
                                className={`px-1.5 py-0.5 rounded border font-mono text-[9px] ${
                                  on ? 'bg-green-900/60 text-green-300 border-green-700/60'
                                     : 'bg-zinc-900 text-zinc-600 border-zinc-800 hover:border-zinc-600'
                                }`}
                              >{s}</button>
                            );
                          })}
                        </div>
                      </div>
                      {/* Live level meter (only meaningful while driving) */}
                      <div className="h-1 rounded bg-zinc-800 overflow-hidden">
                        <div
                          className="h-full rounded bg-cyan-400/80 transition-all duration-300"
                          style={{ width: `${Math.round((ch?.level ?? 0) * 100)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="mt-3 flex items-center gap-3 text-[10px] font-mono text-zinc-600">
              <span title="entertainment stream (DTLS/UDP) — REST is never used here">
                stream: {driveStatus.streamActive ? <span className="text-green-400">up</span> : 'down'}
              </span>
              <span>
                envelope: {driveStatus.envelope
                  ? <span className="text-green-400">loaded</span>
                  : driveStatus.envelopeError
                    ? <span className="text-amber-400" title={driveStatus.envelopeError}>waiting</span>
                    : '–'}
              </span>
              <span>offset {driveStatus.config?.offsetMs ?? '–'}ms</span>
            </div>
            <div className="mt-1 text-[10px] font-mono text-zinc-700">
              stems mapped to a light are averaged · server-side drive — closing this page changes nothing
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
