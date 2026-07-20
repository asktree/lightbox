import type { IngestProgress } from '../types';
import { fmtSecs } from '../api';

// Pipeline stepper for the stems-only ingest: download → demucs.
// Renders whatever stages the progress file actually contains, in
// canonical order (metadata is subsecond and elided).
const STAGE_ORDER = ['download', 'demucs'];
const STAGE_TYPICAL: Record<string, number> = { download: 10, demucs: 45 };

export function IngestStepper({ progress, now }: { progress: IngestProgress | null | undefined; now: number }) {
  const stage = progress?.stage;
  const stages = progress?.stages ?? {};
  const present = STAGE_ORDER.filter((s) => s in stages || s === stage);
  const pipeline = present.length > 0 ? present : STAGE_ORDER;
  const activeIdx = stage ? pipeline.indexOf(stage) : -1;
  return (
    <div className="flex items-center gap-x-1.5 gap-y-0.5 flex-wrap min-w-0">
      {pipeline.map((s, i) => {
        const info = stages[s];
        const isActive = stage === s;
        const isDone = !!info?.secs || stage === 'done' || activeIdx > i;
        const isFailed = stage === 'failed' && !!info && info.secs == null;
        const elapsed = isActive && info?.started_at ? now / 1000 - info.started_at : null;
        const typical = STAGE_TYPICAL[s] ?? 45;
        const pct = elapsed != null ? Math.min(95, (elapsed / typical) * 100) : isDone ? 100 : 0;
        return (
          <div key={s} className="flex items-center gap-1.5 min-w-0">
            {i > 0 && <span className="text-zinc-700 text-[9px]">→</span>}
            <div className="flex flex-col gap-0.5 w-[72px] shrink">
              <div className="flex items-baseline justify-between gap-1">
                <span className={`text-[9px] font-mono truncate ${
                  isFailed ? 'text-red-400' : isActive ? 'text-amber-300' : isDone ? 'text-green-400' : 'text-zinc-600'
                }`}>{s}</span>
                <span className="text-[9px] font-mono text-zinc-500 whitespace-nowrap">
                  {info?.secs != null ? fmtSecs(info.secs) : elapsed != null ? fmtSecs(elapsed) : ''}
                </span>
              </div>
              <div className="h-1 rounded bg-zinc-800 overflow-hidden">
                <div
                  className={`h-full rounded transition-all duration-500 ${
                    isFailed ? 'bg-red-500' : isActive ? 'bg-amber-400 animate-pulse' : isDone ? 'bg-green-500' : ''
                  }`}
                  style={{ width: `${info?.secs != null ? 100 : pct}%` }}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
