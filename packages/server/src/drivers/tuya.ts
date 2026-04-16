import TuyAPI from 'tuyapi';
import type { Light, LightState, LightDriver, Brand, Capability } from '@lightbox/shared';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(__dirname, '../../data');
const DEVICES_FILE = join(CONFIG_DIR, 'tuya-devices.json');

interface TuyaDeviceConfig {
  name: string;
  id: string;
  key: string;
  ip?: string;
  version?: string;
  mapping?: Record<string, { code: string; type: string; values?: any }>;
}

interface TuyaDevice {
  config: TuyaDeviceConfig;
  api: any;
  state: LightState;
  reachable: boolean;
  connected: boolean;
  reconnectTimer?: NodeJS.Timeout;
  reconnectAttempts: number;  // For exponential backoff
}

interface MutedChannels {
  r: boolean;
  g: boolean;
  b: boolean;
}

// HSV to RGB (h: 0-360, s: 0-100, v: 0-100) -> (r, g, b: 0-255)
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  s = s / 100;
  v = v / 100;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

// RGB to HSV (r, g, b: 0-255) -> (h: 0-360, s: 0-100, v: 0-100)
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r = r / 255;
  g = g / 255;
  b = b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  const s = max === 0 ? 0 : d / max;
  const v = max;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return [Math.round(h), Math.round(s * 100), Math.round(v * 100)];
}

/**
 * Tuya local control driver using tuyapi.
 * Uses persistent connections with auto-reconnect for real-time state updates.
 */
export class TuyaDriver implements LightDriver {
  readonly brand: Brand = 'tuya';

  private devices: Map<string, TuyaDevice> = new Map();
  private configs: TuyaDeviceConfig[] = [];

  // Per-device muted RGB channels (for filtering out unwanted colors)
  // Galaxy Projector defaults to G muted (green laser is overpowering)
  private mutedChannels: Map<string, MutedChannels> = new Map([
    ['tuya:ebc64ec87a6c462e20hmjo', { r: false, g: true, b: false }],
  ]);

  // Callback for real-time updates (set by LightManager)
  onUpdate?: (deviceId: string, state: LightState) => void;

  // Callbacks for debug messages
  onDebug?: (id: string, deviceName: string, message: string, direction: 'in' | 'out') => void;
  onDebugUpdate?: (id: string, message: string) => void;

  // Callback for connection state changes
  onDiagnosticsChange?: () => void;

  // Callback when device is ready for more commands (for fast palette updates)
  onReadyForMore?: (deviceId: string) => void;

  private debugSeq = 0;

  // Command coalescing: max 1 in-flight + 1 pending per device
  private inFlight = new Map<string, boolean>();
  private pending = new Map<string, { state: Partial<LightState>; transition?: number }>();

  private emitDebug(deviceName: string, message: string, direction: 'in' | 'out'): string {
    const id = `tuya-${++this.debugSeq}`;
    if (this.onDebug) {
      this.onDebug(id, deviceName, message, direction);
    }
    return id;
  }

  private updateDebug(id: string, message: string): void {
    if (this.onDebugUpdate) {
      this.onDebugUpdate(id, message);
    }
  }

  async initialize(): Promise<void> {
    if (!existsSync(DEVICES_FILE)) {
      console.log('Tuya: no devices.json found, run tinytuya wizard first');
      return;
    }

    try {
      this.configs = JSON.parse(readFileSync(DEVICES_FILE, 'utf-8'));
      console.log(`Tuya: loaded ${this.configs.length} device configs`);
    } catch (err) {
      console.error('Tuya: failed to parse devices.json:', err);
    }
  }

