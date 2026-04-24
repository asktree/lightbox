import express from 'express';
import http from 'http';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

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

// ---- Server ----

const app = express();

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

const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`Musicbox server: http://localhost:${PORT}`);
  console.log(`Library: ${LIBRARY_DIR}`);
});
