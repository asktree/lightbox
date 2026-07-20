import type { AutopilotState, StemSyncStatus } from '../types';
import { fmtSecs } from '../api';

export function Diagnostics({ ap, drive, now }: { ap: AutopilotState; drive: StemSyncStatus; now: number }) {
  const history = ap.ingest_history ?? [];
  const stateAge = ap.updated_at ? Math.max(0, now / 1000 - ap.updated_at) : null;
  const items: Array<{ label: string; value: string; warn?: boolean; title?: string }> = [
    { label: 'autopilot', value: ap.running ? `pid ${ap.pid}` : 'stopped', warn: !ap.running },
    { label: 'drift', value: ap.drift_ms != null ? `${ap.drift_ms > 0 ? '+' : ''}${ap.drift_ms}ms` : '–', title: 'Spotify clock vs interpolation (EMA)' },
    { label: 'drive offset', value: drive.config ? `${drive.config.offsetMs}ms` : '–', title: 'negative = fire early to beat bridge latency' },
    { label: 'audio out', value: ap.output_latency_ms != null ? `${ap.output_latency_ms}ms` : '–', title: ap.output_device_name ?? '' },
    { label: 'ingesting', value: String((ap.ingesting ?? []).length) },
  ];
  return (
    <div className="flex items-center gap-5 text-[10px] font-mono text-zinc-500 flex-wrap">
      {items.map((d) => (
        <span key={d.label} title={d.title}>
          <span className="text-zinc-600 uppercase tracking-wider mr-1.5">{d.label}</span>
          <span className={d.warn ? 'text-red-400' : 'text-zinc-300'}>{d.value}</span>
        </span>
      ))}
      {stateAge != null && stateAge > 3 && ap.running && (
        <span className="text-amber-400">state {stateAge.toFixed(0)}s old</span>
      )}
      {history.length > 0 && (
        <span className="text-zinc-600">
          last ingest: <span className={history[0].ok ? 'text-green-400' : 'text-red-400'}>
            {history[0].name ?? history[0].id} {history[0].ok ? `✓ ${fmtSecs(history[0].secs)}` : `✗ rc=${history[0].rc}`}
          </span>
        </span>
      )}
      {ap.last_error && <span className="text-red-400 truncate max-w-[280px]" title={ap.last_error}>spotify: {ap.last_error}</span>}
      {drive.envelopeError && <span className="text-amber-400/80 truncate max-w-[220px]" title={drive.envelopeError}>env: {drive.envelopeError}</span>}
    </div>
  );
}
