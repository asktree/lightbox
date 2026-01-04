import { useCallback } from 'react';
import type { Light } from '@lightbox/shared';
import { getPointOnPalette } from '@lightbox/shared';
import { usePalettesStore } from '../stores/palettes';
import { useLightsStore } from '../stores/lights';
import { useDebugStore } from '../stores/debug';
import { PaletteWheel } from './PaletteWheel';
import { DebugPanel } from './DebugPanel';

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
  roomId: string;
  onClose: () => void;
}

export function LightPane({ light, roomId, onClose }: LightPaneProps) {
  const palettes = usePalettesStore((s) => s.palettes);
  const getRoomState = usePalettesStore((s) => s.getRoomState);
  const setLightTrackPosition = usePalettesStore((s) => s.setLightTrackPosition);
  const setLightState = useLightsStore((s) => s.setLightState);
  const diagnostics = useDebugStore((s) => s.diagnostics);

  // Get room-specific state
  const roomState = getRoomState(roomId);
  const activePaletteId = roomState.activePaletteId;
  const lightPositions = roomState.positions;

  // Get diagnostic for this light
  const diag = diagnostics.get(light.id);

  const activePalette = palettes.find((p) => p.id === activePaletteId);
  const lightPosition = lightPositions[light.id] ?? 0;

  // Handle light position change on palette - update store AND send color to light
  const handlePositionChange = useCallback((pos: number) => {
    if (!activePalette) return;

    // Update position in store (via server)
    setLightTrackPosition(roomId, light.id, pos);

    // Calculate color at this position and send to light with smooth transition
    const point = getPointOnPalette(activePalette, pos);
    const { h, s } = normalizedToHs(point.x, point.y);
    setLightState(light.id, { color: { h, s } }, 50);
  }, [light.id, roomId, activePalette, setLightTrackPosition, setLightState]);

  // Handle brightness change
  const handleBrightnessChange = useCallback((brightness: number) => {
    setLightState(light.id, { brightness }, 50);
  }, [light.id, setLightState]);

  const brightness = light.state.brightness ?? 100;

  return (
    <div className="fixed top-20 right-4 bg-zinc-900/95 backdrop-blur border border-zinc-700 rounded-lg shadow-xl p-4 min-w-[240px] max-w-[320px]">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-zinc-300">{light.name}</h3>
          {/* Connection status indicator */}
          {diag && (
            <span
              className={`w-2 h-2 rounded-full ${
                diag.connected ? 'bg-green-500' : 'bg-red-500'
              }`}
              title={diag.connected ? 'Connected' : 'Disconnected'}
            />
          )}
        </div>
        <button
          onClick={onClose}
          className="text-zinc-500 hover:text-white transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Status line */}
      <div className="flex items-center gap-2 mb-3 text-[10px] text-zinc-500">
        <span className={`px-1.5 py-0.5 rounded ${
          light.brand === 'tuya' ? 'bg-purple-900/50 text-purple-300' :
          light.brand === 'hue' ? 'bg-amber-900/50 text-amber-300' :
          'bg-zinc-800 text-zinc-400'
        }`}>
          {light.brand}
        </span>
        {diag && (
          <span className={diag.connected ? 'text-green-500' : 'text-red-400'}>
            {diag.connected ? 'connected' : 'disconnected'}
          </span>
        )}
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

      {/* Debug log for this light (Tuya only for now) */}
      {light.brand === 'tuya' && (
        <DebugPanel filterDevice={light.name} compact />
      )}
    </div>
  );
}
