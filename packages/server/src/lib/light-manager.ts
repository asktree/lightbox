import { EventEmitter } from 'events';
import type { Light, LightState, LightDriver, Group, Palette, PaletteNode } from '@lightbox/shared';
import { HueDriver } from '../drivers/hue.js';
import { GoveeDriver } from '../drivers/govee.js';
import { TuyaDriver } from '../drivers/tuya.js';
import { Database } from './database.js';

export class LightManager extends EventEmitter {
  private drivers: LightDriver[] = [];
  private lights: Map<string, Light> = new Map();
  private db: Database;

  constructor() {
    super();
    this.db = new Database();
  }

  async initialize(): Promise<void> {
    // Initialize database
    this.db.initialize();

    // Initialize drivers
    this.drivers = [
      new HueDriver(),
      new GoveeDriver(),
      new TuyaDriver(),
    ];

    // Initialize each driver and discover lights
    for (const driver of this.drivers) {
      try {
        await driver.initialize();
        const discovered = await driver.discover();
        for (const light of discovered) {
          this.lights.set(light.id, light);
        }
        console.log(`${driver.brand}: discovered ${discovered.length} lights`);

        // Set up real-time update callback if driver supports it
        if (driver.startListening) {
          driver.onUpdate = (deviceId: string, state: LightState) => {
            const lightId = `${driver.brand}:${deviceId}`;
            const light = this.lights.get(lightId);
            if (light && this.hasStateChanged(light.state, state)) {
              light.state = state;
              this.emit('update', light);
            }
          };
          await driver.startListening();
        }
      } catch (err) {
        console.error(`Failed to initialize ${driver.brand} driver:`, err);
      }
    }

    // Start polling for state updates (fallback for drivers without EventStream)
    this.startPolling();
  }

  private startPolling(): void {
    // Poll every second for state changes
    setInterval(async () => {
      for (const [id, light] of this.lights) {
        const driver = this.getDriverForLight(light);
        if (!driver) continue;

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
    }, 1000);
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

  async setLightState(id: string, state: Partial<LightState>, transition?: number): Promise<void> {
    const light = this.lights.get(id);
    if (!light) throw new Error(`Light not found: ${id}`);

    const driver = this.getDriverForLight(light);
    if (!driver) throw new Error(`No driver for light: ${id}`);

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

  async dispose(): Promise<void> {
    for (const driver of this.drivers) {
      await driver.dispose();
    }
    this.db.close();
  }
}
