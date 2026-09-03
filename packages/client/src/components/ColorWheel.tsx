import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { motion } from 'framer-motion';
import type { Light } from '@lightbox/shared';
import { findClosestPointOnTrack } from '@lightbox/shared';
import { useLightsStore } from '../stores/lights';
import { usePalettesStore, useRoomPlayState, useRoomPositions } from '../stores/palettes';
import { useDebugStore } from '../stores/debug';
import { PaletteTrack } from './PaletteTrack';
import { xToKelvin } from './KelvinBar';

interface Props {
  lights: Light[];
  size?: number;
  selectedLightId?: string | null;
  onLightSelect?: (lightId: string | null) => void;
  roomId: string; // Current room for palette state
  // Render a faded ghost track for this palette on top of the wheel, with
  // each light snapped to its closest point on that palette's path. Used
  // by PaletteControls hover-preview. Ignored when equal to the active
  // palette (would just double-draw the same path).
  previewPaletteId?: string | null;
  // Kelvin bar container: dragging a temperature-capable pin inside its
  // rect switches the light to CT mode (the bar handles the reverse).
  kelvinBarRef?: React.RefObject<HTMLDivElement | null>;
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

export function ColorWheel({ lights, size = 300, selectedLightId, onLightSelect, roomId, previewPaletteId, kelvinBarRef }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const setLightState = useLightsStore((s) => s.setLightState);
  const startControlling = useLightsStore((s) => s.startControlling);
  const stopControlling = useLightsStore((s) => s.stopControlling);

  const palettes = usePalettesStore((s) => s.palettes);
  const isEditing = usePalettesStore((s) => s.isEditing);
  const editingNodes = usePalettesStore((s) => s.editingNodes);
  const addNode = usePalettesStore((s) => s.addNode);
  const addNodeToActive = usePalettesStore((s) => s.addNodeToActive);
  const editPaletteMode = usePalettesStore((s) => s.editPaletteMode);

  const diagnostics = useDebugStore((s) => s.diagnostics);

  // Get room-specific palette state - split for efficiency
  const { activePaletteId } = useRoomPlayState(roomId);
  const lightPositions = useRoomPositions(roomId);

  const activePalette = palettes.find((p) => p.id === activePaletteId);

  // Helper to check if a light is connected (using diagnostics or reachable)
  const isLightConnected = useCallback((light: Light) => {
    const diag = diagnostics[light.id];
    // Use diagnostics if available, otherwise fall back to light.reachable
    if (diag) {
      return diag.connected;
    }
    return light.reachable;
  }, [diagnostics]);

  const radius = size / 2;
  const pinRadius = 16;

  // Preview palette: ignore if it's the active one (avoid double-render of
  // the same path) or below 2 nodes (track needs an interpolation segment).
  const previewPalette = useMemo(() => {
    if (!previewPaletteId || previewPaletteId === activePaletteId) return null;
    const p = palettes.find((p) => p.id === previewPaletteId);
    return p && p.nodes.length >= 2 ? p : null;
  }, [previewPaletteId, activePaletteId, palettes]);

  // Snap each light's current (h,s) to the nearest point on the preview
  // track. PaletteTrack expects normalized 0-1 xy in the SAME frame the
  // track was authored in (relative to the wheel canvas). hsToPosition
  // returns pixel xy on the wheel — divide by size to normalize.
  const previewLightPositions = useMemo(() => {
    if (!previewPalette) return {};
    const out: Record<string, number> = {};
    for (const light of lights) {
      if (!light.capabilities.includes('color') || !light.state.on) continue;
      const c = light.state.color;
      if (!c) continue;
      const angle = (c.h - 90) * Math.PI / 180;
      const distance = (c.s / 100) * radius;
      const nx = (radius + distance * Math.cos(angle)) / size;
      const ny = (radius + distance * Math.sin(angle)) / size;
      out[light.id] = findClosestPointOnTrack(previewPalette, nx, ny);
    }
    return out;
  }, [previewPalette, lights, radius, size]);

  // Draw color wheel pixel-by-pixel for perfectly smooth gradients
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d')!;
    const imageData = ctx.createImageData(size, size);
    const data = imageData.data;
    const centerX = radius;
    const centerY = radius;

    // HSV to RGB conversion (inline for performance)
    const hsvToRgb = (h: number, s: number, v: number): [number, number, number] => {
      h = h / 360;
      s = s / 100;
      v = v / 100;

      const i = Math.floor(h * 6);
      const f = h * 6 - i;
      const p = v * (1 - s);
      const q = v * (1 - f * s);
      const t = v * (1 - (1 - f) * s);

      let r = 0, g = 0, b = 0;
      switch (i % 6) {
        case 0: r = v; g = t; b = p; break;
        case 1: r = q; g = v; b = p; break;
        case 2: r = p; g = v; b = t; break;
        case 3: r = p; g = q; b = v; break;
        case 4: r = t; g = p; b = v; break;
        case 5: r = v; g = p; b = q; break;
      }
      return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
    };

    // Iterate over every pixel
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - centerX;
        const dy = y - centerY;
        const distance = Math.sqrt(dx * dx + dy * dy);

        const idx = (y * size + x) * 4;

        if (distance <= radius) {
          // Calculate hue from angle (0 at top, clockwise)
          let angle = Math.atan2(dy, dx) * 180 / Math.PI + 90;
          if (angle < 0) angle += 360;

          // Saturation from distance (0 at center, 100 at edge)
          const saturation = (distance / radius) * 100;

          const [r, g, b] = hsvToRgb(angle, saturation, 100);
          data[idx] = r;
          data[idx + 1] = g;
          data[idx + 2] = b;
          data[idx + 3] = 255;
        } else {
          // Outside circle - transparent
          data[idx + 3] = 0;
        }
      }
    }

    ctx.putImageData(imageData, 0, 0);

    // Soft white center overlay
    const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius * 0.12);
    gradient.addColorStop(0, 'rgba(255,255,255,0.7)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius * 0.12, 0, Math.PI * 2);
    ctx.fill();
  }, [size, radius]);

  // Convert H/S to x/y position
  const hsToPosition = useCallback((h: number, s: number) => {
    const angle = (h - 90) * Math.PI / 180;
    const distance = (s / 100) * radius;
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
      s: Math.min(100, (distance / radius) * 100),
    };
  }, [radius]);

  // Handle wheel click for adding nodes in edit mode
  const handleWheelClick = useCallback((e: React.MouseEvent) => {
    if (!isEditing) return;
    if (!containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / size;
    const y = (e.clientY - rect.top) / size;

    addNode(x, y);
  }, [isEditing, size, addNode]);

  // Handle double-click on wheel to add node to active palette (only when editPaletteMode is on)
  const handleWheelDoubleClick = useCallback((e: React.MouseEvent) => {
    if (!activePalette || isEditing || !editPaletteMode) return;
    if (!containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / size;
    const y = (e.clientY - rect.top) / size;

    addNodeToActive(activePalette.id, x, y);
  }, [activePalette, isEditing, editPaletteMode, size, addNodeToActive]);

  // Handle drag (only used when no palette is active)
  const handleMouseMove = useCallback((e: React.MouseEvent | MouseEvent) => {
    if (!dragging || !containerRef.current) return;

    // Dragged into the kelvin bar → switch to CT mode (temperature-capable
    // lights only; the bar hands the light back when dragged into the wheel).
    const bar = kelvinBarRef?.current;
    if (bar) {
      const br = bar.getBoundingClientRect();
      const light = lights.find((l) => l.id === dragging);
      if (
        light?.capabilities.includes('temperature') &&
        e.clientX >= br.left && e.clientX <= br.right &&
        e.clientY >= br.top && e.clientY <= br.bottom
      ) {
        setLightState(dragging, { temperature: xToKelvin(e.clientX, br) }, 50);
        return;
      }
    }

    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const { h, s } = positionToHs(x, y);
    setLightState(dragging, { color: { h: Math.round(h), s: Math.round(s) } }, 50);
  }, [dragging, positionToHs, setLightState, lights, kelvinBarRef]);

  const handleMouseUp = useCallback(() => {
    if (dragging) {
      stopControlling(dragging);
      setDragging(null);
    }
  }, [dragging, stopControlling]);

  const handleMouseDown = useCallback((lightId: string) => {
    startControlling(lightId);
    setDragging(lightId);
  }, [startControlling]);

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

  // Handle clicking on a light on the palette track
  const handleLightClick = useCallback((lightId: string) => {
    if (onLightSelect) {
      // Toggle: if already selected, deselect
      onLightSelect(selectedLightId === lightId ? null : lightId);
    }
  }, [onLightSelect, selectedLightId]);

  // Filter to only color-capable, on lights (include disconnected to show
  // faded). Lights currently in CT mode live on the kelvin bar, not here.
  const colorLights = lights.filter(
    (l) => l.capabilities.includes('color') && l.state.on && l.state.temperature === undefined
  );

  // When palette is active, don't show individual light pins (they're on the track)
  const showLightPins = !activePalette;

  return (
    <div
      ref={containerRef}
      className={`relative select-none ${isEditing ? 'cursor-crosshair' : ''}`}
      style={{ width: size, height: size }}
      onClick={handleWheelClick}
      onDoubleClick={handleWheelDoubleClick}
    >
      {/* Color wheel canvas */}
      <canvas
        ref={canvasRef}
        width={size}
        height={size}
        className="rounded-full"
      />

      {/* Active palette track */}
      {activePalette && activePalette.nodes.length >= 2 && (
        <PaletteTrack
          palette={activePalette}
          size={size}
          lightPositions={lightPositions}
          roomId={roomId}
          onLightClick={handleLightClick}
          selectedLightId={selectedLightId}
          editPaletteMode={editPaletteMode}
        />
      )}

      {/* Hover preview track — ghosted path of a different palette with
          per-light positions snapped to where they'd land if it activated.
          Light positions: closest-point-on-track of each light's current
          (h,s) → normalized wheel xy. Cheap (~100 samples × N lights). */}
      {previewPalette && (
        <PaletteTrack
          palette={previewPalette}
          size={size}
          lightPositions={previewLightPositions}
          isPreview
        />
      )}

      {/* Editing track preview */}
      {isEditing && editingNodes.length >= 1 && (
        <PaletteTrack
          palette={{
            id: 'editing',
            name: 'New',
            nodes: editingNodes,
            tension: 0.5,
            secondsPerNode: 2,
          }}
          size={size}
          lightPositions={{}}
          isEditing
        />
      )}

      {/* Light pins - only when no palette is active */}
      {showLightPins && colorLights.map((light) => {
        const color = light.state.color ?? { h: 0, s: 0 };
        const pos = hsToPosition(color.h, color.s);
        const pinColor = hsvToHex(color.h, color.s);
        const isDragging = dragging === light.id;

        return (
          <div key={light.id}>
            {/* Light pin */}
            <div
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleMouseDown(light.id);
                // Also select the light to open the pane
                if (onLightSelect) {
                  onLightSelect(light.id);
                }
              }}
              className={`absolute flex items-center justify-center cursor-grab active:cursor-grabbing ${
                isDragging ? 'z-20' : 'z-10'
              }`}
              style={{
                left: 0,
                top: 0,
                width: pinRadius * 2,
                height: pinRadius * 2,
                transform: `translate(${pos.x - pinRadius}px, ${pos.y - pinRadius}px)`,
                transition: isDragging ? 'none' : 'transform 100ms ease-out',
                opacity: isLightConnected(light) ? 1 : 0.5,
              }}
            >
              <motion.div
                className="w-full h-full rounded-full border-white"
                animate={{ borderWidth: selectedLightId === light.id ? 5 : 3 }}
                transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                style={{
                  backgroundColor: pinColor,
                  boxShadow: `0 2px 8px rgba(0,0,0,0.3)`,
                }}
              />
              {/* Label - hidden while dragging, higher z-index */}
              {!isDragging && (
                <div
                  className="absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] text-white whitespace-nowrap pointer-events-none z-30"
                  style={{ textShadow: '0 1px 2px rgba(0,0,0,0.5), 0 0 6px rgba(0,0,0,0.3)' }}
                >
                  {light.name}
                </div>
              )}
            </div>
          </div>
        );
      })}

      {colorLights.length === 0 && !isEditing && !activePalette && (
        <div className="absolute inset-0 flex items-center justify-center text-zinc-500 text-sm pointer-events-none">
          No color lights on
        </div>
      )}

      {isEditing && (
        <div className="absolute inset-0 flex items-center justify-center text-amber-400 text-sm pointer-events-none">
          Click to add points
        </div>
      )}
    </div>
  );
}
