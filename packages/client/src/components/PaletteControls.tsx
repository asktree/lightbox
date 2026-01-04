import { useEffect, useState, useRef } from 'react';
import { usePalettesStore } from '../stores/palettes';

interface PaletteControlsProps {
  lightIds: string[]; // Current room's light IDs
}

export function PaletteControls({ lightIds }: PaletteControlsProps) {
  const palettes = usePalettesStore((s) => s.palettes);
  const activePaletteId = usePalettesStore((s) => s.activePaletteId);
  const isAnimating = usePalettesStore((s) => s.isAnimating);
  const isEditing = usePalettesStore((s) => s.isEditing);
  const editingNodes = usePalettesStore((s) => s.editingNodes);
  const fetchPalettes = usePalettesStore((s) => s.fetchPalettes);
  const selectPalette = usePalettesStore((s) => s.selectPalette);
  const playPalette = usePalettesStore((s) => s.playPalette);
  const pausePalette = usePalettesStore((s) => s.pausePalette);
  const deselectPalette = usePalettesStore((s) => s.deselectPalette);
  const startEditing = usePalettesStore((s) => s.startEditing);
  const cancelEditing = usePalettesStore((s) => s.cancelEditing);
  const savePalette = usePalettesStore((s) => s.savePalette);
  const setTension = usePalettesStore((s) => s.setTension);
  const setSpeed = usePalettesStore((s) => s.setSpeed);
  const deletePalette = usePalettesStore((s) => s.deletePalette);
  const renamePalette = usePalettesStore((s) => s.renamePalette);
  const initializeLightPositions = usePalettesStore((s) => s.initializeLightPositions);

  const [newName, setNewName] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  const activePalette = palettes.find((p) => p.id === activePaletteId);

  useEffect(() => {
    fetchPalettes();
  }, [fetchPalettes]);

  // Focus input when starting to rename
  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  const startRenaming = () => {
    if (activePalette) {
      setRenameValue(activePalette.name);
      setIsRenaming(true);
    }
  };

  const handleRenameSubmit = async () => {
    if (!activePalette || !renameValue.trim()) {
      setIsRenaming(false);
      return;
    }
    if (renameValue.trim() !== activePalette.name) {
      await renamePalette(activePalette.id, renameValue.trim());
    }
    setIsRenaming(false);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleRenameSubmit();
    } else if (e.key === 'Escape') {
      setIsRenaming(false);
    }
  };

  // Log scale for speed: 0.5s to 1800s (30 minutes)
  const speedToSlider = (s: number) => Math.log(s / 0.5) / Math.log(3600);
  const sliderToSpeed = (v: number) => 0.5 * Math.pow(3600, v);

  // Format speed for display
  const formatSpeed = (seconds: number) => {
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
    return `${(seconds / 3600).toFixed(1)}h`;
  };

  const handlePaletteClick = (id: string) => {
    if (id === activePaletteId) {
      // Already selected - toggle play/pause
      if (isAnimating) {
        pausePalette();
      } else {
        playPalette(lightIds);
      }
    } else {
      // Switching to different palette
      const wasAnimating = isAnimating;
      selectPalette(id);
      // Initialize light positions so they show on the track immediately
      initializeLightPositions(lightIds);
      // Only auto-play if we were already playing
      if (wasAnimating) {
        setTimeout(() => {
          usePalettesStore.getState().playPalette(lightIds);
        }, 0);
      }
    }
  };

  const handleSave = () => {
    if (newName.trim() && editingNodes.length >= 2) {
      savePalette(newName.trim());
      setNewName('');
    }
  };

  return (
    <div className="fixed bottom-4 right-4 bg-zinc-900/95 backdrop-blur border border-zinc-700 rounded-lg shadow-xl p-4 min-w-[280px] max-w-[320px]">

      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-zinc-300">Palettes</h3>
        {isAnimating && (
          <span className="text-xs text-green-400 animate-pulse">Playing</span>
        )}
        {activePalette && !isAnimating && (
          <span className="text-xs text-zinc-500">Paused</span>
        )}
        {isEditing && (
          <span className="text-xs text-amber-400">Editing</span>
        )}
      </div>

      {/* Editing mode */}
      {isEditing ? (
        <div className="space-y-3">
          <p className="text-xs text-zinc-400">
            Click on the color wheel to add points. Need at least 2.
          </p>
          <p className="text-sm text-zinc-300">
            Points: {editingNodes.length}
          </p>

          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Palette name..."
            className="w-full px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-600 rounded text-white placeholder-zinc-500 focus:outline-none focus:border-purple-500"
          />

          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={editingNodes.length < 2 || !newName.trim()}
              className="flex-1 py-1.5 text-sm bg-purple-600 text-white rounded hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Save
            </button>
            <button
              onClick={cancelEditing}
              className="px-3 py-1.5 text-sm bg-zinc-700 text-white rounded hover:bg-zinc-600"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Palette buttons */}
          <div className="flex flex-wrap gap-2 mb-3">
            {palettes.length === 0 ? (
              <span className="text-xs text-zinc-500">No palettes yet</span>
            ) : (
              palettes.map((palette) => (
                <button
                  key={palette.id}
                  onClick={() => handlePaletteClick(palette.id)}
                  className={`px-3 py-1.5 text-sm rounded transition-colors ${
                    palette.id === activePaletteId
                      ? 'bg-purple-600 text-white'
                      : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                  }`}
                >
                  {palette.name}
                </button>
              ))
            )}
            <button
              onClick={startEditing}
              className="px-3 py-1.5 text-sm rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white"
            >
              + New
            </button>
          </div>

          {/* Active palette controls */}
          {activePalette && (
            <div className="space-y-3 pt-3 border-t border-zinc-700">
              {/* Palette name (editable) */}
              <div>
                {isRenaming ? (
                  <input
                    ref={renameInputRef}
                    type="text"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={handleRenameSubmit}
                    onKeyDown={handleRenameKeyDown}
                    className="w-full px-2 py-1 text-sm bg-zinc-800 border border-zinc-600 rounded text-white focus:outline-none focus:border-purple-500"
                  />
                ) : (
                  <button
                    onClick={startRenaming}
                    className="text-sm text-zinc-300 hover:text-white cursor-pointer"
                    title="click to rename"
                  >
                    {activePalette.name}
                  </button>
                )}
              </div>

              {/* Play/Pause button */}
              <div className="flex gap-2">
                <button
                  onClick={() => isAnimating ? pausePalette() : playPalette(lightIds)}
                  className={`flex-1 py-2 text-sm rounded font-medium transition-colors ${
                    isAnimating
                      ? 'bg-amber-600 hover:bg-amber-500 text-white'
                      : 'bg-green-600 hover:bg-green-500 text-white'
                  }`}
                >
                  {isAnimating ? '⏸ Pause' : '▶ Play'}
                </button>
                <button
                  onClick={deselectPalette}
                  className="px-3 py-2 text-sm bg-zinc-700 text-white rounded hover:bg-zinc-600"
                >
                  ✕
                </button>
              </div>

              {/* Tension slider */}
              <div>
                <label className="text-xs text-zinc-400 mb-1 block">
                  Curve: {(activePalette.tension * 100).toFixed(0)}%
                </label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={activePalette.tension}
                  onChange={(e) => setTension(parseFloat(e.target.value))}
                  className="w-full h-1 bg-zinc-700 rounded-full appearance-none cursor-pointer"
                />
              </div>

              {/* Speed slider */}
              <div>
                <label className="text-xs text-zinc-400 mb-1 block">
                  Speed: {formatSpeed(activePalette.secondsPerNode)}/node
                </label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.02"
                  value={speedToSlider(activePalette.secondsPerNode)}
                  onChange={(e) => setSpeed(sliderToSpeed(parseFloat(e.target.value)))}
                  className="w-full h-1 bg-zinc-700 rounded-full appearance-none cursor-pointer"
                />
              </div>

              {/* Delete */}
              <button
                onClick={() => {
                  if (confirm(`Delete "${activePalette.name}"?`)) {
                    deletePalette(activePalette.id);
                  }
                }}
                className="w-full py-1.5 text-sm bg-red-600/20 text-red-400 rounded hover:bg-red-600/30"
              >
                Delete Palette
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
