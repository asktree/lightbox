import { useEffect, useRef, useState } from 'react';
import { STEMS, STEM_COLOR, type Stem, type StemSyncStatus, type RestLight, type AutopilotState } from '../types';
import type { PlayheadRef } from '../playhead';
import { LIGHTBOX_URL } from '../api';
import { peekStemData } from '../dsp/stems';

// The only controls in the app: which stems feed which light, and the
// engine's on/off. THE SERVER IS THE SOURCE OF TRUTH — the local map is
// seeded from /status and pushed only on user clicks (an empty push while
// active is also rejected server-side; belt and suspenders).
//
// Meters run at display rate: when stem PCM is decoded locally we compute
// each light's level per-frame from its bound stems' energy at the
// playhead (the same math the engine runs at 30Hz), falling back to the
// server-polled level when PCM isn't available. Direct DOM writes — no
// React state at 60fps.
export function DriveRail({ status, lights, apRef, playhead }: {
  status: StemSyncStatus;
  lights: RestLight[];
  apRef: React.MutableRefObject<AutopilotState>;
  playhead: PlayheadRef;
}) {
  const [stemMap, setStemMap] = useState<Record<string, Stem[]>>({});
  // rid → color mode: 'palette' (default) or 'chroma' (hue follows timbre).
  const [colorModes, setColorModes] = useState<Record<string, 'palette' | 'chroma'>>({});
  const seeded = useRef(false);
  const [busy, setBusy] = useState(false);
  // Response shaping — engine params, seeded from the server once and
  // pushed (debounced) on slider moves. These are aesthetic controls, not
  // latency: gamma bends the curve, attack/decay smooth rise/fall.
  const [shaping, setShaping] = useState<{ gamma: number; attack: number; decay: number } | null>(null);
  const shapingPushTimer = useRef<number | null>(null);
  const meterRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const stemMapRef = useRef(stemMap);
  useEffect(() => { stemMapRef.current = stemMap; }, [stemMap]);
  const statusRef = useRef(status);
  useEffect(() => { statusRef.current = status; }, [status]);

  if (!seeded.current && Array.isArray(status.bindings) && status.config) {
    seeded.current = true;
    const m: Record<string, Stem[]> = {};
    const cm: Record<string, 'palette' | 'chroma'> = {};
    for (const b of status.bindings) if (b?.rid) {
      m[b.rid] = b.stems ?? [];
      cm[b.rid] = b.colorMode === 'chroma' ? 'chroma' : 'palette';
    }
    const { gamma, attack, decay } = status.config;
    setTimeout(() => { setStemMap(m); setColorModes(cm); setShaping({ gamma, attack, decay }); }, 0);
  }

  const pushShaping = (next: { gamma: number; attack: number; decay: number }) => {
    setShaping(next);
    if (shapingPushTimer.current != null) window.clearTimeout(shapingPushTimer.current);
    shapingPushTimer.current = window.setTimeout(() => {
      fetch(`${LIGHTBOX_URL}/api/stem-sync/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      }).catch(() => {});
    }, 150);
  };

  // Display-rate meters — same math the engine runs (mean of bound stems'
  // normalized energy → attack/decay smoothing → gamma), so the meters
  // respond live to the shaping sliders too.
  useEffect(() => {
    let raf = 0;
    const smoothed: Record<string, number> = {};
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const ap = apRef.current;
      const st = statusRef.current;
      const data = ap.track_id ? peekStemData(ap.track_id) : null;
      const pos = playhead.current;
      const cfg = st.config;
      for (const [rid, el] of Object.entries(meterRefs.current)) {
        if (!el) continue;
        let level: number | null = null;
        const stems = stemMapRef.current[rid] ?? [];
        if (data && ap.playing && stems.length > 0 && st.active) {
          const idx = Math.max(0, Math.min(
            data.energy.drums.samples.length - 1,
            Math.floor(pos * data.energyHz),
          ));
          let target = 0;
          for (const s of stems) {
            const e = data.energy[s];
            if (e.max > 0) target += e.samples[idx] / e.max;
          }
          target = Math.min(1, target / stems.length);
          const prev = smoothed[rid] ?? 0;
          const a = target > prev ? (cfg?.attack ?? 0) : (cfg?.decay ?? 0);
          const v = a > 0 ? prev * a + target * (1 - a) : target;
          smoothed[rid] = v;
          level = Math.pow(v, cfg?.gamma ?? 1);
        } else {
          // Fall back to the engine's own (polled) level.
          const ch = (st.channels ?? []).find((c) => c.rid === rid);
          level = ch ? ch.level : 0;
          smoothed[rid] = 0;
        }
        el.style.width = `${Math.round((level ?? 0) * 100)}%`;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [apRef, playhead]);

  const push = (nextStems: Record<string, Stem[]>, nextModes: Record<string, 'palette' | 'chroma'>) => {
    setStemMap(nextStems);
    setColorModes(nextModes);
    const bindings = Object.entries(nextStems)
      .filter(([, stems]) => stems.length > 0)
      .map(([rid, stems]) => ({ rid, stems, colorMode: nextModes[rid] ?? 'palette' }));
    fetch(`${LIGHTBOX_URL}/api/stem-sync/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bindings }),
    }).catch(() => {});
  };

  const toggleEngine = async () => {
    setBusy(true);
    try {
      await fetch(`${LIGHTBOX_URL}/api/stem-sync/${status.active ? 'stop' : 'start'}`, { method: 'POST' });
    } catch { /* status poll catches up */ }
    finally { setBusy(false); }
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Stem drive</div>
        <span className={`w-1.5 h-1.5 rounded-full ${status.active ? 'bg-green-400 animate-pulse' : 'bg-zinc-700'}`} />
        <div className="flex-1" />
        <button
          onClick={toggleEngine}
          disabled={busy}
          className={`px-2 py-0.5 rounded font-mono text-[10px] font-semibold disabled:opacity-50 ${
            status.active ? 'bg-red-600 hover:bg-red-500' : 'bg-green-600 hover:bg-green-500'
          }`}
        >{busy ? '…' : status.active ? 'stop' : 'start'}</button>
      </div>

      <div className="flex flex-col gap-2.5">
        {lights.map((l) => {
          const stems = stemMap[l.rid] ?? [];
          const ch = (status.channels ?? []).find((c) => c.rid === l.rid);
          return (
            <div key={l.rid} className="flex flex-col gap-1">
              <div className="flex items-center gap-2 text-xs">
                <span className={stems.length > 0 ? 'text-zinc-200' : 'text-zinc-500'}>{l.name}</span>
                {ch?.lastError && <span className="text-[9px] text-red-400" title={ch.lastError}>!</span>}
                <div className="flex-1" />
                <div className="flex gap-1">
                  {STEMS.map((s) => {
                    const on = stems.includes(s);
                    return (
                      <button
                        key={s}
                        onClick={() => push({
                          ...stemMap,
                          [l.rid]: on ? stems.filter((x) => x !== s) : [...stems, s],
                        }, colorModes)}
                        style={on ? { color: STEM_COLOR[s], borderColor: `${STEM_COLOR[s]}66`, background: `${STEM_COLOR[s]}1a` } : undefined}
                        className={`px-1.5 py-0.5 rounded border font-mono text-[9px] ${
                          on ? '' : 'bg-zinc-900 text-zinc-600 border-zinc-800 hover:border-zinc-600'
                        }`}
                      >{s}</button>
                    );
                  })}
                  <button
                    onClick={() => push(stemMap, {
                      ...colorModes,
                      [l.rid]: (colorModes[l.rid] ?? 'palette') === 'chroma' ? 'palette' : 'chroma',
                    })}
                    title="hue source: palette (room colors) vs chroma (color follows the music's timbre — dark=amber, bright=cyan)"
                    className={`px-1.5 py-0.5 rounded border font-mono text-[9px] ${
                      (colorModes[l.rid] ?? 'palette') === 'chroma'
                        ? 'text-cyan-300 border-cyan-700/60 bg-cyan-900/30'
                        : 'bg-zinc-900 text-zinc-600 border-zinc-800 hover:border-zinc-600'
                    }`}
                  >♪hue</button>
                </div>
              </div>
              <div className="h-1 rounded bg-zinc-800 overflow-hidden">
                <div
                  ref={(el) => { meterRefs.current[l.rid] = el; }}
                  className="h-full rounded bg-cyan-400/80"
                />
              </div>
            </div>
          );
        })}
      </div>

      {shaping && (
        <div className="flex flex-col gap-1.5 border-t border-zinc-800/60 pt-2">
          {([
            { key: 'gamma', label: 'gamma', min: 0.2, max: 4, step: 0.05,
              title: 'response curve: >1 tames quiet parts / darkens mids, <1 lifts them' },
            { key: 'attack', label: 'attack', min: 0, max: 0.95, step: 0.01,
              title: 'rise smoothing: 0 = instant hit, higher = softer swell' },
            { key: 'decay', label: 'decay', min: 0, max: 0.95, step: 0.01,
              title: 'fall smoothing: 0 = instant drop, higher = longer glow tail' },
          ] as const).map((s) => (
            <label key={s.key} className="flex items-center gap-2 text-[10px] font-mono text-zinc-500" title={s.title}>
              <span className="w-10 uppercase tracking-wider text-zinc-600">{s.label}</span>
              <input
                type="range" min={s.min} max={s.max} step={s.step}
                value={shaping[s.key]}
                onChange={(e) => pushShaping({ ...shaping, [s.key]: +e.target.value })}
                className="flex-1 accent-cyan-400 cursor-pointer"
              />
              <span className="w-8 text-right tabular-nums text-zinc-300">{shaping[s.key].toFixed(2)}</span>
            </label>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3 text-[10px] font-mono text-zinc-600">
        <span title="entertainment stream (DTLS/UDP)">stream: {status.streamActive ? <span className="text-green-400">up</span> : 'down'}</span>
        <span>
          env: {status.envelope ? <span className="text-green-400">loaded</span>
            : status.envelopeError ? <span className="text-amber-400" title={status.envelopeError}>waiting</span> : '–'}
        </span>
        <span>offset {status.config?.offsetMs ?? '–'}ms</span>
      </div>
    </section>
  );
}
