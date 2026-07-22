// LruMap — the envelope cache's eviction policy (envelope.ts, CACHE_MAX=50).
// Semantics under test: touch (re-)inserts marking recency and evicts the
// oldest past the cap; get is a plain lookup (getEnvelope always follows a
// hit with touch, which is the recency bump).
import { describe, it, expect } from 'vitest';
import { LruMap } from '../src/server/lru.js';

describe('LruMap', () => {
  it('holds entries up to the cap without evicting', () => {
    const lru = new LruMap<string, number>(3);
    lru.touch('a', 1);
    lru.touch('b', 2);
    lru.touch('c', 3);
    expect(lru.size).toBe(3);
    expect([...lru.keys()]).toEqual(['a', 'b', 'c']);
    expect(lru.get('a')).toBe(1);
  });

  it('evicts the oldest entry when the cap is exceeded', () => {
    const lru = new LruMap<string, number>(3);
    lru.touch('a', 1);
    lru.touch('b', 2);
    lru.touch('c', 3);
    lru.touch('d', 4);
    expect(lru.size).toBe(3);
    expect(lru.get('a')).toBeUndefined();
    expect([...lru.keys()]).toEqual(['b', 'c', 'd']);
  });

  it('touch on an existing key bumps recency, changing who gets evicted', () => {
    const lru = new LruMap<string, number>(3);
    lru.touch('a', 1);
    lru.touch('b', 2);
    lru.touch('c', 3);
    // Re-touch 'a' (the cache-hit path: get + touch) → 'b' is now oldest.
    lru.touch('a', lru.get('a')!);
    lru.touch('d', 4);
    expect(lru.get('b')).toBeUndefined();
    expect([...lru.keys()]).toEqual(['c', 'a', 'd']);
  });

  it('eviction order follows repeated insertions exactly', () => {
    const lru = new LruMap<number, number>(2);
    for (let i = 0; i < 10; i++) lru.touch(i, i);
    expect(lru.size).toBe(2);
    expect([...lru.keys()]).toEqual([8, 9]);
  });

  it('touch replaces the value for an existing key', () => {
    const lru = new LruMap<string, number>(2);
    lru.touch('a', 1);
    lru.touch('a', 99);
    expect(lru.size).toBe(1);
    expect(lru.get('a')).toBe(99);
  });

  it('delete removes an entry (the compute-failure retry path)', () => {
    const lru = new LruMap<string, number>(2);
    lru.touch('a', 1);
    expect(lru.delete('a')).toBe(true);
    expect(lru.delete('a')).toBe(false);
    expect(lru.size).toBe(0);
    expect(lru.get('a')).toBeUndefined();
  });

  it('respects a cap of 1', () => {
    const lru = new LruMap<string, number>(1);
    lru.touch('a', 1);
    lru.touch('b', 2);
    expect([...lru.keys()]).toEqual(['b']);
  });
});
