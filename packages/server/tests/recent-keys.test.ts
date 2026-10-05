import { describe, it, expect } from 'vitest';
import { RecentKeys, remoteEventKey } from '../src/lib/recent-keys.js';

describe('RecentKeys', () => {
  it('reports a key the second time', () => {
    const r = new RecentKeys();
    expect(r.seen('a')).toBe(false);
    expect(r.seen('a')).toBe(true);
    expect(r.seen('b')).toBe(false);
    expect(r.seen('a')).toBe(true);
  });

  it('forgets the oldest key when it is full', () => {
    const r = new RecentKeys(3);
    r.seen('a'); r.seen('b'); r.seen('c');
    expect(r.seen('d')).toBe(false);   // 'a' goes out
    expect(r.seen('b')).toBe(true);
    expect(r.seen('a')).toBe(false);   // 'a' is new again
  });
});

describe('remoteEventKey', () => {
  const press = {
    type: 'button', id: 'btn-2',
    button: { button_report: { updated: '2026-10-05T14:36:37.100Z', event: 'initial_press' }, last_event: 'initial_press' },
  };

  it('gives the same key for the same button event', () => {
    expect(remoteEventKey(press)).toBe(remoteEventKey(JSON.parse(JSON.stringify(press))));
  });

  it('gives different keys for the press and the release', () => {
    const release = { ...press, button: { button_report: { updated: '2026-10-05T14:36:37.900Z', event: 'short_release' } } };
    expect(remoteEventKey(release)).not.toBe(remoteEventKey(press));
    // Also with the same stamp, the event name keeps them apart.
    const sameStamp = { ...press, button: { button_report: { updated: press.button.button_report.updated, event: 'short_release' } } };
    expect(remoteEventKey(sameStamp)).not.toBe(remoteEventKey(press));
  });

  it('keeps two buttons apart', () => {
    expect(remoteEventKey({ ...press, id: 'btn-1' })).not.toBe(remoteEventKey(press));
  });

  it('gives a key for a dial report', () => {
    const turn = {
      type: 'relative_rotary', id: 'dial-1',
      relative_rotary: { rotary_report: { updated: '2026-10-05T05:38:59.572Z', action: 'repeat', rotation: { direction: 'clock_wise', steps: 30, duration: 400 } } },
    };
    expect(remoteEventKey(turn)).toBe('dial-1|rotary|2026-10-05T05:38:59.572Z');
  });

  it('gives null when there is no stamp, or for other items', () => {
    expect(remoteEventKey({ type: 'button', id: 'b', button: { last_event: 'initial_press' } })).toBeNull();
    expect(remoteEventKey({ type: 'relative_rotary', id: 'd', relative_rotary: {} })).toBeNull();
    expect(remoteEventKey({ type: 'light', id: 'l' })).toBeNull();
    expect(remoteEventKey(null)).toBeNull();
  });
});
