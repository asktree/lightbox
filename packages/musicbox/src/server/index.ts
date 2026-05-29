import express from 'express';
import http from 'http';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getEnvelope, serializeEnvelope, envelopeStats } from './envelope.js';

const PORT = 3002;
const LIBRARY_DIR = process.env.MUSICBOX_LIBRARY ?? join(homedir(), 'music-library');
const TRACKS_DIR = join(LIBRARY_DIR, 'tracks');

interface TrackMeta {
  id: string;
  name: string;
  artists: string[];
  album?: string;
  duration_ms?: number;
  isrc?: string;
  added_at?: string;
}

interface LibraryEntry extends TrackMeta {
  bpm?: number;
  key?: string;
  mode?: string;
  analyzed: boolean;
}

function readTrackMeta(id: string): LibraryEntry | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null; // path-traversal guard
  const dir = join(TRACKS_DIR, id);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  const metaPath = join(dir, 'meta.json');
  if (!existsSync(metaPath)) return null;
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as TrackMeta;
    const analysisPath = join(dir, 'analysis.json');
    const analyzed = existsSync(analysisPath);
    let bpm: number | undefined, key: string | undefined, mode: string | undefined;
    if (analyzed) {
      try {
        const a = JSON.parse(readFileSync(analysisPath, 'utf-8'));
        bpm = a.bpm; key = a.key; mode = a.mode;
      } catch {}
    }
    return { ...meta, analyzed, bpm, key, mode };
  } catch {
    return null;
  }
}

