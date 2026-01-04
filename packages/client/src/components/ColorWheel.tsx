import { useRef, useEffect, useState, useCallback } from 'react';
import type { Light } from '@lightbox/shared';
import { useLightsStore } from '../stores/lights';

interface Props {
  lights: Light[];
  size?: number;
}

function hsvToHex(h: number, s: number, v: number = 100): string {
  h = h / 360;
  s = s / 100;
  v = v / 100;

  let r = 0, g = 0, b = 0;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);

  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }

  const toHex = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function ColorWheel({ lights, size = 300 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const setLightState = useLightsStore((s) => s.setLightState);

  const radius = size / 2;
  const pinRadius = 16;

  // Draw the color wheel
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d')!;
    const centerX = radius;
    const centerY = radius;

    // Clear
    ctx.clearRect(0, 0, size, size);

    // Draw color wheel using conic gradient simulation
    for (let angle = 0; angle < 360; angle++) {
      for (let r = 0; r < radius; r++) {
        const saturation = (r / radius) * 100;
        const color = hsvToHex(angle, saturation);

        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(
          centerX + r * Math.cos((angle - 90) * Math.PI / 180),
          centerY + r * Math.sin((angle - 90) * Math.PI / 180),
          2,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
    }

    // Add white center fade
    const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius * 0.15);
    gradient.addColorStop(0, 'rgba(255,255,255,0.8)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius * 0.15, 0, Math.PI * 2);
    ctx.fill();
  }, [size, radius]);

  // Convert H/S to x/y position
  const hsToPosition = useCallback((h: number, s: number) => {
    const angle = (h - 90) * Math.PI / 180; // -90 to start at top
    const distance = (s / 100) * (radius - pinRadius);
    return {
      x: radius + distance * Math.cos(angle),
      y: radius + distance * Math.sin(angle),
    };
  }, [radius]);

  // Convert x/y to H/S
  const positionToHs = useCallback((x: number, y: number) => {
    const dx = x - radius;
    const dy = y - radius;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx) * 180 / Math.PI + 90;

    return {
      h: ((angle % 360) + 360) % 360,
      s: Math.min(100, (distance / (radius - pinRadius)) * 100),
    };
  }, [radius]);

  // Handle drag
  const handleMouseMove = useCallback((e: React.MouseEvent | MouseEvent) => {
    if (!dragging || !containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const { h, s } = positionToHs(x, y);
    setLightState(dragging, { color: { h: Math.round(h), s: Math.round(s) } });
  }, [dragging, positionToHs, setLightState]);

  const handleMouseUp = useCallback(() => {
    setDragging(null);
  }, []);

  // Global mouse events for dragging
  useEffect(() => {
    if (dragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [dragging, handleMouseMove, handleMouseUp]);

  // Filter to only color-capable, on lights
  const colorLights = lights.filter(
    (l) => l.capabilities.includes('color') && l.state.on && l.reachable
  );

  return (
    <div
      ref={containerRef}
      className="relative select-none"
      style={{ width: size, height: size }}
    >
      {/* Color wheel canvas */}
      <canvas
        ref={canvasRef}
        width={size}
        height={size}
        className="rounded-full"
      />

      {/* Light pins */}
      {colorLights.map((light) => {
        const color = light.state.color ?? { h: 0, s: 0 };
        const pos = hsToPosition(color.h, color.s);
        const pinColor = hsvToHex(color.h, color.s);

        return (
          <div
            key={light.id}
            onMouseDown={(e) => {
              e.preventDefault();
              setDragging(light.id);
            }}
            className={`absolute flex items-center justify-center cursor-grab active:cursor-grabbing transition-shadow ${
              dragging === light.id ? 'z-20' : 'z-10'
            }`}
            style={{
              left: pos.x - pinRadius,
              top: pos.y - pinRadius,
              width: pinRadius * 2,
              height: pinRadius * 2,
            }}
          >
            {/* Pin */}
            <div
              className="w-full h-full rounded-full border-4 border-white shadow-lg"
              style={{
                backgroundColor: pinColor,
                boxShadow: dragging === light.id
                  ? `0 0 20px ${pinColor}, 0 4px 12px rgba(0,0,0,0.4)`
                  : `0 2px 8px rgba(0,0,0,0.3)`,
              }}
            />
            {/* Label on hover */}
            <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 text-xs text-white bg-black/70 px-2 py-0.5 rounded opacity-0 hover:opacity-100 whitespace-nowrap pointer-events-none">
              {light.name}
            </div>
          </div>
        );
      })}

      {colorLights.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-zinc-500 text-sm">
          No color lights on
        </div>
      )}
    </div>
  );
}
