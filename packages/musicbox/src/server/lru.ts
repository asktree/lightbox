// Tiny LRU map used by the envelope cache. Extracted from envelope.ts so
// the eviction behavior is unit-testable. Semantics are exactly the old
// inline Map + touchLru pair:
//   - `get` is a plain lookup (no recency bump on its own).
//   - `touch` (re-)inserts the entry, marking it most-recent, then evicts
//     oldest entries until size <= max. Map iteration order is insertion
//     order, so re-inserting is the recency bump.
export class LruMap<K, V> {
  private map = new Map<K, V>();
  constructor(private readonly max: number) {}

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  touch(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as K;
      this.map.delete(oldest);
    }
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }
}
