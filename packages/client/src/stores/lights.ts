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

// Check if two states are close enough (bridge caught up)
function statesMatch(a: LightState, b: LightState, tolerance = 5): boolean {
  if (a.on !== b.on) return false;
  if (a.brightness !== undefined && b.brightness !== undefined) {
    if (Math.abs(a.brightness - b.brightness) > tolerance) return false;
  }
  if (a.color && b.color) {
    if (Math.abs(a.color.h - b.color.h) > tolerance) return false;
    if (Math.abs(a.color.s - b.color.s) > tolerance) return false;
  }
  return true;
}

interface LightsStore {
  lights: Map<string, Light>;
  connected: boolean;

  // Track lights being actively controlled (don't update from WS while dragging)
  controlledLights: Set<string>;
  // Track lights that were just released (waiting for bridge to catch up)
  releasedLights: Map<string, LightState>; // id -> target state when released
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
  releasedLights: new Map(),
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
    const { controlledLights, releasedLights, bridgeStates } = get();

    // If actively being dragged, just update bridge state for phantom
    if (controlledLights.has(light.id)) {
      const newBridgeStates = new Map(bridgeStates);
      newBridgeStates.set(light.id, light.state);
      set({ bridgeStates: newBridgeStates });
      return;
    }

    // If recently released, check if bridge caught up to our target
    const targetState = releasedLights.get(light.id);
    if (targetState) {
      // Update phantom to show progress
      const newBridgeStates = new Map(bridgeStates);
      newBridgeStates.set(light.id, light.state);

      if (statesMatch(light.state, targetState)) {
        // Bridge caught up! Clear released state and update normally
        const newReleasedLights = new Map(releasedLights);
        newReleasedLights.delete(light.id);
        newBridgeStates.delete(light.id);

        const lights = new Map(get().lights);
        lights.set(light.id, light);
        set({ lights, releasedLights: newReleasedLights, bridgeStates: newBridgeStates });
      } else {
        // Still waiting for bridge to catch up
        set({ bridgeStates: newBridgeStates });
      }
      return;
    }

    // Normal update
    const lights = new Map(get().lights);
    lights.set(light.id, light);
    set({ lights });
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

    // Clear any pending released state
    const releasedLights = new Map(get().releasedLights);
    releasedLights.delete(id);

    set({ controlledLights, releasedLights });
  },

  stopControlling: (id) => {
    const controlledLights = new Set(get().controlledLights);
    controlledLights.delete(id);

    // Remember the target state so we can wait for bridge to catch up
    const currentLight = get().lights.get(id);
    const releasedLights = new Map(get().releasedLights);
    if (currentLight) {
      releasedLights.set(id, currentLight.state);
    }

    set({ controlledLights, releasedLights });

    // Safety timeout: if bridge hasn't caught up in 2s, give up waiting
    setTimeout(() => {
      const { releasedLights, bridgeStates } = get();
      if (releasedLights.has(id)) {
        const newReleasedLights = new Map(releasedLights);
        newReleasedLights.delete(id);
        const newBridgeStates = new Map(bridgeStates);
        newBridgeStates.delete(id);
        set({ releasedLights: newReleasedLights, bridgeStates: newBridgeStates });
      }
    }, 2000);
  },
}));
