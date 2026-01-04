import { useState } from 'react';
import { useLightsStore } from './stores/lights';
import { usePalettesStore } from './stores/palettes';
import { useWebSocket } from './hooks/useWebSocket';
import { usePaletteAnimation } from './hooks/usePaletteAnimation';
import { LightCard } from './components/LightCard';
import { ColorWheel } from './components/ColorWheel';
import { PaletteControls } from './components/PaletteControls';
import { AgentChat } from './components/AgentChat';

type View = 'grid' | 'wheel';

// Room definitions - lights grouped by location
const ROOMS: Record<string, { name: string; lightIds: string[] }> = {
  bedroom: {
    name: 'Bedroom',
    lightIds: ['hue:3', 'hue:4'], // spaceship floor, cockpit
  },
  living: {
    name: 'Living Room',
    lightIds: ['hue:2', 'hue:7', 'hue:6', 'hue:8'], // couch lights, iris, floor lamp
  },
  all: {
    name: 'All Lights',
    lightIds: [], // empty = show all
  },
};

export default function App() {
  useWebSocket();
  usePaletteAnimation();

  const lights = useLightsStore((s) => s.lights);
  const connected = useLightsStore((s) => s.connected);
  const activePaletteId = usePalettesStore((s) => s.activePaletteId);
  const palettes = usePalettesStore((s) => s.palettes);
  const isEditing = usePalettesStore((s) => s.isEditing);

  const activePalette = palettes.find((p) => p.id === activePaletteId);

  const [view, setView] = useState<View>('grid');
  const [selectedLightIds, setSelectedLightIds] = useState<Set<string>>(new Set());
  const [currentRoom, setCurrentRoom] = useState<string>('bedroom');

  const allLights = Array.from(lights.values());

  // Filter lights by current room
  const roomConfig = ROOMS[currentRoom];
  const lightsList = roomConfig.lightIds.length > 0
    ? allLights.filter((l) => roomConfig.lightIds.includes(l.id))
    : allLights;
  const reachableLights = lightsList.filter((l) => l.reachable);
  const unreachableLights = lightsList.filter((l) => !l.reachable);
  const colorLights = reachableLights.filter((l) => l.capabilities.includes('color'));

  // For color wheel: use selected lights, or all color lights if none selected
  const wheelLights = selectedLightIds.size > 0
    ? colorLights.filter((l) => selectedLightIds.has(l.id))
    : colorLights;

  const toggleLightSelection = (id: string) => {
    const next = new Set(selectedLightIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedLightIds(next);
  };

  // Get light IDs for current room (for passing to palette)
  const roomLightIds = roomConfig.lightIds.length > 0
    ? roomConfig.lightIds
    : allLights.map(l => l.id);

  return (
    <div
      className={`min-h-screen p-6 transition-all ${
        activePalette
          ? 'ring-2 ring-purple-500/50 ring-inset bg-gradient-to-b from-purple-950/20 to-transparent'
          : ''
      }`}
    >
      {/* Header */}
      <header className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">Lightbox</h1>
          {activePalette && (
            <span className="px-2 py-0.5 bg-purple-600/30 text-purple-300 text-sm rounded animate-pulse">
              {activePalette.name}
            </span>
          )}
          {isEditing && (
            <span className="px-2 py-0.5 bg-amber-600/30 text-amber-300 text-sm rounded">
              Creating palette...
            </span>
          )}
        </div>
        <div className="flex items-center gap-4">
          {/* Room selector */}
          <div className="flex bg-zinc-800 rounded-lg p-1">
            {Object.entries(ROOMS).map(([key, room]) => (
              <button
                key={key}
                onClick={() => setCurrentRoom(key)}
                className={`px-3 py-1 text-sm rounded-md transition-all ${
                  currentRoom === key ? 'bg-purple-600 text-white' : 'text-zinc-400'
                }`}
              >
                {room.name}
              </button>
            ))}
          </div>

          {/* View toggle */}
          <div className="flex bg-zinc-800 rounded-lg p-1">
            <button
              onClick={() => setView('grid')}
              className={`px-3 py-1 text-sm rounded-md transition-all ${
                view === 'grid' ? 'bg-zinc-600 text-white' : 'text-zinc-400'
              }`}
            >
              Grid
            </button>
            <button
              onClick={() => setView('wheel')}
              className={`px-3 py-1 text-sm rounded-md transition-all ${
                view === 'wheel' ? 'bg-zinc-600 text-white' : 'text-zinc-400'
              }`}
            >
              Wheel
            </button>
          </div>

          {/* Connection status */}
          <div className="flex items-center gap-2">
            <div
              className={`w-2 h-2 rounded-full ${
                connected ? 'bg-green-500' : 'bg-red-500'
              }`}
            />
            <span className="text-sm text-zinc-400">
              {connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
        </div>
      </header>

      {/* All lights toggle */}
      {lightsList.length > 0 && view === 'grid' && (
        <div className="mb-6 flex gap-2">
          <button
            onClick={() => {
              const { setLightState } = useLightsStore.getState();
              reachableLights.forEach((l) => setLightState(l.id, { on: true }));
            }}
            className="px-4 py-2 bg-white text-black rounded-lg text-sm font-medium hover:bg-zinc-200 transition-all"
          >
            All On
          </button>
          <button
            onClick={() => {
              const { setLightState } = useLightsStore.getState();
              reachableLights.forEach((l) => setLightState(l.id, { on: false }));
            }}
            className="px-4 py-2 bg-zinc-800 rounded-lg text-sm font-medium hover:bg-zinc-700 transition-all"
          >
            All Off
          </button>
        </div>
      )}

      {/* Grid View */}
      {view === 'grid' && (
        <>
          {lightsList.length === 0 ? (
            <div className="text-center py-20 text-zinc-500">
              {connected ? 'No lights found' : 'Connecting...'}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                {reachableLights.map((light) => (
                  <LightCard key={light.id} light={light} />
                ))}
              </div>

              {unreachableLights.length > 0 && (
                <>
                  <h2 className="text-sm text-zinc-500 mt-8 mb-4">Unreachable</h2>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                    {unreachableLights.map((light) => (
                      <LightCard key={light.id} light={light} />
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}

      {/* Color Wheel View */}
      {view === 'wheel' && (
        <div className="flex flex-col lg:flex-row gap-8">
          {/* Wheel */}
          <div className="flex-shrink-0 flex justify-center">
            <ColorWheel lights={wheelLights} size={350} />
          </div>

          {/* Light filter */}
          <div className="flex-1">
            <h2 className="text-sm text-zinc-400 mb-3">
              {selectedLightIds.size === 0
                ? 'Showing all color lights (click to filter)'
                : `Showing ${selectedLightIds.size} selected`}
            </h2>
            <div className="flex flex-wrap gap-2">
              {colorLights.map((light) => {
                const isSelected = selectedLightIds.has(light.id);
                const color = light.state.color;
                const bgColor = color
                  ? `hsl(${color.h}, ${color.s}%, 50%)`
                  : '#888';

                return (
                  <button
                    key={light.id}
                    onClick={() => toggleLightSelection(light.id)}
                    className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all flex items-center gap-2 ${
                      isSelected || selectedLightIds.size === 0
                        ? 'bg-zinc-700 text-white'
                        : 'bg-zinc-800 text-zinc-500'
                    }`}
                  >
                    <div
                      className="w-3 h-3 rounded-full"
                      style={{ backgroundColor: light.state.on ? bgColor : '#444' }}
                    />
                    {light.name}
                  </button>
                );
              })}
            </div>

            {selectedLightIds.size > 0 && (
              <button
                onClick={() => setSelectedLightIds(new Set())}
                className="mt-4 text-sm text-zinc-500 hover:text-white transition-all"
              >
                Clear selection
              </button>
            )}

            {colorLights.length === 0 && (
              <p className="text-zinc-500">No color-capable lights available</p>
            )}
          </div>
        </div>
      )}

      {/* Palette Controls */}
      <PaletteControls lightIds={roomLightIds} />

      {/* Agent Chat */}
      <AgentChat />
    </div>
  );
}
