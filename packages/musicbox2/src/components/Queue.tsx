import type { AutopilotState } from '../types';
import { fmtTime } from '../api';
import { Art, StatusBadge } from './badges';
import { IngestStepper } from './IngestStepper';

export function Queue({ state, now }: { state: AutopilotState; now: number }) {
  const queue = state.queue ?? [];
  return (
    <section>
      <div className="text-[10px] font-mono uppercase tracking-widest text-zinc-500 mb-2">Up next</div>
      {queue.length === 0 ? (
        <div className="text-zinc-600 text-xs font-mono">queue empty</div>
      ) : (
        <div className="flex flex-col gap-2">
          {queue.map((q, i) => (
            <div key={`${q.id}-${i}`} className="flex flex-col gap-1 min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[10px] font-mono text-zinc-700 w-3 text-right shrink-0">{i + 1}</span>
                <Art url={q.art_url} size="w-8 h-8" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs truncate">{q.name}</div>
                  <div className="text-[10px] text-zinc-500 truncate">{q.artists.join(', ')}</div>
                </div>
                <span className="text-[10px] font-mono text-zinc-600 shrink-0">{q.duration_s ? fmtTime(q.duration_s) : ''}</span>
                <StatusBadge status={q.status} />
              </div>
              {q.status === 'ingesting' && q.id && (
                <div className="pl-[52px] min-w-0">
                  <IngestStepper progress={state.ingest_progress?.[q.id]} now={now} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