  async discover(): Promise<Light[]> {
    const lights: Light[] = [];

    for (const config of this.configs) {
      if (!config.ip) {
        console.log(`Tuya: ${config.name} has no IP, skipping`);
        continue;
      }

      const id = `tuya:${config.id}`;

      try {
        console.log(`Tuya: connecting to ${config.name}...`);

        const api = new TuyAPI({
          id: config.id,
          key: config.key,
          ip: config.ip,
          version: config.version || '3.3',
        });

        const device: TuyaDevice = {
          config,
          api,
          state: { on: false },
          reachable: false,
          connected: false,
          reconnectAttempts: 0,
        };
        this.devices.set(id, device);

        // Set up event handlers
        this.setupDeviceEvents(device, id);

        // Initial connection
        await this.connectDevice(device, id);

        lights.push({
          id,
          name: config.name,
          brand: 'tuya',
          capabilities: this.getCapabilities(config),
          state: device.state,
          reachable: device.reachable,
        });

        console.log(`Tuya: discovered ${config.name} at ${config.ip}`);
      } catch (err: any) {
        console.error(`Tuya: failed to connect to ${config.name}:`, err.message);

        // Still add device as unreachable so it shows in UI
        const device: TuyaDevice = {
          config,
          api: new TuyAPI({
            id: config.id,
            key: config.key,
            ip: config.ip,
            version: config.version || '3.3',
          }),
          state: { on: false },
          reachable: false,
          connected: false,
          reconnectAttempts: 0,
        };
        this.devices.set(id, device);
        this.setupDeviceEvents(device, id);
        this.scheduleReconnect(device, id);

        lights.push({
          id,
          name: config.name,
          brand: 'tuya',
          capabilities: this.getCapabilities(config),
          state: device.state,
          reachable: false,
        });
      }
    }

    return lights;
  }

  private setupDeviceEvents(device: TuyaDevice, id: string): void {
    const { api, config } = device;

    // Capture reference to driver methods to avoid `this` binding issues
    const emitDebug = this.emitDebug.bind(this);
    const scheduleReconnect = this.scheduleReconnect.bind(this);
    const parseState = this.parseState.bind(this);
    const driver = this;

    api.on('connected', () => {
      device.connected = true;
      device.reachable = true;
      device.reconnectAttempts = 0; // Reset backoff on successful connection
      emitDebug(config.name, 'connected', 'in');
      if (driver.onDiagnosticsChange) driver.onDiagnosticsChange();
    });

    api.on('disconnected', () => {
      device.connected = false;
      emitDebug(config.name, 'disconnected', 'in');
      if (driver.onDiagnosticsChange) driver.onDiagnosticsChange();
      scheduleReconnect(device, id);
    });

    api.on('error', (err: Error) => {
      // Silently handle - errors are common with Tuya devices
      if (err?.message) {
        emitDebug(config.name, `error: ${err.message}`, 'in');
      }
    });

    api.on('data', (data: any) => {
      if (data?.dps) {
        emitDebug(config.name, `data: ${JSON.stringify(data.dps)}`, 'in');
        const newState = parseState(config, data.dps);
        // Merge with existing state (data events may only have changed dps)
        device.state = { ...device.state, ...newState };
        device.reachable = true;

        // Notify LightManager of update
        if (driver.onUpdate) {
          driver.onUpdate(config.id, device.state);
        }
      }
    });
  }

  private async connectDevice(device: TuyaDevice, id: string): Promise<void> {
    const { api, config } = device;

    try {
      await api.find({ timeout: 3 });
      await api.connect();

      // Get initial state
      const status = await api.get({ schema: true });
      if (status?.dps) {
        device.state = this.parseState(config, status.dps);
      }
      device.reachable = true;
      device.connected = true;
    } catch (err: any) {
      device.reachable = false;
      device.connected = false;
      throw err;
    }
  }

  private scheduleReconnect(device: TuyaDevice, id: string): void {
    // Clear any existing reconnect timer
    if (device.reconnectTimer) {
      clearTimeout(device.reconnectTimer);
    }

    // Exponential backoff: 5s, 10s, 20s, 40s, max 60s
    const baseDelay = 5000;
    const maxDelay = 60000;
    const delay = Math.min(baseDelay * Math.pow(2, device.reconnectAttempts), maxDelay);
    device.reconnectAttempts++;

    device.reconnectTimer = setTimeout(async () => {
      if (device.connected) return; // Already reconnected

      try {
        await this.connectDevice(device, id);
        console.log(`Tuya: ${device.config.name} reconnected`);
        device.reconnectAttempts = 0; // Reset on successful connection

        // Notify of state update after reconnection
        if (this.onUpdate) {
          this.onUpdate(device.config.id, device.state);
        }
        if (this.onDiagnosticsChange) this.onDiagnosticsChange();
      } catch {
        // Will retry with increased backoff
        this.scheduleReconnect(device, id);
      }
    }, delay);
  }

