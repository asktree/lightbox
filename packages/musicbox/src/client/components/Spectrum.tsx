import { useRef, useEffect } from 'react';

// Color gradient: warm (bass) → cool (treble)
function barColor(i: number, total: number): string {
  const t = i / total;
  // amber → green → cyan → blue
  if (t < 0.25) {
    const p = t / 0.25;
    return `rgb(${255 - Math.round(p * 55)}, ${160 + Math.round(p * 60)}, ${50 - Math.round(p * 20)})`;
  } else if (t < 0.5) {
    const p = (t - 0.25) / 0.25;
    return `rgb(${100 - Math.round(p * 60)}, ${220 + Math.round(p * 35)}, ${30 + Math.round(p * 170)})`;
  } else if (t < 0.75) {
    const p = (t - 0.5) / 0.25;
    return `rgb(${40 - Math.round(p * 20)}, ${255 - Math.round(p * 55)}, ${200 + Math.round(p * 55)})`;
  } else {
    const p = (t - 0.75) / 0.25;
    return `rgb(${20 + Math.round(p * 40)}, ${200 - Math.round(p * 80)}, ${255 - Math.round(p * 30)})`;
  }
}

interface Props {
  data: number[];
}

export function Spectrum({ data }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peaksRef = useRef<number[]>(new Array(128).fill(0));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;

    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const numBars = data.length;
    const gap = 1;
    const barW = Math.max(1, (w - gap * (numBars - 1)) / numBars);

    // Clear
    ctx.clearRect(0, 0, w, h);

    // Update peaks (fast rise, slow fall)
    const peaks = peaksRef.current;
    for (let i = 0; i < numBars; i++) {
      if (data[i] >= peaks[i]) {
        peaks[i] = data[i];
      } else {
        peaks[i] *= 0.97; // slow decay
      }
    }

    // Draw bars
    for (let i = 0; i < numBars; i++) {
      const x = i * (barW + gap);
      const barH = data[i] * h * 0.9;
      const color = barColor(i, numBars);

      // Main bar
      ctx.fillStyle = color;
      ctx.fillRect(x, h - barH, barW, barH);

      // Subtle glow
      ctx.globalAlpha = 0.15;
      ctx.fillRect(x - 1, h - barH - 2, barW + 2, barH + 4);
      ctx.globalAlpha = 1;

      // Peak indicator
      const peakY = h - peaks[i] * h * 0.9;
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.8;
      ctx.fillRect(x, peakY - 2, barW, 2);
      ctx.globalAlpha = 1;
    }

    // Subtle reflection
    ctx.globalAlpha = 0.06;
    ctx.scale(1, -1);
    ctx.translate(0, -2 * h);
    for (let i = 0; i < numBars; i++) {
      const x = i * (barW + gap);
      const barH = data[i] * h * 0.3;
      ctx.fillStyle = barColor(i, numBars);
      ctx.fillRect(x, h - barH, barW, barH);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
  }, [data]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full"
      style={{ display: 'block' }}
    />
  );
}
