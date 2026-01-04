// Light capability flags
export type Capability =
  | 'on_off'
  | 'brightness'
  | 'color'
  | 'temperature';

export type Brand = 'hue' | 'govee' | 'tuya' | 'tuya-ble';

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

// Debug log entry
export interface DebugLogEntry {
  id: string;
  timestamp: number;
  brand: Brand;
  device: string;
  message: string;
  direction: 'in' | 'out';
}

// Device diagnostics
export interface DeviceDiagnostics {
  id: string;
  brand: Brand;
  connected: boolean;
  reachable: boolean;
}

// WebSocket message types
export type WSMessage =
  | { type: 'light_update'; light: Light }
  | { type: 'lights_sync'; lights: Light[] }
  | { type: 'connection'; status: 'connected' | 'disconnected' }
  | { type: 'debug_log'; entry: DebugLogEntry }
  | { type: 'debug_log_update'; id: string; message: string }
  | { type: 'diagnostics_sync'; diagnostics: DeviceDiagnostics[] }
  // Room/palette animation messages
  | { type: 'room_states_sync'; roomStates: RoomState[] }
  | { type: 'room_state'; roomId: string; activePaletteId: string | null; isPlaying: boolean; secondsPerNode: number }
  | { type: 'palette_positions'; roomId: string; paletteId: string; positions: PalettePositions }
  | { type: 'position_update'; roomId: string; paletteId: string; lightId: string; position: number };

// Driver interface (for server-side implementation)
export interface LightDriver {
  readonly brand: Brand;

  initialize(): Promise<void>;
  discover(): Promise<Light[]>;
  getState(deviceId: string): Promise<LightState>;
  setState(deviceId: string, state: Partial<LightState>, transition?: number): Promise<void>;
  dispose(): Promise<void>;

  // Optional: Driver can push updates instead of being polled
  onUpdate?: (deviceId: string, state: LightState) => void;
  // Optional: Start listening for real-time updates (SSE, WebSocket, etc.)
  startListening?(): Promise<void>;
}

// Room animation state (per room)
export interface RoomState {
  roomId: string;
  activePaletteId: string | null;
  isPlaying: boolean;
  secondsPerNode: number; // Animation speed (global per room)
}

// Light positions on a palette track
export type PalettePositions = Record<string, number>; // lightId -> position (0-1)

// Re-export room config
export { ROOMS, ROOM_IDS, HIDDEN_LIGHT_IDS, type Room } from './rooms.js';

// Re-export palette utilities
export {
  catmullRom,
  getPointOnPalette,
  positionToColor,
  findClosestPointOnTrack,
} from './palette-utils.js';
