import { EventEmitter } from 'events';
import type { Light, LightState, LightDriver, Group, Palette, PaletteNode, DebugLogEntry, DeviceDiagnostics, LightSettings } from '@lightbox/shared';
import { HueDriver } from '../drivers/hue.js';
import { GoveeDriver } from '../drivers/govee.js';
import { TuyaDriver } from '../drivers/tuya.js';
import { TuyaBLEProxyDriver } from '../drivers/tuya-ble-proxy.js';
import { Database } from './database.js';

export class LightManager extends EventEmitter {
  private drivers: LightDriver[] = [];
  private lights: Map<string, Light> = new Map();
  private db: Database;
  private ownsDb: boolean;

  // Track recently controlled lights to skip polling (prevents race conditions)
  private recentlyControlled: Map<string, number> = new Map();
  private readonly CONTROL_COOLDOWN_MS = 3000;

  constructor(db?: Database) {
    super();
    if (db) {
      this.db = db;
      this.ownsDb = false;
    } else {
      this.db = new Database();
      this.ownsDb = true;
    }
  }

  async initialize(): Promise<void> {
    // Initialize database (only if we own it)
    if (this.ownsDb) {
      this.db.initialize();
    }

    // Initialize drivers
    this.drivers = [
      new HueDriver(),
      new GoveeDriver(),
      new TuyaDriver(),
      new TuyaBLEProxyDriver(),
    ];

    // Set up callbacks for all drivers first
    for (const driver of this.drivers) {
      // Set up real-time update callback BEFORE discover (Tuya connects during discover)
      if ('onUpdate' in driver) {
        driver.onUpdate = (deviceId: string, state: LightState) => {
          const lightId = `${driver.brand}:${deviceId}`;
          const light = this.lights.get(lightId);
          if (light && this.hasStateChanged(light.state, state)) {
            light.state = state;
            this.emit('update', light);
          }
        };
      }

      // Set up debug callbacks for drivers that support it
      if ('onDebug' in driver) {
        (driver as any).onDebug = (id: string, deviceName: string, message: string, direction: 'in' | 'out') => {
          const entry: DebugLogEntry = {
            id,
            timestamp: Date.now(),
            brand: driver.brand,
            device: deviceName,
            message,
            direction,
          };
          this.emit('debug', entry);
        };
      }
      if ('onDebugUpdate' in driver) {
        (driver as any).onDebugUpdate = (id: string, message: string) => {
          this.emit('debug_update', { id, message });
        };
      }

      // Set up diagnostics change callback (Tuya)
      if ('onDiagnosticsChange' in driver) {
        (driver as any).onDiagnosticsChange = () => {
          this.emit('diagnostics', this.getDiagnostics());
        };
      }

      // Set up "ready for more" callback (Tuya) - used for fast palette updates
      if ('onReadyForMore' in driver) {
        (driver as any).onReadyForMore = (deviceId: string) => {
          this.emit('ready_for_more', deviceId);
        };
      }
    }

    // Initialize and discover from all drivers in parallel
    await Promise.all(this.drivers.map(async (driver) => {
      try {
        await driver.initialize();
        const discovered = await driver.discover();
        for (const light of discovered) {
          this.lights.set(light.id, light);
        }
        console.log(`${driver.brand}: discovered ${discovered.length} lights`);

        // Start listening for drivers that need explicit listener setup (Hue EventStream)
        if (driver.startListening) {
          await driver.startListening();
        }
      } catch (err) {
        console.error(`Failed to initialize ${driver.brand} driver:`, err);
      }
    }))

    // Start polling for state updates (fallback for drivers without EventStream)
    this.startPolling();
  }

  private startPolling(): void {
    // Poll every 2 seconds for state changes (backup for drivers with real-time updates)
    setInterval(async () => {
      const now = Date.now();

      for (const [id, light] of this.lights) {
        // Skip recently controlled lights to prevent race conditions
        const lastControlled = this.recentlyControlled.get(id);
        if (lastControlled && now - lastControlled < this.CONTROL_COOLDOWN_MS) {
          continue;
        }

        // Skip drivers with real-time updates (Hue has EventStream, Tuya has persistent connections)
        const driver = this.getDriverForLight(light);
        if (!driver) continue;
        if ('onUpdate' in driver && driver.onUpdate) continue;

        try {
          const state = await driver.getState(this.getDeviceId(id));
          if (this.hasStateChanged(light.state, state)) {
            light.state = state;
            this.emit('update', light);
          }
        } catch {
          // Light may be unreachable
          if (light.reachable) {
            light.reachable = false;
            this.emit('update', light);
          }
        }
      }
    }, 2000);
  }

  private hasStateChanged(a: LightState, b: LightState): boolean {
    return JSON.stringify(a) !== JSON.stringify(b);
  }

  private getDriverForLight(light: Light): LightDriver | undefined {
    return this.drivers.find(d => d.brand === light.brand);
  }

  private getDeviceId(lightId: string): string {
    // Format: brand:deviceId
    return lightId.split(':')[1] || lightId;
  }

  getAllLights(): Light[] {
    return Array.from(this.lights.values());
  }

  getLight(id: string): Light | undefined {
    return this.lights.get(id);
  }

