// Contract test for services/audio-output.ts: which output device the sync
// uses. A fresh remote report (scraper/output_reporter.py on a laptop)
// replaces the local reading. A measured registry value applies only to the
// device it was measured on.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  REMOTE_FRESH_MS,
  clearRemoteOutputReport,
  getRemoteOutputReport,
  resolveAudioOutput,
  setRemoteOutputReport,
} from '../src/services/audio-output.js';

const NOW = 1_800_000_000_000;
const LOCAL = { device: 'Mac mini Speakers', reportedMs: 27 };
const MEASURED = { latencyMs: 410.1, outputDeviceName: 'HK Onyx Studio 8' };

describe('resolveAudioOutput', () => {
  beforeEach(() => clearRemoteOutputReport());

  it('uses the local reading when there is no remote report', () => {
    expect(resolveAudioOutput(LOCAL, MEASURED, NOW)).toEqual({
      latencyMs: 27, latencySource: 'reported', device: 'Mac mini Speakers', host: null,
    });
  });

  it('gives source none when nothing is known', () => {
    expect(resolveAudioOutput({ device: null, reportedMs: null }, MEASURED, NOW)).toEqual({
      latencyMs: 0, latencySource: 'none', device: null, host: null,
    });
  });

  it('uses a fresh remote report in place of the local reading', () => {
    setRemoteOutputReport("sock's MacBook Air", 'Living Room Sonos', 2000, NOW);
    expect(resolveAudioOutput(LOCAL, MEASURED, NOW + 5000)).toEqual({
      latencyMs: 2000, latencySource: 'reported', device: 'Living Room Sonos', host: "sock's MacBook Air",
    });
  });

  it('drops a remote report after it goes stale', () => {
    setRemoteOutputReport("sock's MacBook Air", 'Living Room Sonos', 2000, NOW);
    expect(getRemoteOutputReport(NOW + REMOTE_FRESH_MS)).not.toBeNull();
    expect(getRemoteOutputReport(NOW + REMOTE_FRESH_MS + 1)).toBeNull();
    expect(resolveAudioOutput(LOCAL, MEASURED, NOW + REMOTE_FRESH_MS + 1).device).toBe('Mac mini Speakers');
  });

  it('uses the measured value only on the device it was measured on', () => {
    setRemoteOutputReport('laptop', 'HK Onyx Studio 8', 204, NOW);
    expect(resolveAudioOutput(LOCAL, MEASURED, NOW)).toMatchObject({ latencyMs: 410.1, latencySource: 'measured' });
    setRemoteOutputReport('laptop', 'MacBook Air Speakers', 30, NOW);
    expect(resolveAudioOutput(LOCAL, MEASURED, NOW)).toMatchObject({ latencyMs: 30, latencySource: 'reported' });
  });
});
