// Light capability flags
export type Capability =
  | 'on_off'
  | 'brightness'
  | 'color'
  | 'temperature';

export type Brand = 'hue' | 'govee' | 'tuya';

export interface LightState {
  on: boolean;
  brightness?: number;        // 0-100
  color?: { h: number; s: number }; // Hue (0-360), Saturation (0-100)
  temperature?: number;       // Kelvin (2000-6500 typical)
}

export interface Light {
  id: string;
  name: string;
  brand: Brand;
  capabilities: Capability[];
  state: LightState;
  reachable: boolean;
}

export interface Group {
  id: string;
  name: string;
  lightIds: string[];
}

export interface Scene {
  id: string;
  name: string;
  states: Record<string, LightState>; // lightId -> state
}

// API request/response types
export interface SetLightStateRequest {
  on?: boolean;
  brightness?: number;
  color?: { h: number; s: number };
  temperature?: number;
  transition?: number; // ms
}

export interface CreateGroupRequest {
  name: string;
  lightIds: string[];
}

export interface CreateSceneRequest {
  name: string;
  states: Record<string, LightState>;
}

// WebSocket message types
export type WSMessage =
  | { type: 'light_update'; light: Light }
  | { type: 'lights_sync'; lights: Light[] }
  | { type: 'connection'; status: 'connected' | 'disconnected' };

// Driver interface (for server-side implementation)
export interface LightDriver {
  readonly brand: Brand;

  initialize(): Promise<void>;
  discover(): Promise<Light[]>;
  getState(deviceId: string): Promise<LightState>;
  setState(deviceId: string, state: Partial<LightState>, transition?: number): Promise<void>;
  dispose(): Promise<void>;
}