  getDiagnostics(): DeviceDiagnostics[] {
    const diagnostics: DeviceDiagnostics[] = [];

    for (const driver of this.drivers) {
      // Tuya driver has getDiagnostics
      if ('getDiagnostics' in driver && typeof (driver as any).getDiagnostics === 'function') {
        const driverDiags = (driver as any).getDiagnostics();
        for (const [id, diag] of Object.entries(driverDiags)) {
          diagnostics.push({
            id,
            brand: driver.brand,
            connected: (diag as any).connected,
            reachable: (diag as any).reachable,
          });
        }
      } else {
        // For other drivers, derive from light state
        for (const [id, light] of this.lights) {
          if (light.brand === driver.brand) {
            diagnostics.push({
              id,
              brand: driver.brand,
              connected: light.reachable,
              reachable: light.reachable,
            });
          }
        }
      }
    }

    return diagnostics;
  }

  async setLightState(id: string, state: Partial<LightState>, transition?: number): Promise<void> {
    const light = this.lights.get(id);
    if (!light) throw new Error(`Light not found: ${id}`);

    const driver = this.getDriverForLight(light);
    if (!driver) throw new Error(`No driver for light: ${id}`);

    // Mark as recently controlled to skip polling (prevents race conditions)
    this.recentlyControlled.set(id, Date.now());

    await driver.setState(this.getDeviceId(id), state, transition);

    // Update local state
    Object.assign(light.state, state);
    this.emit('update', light);
  }

  // Groups
  getGroups(): Group[] {
    return this.db.getGroups();
  }

  getGroup(id: string): Group | undefined {
    return this.db.getGroup(id);
  }

  createGroup(name: string, lightIds: string[]): Group {
    return this.db.createGroup(name, lightIds);
  }

  updateGroup(id: string, name: string, lightIds: string[]): void {
    this.db.updateGroup(id, name, lightIds);
  }

  deleteGroup(id: string): void {
    this.db.deleteGroup(id);
  }

  async setGroupState(id: string, state: Partial<LightState>, transition?: number): Promise<void> {
    const group = this.getGroup(id);
    if (!group) throw new Error(`Group not found: ${id}`);

    await Promise.all(
      group.lightIds.map(lightId => this.setLightState(lightId, state, transition))
    );
  }

  /**
   * Set raw DPS values for a Tuya device (for custom device controls)
   */
  async setTuyaRawDps(id: string, dps: Record<string, any>): Promise<void> {
    const light = this.lights.get(id);
    if (!light) throw new Error(`Light not found: ${id}`);
    if (light.brand !== 'tuya') throw new Error('Raw DPS only supported for Tuya devices');

    const tuyaDriver = this.drivers.find(d => d.brand === 'tuya') as TuyaDriver | undefined;
    if (!tuyaDriver) throw new Error('Tuya driver not found');

    await tuyaDriver.setRawDps(this.getDeviceId(id), dps);
  }

  /**
   * Get muted RGB channels for a Tuya device
   */
  getTuyaMutedChannels(id: string): { r: boolean; g: boolean; b: boolean } {
    const light = this.lights.get(id);
    if (!light || light.brand !== 'tuya') {
      return { r: false, g: false, b: false };
    }

    const tuyaDriver = this.drivers.find(d => d.brand === 'tuya') as TuyaDriver | undefined;
    if (!tuyaDriver) return { r: false, g: false, b: false };

    return tuyaDriver.getMutedChannels(id);
  }

  /**
   * Set muted RGB channels for a Tuya device
   */
  setTuyaMutedChannels(id: string, channels: { r: boolean; g: boolean; b: boolean }): void {
    const light = this.lights.get(id);
    if (!light) throw new Error(`Light not found: ${id}`);
    if (light.brand !== 'tuya') throw new Error('Muted channels only supported for Tuya devices');

    const tuyaDriver = this.drivers.find(d => d.brand === 'tuya') as TuyaDriver | undefined;
    if (!tuyaDriver) throw new Error('Tuya driver not found');

    tuyaDriver.setMutedChannels(id, channels);
  }

  // Palettes
  getPalettes(): Palette[] {
    return this.db.getPalettes();
  }

  getPalette(id: string): Palette | undefined {
    return this.db.getPalette(id);
  }

  createPalette(
    name: string,
    nodes: PaletteNode[],
    tension?: number,
    secondsPerNode?: number
  ): Palette {
    return this.db.createPalette(name, nodes, tension, secondsPerNode);
  }

  updatePalette(
    id: string,
    updates: {
      name?: string;
      nodes?: PaletteNode[];
      tension?: number;
      secondsPerNode?: number;
    }
  ): void {
    this.db.updatePalette(id, updates);
  }

  deletePalette(id: string): void {
    this.db.deletePalette(id);
  }

  // Light Settings (per-light refresh intervals, etc.)
  getLightSettings(lightId: string): LightSettings {
    return this.db.getLightSettings(lightId);
  }

  getAllLightSettings(): LightSettings[] {
    return this.db.getAllLightSettings();
  }

  setLightSettings(lightId: string, maxRefreshIntervalMs: number): void {
    this.db.setLightSettings(lightId, maxRefreshIntervalMs);
  }

  async dispose(): Promise<void> {
    for (const driver of this.drivers) {
      await driver.dispose();
    }
    if (this.ownsDb) {
      this.db.close();
    }
  }
}
