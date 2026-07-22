import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface LibraryEntry {
  id: string;
  name: string;
  artists: string[];
  album?: string;
  duration_ms?: number;
  analyzed: boolean;
  hasStems: boolean;
  bpm?: number;
  key?: string;
  mode?: string;
}

interface LatencyInfo {
  output_latency_ms: number;
  output_device_name: string;
}

const LIGHTBOX = `http://${window.location.hostname}:3001`;

function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function App() {
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [query, setQuery] = useState('');
  const [queue, setQueue] = useState<LibraryEntry[]>([]);
  const [current, setCurrent] = useState<LibraryEntry | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [latency, setLatency] = useState<LatencyInfo | null>(null);

  const audioRef = useRef<HTMLAudioElement>(null);
  const latencyRef = useRef(0);
  const queueRef = useRef<LibraryEntry[]>([]);
  queueRef.current = queue;

  // ear-time position: what the listener is actually hearing right now
  const earTime = useCallback(() => {
    const a = audioRef.current;
    if (!a) return 0;
    return Math.max(0, a.currentTime - latencyRef.current / 1000);
  }, []);

  // Every push carries the current trackId, not just track-change pushes —
  // /api/playback is a partial-update API, so if anything else writes
  // trackId (another client, a curl), a partial push here would leave the
  // clobbered value in place and consumers would show "no track" forever.
  const currentIdRef = useRef<string | null>(null);
  const pushPlayback = useCallback(
    (body: { trackId?: string | null; position?: number; playing?: boolean }) => {
      if (body.trackId !== undefined) currentIdRef.current = body.trackId;
      fetch('/api/playback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackId: currentIdRef.current, ...body }),
      }).catch(() => {});
    },
    []
  );

  // --- library ---
  useEffect(() => {
    fetch('/api/library')
      .then((r) => r.json())
      .then(setLibrary)
      .catch(() => {});
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return library;
    return library.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.artists.some((a) => a.toLowerCase().includes(q)) ||
        (t.album ?? '').toLowerCase().includes(q)
    );
  }, [library, query]);

  // --- queue polling (mirror server state; others may enqueue) ---
  useEffect(() => {
    const poll = () =>
      fetch('/api/queue')
        .then((r) => r.json())
        .then(setQueue)
        .catch(() => {});
    poll();
    const iv = setInterval(poll, 2000);
    return () => clearInterval(iv);
  }, []);

  // --- output-latency probe (lightbox server), in-flight guard ---
  useEffect(() => {
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const r = await fetch(`${LIGHTBOX}/api/audio-latency`);
        const j: LatencyInfo = await r.json();
        latencyRef.current = j.output_latency_ms;
        setLatency(j);
      } catch {
        // lightbox server may be down; keep last value
      } finally {
        inFlight = false;
      }
    };
    poll();
    const iv = setInterval(poll, 2000);
    return () => clearInterval(iv);
  }, []);

  // --- 10s position re-sync while playing (bounds server-side drift) ---
  useEffect(() => {
    if (!playing) return;
    const iv = setInterval(() => {
      pushPlayback({ position: earTime(), playing: true });
    }, 10000);
    return () => clearInterval(iv);
  }, [playing, pushPlayback, earTime]);

  // --- best-effort "stopped" on leave ---
  useEffect(() => {
    const bye = () => {
      const body = JSON.stringify({ playing: false });
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/playback', new Blob([body], { type: 'application/json' }));
      } else {
        fetch('/api/playback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: true,
        }).catch(() => {});
      }
    };
    window.addEventListener('beforeunload', bye);
    return () => {
      window.removeEventListener('beforeunload', bye);
      bye();
    };
  }, []);

  // --- transport actions ---
  const playTrack = useCallback(
    (track: LibraryEntry) => {
      const a = audioRef.current;
      if (!a) return;
      setCurrent(track);
      setPosition(0);
      setDuration((track.duration_ms ?? 0) / 1000);
      a.src = `/api/library/${track.id}/audio`;
      a.play().catch(() => {});
      setPlaying(true);
      pushPlayback({ trackId: track.id, position: 0, playing: true });
    },
    [pushPlayback]
  );

  const enqueue = useCallback((track: LibraryEntry) => {
    fetch('/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackId: track.id }),
    })
      .then((r) => r.json())
      .then((j) => setQueue(j.queue))
      .catch(() => {});
  }, []);

  const removeAt = useCallback((idx: number) => {
    fetch(`/api/queue/${idx}`, { method: 'DELETE' })
      .then((r) => r.json())
      .then(setQueue)
      .catch(() => {});
  }, []);

  const clearQueue = useCallback(() => {
    fetch('/api/queue', { method: 'DELETE' })
      .then((r) => r.json())
      .then(setQueue)
      .catch(() => {});
  }, []);

  // pop head and play it; queue[0] is captured BEFORE the delete
  const advance = useCallback(() => {
    const next = queueRef.current[0];
    if (!next) {
      const a = audioRef.current;
      if (a) a.pause();
      setPlaying(false);
      pushPlayback({ playing: false });
      return;
    }
    fetch('/api/queue/0', { method: 'DELETE' })
      .then((r) => r.json())
      .then(setQueue)
      .catch(() => {});
    playTrack(next);
  }, [playTrack, pushPlayback]);

  const togglePlay = useCallback(() => {
    const a = audioRef.current;
    if (!current) {
      // Nothing loaded — play means "start consuming the queue".
      if (queueRef.current.length > 0) advance();
      return;
    }
    if (!a) return;
    if (a.paused) {
      a.play().catch(() => {});
      setPlaying(true);
      pushPlayback({ position: earTime(), playing: true });
    } else {
      a.pause();
      setPlaying(false);
      pushPlayback({ position: earTime(), playing: false });
    }
  }, [current, pushPlayback, earTime, advance]);

  const seek = useCallback(
    (t: number) => {
      const a = audioRef.current;
      if (!a) return;
      a.currentTime = t;
      setPosition(t);
      pushPlayback({ position: Math.max(0, t - latencyRef.current / 1000), playing: !a.paused });
    },
    [pushPlayback]
  );

  return (
    <div className="h-screen flex flex-col bg-zinc-950 text-white">
      {/* header */}
      <header className="flex items-center gap-4 px-4 py-3 border-b border-zinc-800">
        <h1 className="font-mono text-sm font-bold tracking-tight">
          music<span className="text-cyan-400">p</span>layer
        </h1>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search library..."
          className="flex-1 max-w-md bg-zinc-900 border border-zinc-800 rounded px-3 py-1.5 text-xs font-mono placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
        />
        <span className="font-mono text-xs text-zinc-600">
          {filtered.length}/{library.length}
        </span>
      </header>

      {/* main split */}
      <div className="flex-1 flex min-h-0">
        {/* library */}
        <div className="flex-1 overflow-y-auto">
          {filtered.map((t) => (
            <div
              key={t.id}
              onClick={() => playTrack(t)}
              className={`group flex items-center gap-3 px-4 py-2 border-b border-zinc-900 cursor-pointer hover:bg-zinc-900 ${
                current?.id === t.id ? 'bg-zinc-900' : ''
              }`}
            >
              <div className="flex-1 min-w-0">
                <div
                  className={`text-sm truncate ${
                    current?.id === t.id ? 'text-cyan-400' : 'text-zinc-100'
                  }`}
                >
                  {t.name}
                </div>
                <div className="text-xs text-zinc-500 truncate">{t.artists.join(', ')}</div>
              </div>
              {t.hasStems && (
                <span className="font-mono text-[10px] text-zinc-600 border border-zinc-800 rounded px-1">
                  stems
                </span>
              )}
              <span className="font-mono text-xs text-zinc-500 w-10 text-right">
                {t.duration_ms != null ? fmtTime(t.duration_ms / 1000) : '–'}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  enqueue(t);
                }}
                title="add to queue"
                className="w-6 h-6 flex items-center justify-center rounded text-zinc-600 hover:text-white hover:bg-zinc-800 opacity-0 group-hover:opacity-100"
              >
                +
              </button>
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="p-8 text-center font-mono text-xs text-zinc-600">no matches</div>
          )}
        </div>

        {/* queue rail */}
        <div className="w-80 border-l border-zinc-800 flex flex-col">
          <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
            <span className="font-mono text-xs text-zinc-400">
              queue{queue.length > 0 ? ` (${queue.length})` : ''}
            </span>
            {queue.length > 0 && (
              <button
                onClick={clearQueue}
                className="font-mono text-xs text-zinc-600 hover:text-red-400"
              >
                clear
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto">
            {/* Spotify-style: the playing track rides at the top of the
                queue until it finishes, then the next row takes its place. */}
            {current && (
              <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-900 bg-zinc-900/60">
                <span className="font-mono text-xs text-cyan-400 w-4 text-right">{playing ? '▶' : '❚❚'}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-cyan-200 truncate">{current.name}</div>
                  <div className="text-[10px] text-zinc-500 truncate">{current.artists.join(', ')}</div>
                </div>
              </div>
            )}
            {queue.map((t, i) => (
              <div
                key={`${t.id}-${i}`}
                className="group flex items-center gap-2 px-3 py-2 border-b border-zinc-900"
              >
                <span className="font-mono text-xs text-zinc-600 w-4 text-right">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-zinc-200 truncate">{t.name}</div>
                  <div className="text-[10px] text-zinc-500 truncate">{t.artists.join(', ')}</div>
                </div>
                <button
                  onClick={() => removeAt(i)}
                  title="remove"
                  className="w-5 h-5 flex items-center justify-center rounded text-zinc-600 hover:text-red-400 opacity-0 group-hover:opacity-100"
                >
                  ✕
                </button>
              </div>
            ))}
            {queue.length === 0 && !current && (
              <div className="p-6 text-center font-mono text-xs text-zinc-700">queue empty</div>
            )}
          </div>
        </div>
      </div>

      {/* footer transport */}
      <footer className="border-t border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-4">
          <button
            onClick={togglePlay}
            disabled={!current && queue.length === 0}
            className="w-9 h-9 flex items-center justify-center rounded-full border border-zinc-700 hover:border-zinc-500 disabled:opacity-30 text-sm"
          >
            {playing ? '❚❚' : '▶'}
          </button>
          <button
            onClick={advance}
            disabled={queue.length === 0}
            title="skip next"
            className="w-7 h-7 flex items-center justify-center rounded border border-zinc-800 hover:border-zinc-600 disabled:opacity-30 text-xs"
          >
            ⏭
          </button>
          <span className="font-mono text-xs text-zinc-500 w-10 text-right">
            {fmtTime(position)}
          </span>
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={Math.min(position, duration || 0)}
            onChange={(e) => seek(parseFloat(e.target.value))}
            disabled={!current}
            className="flex-1 accent-cyan-400 disabled:opacity-30"
          />
          <span className="font-mono text-xs text-zinc-500 w-10">{fmtTime(duration)}</span>
          <div className="w-64 min-w-0 text-right">
            {current ? (
              <div className="text-xs truncate">
                <span className="text-zinc-200">{current.name}</span>
                <span className="text-zinc-500"> — {current.artists.join(', ')}</span>
              </div>
            ) : (
              <span className="font-mono text-xs text-zinc-700">nothing playing</span>
            )}
          </div>
        </div>
        {latency && (
          <div className="mt-1 font-mono text-[10px] text-zinc-700 text-right">
            {latency.output_device_name} · {latency.output_latency_ms}ms
          </div>
        )}
      </footer>

      <audio
        ref={audioRef}
        onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
        onDurationChange={(e) => {
          const d = e.currentTarget.duration;
          if (isFinite(d) && d > 0) setDuration(d);
        }}
        onEnded={advance}
      />
    </div>
  );
}
