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
// The board does not always get the position report of the motor after a
// move. On 2026-10-05 a move to 61 % stayed "0 %" in the board state until a
// query. So after each delivered command, ask the motor for its position
// when the move is over (POST /refresh). The answer is in the board state
// about 2 s later.
const DEFAULT_TRAVEL_MS = 32_000;
const SETTLE_AFTER_MOVE_MS = 2_500;
const SETTLE_AFTER_STOP_MS = 2_000;
const REFRESH_ANSWER_MS = 3_500;
const POSITION_TRIES = 3;

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
// IPv4 explicitly and cache. The board keeps its IP, but it may not answer
// mDNS while its radio is on Zigbee. So a failed request does not drop the
// IP: it only marks it for a new lookup in the background. A request never
// waits on a lookup while an old IP is known (IGG-1344).
const IP_FRESH_MS = 10 * 60_000;
const LOOKUP_TIMEOUT_MS = 3_000;
let cachedIp: { ip: string; at: number } | null = null;
let lookingUp: Promise<string> | null = null;

function lookupIp(): Promise<string> {
  lookingUp ??= Promise.race([
    lookup(HOST, { family: 4 }).then(({ address }) => address),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`mDNS lookup of ${HOST} timed out`)), LOOKUP_TIMEOUT_MS)),
  ])
    .then((ip) => { cachedIp = { ip, at: Date.now() }; return ip; })
    .finally(() => { lookingUp = null; });
  return lookingUp;
}

async function resolveIp(): Promise<string> {
  if (!cachedIp) return lookupIp();
  if (Date.now() - cachedIp.at >= IP_FRESH_MS) lookupIp().catch(() => {});
  return cachedIp.ip;
}

let lastState: ShadeState | null = null;
let lastStateAt = 0;
let lastError: string | null = null;

// `cancel`, plus a timeout. (AbortSignal.any needs Node 20.3.)
function withTimeout(cancel: AbortSignal, ms: number): AbortSignal {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
  const stop = () => { clearTimeout(timer); ac.abort(cancel.reason); };
  if (cancel.aborted) stop(); else cancel.addEventListener('abort', stop, { once: true });
  ac.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return ac.signal;
}

async function request(method: 'GET' | 'POST', path: string, cancel?: AbortSignal): Promise<ShadeState> {
  try {
    const ip = await resolveIp();
    const signal = cancel ? withTimeout(cancel, REQUEST_TIMEOUT_MS) : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const r = await fetch(`http://${ip}${path}`, { method, signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    lastState = (await r.json()) as ShadeState;
    lastStateAt = Date.now();
    lastError = null;
    return lastState;
  } catch (err) {
    // Look up the IP again in the background, in case the board has a new one.
    if (cachedIp && !cancel?.aborted) cachedIp.at = 0;
    lastError = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

function pathFor(cmd: ShadeCommand): string {
  return cmd.kind === 'go' ? `/go?open=${Math.round(cmd.open)}` : `/${cmd.kind}`;
}

/** The time from `cmd` until the move is over, from the state at the start of the move. */
export function moveTimeMs(cmd: ShadeCommand, state: { open: number; travelMs?: unknown } | null): number {
  if (cmd.kind === 'stop') return SETTLE_AFTER_STOP_MS;
  const target = targetOf(cmd);
  const t = state?.travelMs;
  const travel = typeof t === 'number' && t >= 3_000 && t <= 180_000 ? t : DEFAULT_TRAVEL_MS;
  const open = state?.open;
  const distance = typeof open === 'number' && open >= 0 && open <= 100 ? Math.abs(target - open) : 100;
  return (distance / 100) * travel + SETTLE_AFTER_MOVE_MS;
}

function targetOf(cmd: Exclude<ShadeCommand, { kind: 'stop' }>): number {
  return cmd.kind === 'go' ? Math.max(0, Math.min(100, cmd.open)) : cmd.kind === 'open' ? 100 : 0;
}

let pending: { cmd: ShadeCommand; since: number } | null = null;
let pumping = false;
// Cancels the command request in flight. A newer command does not wait for
// an old request to time out: the newest intent goes out at once.
let inflight: AbortController | null = null;

// One position check runs at a time. A newer command starts a new one.
let positionTimer: NodeJS.Timeout | null = null;
let positionGen = 0;

function schedulePositionCheck(cmd: ShadeCommand, delayMs: number, tries: number): void {
  if (positionTimer) clearTimeout(positionTimer);
  const gen = ++positionGen;
  positionTimer = setTimeout(() => {
    positionTimer = null;
    void checkPosition(cmd, tries, gen);
  }, delayMs);
}

async function checkPosition(cmd: ShadeCommand, tries: number, gen: number): Promise<void> {
  const stale = () => gen !== positionGen || pending !== null;
  if (stale()) return;
  let asked = true;
  try {
    await request('POST', '/refresh');
  } catch {
    asked = false;
  }
  if (stale()) return;
  if (!asked) {
    if (tries > 1) schedulePositionCheck(cmd, 1_000, tries - 1);
    return;
  }
  await new Promise((r) => setTimeout(r, REFRESH_ANSWER_MS));
  if (stale()) return;
  let st: ShadeState | null = null;
  try {
    st = await request('GET', '/state');
  } catch { /* the next command or state read updates it */ }
  if (stale()) return;
  console.log(`shade: position after ${pathFor(cmd)}: ${st ? `${st.open}%` : 'no answer from the board'}`);
  if (tries <= 1 || cmd.kind === 'stop') return;
  // Not at the target: the move took longer than the estimate, or the answer
  // of the motor did not arrive. Read again when the rest of the move is over.
  if (!st || Math.abs(st.open - targetOf(cmd)) > 2) {
    schedulePositionCheck(cmd, st ? moveTimeMs(cmd, st) : 2_000, tries - 1);
  }
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (pending) {
      const job = pending;
      try {
        // The reply has the position at the start of the move.
        inflight = new AbortController();
        const start = await request('POST', pathFor(job.cmd), inflight.signal);
        if (pending === job) {
          pending = null;
          schedulePositionCheck(job.cmd, moveTimeMs(job.cmd, start), POSITION_TRIES);
        }
      } catch {
        if (pending !== job) continue;            // a newer command replaced it
        if (Date.now() - job.since > GIVE_UP_MS) {
          console.warn(`shade: gave up on ${pathFor(job.cmd)} after ${GIVE_UP_MS / 1000}s (${lastError})`);
          pending = null;
        } else {
          await new Promise((r) => setTimeout(r, RETRY_MS));
        }
      } finally {
        inflight = null;
      }
    }
  } finally {
    pumping = false;
  }
}

/** Queue a command. A newer command replaces one that is not delivered yet. */
export function sendShade(cmd: ShadeCommand): void {
  if (positionTimer) { clearTimeout(positionTimer); positionTimer = null; }
  positionGen++;
  pending = { cmd, since: Date.now() };
  inflight?.abort();
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
