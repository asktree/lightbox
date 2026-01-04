import { create } from 'zustand';
import type { Palette, PaletteNode } from '@lightbox/shared';

interface PalettesStore {
  palettes: Palette[];
  activePaletteId: string | null;
  isAnimating: boolean;

  // For editing a new palette before saving
  editingNodes: PaletteNode[];
  isEditing: boolean;

  // Light positions on track (0-1) - keyed by light id
  lightPositions: Record<string, number>;

  // Actions
  fetchPalettes: () => Promise<void>;

  // Playback
  selectPalette: (id: string) => void;
  playPalette: (lightIds: string[]) => void;
  pausePalette: () => void;
  deselectPalette: () => void;
  setLightPosition: (lightId: string, position: number) => void;

  // Editing (for creating new palettes)
  startEditing: () => void;
  addNode: (x: number, y: number) => void;
  updateNode: (index: number, x: number, y: number) => void;
  removeNode: (index: number) => void;
  cancelEditing: () => void;
  savePalette: (name: string) => Promise<void>;

  // Modify active palette
  setTension: (tension: number) => Promise<void>;
  setSpeed: (secondsPerNode: number) => Promise<void>;
  deletePalette: (id: string) => Promise<void>;
  updateNodePosition: (nodeIndex: number, x: number, y: number) => void;
  saveNodePositions: () => Promise<void>;

  // Sync positions from animation ref to store (for UI display)
  syncPositions: (positions: Record<string, number>) => void;
}

export const usePalettesStore = create<PalettesStore>((set, get) => ({
  palettes: [],
  activePaletteId: null,
  isAnimating: false,
  editingNodes: [],
  isEditing: false,
  lightPositions: {},

  fetchPalettes: async () => {
    const res = await fetch('/api/palettes');
    const palettes = await res.json();
    set({ palettes });
  },

  selectPalette: (id: string) => {
    const palette = get().palettes.find((p) => p.id === id);
    if (!palette || palette.nodes.length < 2) return;

    set({
      activePaletteId: id,
      isEditing: false,
      editingNodes: [],
    });
  },

  playPalette: (lightIds: string[]) => {
    const { activePaletteId, palettes, lightPositions } = get();
    if (!activePaletteId) return;

    const palette = palettes.find((p) => p.id === activePaletteId);
    if (!palette || palette.nodes.length < 2) return;

    // Only initialize positions if not already set (preserve positions on resume)
    let positions = lightPositions;
    if (Object.keys(positions).length === 0) {
      positions = {};
      lightIds.forEach((lightId, index) => {
        positions[lightId] = index / Math.max(lightIds.length, 1);
      });
    }

    set({
      lightPositions: positions,
      isAnimating: true,
    });
  },

  pausePalette: () => {
    set({ isAnimating: false });
  },

  deselectPalette: () => {
    set({
      isAnimating: false,
      activePaletteId: null,
      lightPositions: {},
    });
  },

  setLightPosition: (lightId: string, position: number) => {
    set((s) => ({
      lightPositions: { ...s.lightPositions, [lightId]: position },
    }));
  },

  startEditing: () => {
    set({
      isEditing: true,
      editingNodes: [],
      isAnimating: false,
      activePaletteId: null,
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

  setTension: async (tension: number) => {
    const { activePaletteId, palettes } = get();
    if (!activePaletteId) return;

    await fetch(`/api/palettes/${activePaletteId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tension }),
    });

    set({
      palettes: palettes.map((p) =>
        p.id === activePaletteId ? { ...p, tension } : p
      ),
    });
  },

  setSpeed: async (secondsPerNode: number) => {
    const { activePaletteId, palettes } = get();
    if (!activePaletteId) return;

    await fetch(`/api/palettes/${activePaletteId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secondsPerNode }),
    });

    set({
      palettes: palettes.map((p) =>
        p.id === activePaletteId ? { ...p, secondsPerNode } : p
      ),
    });
  },

  deletePalette: async (id: string) => {
    await fetch(`/api/palettes/${id}`, { method: 'DELETE' });
    set((s) => ({
      palettes: s.palettes.filter((p) => p.id !== id),
      activePaletteId: s.activePaletteId === id ? null : s.activePaletteId,
      isAnimating: s.activePaletteId === id ? false : s.isAnimating,
    }));
  },

  syncPositions: (positions: Record<string, number>) => {
    set({ lightPositions: { ...positions } });
  },

  updateNodePosition: (nodeIndex: number, x: number, y: number) => {
    const { activePaletteId, palettes } = get();
    if (!activePaletteId) return;

    set({
      palettes: palettes.map((p) => {
        if (p.id !== activePaletteId) return p;
        const nodes = [...p.nodes];
        nodes[nodeIndex] = { x, y };
        return { ...p, nodes };
      }),
    });
  },

  saveNodePositions: async () => {
    const { activePaletteId, palettes } = get();
    if (!activePaletteId) return;

    const palette = palettes.find((p) => p.id === activePaletteId);
    if (!palette) return;

    await fetch(`/api/palettes/${activePaletteId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodes: palette.nodes }),
    });
  },
}));
