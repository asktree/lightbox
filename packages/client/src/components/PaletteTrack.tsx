import { useState, useCallback, useEffect } from 'react';
import type { Palette, PaletteNode } from '@lightbox/shared';
import { usePalettesStore } from '../stores/palettes';

interface Props {
  palette: Palette;
  size: number;
  lightPositions: Record<string, number>;
  isEditing?: boolean;
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

  // Linear interpolation
  const linearX = p1.x + t * (p2.x - p1.x);
  const linearY = p1.y + t * (p2.y - p1.y);

  // Catmull-Rom interpolation
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

// Get point on track at position t (0-1)
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

// Convert normalized (0-1) coords to canvas coords
function toCanvasCoords(node: PaletteNode, size: number): { x: number; y: number } {
  return {
    x: node.x * size,
    y: node.y * size,
  };
}

// Generate SVG path for the track
function generateTrackPath(palette: Palette, size: number): string {
  if (palette.nodes.length < 2) return '';

  const points: string[] = [];
  const steps = palette.nodes.length * 20;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const point = getPointOnPalette(palette, t);
    const { x, y } = toCanvasCoords(point, size);
    points.push(`${i === 0 ? 'M' : 'L'} ${x} ${y}`);
  }

  return points.join(' ') + ' Z';
}

export function PaletteTrack({ palette, size, lightPositions, isEditing }: Props) {
  const [draggingNode, setDraggingNode] = useState<number | null>(null);
  const updateNodePosition = usePalettesStore((s) => s.updateNodePosition);
  const saveNodePositions = usePalettesStore((s) => s.saveNodePositions);
  const activePaletteId = usePalettesStore((s) => s.activePaletteId);

  const nodeRadius = 8;
  const pathD = generateTrackPath(palette, size);
  const strokeColor = isEditing ? 'rgba(251, 191, 36, 0.7)' : 'rgba(168, 85, 247, 0.7)';
  const nodeColor = isEditing ? '#fbbf24' : '#a855f7';

  // Can drag nodes if this is the active palette (not in editing mode for new palettes)
  const canDragNodes = palette.id === activePaletteId && !isEditing;

  const handleMouseDown = useCallback((e: React.MouseEvent, index: number) => {
    if (!canDragNodes) return;
    e.preventDefault();
    e.stopPropagation();
    setDraggingNode(index);
  }, [canDragNodes]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (draggingNode === null) return;

    // Get the track container's position
    const container = document.querySelector('[data-palette-track]');
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / size));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / size));

    updateNodePosition(draggingNode, x, y);
  }, [draggingNode, size, updateNodePosition]);

  const handleMouseUp = useCallback(() => {
    if (draggingNode !== null) {
      saveNodePositions();
      setDraggingNode(null);
    }
  }, [draggingNode, saveNodePositions]);

  // Global mouse events for dragging
  useEffect(() => {
    if (draggingNode !== null) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [draggingNode, handleMouseMove, handleMouseUp]);

  return (
    <div
      data-palette-track
      className="absolute inset-0"
      style={{ width: size, height: size, pointerEvents: canDragNodes ? 'auto' : 'none' }}
    >
      <svg width={size} height={size} className="absolute inset-0">
        {/* Track path */}
        {pathD && (
          <path
            d={pathD}
            fill="none"
            stroke={strokeColor}
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ pointerEvents: 'none' }}
          />
        )}

        {/* Control nodes */}
        {palette.nodes.map((node, i) => {
          const { x, y } = toCanvasCoords(node, size);
          const isDragging = draggingNode === i;
          return (
            <g
              key={i}
              style={{ cursor: canDragNodes ? 'grab' : 'default' }}
              onMouseDown={(e) => handleMouseDown(e, i)}
            >
              <circle
                cx={x}
                cy={y}
                r={nodeRadius + 4}
                fill="transparent"
                style={{ pointerEvents: canDragNodes ? 'auto' : 'none' }}
              />
              <circle
                cx={x}
                cy={y}
                r={nodeRadius + 2}
                fill={`${nodeColor}33`}
                style={{ pointerEvents: 'none' }}
              />
              <circle
                cx={x}
                cy={y}
                r={nodeRadius}
                fill={nodeColor}
                stroke="white"
                strokeWidth={isDragging ? 3 : 2}
                style={{ pointerEvents: 'none' }}
              />
              <text
                x={x}
                y={y + 1}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="white"
                fontSize="10"
                fontWeight="bold"
                className="select-none"
                style={{ pointerEvents: 'none' }}
              >
                {i + 1}
              </text>
            </g>
          );
        })}

        {/* Light positions on track */}
        {Object.entries(lightPositions).map(([lightId, position]) => {
          const point = getPointOnPalette(palette, position);
          const { x, y } = toCanvasCoords(point, size);
          return (
            <circle
              key={lightId}
              cx={x}
              cy={y}
              r={6}
              fill="rgba(255, 255, 255, 0.9)"
              stroke="rgba(255, 255, 255, 0.5)"
              strokeWidth="2"
              style={{ pointerEvents: 'none' }}
            />
          );
        })}
      </svg>
    </div>
  );
}
