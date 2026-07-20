// Autopilot control + status. Spawns/kills the Python autopilot subprocess
// and exposes its state-file contents over HTTP so the musicbox UI can show
// a live status panel with an on/off toggle.
//
// The Python process writes /tmp/lightbox-autopilot.json every ~500ms; we
// just relay it. Start uses child_process.spawn with detached:true so the
// autopilot survives tsx-watch dev-server restarts. Stop reads the PID
// from the state file and sends SIGTERM.

import { Router } from 'express';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync, openSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../../..');
const SCRAPER_DIR = join(REPO_ROOT, 'packages/music-scraper');
const VENV_PYTHON = join(SCRAPER_DIR, '.venv/bin/python');
const STATE_FILE = '/tmp/lightbox-autopilot.json';
const LIGHTS_FILE = '/tmp/lightbox-autopilot-lights.json';

interface AutopilotState {
  running: boolean;
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
  light_rid?: string;
  ingesting?: string[];
  blacklist?: string[];
  last_error?: string | null;
  updated_at?: number;
  stale?: boolean; // derived: state file hasn't been updated recently
}

function readState(): AutopilotState {
  if (!existsSync(STATE_FILE)) return { running: false };
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    const age = Date.now() / 1000 - (raw.updated_at ?? 0);
    raw.stale = age > 5; // if no update for 5s+, probably dead
    raw.running = !raw.stale;
    // Age-correct the playhead at read time. The state file is written at
    // 2Hz, so position_s is up to ~500ms stale when a client polls — and
    // this process shares a clock with the autopilot, so the correction
    // here is exact. Clients extrapolate from position_live using only
    // their own receive time (network latency ≈ ms on LAN).
    if (raw.playing && typeof raw.position_s === 'number' && !raw.stale) {
      raw.position_live = raw.position_s + Math.max(0, age);
    } else {
      raw.position_live = raw.position_s ?? 0;
    }
    return raw;
  } catch {
    return { running: false };
  }
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Autopilot is the Spotify playhead + auto-ingest brain; it drives no
// lights (that's stem-sync). See GRAVESTONE.md for the dead pulse-firing
// options this spawn used to carry.
function spawnAutopilot(opts: { autoIngest?: boolean; prefetch?: number }): number | undefined {
  const { autoIngest = true, prefetch = 2 } = opts;

  const args = ['-m', 'scraper.autopilot', '--prefetch', String(prefetch)];
  if (autoIngest) args.push('--auto-ingest');

  // Redirect child stdout/stderr to a log file so we can post-mortem when
  // the detached process dies silently.
  const logFd = openSync('/tmp/lightbox-autopilot.log', 'a');
  const child = spawn(VENV_PYTHON, args, {
    cwd: SCRAPER_DIR,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  return child.pid;
}

// Called at server boot. If no autopilot is running, start one in drift-only
// mode (no lights). UI checkboxes add/remove lights live without needing
// another spawn. Gives us a continuously-updating drift readout.
export function ensureAutopilotRunning(): void {
  const state = readState();
  if (state.pid && isPidAlive(state.pid)) {
    console.log(`[autopilot] already running pid=${state.pid}`);
    return;
  }
  const pid = spawnAutopilot({});
  console.log(`[autopilot] daemon spawned pid=${pid}`);
}

export function createAutopilotRouter(): Router {
  const r = Router();

  r.get('/state', (_req, res) => res.json(readState()));

  // Debug dump: current state + process liveness + recent log tail. Useful
  // when the drift readout is blank (answers "is autopilot running? is
  // Spotify reporting? is it logging errors?").
  r.get('/debug', (_req, res) => {
    const state = readState();
    const pidAlive = state.pid ? isPidAlive(state.pid) : false;
    let logTail: string | null = null;
    try {
      if (existsSync('/tmp/lightbox-autopilot.log')) {
        const raw = readFileSync('/tmp/lightbox-autopilot.log', 'utf-8');
        logTail = raw.slice(-4000);
      }
    } catch {}
    res.json({
      state_file_exists: existsSync(STATE_FILE),
      lights_file_exists: existsSync(LIGHTS_FILE),
      state,
      pid_alive: pidAlive,
      log_tail: logTail,
    });
  });

  // Self-test: assert the drift math with synthetic inputs. Doesn't
  // require Spotify playback.
  r.post('/self-test', (_req, res) => {
    const script = `
# Minimal drift math reproduction — same formula as the loop
def compute_drift(prev_anchor_mono_ms, prev_anchor_spotify_s, now_ms, reported_ms):
    predicted_s = prev_anchor_spotify_s + (now_ms - prev_anchor_mono_ms) / 1000.0
    reported_s = reported_ms / 1000.0
    return (reported_s - predicted_s) * 1000.0

# Simulate Spotify's clock running 200ms ahead of ours over 2s
drift = compute_drift(
    prev_anchor_mono_ms=1000.0,
    prev_anchor_spotify_s=10.0,
    now_ms=3000.0,       # 2000ms elapsed
    reported_ms=12200.0, # 2200ms elapsed on Spotify
)
print(f"drift_ms={drift:.1f}")
assert 190 <= drift <= 210, f"expected ~200, got {drift}"

# Simulate Spotify running slow by 150ms
drift = compute_drift(1000.0, 10.0, 3000.0, 11850.0)
print(f"drift_ms={drift:.1f}")
assert -160 <= drift <= -140

# Sanity: 0 drift
drift = compute_drift(1000.0, 10.0, 3000.0, 12000.0)
print(f"drift_ms={drift:.1f}")
assert abs(drift) < 1

print("OK")
`;
    import('child_process').then(({ execFileSync }) => {
      try {
        const out = execFileSync(VENV_PYTHON, ['-c', script], {
          cwd: SCRAPER_DIR,
          encoding: 'utf-8',
          timeout: 5000,
        });
        res.json({ ok: true, output: out });
      } catch (err: any) {
        res.status(500).json({
          ok: false,
          error: String(err?.message ?? err),
          stdout: err?.stdout?.toString?.() ?? null,
          stderr: err?.stderr?.toString?.() ?? null,
        });
      }
    });
  });

  // Body: { autoIngest?, prefetch? } (legacy light/source fields ignored)
  r.post('/start', (req, res) => {
    const current = readState();
    if (current.pid && isPidAlive(current.pid)) {
      return res.status(409).json({ error: 'autopilot already running', state: current });
    }
    const { autoIngest = true, prefetch = 2 } = req.body ?? {};
    const pid = spawnAutopilot({ autoIngest, prefetch });
    console.log(`[autopilot] spawned pid=${pid}`);
    res.json({ ok: true, pid });
  });

  // Read-merge-write the config file so partial updates don't clobber
  // fields we didn't send.
  function updateConfig(patch: Record<string, unknown>): Record<string, unknown> {
    let cur: Record<string, unknown> = {};
    try {
      if (existsSync(LIGHTS_FILE)) cur = JSON.parse(readFileSync(LIGHTS_FILE, 'utf-8')) || {};
    } catch { /* reset on parse error */ }
    const next = { ...cur, ...patch };
    writeFileSync(LIGHTS_FILE, JSON.stringify(next));
    return next;
  }

  // Live-update the active light set without restarting the autopilot.
  // Body: { lightRids: string[] }
  r.post('/set-lights', (req, res) => {
    const { lightRids } = req.body ?? {};
    if (!Array.isArray(lightRids)) {
      return res.status(400).json({ error: 'lightRids array required' });
    }
    const rids = lightRids.filter((x) => typeof x === 'string');
    res.json({ ok: true, config: updateConfig({ lightRids: rids }) });
  });

  // Live-update the offset. Body: { offsetMs: number }
  r.post('/set-offset', (req, res) => {
    const { offsetMs } = req.body ?? {};
    if (typeof offsetMs !== 'number') {
      return res.status(400).json({ error: 'offsetMs number required' });
    }
    res.json({ ok: true, config: updateConfig({ offsetMs: Math.round(offsetMs) }) });
  });

  r.post('/stop', (_req, res) => {
    const current = readState();
    if (!current.pid || !isPidAlive(current.pid)) {
      try { if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE); } catch {}
      return res.json({ ok: true, was_running: false });
    }
    try {
      process.kill(current.pid, 'SIGTERM');
      console.log(`[autopilot] sent SIGTERM to pid=${current.pid}`);
      // State file is removed by the child's finally block; wipe here as backup.
      setTimeout(() => { try { if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE); } catch {} }, 500);
      res.json({ ok: true, was_running: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return r;
}
