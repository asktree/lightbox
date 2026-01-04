import { create } from 'zustand';
import type { Light, LightState } from '@lightbox/shared';

// Throttle API calls per light - only send latest state
const pendingUpdates = new Map<string, { state: Partial<LightState>; transition?: number }>();
const throttleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const THROTTLE_MS = 50;

function sendThrottled(id: string, state: Partial<LightState>, transition?: number) {
  // Merge with any pending update (latest transition wins)
  const pending = pendingUpdates.get(id);
  let mergedState = { ...(pending?.state || {}), ...state };

  // Color and temperature are mutually exclusive - if one is set, clear the other
  if (state.temperature !== undefined) {
    delete mergedState.color;
  } else if (state.color !== undefined) {
    delete mergedState.temperature;
  }

  pendingUpdates.set(id, {
    state: mergedState,
    transition,
  });

  // If no timer running, start one
  if (!throttleTimers.has(id)) {
    const timer = setTimeout(() => {
      const toSend = pendingUpdates.get(id);
      pendingUpdates.delete(id);
      throttleTimers.delete(id);

      if (toSend) {
        fetch(`/api/lights/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...toSend.state, transition: toSend.transition }),
        }).catch(console.error);
      }
    }, THROTTLE_MS);
    throttleTimers.set(id, timer);
  }
}

interface LightsStore {
  lights: Map<string, Light>;
  connected: boolean;

  // Track lights being actively controlled (don't update from WS while dragging)
  controlledLights: Set<string>;
  // Track when lights were released (ignore bridge updates for 1s after release)
  releasedAt: Map<string, number>; // id -> timestamp
  // Bridge-reported state (for phantom UI) - shows real state while user drags
  bridgeStates: Map<string, LightState>;

  // Actions
  setConnected: (connected: boolean) => void;
  syncLights: (lights: Light[]) => void;
  updateLight: (light: Light) => void;
  setLightState: (id: string, state: Partial<LightState>, transition?: number) => void;

  // Control tracking
  startControlling: (id: string) => void;
  stopControlling: (id: string) => void;
}

export const useLightsStore = create<LightsStore>((set, get) => ({
  lights: new Map(),
  connected: false,
  controlledLights: new Set(),
  releasedAt: new Map(),
  bridgeStates: new Map(),

  setConnected: (connected) => set({ connected }),

  syncLights: (lights) => {
    const map = new Map<string, Light>();
    for (const light of lights) {
      map.set(light.id, light);
    }
    set({ lights: map });
  },

  updateLight: (light) => {
    const { controlledLights, releasedAt, bridgeStates } = get();

    // Always update bridge state (for phantom pin during drag)
    const newBridgeStates = new Map(bridgeStates);
    newBridgeStates.set(light.id, light.state);

    // If actively being dragged, only update bridge state
    if (controlledLights.has(light.id)) {
      set({ bridgeStates: newBridgeStates });
      return;
    }

    // If recently released (within 1s), keep optimistic position
    const releaseTime = releasedAt.get(light.id);
    if (releaseTime && Date.now() - releaseTime < 1000) {
      set({ bridgeStates: newBridgeStates });
      return;
    }

    // Otherwise, update to bridge state
    const newReleasedAt = new Map(releasedAt);
    newReleasedAt.delete(light.id);
    newBridgeStates.delete(light.id);

    const lights = new Map(get().lights);
    lights.set(light.id, light);
    set({ lights, releasedAt: newReleasedAt, bridgeStates: newBridgeStates });
  },

  setLightState: (id, state, transition) => {
    // Optimistic update - apply immediately
    const currentLight = get().lights.get(id);
    if (currentLight) {
      // Color and temperature are mutually exclusive
      let newState = { ...currentLight.state, ...state };
      if (state.temperature !== undefined) {
        delete newState.color;
      } else if (state.color !== undefined) {
        delete newState.temperature;
      }

      const optimisticLight: Light = {
        ...currentLight,
        state: newState,
      };
      const lights = new Map(get().lights);
      lights.set(id, optimisticLight);
      set({ lights });
    }

    // Throttled API call - only sends latest state, skips intermediate
    sendThrottled(id, state, transition);
  },

  startControlling: (id) => {
    const controlledLights = new Set(get().controlledLights);
    controlledLights.add(id);

    // Clear any pending release timer
    const releasedAt = new Map(get().releasedAt);
    releasedAt.delete(id);

    set({ controlledLights, releasedAt });
  },

  stopControlling: (id) => {
    const controlledLights = new Set(get().controlledLights);
    controlledLights.delete(id);

    // Record release time - updates will be ignored for 1s
    const releasedAt = new Map(get().releasedAt);
    releasedAt.set(id, Date.now());

    set({ controlledLights, releasedAt });
  },
}));
