// Shadebox client: the Yoolax blind behind the ESP32-C6 at shadebox.local.
// The board shares one radio between Wi-Fi and Zigbee. It leaves Wi-Fi for a
// short time when it sends a command to the blind, so a request can fail.
// Commands go through a latest-wins queue with retries: only the newest
// intent matters, and latency is not important.
import { lookup } from 'node:dns/promises';

const HOST = 'shadebox.local';
const REQUEST_TIMEOUT_MS = 2500;
const RETRY_MS = 400;
const GIVE_UP_MS = 30_000;

export type ShadeCommand =
  | { kind: 'open' }
  | { kind: 'close' }
  | { kind: 'stop' }
  | { kind: 'go'; open: number };

export interface ShadeState {
  paired: boolean;
  open: number;        // 0 closed .. 100 open, -1 = not known
  moving: boolean;
  dir: number;
  target: number;
  [key: string]: unknown;
}

// macOS getaddrinfo stalls ~5s on .local names (see ambience.ts) — resolve
// IPv4 explicitly and cache. A failed request drops the cache entry.
let cachedIp: { ip: string; at: number } | null = null;
async function resolveIp(): Promise<string> {
  if (cachedIp && Date.now() - cachedIp.at < 10 * 60_000) return cachedIp.ip;
  const { address } = await lookup(HOST, { family: 4 });
  cachedIp = { ip: address, at: Date.now() };
  return address;
}

let lastState: ShadeState | null = null;
let lastStateAt = 0;
let lastError: string | null = null;

async function request(method: 'GET' | 'POST', path: string): Promise<ShadeState> {
  try {
    const ip = await resolveIp();
    const r = await fetch(`http://${ip}${path}`, { method, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    lastState = (await r.json()) as ShadeState;
    lastStateAt = Date.now();
    lastError = null;
    return lastState;
  } catch (err) {
    cachedIp = null;
    lastError = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

function pathFor(cmd: ShadeCommand): string {
  return cmd.kind === 'go' ? `/go?open=${Math.round(cmd.open)}` : `/${cmd.kind}`;
}

let pending: { cmd: ShadeCommand; since: number } | null = null;
let pumping = false;

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (pending) {
      const job = pending;
      try {
        await request('POST', pathFor(job.cmd));
        if (pending === job) pending = null;
      } catch {
        if (pending !== job) continue;            // a newer command replaced it
        if (Date.now() - job.since > GIVE_UP_MS) {
          console.warn(`shade: gave up on ${pathFor(job.cmd)} after ${GIVE_UP_MS / 1000}s (${lastError})`);
          pending = null;
        } else {
          await new Promise((r) => setTimeout(r, RETRY_MS));
        }
      }
    }
  } finally {
    pumping = false;
  }
}

/** Queue a command. A newer command replaces one that is not delivered yet. */
export function sendShade(cmd: ShadeCommand): void {
  pending = { cmd, since: Date.now() };
  void pump();
}

/** Read the state from the board. Throws if the board does not answer. */
export function fetchShadeState(): Promise<ShadeState> {
  return request('GET', '/state');
}

/** The last state the board gave, with its age. No network call. */
export function shadeStatus() {
  return {
    host: HOST,
    state: lastState,
    stateAgeMs: lastState ? Date.now() - lastStateAt : null,
    pending: pending ? pathFor(pending.cmd) : null,
    lastError,
  };
}
