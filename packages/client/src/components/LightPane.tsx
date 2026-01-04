import { useCallback } from 'react';
import type { Light, Palette, PaletteNode } from '@lightbox/shared';
import { usePalettesStore } from '../stores/palettes';
import { useLightsStore } from '../stores/lights';
import { PaletteWheel } from './PaletteWheel';

// Catmull-Rom spline interpolation
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
    0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t +
      (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
      (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
  const crY =
    0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t +
      (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
      (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);

  return {
    x: linearX * (1 - s) + crX * s,
    y: linearY * (1 - s) + crY * s,
  };
}

// Get point on palette at position t (0-1)
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

interface LightPaneProps {
  light: Light;
  onClose: () => void;
}

export function LightPane({ light, onClose }: LightPaneProps) {
  const activePaletteId = usePalettesStore((s) => s.activePaletteId);
  const palettes = usePalettesStore((s) => s.palettes);
  const lightPositions = usePalettesStore((s) => s.lightPositions);
  const setLightTrackPosition = usePalettesStore((s) => s.setLightTrackPosition);
  const setLightState = useLightsStore((s) => s.setLightState);

  const activePalette = palettes.find((p) => p.id === activePaletteId);
  const lightPosition = lightPositions[light.id] ?? 0;

  // Handle light position change on palette - update store AND send color to light
  const handlePositionChange = useCallback((pos: number) => {
    if (!activePalette) return;

    // Update position in store
    setLightTrackPosition(light.id, pos);

    // Calculate color at this position and send to light with smooth transition
    const point = getPointOnPalette(activePalette, pos);
    const { h, s } = normalizedToHs(point.x, point.y);
    setLightState(light.id, { color: { h, s } }, 50);
  }, [light.id, activePalette, setLightTrackPosition, setLightState]);

  // Handle brightness change
  const handleBrightnessChange = useCallback((brightness: number) => {
    setLightState(light.id, { brightness }, 50);
  }, [light.id, setLightState]);

  const brightness = light.state.brightness ?? 100;

  return (
    <div className="fixed top-20 right-4 bg-zinc-900/95 backdrop-blur border border-zinc-700 rounded-lg shadow-xl p-4 min-w-[200px]">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-zinc-300">{light.name}</h3>
        <button
          onClick={onClose}
          className="text-zinc-500 hover:text-white transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex gap-4 items-start">
        {/* Brightness slider (vertical) */}
        <div className="flex flex-col items-center">
          <div
            className="relative w-3 rounded-full overflow-hidden cursor-pointer"
            style={{ height: 120 }}
            onMouseDown={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const updateBrightness = (clientY: number) => {
                const y = clientY - rect.top;
                const pct = Math.round(Math.max(0, Math.min(100, (1 - y / rect.height) * 100)));
                handleBrightnessChange(pct);
              };
              updateBrightness(e.clientY);

              const onMove = (ev: MouseEvent) => updateBrightness(ev.clientY);
              const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
              };
              window.addEventListener('mousemove', onMove);
              window.addEventListener('mouseup', onUp);
            }}
          >
            {/* Track background */}
            <div
              className="absolute inset-0"
              style={{
                background: 'linear-gradient(to top, #27272a 0%, #3f3f46 100%)',
              }}
            />
            {/* Fill */}
            <div
              className="absolute bottom-0 left-0 right-0 transition-all duration-100"
              style={{
                height: `${brightness}%`,
                background: `linear-gradient(to top, #d4d4d8 0%, #fafafa 100%)`,
                boxShadow: brightness > 10 ? `0 -4px 12px rgba(255, 255, 255, ${brightness / 200})` : 'none',
              }}
            />
          </div>
          <span className="text-xs text-zinc-400 mt-2 w-8 text-center">{brightness}%</span>
        </div>

        {/* Palette wheel - only when palette is active */}
        {activePalette && (
          <PaletteWheel
            palette={activePalette}
            position={lightPosition}
            onChange={handlePositionChange}
            size={120}
          />
        )}
      </div>
    </div>
  );
}
