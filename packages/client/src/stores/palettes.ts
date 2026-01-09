import { create } from 'zustand';
import type { Palette, PaletteNode, RoomState, PalettePositions } from '@lightbox/shared';

interface PalettesStore {
  // Palette definitions (global - same for all rooms)
  palettes: Palette[];

  // Room animation state from server (per-room)
  roomStates: Record<string, RoomState>;
  roomPositions: Record<string, { paletteId: string; positions: PalettePositions }>;

  // For editing a new palette before saving (client-side only)
  editingNodes: PaletteNode[];
  isEditing: boolean;

  // Edit palette mode - when true, palette nodes are interactive, lights are not
  editPaletteMode: boolean;
  setEditPaletteMode: (mode: boolean) => void;

  // Actions - fetch palette definitions
  fetchPalettes: () => Promise<void>;

  // Server state sync (called from WebSocket handler)
  syncRoomStates: (states: RoomState[]) => void;
  updateRoomState: (roomId: string, activePaletteId: string | null, isPlaying: boolean, secondsPerNode?: number) => void;
  updatePalettePositions: (roomId: string, paletteId: string, positions: PalettePositions) => void;
  updateLightPosition: (roomId: string, paletteId: string, lightId: string, position: number) => void;

  // Room controls - call server APIs
  selectPalette: (roomId: string, paletteId: string) => Promise<void>;
  deselectPalette: (roomId: string) => Promise<void>;
  playPalette: (roomId: string) => Promise<void>;
  pausePalette: (roomId: string) => Promise<void>;
  setRoomSpeed: (roomId: string, secondsPerNode: number) => Promise<void>;
  setLightTrackPosition: (roomId: string, lightId: string, position: number) => Promise<void>;

  // Editing (for creating new palettes - client-side)
  startEditing: () => void;
  addNode: (x: number, y: number) => void;
  updateNode: (index: number, x: number, y: number) => void;
  removeNode: (index: number) => void;
  cancelEditing: () => void;
  savePalette: (name: string) => Promise<void>;

  // Modify existing palette (server-side)
  setTension: (id: string, tension: number) => Promise<void>;
  setSpeed: (id: string, secondsPerNode: number) => Promise<void>;
  deletePalette: (id: string) => Promise<void>;
  clonePalette: (id: string) => Promise<void>;
  updateNodePosition: (id: string, nodeIndex: number, x: number, y: number) => void;
  saveNodePositions: (id: string) => Promise<void>;
  addNodeToActive: (id: string, x: number, y: number) => Promise<void>;
  removeNodeFromActive: (id: string, index: number) => Promise<void>;
  renamePalette: (id: string, name: string) => Promise<void>;

  // Helper to get room state
  getRoomState: (roomId: string) => { activePaletteId: string | null; isPlaying: boolean; secondsPerNode: number; positions: PalettePositions };
}