  async getState(deviceId: string): Promise<LightState> {
    const device = this.devices.get(`tuya:${deviceId}`);
    if (!device) return { on: false };
    return device.state;
  }

  async setState(deviceId: string, state: Partial<LightState>, transition?: number): Promise<void> {
    const fullId = deviceId.startsWith('tuya:') ? deviceId : `tuya:${deviceId}`;
    const device = this.devices.get(fullId);
    if (!device) {
      throw new Error('Tuya device not found');
    }

    // Command coalescing: if something is in-flight, just update pending
    if (this.inFlight.get(fullId)) {
      // Merge with existing pending state
      const existingPending = this.pending.get(fullId);
      const mergedState = { ...(existingPending?.state || {}), ...state };
      this.pending.set(fullId, { state: mergedState, transition });
      return;
    }

    // Nothing in-flight, send immediately
    await this.sendCommand(fullId, device, state);
  }

  private async sendCommand(fullId: string, device: TuyaDevice, state: Partial<LightState>): Promise<void> {
    const dps = this.buildDps(fullId, device.config, state, device.state);
    if (Object.keys(dps).length === 0) {
      // Nothing to send, check pending
      this.processPending(fullId, device);
      return;
    }

    // If not connected, try to reconnect first
    if (!device.connected) {
      try {
        await this.connectDevice(device, fullId);
      } catch (err: any) {
        throw new Error(`Tuya device ${device.config.name} not reachable: ${err.message}`);
      }
    }

    // Mark as in-flight
    this.inFlight.set(fullId, true);

    // Build a short summary of what we're setting
    const summary = Object.entries(dps)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 12) : v}`)
      .join(' ');

    const logId = this.emitDebug(device.config.name, `${summary} (...)`, 'out');
    const startTime = Date.now();

    try {
      await device.api.set({ multiple: true, data: dps });
      const elapsed = Date.now() - startTime;
      this.updateDebug(logId, `${summary} (✓ ${elapsed}ms)`);

      // Update local state
      if (state.on !== undefined) device.state.on = state.on;
      if (state.brightness !== undefined) device.state.brightness = state.brightness;
      if (state.color !== undefined) {
        device.state.color = state.color;
        delete device.state.temperature;
      }
      if (state.temperature !== undefined) {
        device.state.temperature = state.temperature;
        delete device.state.color;
      }
    } catch (err: any) {
      const elapsed = Date.now() - startTime;
      this.updateDebug(logId, `${summary} (✗ ${elapsed}ms)`);
      device.connected = false;
      if (this.onDiagnosticsChange) this.onDiagnosticsChange();
      this.scheduleReconnect(device, fullId);
      // Don't throw - we still want to process pending
    } finally {
      // Mark as no longer in-flight and process any pending command
      this.inFlight.set(fullId, false);
      this.processPending(fullId, device);
    }
  }

  private processPending(fullId: string, device: TuyaDevice): void {
    const pendingCmd = this.pending.get(fullId);
    if (pendingCmd) {
      this.pending.delete(fullId);
      // Fire and forget - don't await, let it run independently
      this.sendCommand(fullId, device, pendingCmd.state).catch(() => {
        // Errors already logged in sendCommand
      });
    } else {
      // No pending command - notify that we're ready for more
      // (used by palette animator for fast continuous updates)
      if (this.onReadyForMore) {
        this.onReadyForMore(fullId);
      }
    }
  }

  /**
   * Get diagnostic info for all Tuya devices
   */
  getDiagnostics(): Record<string, { connected: boolean; reachable: boolean }> {
    const result: Record<string, { connected: boolean; reachable: boolean }> = {};
    for (const [id, device] of this.devices) {
      result[id] = {
        connected: device.connected,
        reachable: device.reachable,
      };
    }
    return result;
  }

  async dispose(): Promise<void> {
    for (const [, device] of this.devices) {
      if (device.reconnectTimer) {
        clearTimeout(device.reconnectTimer);
      }
      try {
        await device.api.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    }
    this.devices.clear();
  }

  /**
   * Set raw DPS values directly (for custom device controls)
   */
  async setRawDps(deviceId: string, dps: Record<string, any>): Promise<void> {
    const fullId = deviceId.startsWith('tuya:') ? deviceId : `tuya:${deviceId}`;
    const device = this.devices.get(fullId);
    if (!device) {
      throw new Error('Tuya device not found');
    }

    // If not connected, try to reconnect first
    if (!device.connected) {
      try {
        await this.connectDevice(device, fullId);
      } catch (err: any) {
        throw new Error(`Tuya device ${device.config.name} not reachable: ${err.message}`);
      }
    }

    // Build a short summary of what we're setting
    const summary = Object.entries(dps)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 12) : v}`)
      .join(' ');

    const logId = this.emitDebug(device.config.name, `raw: ${summary} (...)`, 'out');
    const startTime = Date.now();

    try {
      await device.api.set({ multiple: true, data: dps });
      const elapsed = Date.now() - startTime;
      this.updateDebug(logId, `raw: ${summary} (✓ ${elapsed}ms)`);
    } catch (err: any) {
      const elapsed = Date.now() - startTime;
      this.updateDebug(logId, `raw: ${summary} (✗ ${elapsed}ms)`);
      device.connected = false;
      if (this.onDiagnosticsChange) this.onDiagnosticsChange();
      this.scheduleReconnect(device, fullId);
      throw err;
    }
  }

  /**
   * Get muted RGB channels for a device
   */
  getMutedChannels(deviceId: string): MutedChannels {
    const fullId = deviceId.startsWith('tuya:') ? deviceId : `tuya:${deviceId}`;
    return this.mutedChannels.get(fullId) ?? { r: false, g: false, b: false };
  }

  /**
   * Set muted RGB channels for a device
   */
  setMutedChannels(deviceId: string, channels: MutedChannels): void {
    const fullId = deviceId.startsWith('tuya:') ? deviceId : `tuya:${deviceId}`;
    this.mutedChannels.set(fullId, channels);
  }

  /**
   * Apply channel muting to HSV color, returns modified H/S
   */
  private applyChannelMuting(deviceId: string, h: number, s: number, v: number): { h: number; s: number; v: number } {
    const muted = this.mutedChannels.get(deviceId);
    if (!muted || (!muted.r && !muted.g && !muted.b)) {
      return { h, s, v }; // No muting
    }

    // Convert to RGB
    let [r, g, b] = hsvToRgb(h, s, v);

    // Apply muting
    if (muted.r) r = 0;
    if (muted.g) g = 0;
    if (muted.b) b = 0;

    // If all channels are muted/zero, return black (low saturation)
    if (r === 0 && g === 0 && b === 0) {
      return { h: 0, s: 0, v: 0 };
    }

    // Convert back to HSV
    const [newH, newS, newV] = rgbToHsv(r, g, b);
    return { h: newH, s: newS, v: newV };
  }

  private getCapabilities(config: TuyaDeviceConfig): Capability[] {
    const caps: Capability[] = ['on_off'];
    const mapping = config.mapping || {};
    const codes = Object.values(mapping).map(m => m.code);

    if (codes.some(c => c.includes('bright'))) caps.push('brightness');
    if (codes.some(c => c.includes('colour'))) caps.push('color');
    if (codes.some(c => c.includes('temp'))) caps.push('temperature');

    return caps;
  }

  private findDpByCode(mapping: Record<string, any>, code: string): string | undefined {
    for (const [dp, info] of Object.entries(mapping)) {
      if (info.code === code) return dp;
    }
    return undefined;
  }

  private parseState(config: TuyaDeviceConfig, dps: Record<string, any>): LightState {
    const mapping = config.mapping || {};
    const state: LightState = { on: false };

    for (const [dp, value] of Object.entries(dps)) {
      const info = mapping[dp];
      if (!info) continue;

      switch (info.code) {
        case 'switch_led':
          state.on = Boolean(value);
          break;
        case 'bright_value_v2':
        case 'bright_value':
          state.brightness = Math.round(Number(value) / 10);
          break;
        case 'colour_data_v2':
        case 'colour_data':
          try {
            if (typeof value === 'string') {
              // Try JSON first
              if (value.startsWith('{')) {
                const color = JSON.parse(value);
                state.color = {
                  h: color.h,
                  s: Math.round(color.s / 10),
                };
              } else {
                // Hex format: HHHHSSSSBBBB (12 chars) or HHHHSSSSVVVV (12+ chars)
                // Each value is 4 hex chars
                const h = parseInt(value.slice(0, 4), 16);
                const s = parseInt(value.slice(4, 8), 16);
                // v would be value.slice(8, 12) but we don't need it
                state.color = {
                  h: h,
                  s: Math.round(s / 10), // 0-1000 -> 0-100
                };
              }
            } else if (value && typeof value === 'object') {
              state.color = {
                h: value.h,
                s: Math.round(value.s / 10),
              };
            }
          } catch {
            // Invalid color data
          }
          break;
        case 'temp_value_v2':
        case 'temp_value':
          state.temperature = 2700 + Math.round((Number(value) / 1000) * 3800);
          break;
      }
    }

    return state;
  }

  private buildDps(
    deviceId: string,
    config: TuyaDeviceConfig,
    state: Partial<LightState>,
    currentState: LightState
  ): Record<string, any> {
    const dps: Record<string, any> = {};
    const mapping = config.mapping || {};

    const switchDp = this.findDpByCode(mapping, 'switch_led');
    const brightDp = this.findDpByCode(mapping, 'bright_value_v2') || this.findDpByCode(mapping, 'bright_value');
    const colourDp = this.findDpByCode(mapping, 'colour_data_v2') || this.findDpByCode(mapping, 'colour_data');
    const tempDp = this.findDpByCode(mapping, 'temp_value_v2') || this.findDpByCode(mapping, 'temp_value');
    const workModeDp = this.findDpByCode(mapping, 'work_mode');

    if (state.on !== undefined && switchDp) {
      dps[switchDp] = state.on;
    }

    if (state.brightness !== undefined) {
      // In color mode, brightness is the V in HSV (via colour_data)
      // In white mode, brightness is via bright_value
      const isColorMode = currentState.color !== undefined;

      if (isColorMode && colourDp && currentState.color) {
        // Update brightness via colour_data HSV value - apply muting
        const vPct = state.brightness;
        const muted = this.applyChannelMuting(deviceId, currentState.color.h, currentState.color.s, vPct);
        const h = muted.h.toString(16).padStart(4, '0');
        const s = Math.round(muted.s * 10).toString(16).padStart(4, '0');
        const v = Math.round(muted.v * 10).toString(16).padStart(4, '0');
        dps[colourDp] = h + s + v;
        // Stay in color mode
        if (workModeDp) dps[workModeDp] = 'colour';
      } else if (brightDp) {
        // White mode - use bright_value
        dps[brightDp] = Math.round(state.brightness * 10);
        if (workModeDp) dps[workModeDp] = 'white';
      }
    }

    if (state.color !== undefined && colourDp) {
      // Apply channel muting before sending color
      const vPct = currentState.brightness ?? 100;
      const muted = this.applyChannelMuting(deviceId, state.color.h, state.color.s, vPct);
      // Use hex format: HHHHSSSSVVVV (4 hex chars each for h, s, v)
      const h = muted.h.toString(16).padStart(4, '0');
      const s = Math.round(muted.s * 10).toString(16).padStart(4, '0');
      const v = Math.round(muted.v * 10).toString(16).padStart(4, '0');
      dps[colourDp] = h + s + v;
      if (workModeDp) dps[workModeDp] = 'colour';
    }

    if (state.temperature !== undefined && tempDp) {
      const normalized = Math.round(((state.temperature - 2700) / 3800) * 1000);
      dps[tempDp] = Math.max(0, Math.min(1000, normalized));
      if (workModeDp) dps[workModeDp] = 'white';
    }

    return dps;
  }
}
