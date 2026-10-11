// Audio output — which device plays the music now, and how late it is.
//
// The music does not always come from this machine. When Spotify plays on a
// laptop, the laptop runs scraper/output_reporter.py. That script sends the
// laptop's CoreAudio output device and latency here each few seconds. While a
// report is fresh, it replaces the local reading from the autopilot state.
//
// A measured registry value is better than a CoreAudio-reported one, but only
// for the device it was measured on. A measurement does not transfer to other
// speakers.

export interface RemoteOutputReport {
  host: string;            // computer that plays the music
  device: string | null;   // its default output device
  latencyMs: number;       // CoreAudio-reported output latency
  receivedAtMs: number;
}

export interface LocalOutputReading {
  device: string | null;
  reportedMs: number | null;
}

export interface MeasuredAudio {
  latencyMs: number;
  outputDeviceName: string | null;
}

export interface AudioOutput {
  latencyMs: number;
  latencySource: 'measured' | 'reported' | 'none';
  device: string | null;
  host: string | null;     // null = this machine
}

// The reporter sends each 3 s. Five missed reports = the laptop is gone.
export const REMOTE_FRESH_MS = 15_000;

let remote: RemoteOutputReport | null = null;

export function setRemoteOutputReport(host: string, device: string | null, latencyMs: number, nowMs = Date.now()): RemoteOutputReport {
  remote = { host, device, latencyMs, receivedAtMs: nowMs };
  return remote;
}

export function clearRemoteOutputReport(): void {
  remote = null;
}

export function getRemoteOutputReport(nowMs = Date.now()): RemoteOutputReport | null {
  if (!remote || nowMs - remote.receivedAtMs > REMOTE_FRESH_MS) return null;
  return remote;
}

export function resolveAudioOutput(
  local: LocalOutputReading,
  measured: MeasuredAudio | null,
  nowMs = Date.now(),
): AudioOutput {
  const rep = getRemoteOutputReport(nowMs);
  const device = rep ? rep.device : local.device;
  const reportedMs = rep ? rep.latencyMs : local.reportedMs;
  const measuredApplies = !!measured && !!device && measured.outputDeviceName === device;
  return {
    latencyMs: measuredApplies ? measured!.latencyMs : reportedMs ?? 0,
    latencySource: measuredApplies ? 'measured' : reportedMs != null ? 'reported' : 'none',
    device,
    host: rep ? rep.host : null,
  };
}
