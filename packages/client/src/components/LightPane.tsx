import { useCallback, useState, useRef } from 'react';
import type { Light } from '@lightbox/shared';
import { getPointOnPalette } from '@lightbox/shared';
import { usePalettesStore, useRoomPlayState, useRoomPositions } from '../stores/palettes';
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

// Galaxy Projector device ID
const GALAXY_PROJECTOR_ID = 'tuya:ebc64ec87a6c462e20hmjo';

// Send raw DPS to Tuya device
async function setTuyaDps(id: string, dps: Record<string, any>) {
  await fetch(`/api/lights/${id}/dps`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dps }),
  });
}

// Set muted channels for a device
async function setMutedChannels(id: string, channels: { r?: boolean; g?: boolean; b?: boolean }) {
  await fetch(`/api/lights/${id}/muted-channels`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(channels),
  });
}

interface LightPaneProps {
  light: Light;
  roomId: string;
  onClose?: () => void;
  variant?: 'fixed' | 'inline';
}

export function LightPane({ light, roomId, onClose, variant = 'fixed' }: LightPaneProps) {
  const palettes = usePalettesStore((s) => s.palettes);
  const setLightTrackPosition = usePalettesStore((s) => s.setLightTrackPosition);
  const setLightState = useLightsStore((s) => s.setLightState);
  const diagnostics = useDebugStore((s) => s.diagnostics);

  // Get room-specific state - split for efficiency
  const { activePaletteId } = useRoomPlayState(roomId);
  const lightPositions = useRoomPositions(roomId);

  // Get diagnostic for this light
  const diag = diagnostics.get(light.id);

  const activePalette = palettes.find((p) => p.id === activePaletteId);
  const lightPosition = lightPositions[light.id] ?? 0;

  // Galaxy Projector custom controls
  const isGalaxyProjector = light.id === GALAXY_PROJECTOR_ID;
  const [laserSpeed, setLaserSpeed] = useState(500);
  const [laserOn, setLaserOn] = useState(true);
  const [nebulaOn, setNebulaOn] = useState(true);
  const laserSpeedThrottle = useRef<ReturnType<typeof setTimeout> | null>(null);

  // RGB channel muting (for filtering unwanted colors)
  const [mutedR, setMutedR] = useState(false);
  const [mutedG, setMutedG] = useState(false);
  const [mutedB, setMutedB] = useState(false);

  const handleLaserSpeedChange = useCallback((speed: number) => {
    setLaserSpeed(speed);
    // Throttle API calls for slider
    if (laserSpeedThrottle.current) {
      clearTimeout(laserSpeedThrottle.current);
    }
    laserSpeedThrottle.current = setTimeout(() => {
      setTuyaDps(light.id, { '101': speed });
    }, 100);
  }, [light.id]);

  const handleLaserToggle = useCallback((on: boolean) => {
    setLaserOn(on);
    setTuyaDps(light.id, { '102': on });
  }, [light.id]);

  const handleNebulaToggle = useCallback((on: boolean) => {
    setNebulaOn(on);
    setTuyaDps(light.id, { '103': on });
  }, [light.id]);

  const handleMutedChannelToggle = useCallback((channel: 'r' | 'g' | 'b', muted: boolean) => {
    if (channel === 'r') setMutedR(muted);
    if (channel === 'g') setMutedG(muted);
    if (channel === 'b') setMutedB(muted);
    setMutedChannels(light.id, { [channel]: muted });
  }, [light.id]);

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

  const isInline = variant === 'inline';

  return (
    <div className={
      isInline
        ? 'bg-zinc-900 border border-zinc-700 rounded-lg p-4'
        : 'fixed top-20 right-4 bg-zinc-900/95 backdrop-blur border border-zinc-700 rounded-lg shadow-xl p-4 min-w-[240px] max-w-[320px]'
    }>
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
        {onClose && (
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-white transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
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
        {/* On/Off toggle */}
        <button
          onClick={() => setLightState(light.id, { on: !light.state.on })}
          className={`ml-auto relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            light.state.on ? 'bg-green-600' : 'bg-zinc-700'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
              light.state.on ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
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

      {/* Galaxy Projector custom controls */}
      {isGalaxyProjector && (
        <div className="mt-4 pt-3 border-t border-zinc-700/50">
          <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2">Projector Controls</div>

          {/* Laser toggle */}
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-zinc-400">Laser</span>
            <button
              onClick={() => handleLaserToggle(!laserOn)}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                laserOn ? 'bg-red-600' : 'bg-zinc-700'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                  laserOn ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          {/* Laser speed slider */}
          <div className="mb-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-zinc-400">Laser Speed</span>
              <span className="text-[10px] text-zinc-500">{Math.round(laserSpeed / 10)}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={1000}
              value={laserSpeed}
              onChange={(e) => handleLaserSpeedChange(Number(e.target.value))}
              className="w-full h-1.5 bg-zinc-700 rounded-full appearance-none cursor-pointer accent-red-500"
              style={{
                background: `linear-gradient(to right, #dc2626 0%, #dc2626 ${laserSpeed / 10}%, #3f3f46 ${laserSpeed / 10}%, #3f3f46 100%)`,
              }}
            />
          </div>

          {/* Nebula toggle */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-400">Nebula</span>
            <button
              onClick={() => handleNebulaToggle(!nebulaOn)}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                nebulaOn ? 'bg-purple-600' : 'bg-zinc-700'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                  nebulaOn ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          {/* RGB channel muting */}
          <div className="flex items-center justify-between mt-3 pt-3 border-t border-zinc-700/50">
            <span className="text-xs text-zinc-400">Mute</span>
            <div className="flex gap-1.5">
              {(['r', 'g', 'b'] as const).map((channel) => {
                const isMuted = channel === 'r' ? mutedR : channel === 'g' ? mutedG : mutedB;
                const colors = {
                  r: { active: 'bg-red-500', muted: 'bg-red-900/50 text-red-400' },
                  g: { active: 'bg-green-500', muted: 'bg-green-900/50 text-green-400' },
                  b: { active: 'bg-blue-500', muted: 'bg-blue-900/50 text-blue-400' },
                };
                return (
                  <button
                    key={channel}
                    onClick={() => handleMutedChannelToggle(channel, !isMuted)}
                    className={`w-7 h-7 rounded text-xs font-bold transition-all ${
                      isMuted
                        ? `${colors[channel].muted} line-through opacity-50`
                        : `${colors[channel].active} text-white`
                    }`}
                  >
                    {channel.toUpperCase()}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Debug log for this light (Tuya only for now) */}
      {light.brand === 'tuya' && (
        <DebugPanel filterDevice={light.name} compact />
      )}
    </div>
  );
}
