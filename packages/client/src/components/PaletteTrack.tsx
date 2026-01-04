import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { Palette, PaletteNode, Light } from '@lightbox/shared';
import { getPointOnPalette, findClosestPointOnTrack, ROOMS } from '@lightbox/shared';
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
  roomId?: string; // Required for active palettes, not needed for editing preview
  isEditing?: boolean;
  onLightClick?: (lightId: string) => void;
  selectedLightId?: string | null;
}

// Convert normalized (0-1) coords to canvas coords
function toCanvasCoords(node: PaletteNode, size: number): { x: number; y: number } {
  return {
    x: node.x * size,
    y: node.y * size,
  };
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

export function PaletteTrack({ palette, size, lightPositions, roomId, isEditing, onLightClick, selectedLightId }: Props) {
  const [draggingNode, setDraggingNode] = useState<number | null>(null);
  const [draggingLight, setDraggingLight] = useState<string | null>(null);
  const didDragLightRef = useRef(false);
  const updateNodePosition = usePalettesStore((s) => s.updateNodePosition);
  const saveNodePositions = usePalettesStore((s) => s.saveNodePositions);
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

  // Can drag nodes if this is a real palette (not editing preview) and roomId is provided
  const canDragNodes = !isEditing && !!roomId;

  // Filter light positions to only include lights in this room
  const filteredLightPositions = useMemo(() => {
    if (!roomId) return lightPositions;
    const room = ROOMS[roomId];
    if (!room) return lightPositions;
    // If room has no specific lights (e.g. "all"), show all positions
    if (room.lightIds.length === 0) return lightPositions;
    // Filter to only lights in this room
    const roomLightSet = new Set(room.lightIds);
    return Object.fromEntries(
      Object.entries(lightPositions).filter(([lightId]) => roomLightSet.has(lightId))
    );
  }, [roomId, lightPositions]);

  // Double-click on a node to delete it (if more than 2 nodes)
  const handleNodeDoubleClick = useCallback((e: React.MouseEvent, index: number) => {
    if (!canDragNodes) return;
    if (palette.nodes.length <= 2) return; // Keep at least 2 nodes
    e.preventDefault();
    e.stopPropagation();
    removeNodeFromActive(palette.id, index);
  }, [canDragNodes, palette.nodes.length, palette.id, removeNodeFromActive]);

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

    updateNodePosition(palette.id, draggingNode, x, y);

    // Update all lights to reflect new track shape
    // Create a temporary palette with the updated node position
    const updatedNodes = [...palette.nodes];
    updatedNodes[draggingNode] = { x, y };
    const updatedPalette = { ...palette, nodes: updatedNodes };

    for (const [lightId, position] of Object.entries(filteredLightPositions)) {
      const point = getPointOnPalette(updatedPalette, position);
      const { h, s } = normalizedToHs(point.x, point.y);
      setLightState(lightId, { color: { h, s } }, 50);
    }
  }, [draggingNode, size, updateNodePosition, palette, filteredLightPositions, setLightState]);

  const handleMouseUp = useCallback(() => {
    if (draggingNode !== null) {
      saveNodePositions(palette.id);
      setDraggingNode(null);
    }
  }, [draggingNode, palette.id, saveNodePositions]);

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
    if (!draggingLight || !roomId) return;

    didDragLightRef.current = true;

    const container = document.querySelector('[data-palette-track]');
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const x = (e.clientX - rect.left) / size; // normalized 0-1
    const y = (e.clientY - rect.top) / size;

    // Find closest point on the track
    const closestT = findClosestPointOnTrack(palette, x, y);

    // Update light position on track (via server)
    setLightTrackPosition(roomId, draggingLight, closestT);

    // Update light color to match track position
    const point = getPointOnPalette(palette, closestT);
    const { h, s } = normalizedToHs(point.x, point.y);
    setLightState(draggingLight, { color: { h, s } }, 50);
  }, [draggingLight, roomId, size, palette, setLightTrackPosition, setLightState]);

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
        {Object.entries(filteredLightPositions).map(([lightId, position]) => {
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
                transform: `translate(${x}px, ${y}px)`,
                transition: isDragging ? 'none' : 'transform 100ms ease-out',
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
                cx={0}
                cy={0}
                r={pinRadius + 4}
                fill="transparent"
                style={{ pointerEvents: canDragNodes || onLightClick ? 'auto' : 'none' }}
              />
              {/* Colored pin circle */}
              <circle
                cx={0}
                cy={0}
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
                  x={0}
                  y={-pinRadius - 6}
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
