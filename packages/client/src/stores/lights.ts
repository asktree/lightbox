import { create } from 'zustand';
import type { Light, LightState } from '@lightbox/shared';

// Throttle API calls per light - only send latest state
const pendingUpdates = new Map<string, { state: Partial<LightState>; transition?: number }>();
const throttleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const THROTTLE_MS = 50;

function sendThrottled(id: string, state: Partial<LightState>, transition?: number) {
  const pending = pendingUpdates.get(id);
  let mergedState = { ...(pending?.state || {}), ...state };

  if (state.temperature !== undefined) {
    delete mergedState.color;
  } else if (state.color !== undefined) {
    delete mergedState.temperature;
  }

  pendingUpdates.set(id, { state: mergedState, transition });

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

// Track control state OUTSIDE of React state - no re-renders needed
const controlledLights = new Set<string>();
const ignoreUpdatesUntil: Record<string, number> = {};

function stateEqual(a: LightState, b: LightState): boolean {
  return a.on === b.on &&
    a.brightness === b.brightness &&
    a.color?.h === b.color?.h &&
    a.color?.s === b.color?.s &&
    a.temperature === b.temperature;
}

interface LightsStore {
  lights: Record<string, Light>;
  connected: boolean;

  setConnected: (connected: boolean) => void;
  syncLights: (lights: Light[]) => void;
  updateLight: (light: Light) => void;
  setLightState: (id: string, state: Partial<LightState>, transition?: number) => void;
  startControlling: (id: string) => void;
  stopControlling: (id: string) => void;
}

export const useLightsStore = create<LightsStore>((set, get) => ({
  lights: {},
  connected: false,

  setConnected: (connected) => set({ connected }),

  syncLights: (newLights) => {
    const lights: Record<string, Light> = {};
    for (const light of newLights) {
      lights[light.id] = light;
    }
    set({ lights });
  },

  updateLight: (light) => {
    // Skip if being actively controlled
    if (controlledLights.has(light.id)) return;

    // Skip if in cooldown period after control release
    const ignoreUntil = ignoreUpdatesUntil[light.id];
    if (ignoreUntil && Date.now() < ignoreUntil) return;

    // Skip if no meaningful change
    const existing = get().lights[light.id];
    if (existing &&
        stateEqual(existing.state, light.state) &&
        existing.reachable === light.reachable) {
      return;
    }

    // Update just this one light
    set((state) => ({
      lights: { ...state.lights, [light.id]: light }
    }));
  },

  setLightState: (id, state, transition) => {
    const currentLight = get().lights[id];
    if (currentLight) {
      let newState = { ...currentLight.state, ...state };
      if (state.temperature !== undefined) delete newState.color;
      else if (state.color !== undefined) delete newState.temperature;

      set((s) => ({
        lights: { ...s.lights, [id]: { ...currentLight, state: newState } }
      }));
    }
    sendThrottled(id, state, transition);
  },

  startControlling: (id) => {
    controlledLights.add(id);
    delete ignoreUpdatesUntil[id];
  },

  stopControlling: (id) => {
    controlledLights.delete(id);
    ignoreUpdatesUntil[id] = Date.now() + 1000;
  },
}));