export const usePalettesStore = create<PalettesStore>((set, get) => ({
  palettes: [],
  roomStates: {},
  roomPositions: {},
  editingNodes: [],
  isEditing: false,
  editPaletteMode: false,

  setEditPaletteMode: (mode: boolean) => set({ editPaletteMode: mode }),

  fetchPalettes: async () => {
    const res = await fetch('/api/palettes');
    const palettes = await res.json();
    set({ palettes });
  },

  // Server state sync
  syncRoomStates: (states: RoomState[]) => {
    const roomStates: Record<string, RoomState> = {};
    for (const state of states) {
      roomStates[state.roomId] = state;
    }
    set({ roomStates });
  },

  updateRoomState: (roomId: string, activePaletteId: string | null, isPlaying: boolean, secondsPerNode?: number) => {
    set((s) => {
      const existing = s.roomStates[roomId];
      return {
        roomStates: {
          ...s.roomStates,
          [roomId]: {
            roomId,
            activePaletteId,
            isPlaying,
            secondsPerNode: secondsPerNode ?? existing?.secondsPerNode ?? 20,
          },
        },
      };
    });
  },

  updatePalettePositions: (roomId: string, paletteId: string, positions: PalettePositions) => {
    set((s) => ({
      roomPositions: {
        ...s.roomPositions,
        [roomId]: { paletteId, positions },
      },
    }));
  },

  updateLightPosition: (roomId: string, paletteId: string, lightId: string, position: number) => {
    set((s) => {
      const current = s.roomPositions[roomId];
      if (!current || current.paletteId !== paletteId) {
        return {
          roomPositions: {
            ...s.roomPositions,
            [roomId]: { paletteId, positions: { [lightId]: position } },
          },
        };
      }
      return {
        roomPositions: {
          ...s.roomPositions,
          [roomId]: {
            paletteId,
            positions: { ...current.positions, [lightId]: position },
          },
        },
      };
    });
  },

  // Helper to get room state with defaults
  getRoomState: (roomId: string) => {
    const { roomStates, roomPositions } = get();
    const state = roomStates[roomId];
    const posData = roomPositions[roomId];
    return {
      activePaletteId: state?.activePaletteId ?? null,
      isPlaying: state?.isPlaying ?? false,
      secondsPerNode: state?.secondsPerNode ?? 20,
      positions: posData?.positions ?? {},
    };
  },

  // Room controls - call server APIs
  selectPalette: async (roomId: string, paletteId: string) => {
    await fetch(`/api/rooms/${roomId}/palette/${paletteId}`, { method: 'POST' });
    // State will be updated via WebSocket
  },

  deselectPalette: async (roomId: string) => {
    await fetch(`/api/rooms/${roomId}/palette`, { method: 'DELETE' });
    // State will be updated via WebSocket
  },

  playPalette: async (roomId: string) => {
    await fetch(`/api/rooms/${roomId}/play`, { method: 'POST' });
    // State will be updated via WebSocket
  },

  pausePalette: async (roomId: string) => {
    await fetch(`/api/rooms/${roomId}/pause`, { method: 'POST' });
    // State will be updated via WebSocket
  },

  setRoomSpeed: async (roomId: string, secondsPerNode: number) => {
    await fetch(`/api/rooms/${roomId}/speed`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secondsPerNode }),
    });
    // State will be updated via WebSocket
  },

  setLightTrackPosition: async (roomId: string, lightId: string, position: number) => {
    await fetch(`/api/rooms/${roomId}/lights/${lightId}/position`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position }),
    });
    // State will be updated via WebSocket
  },

  // Editing (client-side only)
  startEditing: () => {
    set({
      isEditing: true,
      editingNodes: [],
    });
  },

  addNode: (x: number, y: number) => {
    set((s) => ({
      editingNodes: [...s.editingNodes, { x, y }],
    }));
  },

  updateNode: (index: number, x: number, y: number) => {
    set((s) => {
      const nodes = [...s.editingNodes];
      nodes[index] = { x, y };
      return { editingNodes: nodes };
    });
  },

  removeNode: (index: number) => {
    set((s) => ({
      editingNodes: s.editingNodes.filter((_, i) => i !== index),
    }));
  },

  cancelEditing: () => {
    set({
      isEditing: false,
      editingNodes: [],
    });
  },

  savePalette: async (name: string) => {
    const { editingNodes } = get();
    if (editingNodes.length < 2) return;

    const res = await fetch('/api/palettes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        nodes: editingNodes,
        tension: 0.5,
        secondsPerNode: 2,
      }),
    });
    const palette = await res.json();

    set((s) => ({
      palettes: [...s.palettes, palette],
      isEditing: false,
      editingNodes: [],
    }));
  },

  setTension: async (id: string, tension: number) => {
    await fetch(`/api/palettes/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tension }),
    });

    set((s) => ({
      palettes: s.palettes.map((p) =>
        p.id === id ? { ...p, tension } : p
      ),
    }));
  },

  setSpeed: async (id: string, secondsPerNode: number) => {
    await fetch(`/api/palettes/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secondsPerNode }),
    });

    set((s) => ({
      palettes: s.palettes.map((p) =>
        p.id === id ? { ...p, secondsPerNode } : p
      ),
    }));
  },

  deletePalette: async (id: string) => {
    await fetch(`/api/palettes/${id}`, { method: 'DELETE' });
    set((s) => ({
      palettes: s.palettes.filter((p) => p.id !== id),
    }));
  },

  clonePalette: async (id: string) => {
    const palette = get().palettes.find((p) => p.id === id);
    if (!palette) return;

    const res = await fetch('/api/palettes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${palette.name} (copy)`,
        nodes: palette.nodes,
        tension: palette.tension,
        secondsPerNode: palette.secondsPerNode,
      }),
    });
    const newPalette = await res.json();

    set((s) => ({
      palettes: [...s.palettes, newPalette],
    }));
  },

  updateNodePosition: (id: string, nodeIndex: number, x: number, y: number) => {
    set((s) => ({
      palettes: s.palettes.map((p) => {
        if (p.id !== id) return p;
        const nodes = [...p.nodes];
        nodes[nodeIndex] = { x, y };
        return { ...p, nodes };
      }),
    }));
  },

  saveNodePositions: async (id: string) => {
    const palette = get().palettes.find((p) => p.id === id);
    if (!palette) return;

    await fetch(`/api/palettes/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodes: palette.nodes }),
    });
  },

  addNodeToActive: async (id: string, x: number, y: number) => {
    const palette = get().palettes.find((p) => p.id === id);
    if (!palette) return;

    const newNodes = [...palette.nodes, { x, y }];

    // Update locally first
    set((s) => ({
      palettes: s.palettes.map((p) =>
        p.id === id ? { ...p, nodes: newNodes } : p
      ),
    }));

    // Save to server
    await fetch(`/api/palettes/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodes: newNodes }),
    });
  },

  removeNodeFromActive: async (id: string, index: number) => {
    const palette = get().palettes.find((p) => p.id === id);
    if (!palette || palette.nodes.length <= 2) return;

    const newNodes = palette.nodes.filter((_, i) => i !== index);

    // Update locally first
    set((s) => ({
      palettes: s.palettes.map((p) =>
        p.id === id ? { ...p, nodes: newNodes } : p
      ),
    }));

    // Save to server
    await fetch(`/api/palettes/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodes: newNodes }),
    });
  },

  renamePalette: async (id: string, name: string) => {
    await fetch(`/api/palettes/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });

    set((s) => ({
      palettes: s.palettes.map((p) =>
        p.id === id ? { ...p, name } : p
      ),
    }));
  },
}));

// Efficient selector hooks - use these instead of getRoomState for better performance

// Stable empty object to avoid infinite re-render loops
const EMPTY_POSITIONS: PalettePositions = {};

/**
 * Subscribe to just the positions for a specific room.
 * Only re-renders when positions actually change.
 */
export function useRoomPositions(roomId: string): PalettePositions {
  return usePalettesStore((s) => s.roomPositions[roomId]?.positions ?? EMPTY_POSITIONS);
}

/**
 * Subscribe to room play state (activePaletteId, isPlaying, secondsPerNode).
 * Does NOT include positions - won't re-render on position updates.
 */
export function useRoomPlayState(roomId: string) {
  const activePaletteId = usePalettesStore((s) => s.roomStates[roomId]?.activePaletteId ?? null);
  const isPlaying = usePalettesStore((s) => s.roomStates[roomId]?.isPlaying ?? false);
  const secondsPerNode = usePalettesStore((s) => s.roomStates[roomId]?.secondsPerNode ?? 20);
  return { activePaletteId, isPlaying, secondsPerNode };
}
