// Contract test for the autopilot state-file derivation (routes/autopilot.ts
// deriveAutopilotState): how the raw JSON the Python daemon writes at 2Hz
// becomes the served state — stale/running from heartbeat age, tombstone
// handling, and the age-corrected playhead. The fixture mirrors a real
// state file written by scraper/autopilot.py.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { deriveAutopilotState } from '../src/routes/autopilot.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/autopilot-state.json');

// deriveAutopilotState mutates its input (production readState re-parses
// the file each call), so hand each test a fresh copy.
function loadFixture(): any {
  return JSON.parse(readFileSync(FIXTURE, 'utf-8'));
}
const UPDATED_AT = loadFixture().updated_at as number; // 1753142400.0

// FRESH_AGE_S in routes/autopilot.ts is 5 — heartbeats younger than that
// are healthy.
const atAge = (ageS: number): number => (UPDATED_AT + ageS) * 1000;

describe('deriveAutopilotState', () => {
  it('returns running:false for a missing state file', () => {
    expect(deriveAutopilotState(null, atAge(0))).toEqual({ running: false });
  });

  it('fresh heartbeat → running:true, not stale', () => {
    const s = deriveAutopilotState(loadFixture(), atAge(1));
    expect(s.running).toBe(true);
    expect(s.stale).toBe(false);
    // Raw fields pass through untouched.
    expect(s.pid).toBe(48213);
    expect(s.track_id).toBe('3n3Ppam7vgaVa1iaRUc9Lp');
    expect(s.track_name).toBe('Mr. Brightside');
    expect(s.artists).toEqual(['The Killers']);
    expect(s.playing).toBe(true);
    expect(s.last_error).toBeNull();
    expect((s as any).album).toBe('Hot Fuss');
    expect((s as any).duration_s).toBe(222.973);
  });

  it('fresh + playing → position_live is age-corrected by exactly the heartbeat age', () => {
    const s = deriveAutopilotState(loadFixture(), atAge(0.5));
    expect(s.position_live).toBeCloseTo(42.5 + 0.5, 6);
    const s2 = deriveAutopilotState(loadFixture(), atAge(4.9));
    expect(s2.position_live).toBeCloseTo(42.5 + 4.9, 6);
  });

  it('fresh but paused → position_live is NOT age-corrected', () => {
    const raw = loadFixture();
    raw.playing = false;
    const s = deriveAutopilotState(raw, atAge(2));
    expect(s.running).toBe(true);
    expect(s.position_live).toBe(42.5);
  });

  it('clock skew (heartbeat from the "future") never corrects backwards', () => {
    const s = deriveAutopilotState(loadFixture(), atAge(-1));
    expect(s.position_live).toBe(42.5); // Math.max(0, age)
    expect(s.running).toBe(true);
  });

  it('stale heartbeat (>5s) → running:false, stale:true, position frozen', () => {
    const s = deriveAutopilotState(loadFixture(), atAge(6));
    expect(s.running).toBe(false);
    expect(s.stale).toBe(true);
    expect(s.position_live).toBe(42.5); // no extrapolation from a dead playhead
  });

  it('boundary: exactly 5s old is still fresh', () => {
    const s = deriveAutopilotState(loadFixture(), atAge(5));
    expect(s.stale).toBe(false);
    expect(s.running).toBe(true);
  });

  it('explicit tombstone (running:false) stays false even when fresh', () => {
    const raw = loadFixture();
    raw.running = false;
    raw.exit_reason = 'stopped';
    raw.exited_at = UPDATED_AT;
    const s = deriveAutopilotState(raw, atAge(0.1));
    expect(s.stale).toBe(false); // heartbeat is fresh...
    expect(s.running).toBe(false); // ...but the tombstone wins
  });

  it('missing updated_at reads as ancient → stale, not running', () => {
    const raw = loadFixture();
    delete raw.updated_at;
    const s = deriveAutopilotState(raw, atAge(0));
    expect(s.stale).toBe(true);
    expect(s.running).toBe(false);
  });

  it('missing position_s → position_live defaults to 0', () => {
    const raw = loadFixture();
    delete raw.position_s;
    const s = deriveAutopilotState(raw, atAge(1));
    expect(s.position_live).toBe(0);
  });
});
