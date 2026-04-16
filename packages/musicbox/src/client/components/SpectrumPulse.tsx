import { useRef, useEffect, type ReactNode } from 'react';

interface Props {
  lowTrigger: boolean;
  highTrigger: boolean;
  children: ReactNode;
}

/**
 * Wraps the spectrum area with two decaying "stage light" overlays:
 *   - red from below, fires on low-band onsets (kicks → floor strip in real life)
 *   - light blue from above, fires on high-band onsets (snares/hats → headboard)
 *
 * Both fade independently on their own rAF-driven decay curves.
 */
export function SpectrumPulse({ lowTrigger, highTrigger, children }: Props) {
  const lowRef = useRef<HTMLDivElement>(null);
  const highRef = useRef<HTMLDivElement>(null);
  const lowDecay = useRef(0);
  const highDecay = useRef(0);

  // Kick decay refs up to 1 when a trigger arrives
  useEffect(() => { if (lowTrigger) lowDecay.current = 1; }, [lowTrigger]);
  useEffect(() => { if (highTrigger) highDecay.current = 1; }, [highTrigger]);

  // Independent rAF loop animating opacity of the two glow layers
  useEffect(() => {
    let raf: number;
    const tick = () => {
      lowDecay.current *= 0.86;
      highDecay.current *= 0.86;
      if (lowDecay.current < 0.005) lowDecay.current = 0;
      if (highDecay.current < 0.005) highDecay.current = 0;
      if (lowRef.current) lowRef.current.style.opacity = String(lowDecay.current);
      if (highRef.current) highRef.current.style.opacity = String(highDecay.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden">
      {children}
      {/* Light blue glow from the top (high onsets — snares/hats) */}
      <div
        ref={highRef}
        aria-hidden
        className="absolute inset-x-0 top-0 pointer-events-none"
        style={{
          height: '60%',
          opacity: 0,
          background: 'linear-gradient(to bottom, rgba(56,189,248,0.55) 0%, rgba(56,189,248,0.22) 45%, rgba(56,189,248,0) 100%)',
          mixBlendMode: 'screen',
        }}
      />
      {/* Red glow from the bottom (low onsets — kicks) */}
      <div
        ref={lowRef}
        aria-hidden
        className="absolute inset-x-0 bottom-0 pointer-events-none"
        style={{
          height: '60%',
          opacity: 0,
          background: 'linear-gradient(to top, rgba(248,113,113,0.6) 0%, rgba(248,113,113,0.22) 45%, rgba(248,113,113,0) 100%)',
          mixBlendMode: 'screen',
        }}
      />
    </div>
  );
}
