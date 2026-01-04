import { create } from 'zustand';
import type { Light, LightState } from '@lightbox/shared';

interface LightsStore {
  lights: Map<string, Light>;
  connected: boolean;

  // Actions
  setConnected: (connected: boolean) => void;
  syncLights: (lights: Light[]) => void;
  updateLight: (light: Light) => void;
  setLightState: (id: string, state: Partial<LightState>) => Promise<void>;
}

export const useLightsStore = create<LightsStore>((set, get) => ({
  lights: new Map(),
  connected: false,

  setConnected: (connected) => set({ connected }),

  syncLights: (lights) => {
    const map = new Map<string, Light>();
    for (const light of lights) {
      map.set(light.id, light);
    }
    set({ lights: map });
  },

  updateLight: (light) => {
    const lights = new Map(get().lights);
    lights.set(light.id, light);
    set({ lights });
  },

  setLightState: async (id, state) => {
    // Optimistic update - apply immediately
    const currentLight = get().lights.get(id);
    if (currentLight) {
      const optimisticLight: Light = {
        ...currentLight,
        state: { ...currentLight.state, ...state },
      };
      get().updateLight(optimisticLight);
    }

    // Fire API call (WebSocket will confirm final state)
    fetch(`/api/lights/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    }).catch(console.error);
  },
}));
