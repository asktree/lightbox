import type { TrackStatus } from '../types';

const STATUS_BADGE: Record<TrackStatus, { label: string; cls: string }> = {
  ready: { label: '✓ ready', cls: 'bg-green-900/60 text-green-300 border-green-700/50' },
  ingesting: { label: '⟳ ingesting', cls: 'bg-amber-900/50 text-amber-300 border-amber-700/50' },
  pending: { label: '· pending', cls: 'bg-zinc-800 text-zinc-400 border-zinc-700' },
  failed: { label: '✗ failed', cls: 'bg-red-900/50 text-red-300 border-red-700/50' },
  unknown: { label: '?', cls: 'bg-zinc-800 text-zinc-500 border-zinc-700' },
};

export function StatusBadge({ status }: { status: TrackStatus }) {
  const b = STATUS_BADGE[status] ?? STATUS_BADGE.unknown;
  return (
    <span className={`px-1.5 py-0.5 rounded border text-[10px] font-mono whitespace-nowrap ${b.cls}`}>
      {b.label}
    </span>
  );
}

export function Art({ url, size, label }: { url?: string | null; size: string; label?: string }) {
  return url ? (
    <img src={url} alt="" className={`${size} rounded object-cover bg-zinc-900 shrink-0`} />
  ) : (
    <div className={`${size} rounded bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-700 shrink-0`}>
      {label ?? '♪'}
    </div>
  );
}
