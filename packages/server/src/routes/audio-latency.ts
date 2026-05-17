import { Router } from 'express';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Audio output latency endpoint. Spawns scraper/audio_latency.py against
// CoreAudio and returns the measured (output_latency_ms, output_device_name).
// Standalone — no autopilot dependency. Result is cached for the server
// lifetime; the OffsetBar polls fast and is served from the cache. Pass
// ?refresh=1 to force a remeasure (e.g., after switching output device).

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../../..');
const SCRAPER_DIR = join(REPO_ROOT, 'packages/music-scraper');
const VENV_PYTHON = join(SCRAPER_DIR, '.venv/bin/python');

interface Reading {
  output_latency_ms: number | null;
  output_device_name: string | null;
  measured_at: number;
}

let cached: Reading | null = null;
let inflight: Promise<Reading> | null = null;

function measure(): Promise<Reading> {
  if (inflight) return inflight;
  inflight = new Promise<Reading>((resolve) => {
    const child = spawn(VENV_PYTHON, ['-m', 'scraper.audio_latency', '--json'], {
      cwd: SCRAPER_DIR,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('close', (code) => {
      let parsed: { output_latency_ms?: number | null; output_device_name?: string | null } = {};
      try { parsed = JSON.parse(stdout.trim()); } catch { /* leave empty */ }
      if (code !== 0 || (parsed.output_latency_ms == null)) {
        // Don't cache failures — next request retries.
        if (stderr) console.error('[audio-latency] python stderr:', stderr.trim().slice(0, 300));
        const failed: Reading = { output_latency_ms: null, output_device_name: null, measured_at: Date.now() };
        inflight = null;
        resolve(failed);
        return;
      }
      const reading: Reading = {
        output_latency_ms: parsed.output_latency_ms ?? null,
        output_device_name: parsed.output_device_name ?? null,
        measured_at: Date.now(),
      };
      cached = reading;
      inflight = null;
      resolve(reading);
    });
    child.on('error', (err) => {
      console.error('[audio-latency] spawn failed:', err.message);
      inflight = null;
      resolve({ output_latency_ms: null, output_device_name: null, measured_at: Date.now() });
    });
  });
  return inflight;
}

export function createAudioLatencyRouter(): Router {
  const r = Router();

  r.get('/', async (req, res) => {
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    if (cached && !refresh) {
      return res.json(cached);
    }
    const reading = await measure();
    res.json(reading);
  });

  return r;
}
