import { useRef, useEffect } from 'react';

interface Props {
  min: number[];
  max: number[];
}

/**
 * Oscilloscope-style waveform. Renders min/max pairs per x position so we get
 * the actual envelope shape instead of aliased point-samples. Auto-normalizes
 * amplitude so the waveform always uses most of the canvas regardless of how
 * quiet the audio actually is (music rarely exceeds ±0.3).
 */
export function Waveform({ min, max }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peakRef = useRef(0.1);

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
    const mid = h / 2;

    ctx.clearRect(0, 0, w, h);

    // Center line
    ctx.strokeStyle = 'rgba(113, 113, 122, 0.2)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();

    const n = Math.min(min.length, max.length);
    if (n === 0) return;

    // Track peak amplitude with fast attack, slow decay — auto-gain
    let curPeak = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.max(Math.abs(min[i]), Math.abs(max[i]));
      if (a > curPeak) curPeak = a;
    }
    peakRef.current = Math.max(curPeak, peakRef.current * 0.98);
    peakRef.current = Math.max(peakRef.current, 0.02);   // floor so silence doesn't look huge
    const amp = (mid * 0.95) / peakRef.current;

    const barW = w / n;

    // Glow layer
    ctx.fillStyle = 'rgba(34, 211, 238, 0.18)';
    for (let i = 0; i < n; i++) {
      const x = i * barW;
      const yTop = mid + max[i] * amp;
      const yBot = mid + min[i] * amp;
      const barH = Math.max(1, Math.abs(yBot - yTop)) + 4;
      ctx.fillRect(x - 1, Math.min(yTop, yBot) - 2, Math.max(1, barW + 1), barH);
    }

    // Solid bars on top
    ctx.fillStyle = 'rgb(34, 211, 238)';
    for (let i = 0; i < n; i++) {
      const x = i * barW;
      const yTop = mid + max[i] * amp;
      const yBot = mid + min[i] * amp;
      const barH = Math.max(1, Math.abs(yBot - yTop));
      ctx.fillRect(x, Math.min(yTop, yBot), Math.max(0.5, barW - 0.5), barH);
    }
  }, [min, max]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full"
      style={{ display: 'block' }}
    />
  );
}
