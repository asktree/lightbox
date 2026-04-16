import { useRef, useEffect, useState } from 'react';

interface Props {
  beatTrigger: boolean;
  lowStrength: number;
  lowTrigger: boolean;
  highStrength: number;
  highTrigger: boolean;
  bpm: number;
}

export function OnsetIndicators({
  beatTrigger, lowStrength, lowTrigger, highStrength, highTrigger, bpm,
}: Props) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-2 px-2">
      <div className="flex items-center justify-around w-full gap-2">
        <Pulse label="BEAT" strength={1} trigger={beatTrigger} hue={280} />
        <Pulse label="LOW"  strength={lowStrength}  trigger={lowTrigger}  hue={15} />
        <Pulse label="HIGH" strength={highStrength} trigger={highTrigger} hue={200} />
      </div>
      <div className="text-[10px] text-zinc-600 uppercase tracking-wider font-mono">
        {bpm > 0 ? `${bpm} BPM` : '-- BPM'}
      </div>
    </div>
  );
}

function Pulse({ label, strength, trigger, hue }: {
  label: string; strength: number; trigger: boolean; hue: number;
}) {
  const [flash, setFlash] = useState(0);
  const decayRef = useRef(0);

  useEffect(() => {
    if (trigger) decayRef.current = 1;
  }, [trigger]);

  useEffect(() => {
    let raf: number;
    const tick = () => {
      decayRef.current *= 0.88;
      if (decayRef.current < 0.01) decayRef.current = 0;
      setFlash(decayRef.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const size = 30 + flash * 14;
  const borderAlpha = 0.3 + flash * 0.7;
  const fillAlpha = 0.1 + flash * 0.5;
  const glow = flash > 0.01
    ? `0 0 ${10 + flash * 18}px hsla(${hue}, 80%, 55%, ${flash * 0.6})`
    : 'none';

  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className="rounded-full border-2 flex items-center justify-center transition-none"
        style={{
          width: size, height: size,
          backgroundColor: `hsla(${hue}, 80%, 55%, ${fillAlpha})`,
          borderColor: `hsla(${hue}, 80%, 55%, ${borderAlpha})`,
          boxShadow: glow,
        }}
      />
      <span className="text-[9px] text-zinc-500 uppercase tracking-wider font-mono">{label}</span>
      <div className="w-8 h-0.5 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full"
          style={{
            width: `${strength * 100}%`,
            backgroundColor: `hsl(${hue}, 70%, 55%)`,
          }}
        />
      </div>
    </div>
  );
}
