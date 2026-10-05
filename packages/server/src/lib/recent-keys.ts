// A small memory of the last keys, to drop something that comes two times.
// The Hue driver uses it while two EventStream connections are open for a
// short time: the bridge sends each event on the two of them.

export class RecentKeys {
  private keys = new Set<string>();

  constructor(private readonly keep = 64) {}

  /** True if `key` came before. If not, the key is recorded. */
  seen(key: string): boolean {
    if (this.keys.has(key)) return true;
    this.keys.add(key);
    // A Set keeps the insertion order, so the first value is the oldest.
    if (this.keys.size > this.keep) this.keys.delete(this.keys.values().next().value as string);
    return false;
  }
}

/**
 * The key of a button or rotary item from the bridge, or null if the item
 * has no time stamp. One press or one dial report has one stamp, also when
 * the bridge sends it on two connections.
 */
export function remoteEventKey(item: any): string | null {
  if (item?.type === 'button') {
    const r = item.button?.button_report;
    if (typeof r?.updated !== 'string') return null;
    return `${item.id}|button|${r.updated}|${r.event}`;
  }
  if (item?.type === 'relative_rotary') {
    const r = item.relative_rotary?.rotary_report;
    if (typeof r?.updated !== 'string') return null;
    return `${item.id}|rotary|${r.updated}`;
  }
  return null;
}
