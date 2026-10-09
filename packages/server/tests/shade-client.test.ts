import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The client keeps module state (IP cache, queue), so each test loads a new copy.
const lookup = vi.fn();
vi.mock('node:dns/promises', () => ({ lookup: (...a: unknown[]) => lookup(...a) }));

type Call = { url: string; signal: AbortSignal };
let calls: Call[];
let answer: (c: Call) => Promise<Response>;

const ok = () => Promise.resolve(new Response(JSON.stringify({ paired: true, open: 40, moving: false, dir: 0, target: 40 })));
const hang = (c: Call) => new Promise<Response>((_, reject) => {
  c.signal.addEventListener('abort', () => reject(c.signal.reason ?? new Error('aborted')), { once: true });
});

async function load() {
  vi.resetModules();
  return import('../src/services/shade.js');
}

const tick = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  lookup.mockReset();
  lookup.mockResolvedValue({ address: '192.168.0.107', family: 4 });
  calls = [];
  answer = ok;
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const c = { url, signal: init.signal! };
    calls.push(c);
    return answer(c);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shade client', () => {
  it('keeps the known IP after a failed request (no mDNS wait)', async () => {
    const shade = await load();
    await shade.fetchShadeState();
    expect(lookup).toHaveBeenCalledTimes(1);

    answer = () => Promise.reject(new Error('EHOSTUNREACH'));
    await expect(shade.fetchShadeState()).rejects.toThrow();

    // mDNS now hangs, as when the board radio is on Zigbee.
    lookup.mockReturnValue(new Promise(() => {}));
    answer = ok;
    const st = await shade.fetchShadeState();
    expect(st.open).toBe(40);
    expect(calls.at(-1)!.url).toBe('http://192.168.0.107/state');
  });

  it('sends a new command at once, and cancels the old request', async () => {
    const shade = await load();
    answer = hang;
    shade.sendShade({ kind: 'go', open: 100 });
    await tick();
    expect(calls.map((c) => c.url)).toEqual(['http://192.168.0.107/go?open=100']);

    answer = ok;
    shade.sendShade({ kind: 'stop' });
    await tick();
    expect(calls[0].signal.aborted).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(['http://192.168.0.107/go?open=100', 'http://192.168.0.107/stop']);
    expect(shade.shadeStatus().pending).toBeNull();
  });
});
