import { useState, useCallback, useEffect, useRef } from 'react';
import type { Palette, PaletteNode, Light } from '@lightbox/shared';
import { usePalettesStore } from '../stores/palettes';
import { useLightsStore } from '../stores/lights';
import { useDebugStore } from '../stores/debug';

// Convert HSV to hex color
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

interface Props {
  palette: Palette;
  size: number;
  lightPositions: Record<string, number>;
  isEditing?: boolean;
  onLightClick?: (lightId: string) => void;
  selectedLightId?: string | null;
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

// Convert normalized x,y (0-1, center at 0.5) to H/S
function normalizedToHs(x: number, y: number): { h: number; s: number } {
  const dx = x - 0.5;
  const dy = y - 0.5;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx) * 180 / Math.PI + 90;
  return {
    h: Math.round(((angle % 360) + 360) % 360),
    s: Math.round(Math.min(100, distance * 2 * 100)),
  };
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

// Find closest point on track (sample many points, return t value)
function findClosestPointOnTrack(
  palette: Palette,
  targetX: number,
  targetY: number,
  samples: number = 100
): number {
  let closestT = 0;
  let closestDist = Infinity;

  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const point = getPointOnPalette(palette, t);
    const dx = point.x - targetX;
    const dy = point.y - targetY;
    const dist = dx * dx + dy * dy;

    if (dist < closestDist) {
      closestDist = dist;
      closestT = t;
    }
  }

  return closestT;
}