function listLibrary(): LibraryEntry[] {
  if (!existsSync(TRACKS_DIR)) return [];
  const entries: LibraryEntry[] = [];
  for (const id of readdirSync(TRACKS_DIR)) {
    const dir = join(TRACKS_DIR, id);
    if (!statSync(dir).isDirectory()) continue;
    const metaPath = join(dir, 'meta.json');
    if (!existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as TrackMeta;
      const analysisPath = join(dir, 'analysis.json');
      const analyzed = existsSync(analysisPath);
      let bpm, key, mode;
      if (analyzed) {
        try {
          // v4 analysis.json is ~30KB — cheap to parse. Older schemas still parse
          // fine since we're only reading the top-level scalar fields.
          const a = JSON.parse(readFileSync(analysisPath, 'utf-8'));
          bpm = a.bpm;
          key = a.key;
          mode = a.mode;
        } catch {}
      }
      entries.push({ ...meta, analyzed, bpm, key, mode });
    } catch {}
  }
  // Sort alphabetically by artist then name
  entries.sort((a, b) => {
    const aa = (a.artists[0] ?? '').toLowerCase();
    const bb = (b.artists[0] ?? '').toLowerCase();
    if (aa !== bb) return aa.localeCompare(bb);
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  return entries;
}

// ---- Play queue ----
//
// In-memory FIFO of track ids. Lost on server restart — fine for UX,
// matches every other media app. The client mirrors via GET poll;
// curl can enqueue directly (the original motivation for moving it
// off the client). Mutations always return the hydrated queue so the
// client doesn't need a follow-up GET.

let queue: string[] = [];

function hydratedQueue(): LibraryEntry[] {
  const out: LibraryEntry[] = [];
  for (const id of queue) {
    const meta = readTrackMeta(id);
    if (meta) out.push(meta);
  }
  return out;
}

// ---- Playback state ----
//
// In-memory current-playback snapshot. The musicbox client posts to
// /api/playback on user actions only (track change, play/pause, seek);
// continuous position between events is inferred from elapsed wall time.
// External consumers (twinklybox) poll /api/playback to learn what's
// playing and where the playhead is.

interface PlaybackState {
  trackId: string | null;
  positionAtUpdate: number; // seconds at lastUpdate
  playing: boolean;
  playSpeed: number;        // 1.0 = normal speed
  lastUpdate: number;       // server ms when we last wrote the state
}

const playback: PlaybackState = {
  trackId: null,
  positionAtUpdate: 0,
  playing: false,
  playSpeed: 1.0,
  lastUpdate: Date.now(),
};

function inferredPosition(): number {
  if (!playback.playing) return playback.positionAtUpdate;
  const elapsedSec = (Date.now() - playback.lastUpdate) / 1000;
  return playback.positionAtUpdate + elapsedSec * playback.playSpeed;
}

// ---- Server ----

const app = express();
app.use(express.json());

// CORS — let the twinklybox dev server (on a different port) poll us.
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.get('/api/library', (_req, res) => {
  try {
    res.json(listLibrary());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/library/:id/analysis', (req, res) => {
  const p = join(TRACKS_DIR, req.params.id, 'analysis.json');
  if (!existsSync(p)) {
    res.status(404).json({ error: 'not analyzed' });
    return;
  }
  res.type('application/json').sendFile(p);
});

app.get('/api/library/:id/madmom-onsets', (req, res) => {
  const p = join(TRACKS_DIR, req.params.id, 'madmom_onsets.json');
  if (!existsSync(p)) {
    res.status(404).json({ error: 'not analyzed' });
    return;
  }
  res.type('application/json').sendFile(p);
});

// Audio streaming
app.get('/api/library/:id/audio', (req, res) => {
  const p = join(TRACKS_DIR, req.params.id, 'audio.ogg');
  if (!existsSync(p)) {
    res.status(404).send('not found');
    return;
  }
  res.type('audio/ogg').sendFile(p);
});

const VALID_STEMS = new Set(['drums', 'bass', 'vocals', 'other']);
app.get('/api/library/:id/stem/:stem', (req, res) => {
  if (!VALID_STEMS.has(req.params.stem)) {
    res.status(404).send('invalid stem');
    return;
  }
  const p = join(TRACKS_DIR, req.params.id, 'stems', `${req.params.stem}.ogg`);
  if (!existsSync(p)) {
    res.status(404).send('stem not available');
    return;
  }
  res.type('audio/ogg').sendFile(p);
});

app.get('/api/library/:id/meta', (req, res) => {
  const p = join(TRACKS_DIR, req.params.id, 'meta.json');
  if (!existsSync(p)) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.type('application/json').sendFile(p);
});

// ---- Queue endpoints ----

app.get('/api/queue', (_req, res) => {
  res.json(hydratedQueue());
});

// Body: { trackId: string } OR { trackIds: string[] }. Appends. Unknown
// ids (no meta.json on disk) are silently dropped — keeps the queue
// honest at GET time.
app.post('/api/queue', (req, res) => {
  const body = req.body ?? {};
  const ids: string[] = Array.isArray(body.trackIds)
    ? body.trackIds.filter((x: any): x is string => typeof x === 'string')
    : (typeof body.trackId === 'string' ? [body.trackId] : []);
  if (ids.length === 0) {
    return res.status(400).json({ error: 'trackId or trackIds required' });
  }
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const id of ids) {
    if (readTrackMeta(id)) { queue.push(id); accepted.push(id); }
    else rejected.push(id);
  }
  res.json({ queue: hydratedQueue(), accepted, rejected });
});

// Numeric index into the queue. Common case: DELETE /api/queue/0 to pop the head.
app.delete('/api/queue/:idx', (req, res) => {
  const idx = parseInt(req.params.idx, 10);
  if (!Number.isFinite(idx) || idx < 0 || idx >= queue.length) {
    return res.status(400).json({ error: `idx out of range (queue length ${queue.length})` });
  }
  queue.splice(idx, 1);
  res.json(hydratedQueue());
});

app.delete('/api/queue', (_req, res) => {
  queue = [];
  res.json([]);
});

// Reorder: move the item at index `from` to index `to`. Index-based (not
// trackId-based) so it stays unambiguous when the same track appears more
// than once in the queue. Returns the hydrated queue in its new order.
app.put('/api/queue/move', (req, res) => {
  const from = parseInt(req.body?.from, 10);
  const to = parseInt(req.body?.to, 10);
  const ok = (n: number) => Number.isFinite(n) && n >= 0 && n < queue.length;
  if (!ok(from) || !ok(to)) {
    return res.status(400).json({ error: `from/to out of range (queue length ${queue.length})` });
  }
  const [item] = queue.splice(from, 1);
  queue.splice(to, 0, item);
  res.json(hydratedQueue());
});

// ---- Envelope endpoint ----

// Returns the binary per-stem energy envelope for a track. First request
// triggers an ffmpeg decode + RMS chunking (~1-2s for a 4-min track on
// modern hardware); subsequent requests hit the in-memory cache.
app.get('/api/library/:id/envelope', async (req, res) => {
  try {
    const pack = await getEnvelope(req.params.id);
    const bin = serializeEnvelope(pack);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Envelope-Tracks', '1');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(bin);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.get('/api/envelope/stats', (_req, res) => res.json(envelopeStats()));

// ---- Playback state ----

app.get('/api/playback', (_req, res) => {
  res.json({
    trackId: playback.trackId,
    position: inferredPosition(),
    playing: playback.playing,
    playSpeed: playback.playSpeed,
    ts: Date.now(),
  });
});

// Partial update. Fields not present are left unchanged. Any update resets
// lastUpdate so the position-interpolation baseline moves forward.
app.post('/api/playback', (req, res) => {
  const body = req.body ?? {};
  if (body.trackId === null || typeof body.trackId === 'string') playback.trackId = body.trackId;
  if (typeof body.position === 'number') playback.positionAtUpdate = body.position;
  if (typeof body.playing === 'boolean') playback.playing = body.playing;
  if (typeof body.playSpeed === 'number') playback.playSpeed = body.playSpeed;
  playback.lastUpdate = Date.now();
  // Logging on every push so we can see whether the client is actually
  // sending pause / play events when expected. Should appear on the
  // musicbox server's stdout — visible in /tmp/musicbox.log.
  console.log(`[playback] ← ${JSON.stringify(body)} → state ${JSON.stringify({ trackId: playback.trackId, position: playback.positionAtUpdate, playing: playback.playing })}`);
  res.json({ ok: true, trackId: playback.trackId, position: inferredPosition(), playing: playback.playing });
});

const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`Musicbox server: http://localhost:${PORT}`);
  console.log(`Library: ${LIBRARY_DIR}`);
});
