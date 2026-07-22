// Autopilot control + status. Spawns/kills the Python autopilot subprocess
// and exposes its state-file contents over HTTP so the musicbox UI can show
// a live status panel with an on/off toggle.
//
// The Python process writes data/state/lightbox-autopilot.json every ~500ms; we
// just relay it. Start uses child_process.spawn with detached:true so the
// autopilot survives tsx-watch dev-server restarts. Stop reads the PID
// from the state file and sends SIGTERM.
//
// Supervision contract with the daemon: it heartbeats every 0.5s even while
// erroring, so heartbeat age > WEDGE_AGE_S with a live pid genuinely means
// wedged (e.g. stuck in a multi-hour rate-limit sleep) — kill and respawn.
// On exit it writes a tombstone {running:false, exit_reason, ...} instead of
// unlinking; exit_reason:"auth" means a human must re-auth Spotify
// interactively, so respawning is pointless and would hammer the API.

import { Router } from 'express';
import { spawn } from 'child_process';
import { readFileSync, existsSync, unlinkSync, openSync, mkdirSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../../..');
const SCRAPER_DIR = join(REPO_ROOT, 'packages/music-scraper');
const VENV_PYTHON = join(SCRAPER_DIR, '.venv/bin/python');
// State under the repo (gitignored), logs under ~/.local/state — never
// /tmp, which macOS purges after ~3 days. STATE_FILE is a shared contract
// with scraper/autopilot.py and services/stem-sync.ts.
const STATE_DIR = join(REPO_ROOT, 'packages/server/data/state');
const STATE_FILE = join(STATE_DIR, 'lightbox-autopilot.json');
const LOG_DIR = join(homedir(), '.local/state/lightbox');
const LOG_FILE = join(LOG_DIR, 'autopilot.log');
const LOG_MAX_BYTES = 10 * 1024 * 1024;

mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });
// Truncate-on-boot: unbounded append would grow forever now that macOS
// isn't purging it for us. Keep the last 1MB so a crash right before a
// restart is still diagnosable.
try {
  if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) {
    const raw = readFileSync(LOG_FILE);
    writeFileSync(LOG_FILE, raw.subarray(raw.length - 1024 * 1024));
  }
} catch { /* best effort */ }

const FRESH_AGE_S = 5; // heartbeat younger than this = healthy
const WEDGE_AGE_S = 60; // pid alive + heartbeat older than this = wedged
const KILL_WAIT_MS = 1500; // grace period after SIGTERM before SIGKILL
const WATCHDOG_INTERVAL_MS = 60_000;
const MAX_CONSECUTIVE_RESPAWNS = 5;

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
  exited_at?: number;
  exit_reason?: 'auth' | 'stopped' | 'crash';
  stale?: boolean; // derived: state file hasn't been updated recently
  position_live?: number; // derived: position_s age-corrected at read time
  pid_alive?: boolean; // derived: process.kill(pid, 0) check (/state only)
}

function readRawState(): any | null {
  try {
    if (!existsSync(STATE_FILE)) return null;
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function heartbeatAge(raw: any): number {
  return Date.now() / 1000 - (raw?.updated_at ?? 0);
}

function readState(): AutopilotState {
  const raw = readRawState();
  if (!raw) return { running: false };
  const age = heartbeatAge(raw);
  raw.stale = age > FRESH_AGE_S; // if no update for 5s+, probably dead
  // An explicit tombstone (daemon wrote running:false on exit) stays false
  // even while fresh; otherwise running derives from heartbeat freshness.
  raw.running = raw.running === false ? false : !raw.stale;
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
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref(); // never hold the process open
  });
}

// SIGTERM, wait up to KILL_WAIT_MS, escalate to SIGKILL, wait again.
// Returns true if the pid is dead by the end.
async function killPid(pid: number): Promise<boolean> {
  for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
    try { process.kill(pid, sig); } catch { return true; } // already gone
    const deadline = Date.now() + KILL_WAIT_MS;
    while (Date.now() < deadline) {
      if (!isPidAlive(pid)) return true;
      await sleep(100);
    }
  }
  return !isPidAlive(pid);
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
  const logFd = openSync(LOG_FILE, 'a');
  const child = spawn(VENV_PYTHON, args, {
    cwd: SCRAPER_DIR,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  return child.pid;
}

// ---------------------------------------------------------------------------
// Watchdog. desiredRunning tracks operator intent (boot/start=true, stop=
// false); the watchdog reconciles reality toward it every 60s.

let desiredRunning = false;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let consecutiveRespawns = 0; // respawns since last healthy heartbeat
let breakerTripped = false;
let authLogged = false; // log the re-auth message once, not every tick

function resetSupervision(): void {
  consecutiveRespawns = 0;
  breakerTripped = false;
  authLogged = false;
}

function respawnFromWatchdog(): void {
  if (breakerTripped) return;
  if (consecutiveRespawns >= MAX_CONSECUTIVE_RESPAWNS) {
    breakerTripped = true;
    console.error(
      `[autopilot] watchdog: ${consecutiveRespawns} respawns without a healthy heartbeat — ` +
      `circuit breaker tripped, not respawning. Check ~/.local/state/lightbox/autopilot.log, then POST /start.`,
    );
    return;
  }
  consecutiveRespawns++;
  const pid = spawnAutopilot({});
  console.log(`[autopilot] watchdog respawned pid=${pid} (attempt ${consecutiveRespawns}/${MAX_CONSECUTIVE_RESPAWNS})`);
}

async function watchdogTick(): Promise<void> {
  const raw = readRawState();
  if (!desiredRunning) {
    // Adopt an already-running daemon after a dev-server restart: module
    // state resets on tsx-watch reloads, but /stop unlinks the state file,
    // so a live non-tombstone heartbeat means someone started it and
    // nobody stopped it — keep supervising it.
    if (raw?.pid && raw.running !== false && isPidAlive(raw.pid)) {
      desiredRunning = true;
    } else {
      return;
    }
  }
  const pid: number | undefined = raw?.pid;
  const age = heartbeatAge(raw);
  const alive = pid != null && isPidAlive(pid);

  if (alive && age <= FRESH_AGE_S) {
    resetSupervision(); // healthy heartbeat observed → re-arm the breaker
    return;
  }

  if (alive) {
    if (age <= WEDGE_AGE_S) return; // 5–60s: slow, but not wedged — hands off
    console.error(`[autopilot] watchdog: pid=${pid} alive but heartbeat ${Math.round(age)}s old — reaping`);
    await killPid(pid!);
    try { if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE); } catch {}
    respawnFromWatchdog();
    return;
  }

  // pid dead (or no state file at all)
  if (raw?.exit_reason === 'auth') {
    if (!authLogged) {
      console.error('[autopilot] watchdog: exit_reason=auth — Spotify token dead, needs interactive re-auth; not respawning');
      authLogged = true;
    }
    return;
  }
  respawnFromWatchdog();
}

