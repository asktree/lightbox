import { useRef, useEffect, useState, useCallback } from 'react';
import type { Palette, PaletteNode } from '@lightbox/shared';

interface Props {
  palette: Palette;
  position: number; // 0-1
  onChange: (position: number) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  size?: number;
}

// Catmull-Rom spline interpolation with tension
function catmullRom(
  p0: PaletteNode,
  p1: PaletteNode,
  p2: PaletteNode,
  p3: PaletteNode,
  t: number,
  tension: number
): PaletteNode {
  const s = tension;
  const linearX = p1.x + t * (p2.x - p1.x);
  const linearY = p1.y + t * (p2.y - p1.y);
  const t2 = t * t;
  const t3 = t2 * t;
  const crX =
    0.5 *
    ((2 * p1.x) +
      (-p0.x + p2.x) * t +
      (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
      (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
  const crY =
    0.5 *
    ((2 * p1.y) +
      (-p0.y + p2.y) * t +
      (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
      (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);

  return {
    x: linearX * (1 - s) + crX * s,
    y: linearY * (1 - s) + crY * s,
  };
}

function getPointOnPalette(palette: Palette, t: number): PaletteNode {
  const nodes = palette.nodes;
  if (nodes.length === 0) return { x: 0.5, y: 0.5 };
  if (nodes.length === 1) return nodes[0];

  const n = nodes.length;
  const totalT = t * n;
  const segment = Math.floor(totalT) % n;
  const localT = totalT - Math.floor(totalT);

  const p0 = nodes[(segment - 1 + n) % n];
  const p1 = nodes[segment];
  const p2 = nodes[(segment + 1) % n];
  const p3 = nodes[(segment + 2) % n];

  return catmullRom(p0, p1, p2, p3, localT, palette.tension);
}

// Convert palette position to HSV color
function positionToColor(point: PaletteNode): { h: number; s: number } {
  const dx = point.x - 0.5;
  const dy = point.y - 0.5;
  const distance = Math.sqrt(dx * dx + dy * dy) * 2;
  const angle = Math.atan2(dy, dx) * 180 / Math.PI + 90;

  return {
    h: ((angle % 360) + 360) % 360,
    s: Math.min(100, distance * 100),
  };
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

export function PaletteWheel({ palette, position, onChange, onDragStart, onDragEnd, size = 160 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const radius = size / 2;
  const trackWidth = 20;
  const handleRadius = 12;

  // Draw the palette gradient ring
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d')!;
    const centerX = radius;
    const centerY = radius;

    ctx.clearRect(0, 0, size, size);

    // Draw gradient ring by sampling palette colors
    const segments = 360;
    for (let i = 0; i < segments; i++) {
      const t = i / segments;
      const point = getPointOnPalette(palette, t);
      const { h, s } = positionToColor(point);
      const color = hsvToHex(h, s);

      // Angle on the wheel (0 = top, clockwise)
      const angle = (t * 360 - 90) * Math.PI / 180;

      ctx.beginPath();
      ctx.arc(
        centerX,
        centerY,
        radius - trackWidth / 2,
        angle,
        angle + (Math.PI * 2 / segments) + 0.01,
        false
      );
      ctx.strokeStyle = color;
      ctx.lineWidth = trackWidth;
      ctx.stroke();
    }

    // Draw inner dark circle for contrast
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius - trackWidth - 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(24, 24, 27, 0.95)';
    ctx.fill();
  }, [palette, size, radius, trackWidth]);

  // Convert position (0-1) to angle
  const positionToAngle = (pos: number) => pos * 360 - 90;

  // Convert angle to position
  const angleToPosition = (angleDeg: number) => {
    const normalized = (angleDeg + 90) / 360;
    return ((normalized % 1) + 1) % 1;
  };

  // Get handle position
  const handleAngle = positionToAngle(position) * Math.PI / 180;
  const handleX = radius + (radius - trackWidth / 2) * Math.cos(handleAngle);
  const handleY = radius + (radius - trackWidth / 2) * Math.sin(handleAngle);

  // Current color
  const currentPoint = getPointOnPalette(palette, position);
  const currentColor = positionToColor(currentPoint);
  const currentHex = hsvToHex(currentColor.h, currentColor.s);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
    onDragStart?.();
  }, [onDragStart]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging || !containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left - radius;
    const y = e.clientY - rect.top - radius;

    const angle = Math.atan2(y, x) * 180 / Math.PI;
    const newPosition = angleToPosition(angle);
    onChange(newPosition);
  }, [isDragging, radius, onChange]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    onDragEnd?.();
  }, [onDragEnd]);

  // Global mouse events
  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp]);

  // Handle click on ring to jump to position
  const handleRingClick = useCallback((e: React.MouseEvent) => {
    if (!containerRef.current) return;
    e.stopPropagation();

    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left - radius;
    const y = e.clientY - rect.top - radius;

    const distance = Math.sqrt(x * x + y * y);
    // Only respond if click is on the ring
    if (distance > radius - trackWidth - 10 && distance < radius + 10) {
      const angle = Math.atan2(y, x) * 180 / Math.PI;
      const newPosition = angleToPosition(angle);
      onChange(newPosition);
    }
  }, [radius, trackWidth, onChange]);

  return (
    <div className="flex flex-col items-center">
      <div
        ref={containerRef}
        className="relative"
        style={{ width: size, height: size }}
        onClick={handleRingClick}
      >
        {/* Gradient ring */}
        <canvas
          ref={canvasRef}
          width={size}
          height={size}
          className="absolute inset-0"
        />

        {/* Center info */}
        <div
          className="absolute flex flex-col items-center justify-center"
          style={{
            left: trackWidth + 4,
            top: trackWidth + 4,
            right: trackWidth + 4,
            bottom: trackWidth + 4,
          }}
        >
          <div
            className="w-10 h-10 rounded-full border-3 border-white shadow-lg"
            style={{ backgroundColor: currentHex }}
          />
          <div className="text-xs text-zinc-400 mt-1">
            {Math.round(position * 100)}%
          </div>
        </div>

        {/* Handle */}
        <div
          className="absolute cursor-grab active:cursor-grabbing"
          style={{
            left: handleX - handleRadius,
            top: handleY - handleRadius,
            width: handleRadius * 2,
            height: handleRadius * 2,
          }}
          onMouseDown={handleMouseDown}
        >
          <div
            className="w-full h-full rounded-full border-3 border-white shadow-lg"
            style={{
              backgroundColor: currentHex,
              boxShadow: isDragging
                ? `0 0 16px ${currentHex}, 0 4px 12px rgba(0,0,0,0.4)`
                : '0 2px 8px rgba(0,0,0,0.3)',
            }}
          />
        </div>

        {/* Node markers on the ring */}
        {palette.nodes.map((_, i) => {
          const nodePos = i / palette.nodes.length;
          const nodeAngle = positionToAngle(nodePos) * Math.PI / 180;
          const nodeX = radius + (radius - trackWidth / 2) * Math.cos(nodeAngle);
          const nodeY = radius + (radius - trackWidth / 2) * Math.sin(nodeAngle);
          return (
            <div
              key={i}
              className="absolute w-1.5 h-1.5 bg-white/80 rounded-full"
              style={{
                left: nodeX - 3,
                top: nodeY - 3,
                pointerEvents: 'none',
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
