import { useRef, useEffect } from 'react';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Hue per pitch class (color wheel mapped to circle of fifths)
const NOTE_HUES = [0, 210, 30, 240, 60, 90, 270, 120, 300, 150, 330, 180];

interface Props {
  data: number[];      // 12 pitch classes 0-1
  centroid: number;    // spectral centroid in Hz
}

export function Chroma({ data, centroid }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

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
    const cx = w / 2;
    const cy = h / 2 - 4;
    const r = Math.min(cx, cy) - 20;

    ctx.clearRect(0, 0, w, h);

    // Draw 12 pitch class wedges in a circle
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2 - Math.PI / 2;
      const nextAngle = ((i + 1) / 12) * Math.PI * 2 - Math.PI / 2;
      const val = data[i] || 0;
      const hue = NOTE_HUES[i];

      // Wedge
      const innerR = r * 0.35;
      const outerR = innerR + (r - innerR) * val;

      ctx.beginPath();
      ctx.arc(cx, cy, outerR, angle, nextAngle);
      ctx.arc(cx, cy, innerR, nextAngle, angle, true);
      ctx.closePath();
      ctx.fillStyle = `hsla(${hue}, 70%, ${45 + val * 25}%, ${0.3 + val * 0.7})`;
      ctx.fill();

      // Note label
      const labelR = r + 10;
      const midAngle = (angle + nextAngle) / 2;
      const lx = cx + Math.cos(midAngle) * labelR;
      const ly = cy + Math.sin(midAngle) * labelR;
      ctx.fillStyle = val > 0.4 ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.3)';
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(NOTE_NAMES[i], lx, ly);
    }

    // Center: spectral centroid
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const centroidKhz = centroid >= 1000
      ? `${(centroid / 1000).toFixed(1)}k`
      : `${Math.round(centroid)}`;
    ctx.fillText(centroidKhz + 'Hz', cx, cy);

  }, [data, centroid]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full"
      style={{ display: 'block' }}
    />
  );
}
