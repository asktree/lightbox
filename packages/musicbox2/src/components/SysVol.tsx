import { useEffect, useRef, useState } from 'react';
import { MUSICBOX_URL } from '../api';

// Host-machine system volume (osascript via 3002/api/sysvol). Slider drags
// throttle POSTs; the poll pauses while dragging so the knob doesn't fight
// the hand holding it.
export function SysVol() {
  const [vol, setVol] = useState<number | null>(null);
  const [muted, setMuted] = useState(false);
  const dragging = useRef(false);
  const lastSent = useRef(0);
  const trailing = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (dragging.current) return;
      try {
        const r = await fetch(`${MUSICBOX_URL}/api/sysvol`);
        const j = await r.json();
        if (cancelled || dragging.current) return;
        setVol(j.volume);
        setMuted(j.muted);
      } catch { /* host endpoint down; keep last */ }
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  const push = (body: { volume?: number; muted?: boolean }) => {
    fetch(`${MUSICBOX_URL}/api/sysvol`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {});
  };

  // At most one POST per 150ms while dragging, plus a trailing send so the
  // release position always lands.
  const pushThrottled = (v: number) => {
    if (trailing.current) clearTimeout(trailing.current);
    const now = Date.now();
    if (now - lastSent.current >= 150) {
      lastSent.current = now;
      push({ volume: v });
    } else {
      trailing.current = setTimeout(() => { lastSent.current = Date.now(); push({ volume: v }); }, 150);
    }
  };

  if (vol === null) return null; // endpoint never answered — hide, don't lie

  return (
    <div className="shrink-0 flex items-center gap-1.5" title="host system volume">
      <button
        onClick={() => { setMuted(!muted); push({ muted: !muted }); }}
        className={`font-mono text-[10px] w-7 text-right ${muted ? 'text-red-400' : 'text-zinc-500 hover:text-zinc-300'}`}
      >{muted ? 'mut' : `${vol}`}</button>
      <input
        type="range"
        min={0}
        max={100}
        value={vol}
        onPointerDown={() => { dragging.current = true; }}
        onPointerUp={() => { dragging.current = false; }}
        onChange={(e) => {
          const v = Number(e.target.value);
          setVol(v);
          pushThrottled(v);
        }}
        className="w-24 accent-cyan-400 cursor-pointer"
      />
    </div>
  );
}