export function startAutopilotWatchdog(): void {
  if (watchdogTimer) return; // idempotent
  watchdogTimer = setInterval(() => {
    // async fn: sync throws become rejections, so .catch covers everything
    watchdogTick().catch((err) => console.error('[autopilot] watchdog tick failed:', err));
  }, WATCHDOG_INTERVAL_MS);
  watchdogTimer.unref();
}

// Called at server boot. If no autopilot is running, start one in drift-only
// mode (no lights). UI checkboxes add/remove lights live without needing
// another spawn. Gives us a continuously-updating drift readout.
export async function ensureAutopilotRunning(): Promise<void> {
  try {
    startAutopilotWatchdog();
    desiredRunning = true;
    const raw = readRawState();
    const pid: number | undefined = raw?.pid;
    if (pid && isPidAlive(pid)) {
      const age = heartbeatAge(raw);
      if (age <= WEDGE_AGE_S) {
        console.log(`[autopilot] already running pid=${pid}`);
        return;
      }
      console.error(`[autopilot] boot: pid=${pid} wedged (heartbeat ${Math.round(age)}s old) — reaping`);
      await killPid(pid);
      try { if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE); } catch {}
    } else if (raw?.exit_reason === 'auth') {
      // Spawning would just 401-hammer Spotify on every server boot.
      console.error('[autopilot] boot: last exit was exit_reason=auth — needs interactive Spotify re-auth, not spawning');
      authLogged = true;
      return;
    }
    const newPid = spawnAutopilot({});
    console.log(`[autopilot] daemon spawned pid=${newPid}`);
  } catch (err) {
    console.error('[autopilot] ensureAutopilotRunning failed:', err);
  }
}

export function createAutopilotRouter(): Router {
  const r = Router();

  r.get('/state', (_req, res) => {
    const state = readState();
    // pid_alive + exit_reason let the UI distinguish "wedged" (alive+stale)
    // and "needs re-auth" from a plain dead daemon.
    res.json({ ...state, pid_alive: state.pid ? isPidAlive(state.pid) : false });
  });

  // Debug dump: current state + process liveness + recent log tail. Useful
  // when the drift readout is blank (answers "is autopilot running? is
  // Spotify reporting? is it logging errors?").
  r.get('/debug', (_req, res) => {
    const state = readState();
    const pidAlive = state.pid ? isPidAlive(state.pid) : false;
    let logTail: string | null = null;
    try {
      if (existsSync(LOG_FILE)) {
        const raw = readFileSync(LOG_FILE, 'utf-8');
        logTail = raw.slice(-4000);
      }
    } catch {}
    res.json({
      state_file_exists: existsSync(STATE_FILE),
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
  r.post('/start', async (req, res) => {
    try {
      const current = readState();
      let reaped: number | undefined;
      if (current.pid && isPidAlive(current.pid)) {
        if (!current.stale) {
          // Alive AND heartbeating — genuinely already running.
          return res.status(409).json({ error: 'autopilot already running', state: current });
        }
        // Alive but heartbeat stale → wedged. Reap so start always works.
        console.error(`[autopilot] reaping wedged pid=${current.pid} (stale heartbeat)`);
        await killPid(current.pid);
        try { if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE); } catch {}
        reaped = current.pid;
      }
      desiredRunning = true;
      resetSupervision(); // manual start re-arms the breaker / auth latch
      const { autoIngest = true, prefetch = 2 } = req.body ?? {};
      const pid = spawnAutopilot({ autoIngest, prefetch });
      console.log(`[autopilot] spawned pid=${pid}${reaped != null ? ` (reaped ${reaped})` : ''}`);
      res.json(reaped != null ? { ok: true, pid, reaped } : { ok: true, pid });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  r.post('/stop', async (_req, res) => {
    desiredRunning = false;
    const current = readState();
    if (!current.pid || !isPidAlive(current.pid)) {
      try { if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE); } catch {}
      return res.json({ ok: true, was_running: false });
    }
    try {
      console.log(`[autopilot] stopping pid=${current.pid}`);
      await killPid(current.pid); // TERM, then KILL if it's wedged
      // A clean exit leaves a tombstone (running:false). A SIGKILLed child
      // can't write one, so wipe a heartbeat still claiming to run.
      try {
        const raw = readRawState();
        if (raw && raw.running !== false) unlinkSync(STATE_FILE);
      } catch {}
      res.json({ ok: true, was_running: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return r;
}
