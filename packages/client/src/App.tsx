import { useState, useEffect } from 'react';
import { ROOMS, HIDDEN_LIGHT_IDS } from '@lightbox/shared';
import { useLightsStore } from './stores/lights';
import { usePalettesStore, useRoomPlayState } from './stores/palettes';
import { useDebugStore } from './stores/debug';
import { useWebSocket } from './hooks/useWebSocket';
import { ColorWheel } from './components/ColorWheel';
import { PaletteControls } from './components/PaletteControls';
import { LightPane } from './components/LightPane';
import { AgentChat } from './components/AgentChat';
import { DebugPanel } from './components/DebugPanel';

type View = 'grid' | 'wheel';

export default function App() {
  useWebSocket();

  const lights = useLightsStore((s) => s.lights);
  const connected = useLightsStore((s) => s.connected);
  const palettes = usePalettesStore((s) => s.palettes);
  const isEditing = usePalettesStore((s) => s.isEditing);

  const debugOpen = useDebugStore((s) => s.isOpen);
  const setDebugOpen = useDebugStore((s) => s.setOpen);

  const [view, setView] = useState<View>(() => {
    const saved = localStorage.getItem('lightbox:viewMode');
    return saved === 'grid' || saved === 'wheel' ? saved : 'wheel';
  });
  const [currentRoom, setCurrentRoom] = useState<string>(() => {
    const saved = localStorage.getItem('lightbox:currentRoom');
    return saved && saved in ROOMS ? saved : 'bedroom';
  });

  // Persist view mode and current room to localStorage
  useEffect(() => {
    localStorage.setItem('lightbox:viewMode', view);
  }, [view]);

  useEffect(() => {
    localStorage.setItem('lightbox:currentRoom', currentRoom);
  }, [currentRoom]);
  const [selectedTrackLight, setSelectedTrackLight] = useState<string | null>(null);

  // Get current room's palette state - efficient selector (no positions)
  const { activePaletteId } = useRoomPlayState(currentRoom);
  const activePalette = palettes.find((p) => p.id === activePaletteId);

  const allLights = Array.from(lights.values()).filter((l) => !HIDDEN_LIGHT_IDS.has(l.id));

  // Filter lights by current room
  const roomConfig = ROOMS[currentRoom];
  const lightsList = roomConfig?.lightIds.length > 0
    ? allLights.filter((l) => roomConfig.lightIds.includes(l.id))
    : allLights;
  const reachableLights = lightsList.filter((l) => l.reachable);
  const unreachableLights = lightsList.filter((l) => !l.reachable);
  const colorLights = reachableLights.filter((l) => l.capabilities.includes('color'));

  // Get selected light for LightPane
  const selectedLight = selectedTrackLight ? lights.get(selectedTrackLight) : null;

  return (
    <>
      {/* Disconnect indicator - visual overlay only, doesn't affect layout */}
      {!connected && (
        <div className="fixed inset-0 pointer-events-none ring-4 ring-inset ring-red-400 z-50" />
      )}
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

          {/* Debug toggle */}
          <button
            onClick={() => setDebugOpen(!debugOpen)}
            className={`px-3 py-1 text-sm rounded-md transition-all ${
              debugOpen ? 'bg-purple-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-white'
            }`}
          >
            Debug
          </button>

          {/* Connection status */}
          <div className="flex items-center gap-2 min-w-[6.5rem]">
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
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {reachableLights.map((light) => (
                  <LightPane key={light.id} light={light} roomId={currentRoom} variant="inline" />
                ))}
              </div>

              {unreachableLights.length > 0 && (
                <>
                  <h2 className="text-sm text-zinc-500 mt-8 mb-4">Unreachable</h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                    {unreachableLights.map((light) => (
                      <LightPane key={light.id} light={light} roomId={currentRoom} variant="inline" />
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
        <div className="flex flex-col items-center gap-6">
          {/* Wheel - up to 2/3 viewport width */}
          <div className="flex-shrink-0">
            <ColorWheel
              lights={colorLights}
              size={Math.min(600, Math.floor(window.innerWidth * 0.65))}
              selectedLightId={selectedTrackLight}
              onLightSelect={setSelectedTrackLight}
              roomId={currentRoom}
            />
          </div>


          {/* Light selection buttons */}
          <div className="flex flex-wrap justify-center gap-2">
            {colorLights.map((light) => {
              const isSelected = selectedTrackLight === light.id;
              const color = light.state.color;
              const bgColor = color
                ? `hsl(${color.h}, ${color.s}%, 50%)`
                : '#888';

              return (
                <button
                  key={light.id}
                  onClick={() => setSelectedTrackLight(isSelected ? null : light.id)}
                  className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all flex items-center gap-2 ${
                    isSelected
                      ? 'bg-purple-600 text-white'
                      : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
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
        </div>
      )}

      {/* Light Pane - shown when a light is selected */}
      {selectedLight && (
        <LightPane
          light={selectedLight}
          roomId={currentRoom}
          onClose={() => setSelectedTrackLight(null)}
        />
      )}

      {/* Palette Controls */}
      <PaletteControls roomId={currentRoom} />

      {/* Agent Chat */}
      <AgentChat />

      {/* Debug Panel */}
      {debugOpen && (
        <DebugPanel
          filterDevices={roomConfig?.lightIds.length > 0 ? lightsList.map((l) => l.name) : undefined}
        />
      )}
    </div>
    </>
  );
}
