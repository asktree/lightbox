import { useEffect, useState, useRef } from 'react';
import { usePalettesStore } from '../stores/palettes';

interface PaletteControlsProps {
  roomId: string; // Current room ID
}

export function PaletteControls({ roomId }: PaletteControlsProps) {
  const palettes = usePalettesStore((s) => s.palettes);
  const isEditing = usePalettesStore((s) => s.isEditing);
  const editingNodes = usePalettesStore((s) => s.editingNodes);
  const fetchPalettes = usePalettesStore((s) => s.fetchPalettes);
  const getRoomState = usePalettesStore((s) => s.getRoomState);

  // Server-side actions
  const selectPalette = usePalettesStore((s) => s.selectPalette);
  const deselectPalette = usePalettesStore((s) => s.deselectPalette);
  const playPalette = usePalettesStore((s) => s.playPalette);
  const pausePalette = usePalettesStore((s) => s.pausePalette);

  // Editing actions (client-side)
  const startEditing = usePalettesStore((s) => s.startEditing);
  const cancelEditing = usePalettesStore((s) => s.cancelEditing);
  const savePalette = usePalettesStore((s) => s.savePalette);

  // Palette modification
  const setRoomSpeed = usePalettesStore((s) => s.setRoomSpeed);
  const deletePalette = usePalettesStore((s) => s.deletePalette);
  const renamePalette = usePalettesStore((s) => s.renamePalette);

  const [newName, setNewName] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Get current room's palette state from server
  const roomState = getRoomState(roomId);
  const activePaletteId = roomState.activePaletteId;
  const isAnimating = roomState.isPlaying;

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

  const handlePaletteClick = async (id: string) => {
    if (id === activePaletteId) {
      // Already selected - toggle play/pause
      if (isAnimating) {
        await pausePalette(roomId);
      } else {
        await playPalette(roomId);
      }
    } else {
      // Switching to different palette
      const wasAnimating = isAnimating;
      await selectPalette(roomId, id);
      // Auto-play if we were already playing
      if (wasAnimating) {
        await playPalette(roomId);
      }
    }
  };

  const handleSave = () => {
    if (newName.trim() && editingNodes.length >= 2) {
      savePalette(newName.trim());
      setNewName('');
    }
  };

  const handleDeselect = async () => {
    await deselectPalette(roomId);
  };

  const handlePlayPause = async () => {
    if (isAnimating) {
      await pausePalette(roomId);
    } else {
      await playPalette(roomId);
    }
  };

  const handleDelete = async () => {
    if (activePalette && confirm(`Delete "${activePalette.name}"?`)) {
      await deletePalette(activePalette.id);
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
                  onClick={handlePlayPause}
                  className={`flex-1 py-2 text-sm rounded font-medium transition-colors ${
                    isAnimating
                      ? 'bg-amber-600 hover:bg-amber-500 text-white'
                      : 'bg-green-600 hover:bg-green-500 text-white'
                  }`}
                >
                  {isAnimating ? '|| Pause' : '> Play'}
                </button>
                <button
                  onClick={handleDeselect}
                  className="px-3 py-2 text-sm bg-zinc-700 text-white rounded hover:bg-zinc-600"
                >
                  X
                </button>
              </div>

              {/* Speed slider (room-level) */}
              <div>
                <label className="text-xs text-zinc-400 mb-1 block">
                  Speed: {formatSpeed(roomState.secondsPerNode)}/node
                </label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.02"
                  value={speedToSlider(roomState.secondsPerNode)}
                  onChange={(e) => setRoomSpeed(roomId, sliderToSpeed(parseFloat(e.target.value)))}
                  className="w-full h-1 bg-zinc-700 rounded-full appearance-none cursor-pointer"
                />
              </div>

              {/* Delete */}
              <button
                onClick={handleDelete}
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
