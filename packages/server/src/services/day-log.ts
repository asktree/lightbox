// Day log: a 5-minute snapshot of what the lights are set to.
//
// Purpose: learn how the rooms are set over a day, by hand, for a few
// weeks. That data is the ground truth for a natural daily kelvin /
// brightness curve later. Nothing here touches the lights — it only reads.
//
// Format: one JSON line per snapshot in data/day-log.jsonl (append-only,
// survives restarts, gitignored). Each line:
//   { t, local, dow, minuteOfDay, mode, curtains: {kelvin,val},
//     lights: [{ id, room, name, on, brightness, kelvin, color, reachable }] }
// Only bedroom + living room lights are logged (shared ROOMS).
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOMS } from '@lightbox/shared';
import type { LightManager } from '../lib/light-manager.js';
import { getAmbienceState } from '../routes/ambience.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DAY_LOG_FILE = join(__dirname, '../../data/day-log.jsonl');

const INTERVAL_MS = 5 * 60_000;
const LOGGED_ROOMS = ['bedroom', 'living'] as const;

export interface DayLogLight {
  id: string;
  room: string;
  name: string;
  on: boolean;
  brightness?: number;
  kelvin?: number;
  color?: { h: number; s: number };
  reachable: boolean;
}

export interface DayLogEntry {
  t: string;             // ISO, UTC
  local: string;         // 'YYYY-MM-DD HH:MM' in server local time
  tz: number;            // minutes east of UTC (Date.getTimezoneOffset negated)
  dow: number;           // 0 = Sunday
  minuteOfDay: number;   // local minutes since midnight
  mode: 'color' | 'normal';
  curtains: { kelvin: number; val: number };
  lights: DayLogLight[];
}

function pad(n: number): string { return String(n).padStart(2, '0'); }

export function buildSnapshot(lightManager: LightManager, now = new Date()): DayLogEntry {
  const amb = getAmbienceState();
  const lights: DayLogLight[] = [];
  for (const room of LOGGED_ROOMS) {
    for (const id of ROOMS[room].lightIds) {
      const l = lightManager.getLight(id);
      if (!l) continue;
      const entry: DayLogLight = { id, room, name: l.name, on: l.state.on, reachable: l.reachable };
      if (l.state.brightness !== undefined) entry.brightness = l.state.brightness;
      if (l.state.temperature !== undefined) entry.kelvin = Math.round(l.state.temperature);
      if (l.state.color) entry.color = { h: Math.round(l.state.color.h * 10) / 10, s: Math.round(l.state.color.s * 10) / 10 };
      lights.push(entry);
    }
  }
  return {
    t: now.toISOString(),
    local: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
    tz: -now.getTimezoneOffset(),
    dow: now.getDay(),
    minuteOfDay: now.getHours() * 60 + now.getMinutes(),
    mode: amb.mode,
    curtains: { kelvin: amb.curtainsKelvin, val: amb.curtainsVal },
    lights,
  };
}

function writeSnapshot(lightManager: LightManager): void {
  try {
    const entry = buildSnapshot(lightManager);
    mkdirSync(dirname(DAY_LOG_FILE), { recursive: true });
    appendFileSync(DAY_LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('[day-log] snapshot failed:', (e as Error).message);
  }
}

/** Start the logger. Snapshots land on wall-clock 5-minute marks
 *  (:00, :05, :10 ...) so restarts do not shift the grid. */
export function startDayLog(lightManager: LightManager): void {
  const msToMark = INTERVAL_MS - (Date.now() % INTERVAL_MS);
  setTimeout(() => {
    writeSnapshot(lightManager);
    setInterval(() => writeSnapshot(lightManager), INTERVAL_MS).unref();
  }, msToMark).unref();
  console.log(`[day-log] logging to ${DAY_LOG_FILE} every 5 min (first in ${Math.round(msToMark / 1000)}s)`);
}
