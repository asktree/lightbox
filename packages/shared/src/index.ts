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

// Palette: a color path on the wheel that lights animate along
export interface PaletteNode {
  x: number;  // 0-1 relative to wheel center
  y: number;
}

// For API input: can specify as x/y OR as hex color
export type PaletteNodeInput =
  | { x: number; y: number }
  | { hex: string }
  | { h: number; s: number };

export interface Palette {
  id: string;
  name: string;
  nodes: PaletteNode[];
  tension: number;        // 0 = straight lines, 1 = max smoothness
  secondsPerNode: number; // Speed: time to travel between nodes
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

export interface CreatePaletteRequest {
  name: string;
  nodes: PaletteNodeInput[];
  tension?: number;
  secondsPerNode?: number;
}

export interface UpdatePaletteRequest {
  name?: string;
  nodes?: PaletteNodeInput[];
  tension?: number;
  secondsPerNode?: number;
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
