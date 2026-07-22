// Server last-alive heartbeat — the freshness gate for boot-time resume.
//
// Design state (stem bindings, palette selections, play state) persists
// unconditionally; whether the server RESUMES ACTUATION on boot depends on
// how long it was down. A tsx-watch restart (seconds) should be seamless:
// streams rebuild, palettes keep animating. A cold start a day later must
// not touch the lights — everything loads paused/idle until a human acts.
//
// Mechanism: a timestamp written every HEARTBEAT_INTERVAL_MS. On boot,
// downtime = now − last written stamp. Crash vs clean shutdown doesn't
// matter — the stamp is at most ~10s stale.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dirname, '../../data/state');
const HEARTBEAT_FILE = join(STATE_DIR, 'server-heartbeat.json');

const HEARTBEAT_INTERVAL_MS = 10_000;
// Downtime below this resumes actuation (dev restarts); at or above it the
// server boots cold — config loaded, lights untouched.
export const RESUME_TTL_MS = 60 * 60 * 1000;

// Read once at module load, before the first beat overwrites the file.
const previousBeatMs: number | null = (() => {
  try {
    if (!existsSync(HEARTBEAT_FILE)) return null;
    const raw = JSON.parse(readFileSync(HEARTBEAT_FILE, 'utf-8'));
    return typeof raw.aliveAtMs === 'number' ? raw.aliveAtMs : null;
  } catch {
    return null;
  }
})();

function beat(): void {
  try {
    writeFileSync(HEARTBEAT_FILE, JSON.stringify({ aliveAtMs: Date.now() }));
  } catch { /* best effort — worst case the next boot is treated as cold */ }
}

/** ms since the previous server process was last alive; null on first run. */
export function downtimeMs(): number | null {
  return previousBeatMs === null ? null : Math.max(0, Date.now() - previousBeatMs);
}

/** True when the server should come up without touching any lights.
 *  First run ever (no heartbeat file) is treated as cold — the cautious
 *  default for an unknown gap. */
export function isColdBoot(): boolean {
  const d = downtimeMs();
  return d === null || d >= RESUME_TTL_MS;
}

export function startServerHeartbeat(): void {
  mkdirSync(STATE_DIR, { recursive: true });
  beat();
  setInterval(beat, HEARTBEAT_INTERVAL_MS).unref();
}

/** Call on graceful shutdown so downtime is measured from the actual exit. */
export function finalHeartbeat(): void {
  beat();
}