export function PaletteTrack({ palette, size, lightPositions, isEditing, onLightClick, selectedLightId }: Props) {
  const [draggingNode, setDraggingNode] = useState<number | null>(null);
  const [draggingLight, setDraggingLight] = useState<string | null>(null);
  const didDragLightRef = useRef(false);
  const updateNodePosition = usePalettesStore((s) => s.updateNodePosition);
  const saveNodePositions = usePalettesStore((s) => s.saveNodePositions);
  const activePaletteId = usePalettesStore((s) => s.activePaletteId);
  const setLightTrackPosition = usePalettesStore((s) => s.setLightTrackPosition);
  const removeNodeFromActive = usePalettesStore((s) => s.removeNodeFromActive);
  const setLightState = useLightsStore((s) => s.setLightState);
  const startControlling = useLightsStore((s) => s.startControlling);
  const stopControlling = useLightsStore((s) => s.stopControlling);
  const lights = useLightsStore((s) => s.lights);
  const diagnostics = useDebugStore((s) => s.diagnostics);

  // Helper to check if a light is connected
  const isLightConnected = useCallback((light: Light) => {
    const diag = diagnostics.get(light.id);
    if (diag) {
      return diag.connected;
    }
    return light.reachable;
  }, [diagnostics]);

  const nodeRadius = 14;
  const pathD = generateTrackPath(palette, size);
  const strokeColor = isEditing ? 'rgba(251, 191, 36, 0.7)' : 'rgba(168, 85, 247, 0.7)';
  const nodeColor = isEditing ? '#fbbf24' : '#a855f7';

  // Can drag nodes if this is the active palette (not in editing mode for new palettes)
  const canDragNodes = palette.id === activePaletteId && !isEditing;

  // Double-click on a node to delete it (if more than 2 nodes)
  const handleNodeDoubleClick = useCallback((e: React.MouseEvent, index: number) => {
    if (!canDragNodes) return;
    if (palette.nodes.length <= 2) return; // Keep at least 2 nodes
    e.preventDefault();
    e.stopPropagation();
    removeNodeFromActive(index);
  }, [canDragNodes, palette.nodes.length, removeNodeFromActive]);

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

    // Update all lights to reflect new track shape
    // Create a temporary palette with the updated node position
    const updatedNodes = [...palette.nodes];
    updatedNodes[draggingNode] = { x, y };
    const updatedPalette = { ...palette, nodes: updatedNodes };

    for (const [lightId, position] of Object.entries(lightPositions)) {
      const point = getPointOnPalette(updatedPalette, position);
      const { h, s } = normalizedToHs(point.x, point.y);
      setLightState(lightId, { color: { h, s } }, 50);
    }
  }, [draggingNode, size, updateNodePosition, palette, lightPositions, setLightState]);

  const handleMouseUp = useCallback(() => {
    if (draggingNode !== null) {
      saveNodePositions();
      setDraggingNode(null);
    }
  }, [draggingNode, saveNodePositions]);

  // Light pin drag handlers
  const handleLightMouseDown = useCallback((e: React.MouseEvent, lightId: string) => {
    if (!canDragNodes) return;
    e.preventDefault();
    e.stopPropagation();
    setDraggingLight(lightId);
    startControlling(lightId);
    didDragLightRef.current = false;
  }, [canDragNodes, startControlling]);

  const handleLightMouseMove = useCallback((e: MouseEvent) => {
    if (!draggingLight) return;

    didDragLightRef.current = true;

    const container = document.querySelector('[data-palette-track]');
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const x = (e.clientX - rect.left) / size; // normalized 0-1
    const y = (e.clientY - rect.top) / size;

    // Find closest point on the track
    const closestT = findClosestPointOnTrack(palette, x, y);

    // Update light position on track
    setLightTrackPosition(draggingLight, closestT);

    // Update light color to match track position
    const point = getPointOnPalette(palette, closestT);
    const { h, s } = normalizedToHs(point.x, point.y);
    setLightState(draggingLight, { color: { h, s } }, 50);
  }, [draggingLight, size, palette, setLightTrackPosition, setLightState]);

  const handleLightMouseUp = useCallback(() => {
    if (draggingLight) {
      stopControlling(draggingLight);
      setDraggingLight(null);
    }
  }, [draggingLight, stopControlling]);

  // Global mouse events for node dragging
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

  // Global mouse events for light dragging
  useEffect(() => {
    if (draggingLight !== null) {
      window.addEventListener('mousemove', handleLightMouseMove);
      window.addEventListener('mouseup', handleLightMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleLightMouseMove);
        window.removeEventListener('mouseup', handleLightMouseUp);
      };
    }
  }, [draggingLight, handleLightMouseMove, handleLightMouseUp]);

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
              onDoubleClick={(e) => handleNodeDoubleClick(e, i)}
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

        {/* Light positions on track - styled pins with colors and labels */}
        {Object.entries(lightPositions).map(([lightId, position]) => {
          const light = lights.get(lightId);
          if (!light) return null;

          // Skip unreachable/offline lights
          if (!isLightConnected(light)) return null;

          const point = getPointOnPalette(palette, position);
          const { x, y } = toCanvasCoords(point, size);
          const color = light.state.color ?? { h: 0, s: 0 };
          const pinColor = hsvToHex(color.h, color.s);
          const isSelected = selectedLightId === lightId;
          const isDragging = draggingLight === lightId;
          const pinRadius = 16;

          return (
            <g
              key={lightId}
              style={{
                cursor: canDragNodes ? 'grab' : (onLightClick ? 'pointer' : 'default'),
              }}
              onMouseDown={(e) => handleLightMouseDown(e, lightId)}
              onClick={(e) => {
                // Only handle click if we didn't drag (prevents toggle on drag release)
                if (onLightClick && !didDragLightRef.current) {
                  e.stopPropagation();
                  onLightClick(lightId);
                }
              }}
            >
              {/* Larger hit area */}
              <circle
                cx={x}
                cy={y}
                r={pinRadius + 4}
                fill="transparent"
                style={{ pointerEvents: canDragNodes || onLightClick ? 'auto' : 'none' }}
              />
              {/* Colored pin circle */}
              <circle
                cx={x}
                cy={y}
                r={pinRadius}
                fill={pinColor}
                stroke="white"
                strokeWidth={isSelected ? 5 : 3}
                style={{
                  pointerEvents: 'none',
                  filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.3))',
                }}
              />
              {/* Label - shown when not dragging */}
              {!isDragging && (
                <text
                  x={x}
                  y={y - pinRadius - 6}
                  textAnchor="middle"
                  fill="white"
                  fontSize="10"
                  className="select-none"
                  style={{
                    pointerEvents: 'none',
                    textShadow: '0 1px 2px rgba(0,0,0,0.5), 0 0 6px rgba(0,0,0,0.3)',
                  }}
                >
                  {light.name}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
