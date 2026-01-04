import { v3 } from 'node-hue-api';
import type { Light, LightState, LightDriver, Brand, Capability } from '@lightbox/shared';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(__dirname, '../../data');
const CONFIG_FILE = join(CONFIG_DIR, 'hue-config.json');

const APP_NAME = 'lightbox';
const DEVICE_NAME = 'server';

interface HueConfig {
  bridgeIp: string;
  username: string;
  clientKey?: string;
}

/**
 * Philips Hue driver using local bridge API.
 */
export class HueDriver implements LightDriver {
  readonly brand: Brand = 'hue';

  private api?: any;
  private config?: HueConfig;
  private lights: Map<string, any> = new Map(); // raw hue light objects

  async initialize(): Promise<void> {
    // Ensure config directory exists
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }

    // Try to load existing config
    if (existsSync(CONFIG_FILE)) {
      try {
        this.config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
        console.log(`Hue: found saved config for bridge at ${this.config!.bridgeIp}`);
      } catch {
        console.log('Hue: failed to parse config, will re-discover');
      }
    }

    // If no config, discover bridge
    if (!this.config) {
      console.log('Hue: searching for bridges...');
      const bridges = await v3.discovery.nupnpSearch();

      if (bridges.length === 0) {
        console.log('Hue: no bridges found on network');
        return;
      }

      const bridgeIp = bridges[0].ipaddress;
      console.log(`Hue: found bridge at ${bridgeIp}`);

      // Need to create a user - requires button press
      console.log('');
      console.log('╔════════════════════════════════════════════════════════════╗');
      console.log('║  Press the button on your Hue Bridge, then wait 10 seconds ║');
      console.log('╚════════════════════════════════════════════════════════════╝');
      console.log('');

      // Wait for button press
      await this.waitForButtonPress(bridgeIp);
    }

    // Connect with credentials
    if (this.config) {
      try {
        this.api = await v3.api.createLocal(this.config.bridgeIp).connect(this.config.username);
        console.log('Hue: connected to bridge');
      } catch (err) {
        console.error('Hue: failed to connect:', err);
        // Config might be stale, clear it
        this.config = undefined;
      }
    }
  }

  private async waitForButtonPress(bridgeIp: string, maxAttempts = 20): Promise<void> {
    const unauthenticatedApi = await v3.api.createLocal(bridgeIp).connect();

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const user = await unauthenticatedApi.users.createUser(APP_NAME, DEVICE_NAME);

        this.config = {
          bridgeIp,
          username: user.username,
          clientKey: user.clientkey,
        };

        // Save config
        writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
        console.log('Hue: authenticated and saved credentials');

        // Connect with new credentials
        this.api = await v3.api.createLocal(bridgeIp).connect(user.username);
        return;
      } catch (err: any) {
        if (err.getHueErrorType?.() === 101) {
          // Link button not pressed, wait and retry
          await new Promise(r => setTimeout(r, 1000));
        } else {
          throw err;
        }
      }
    }

    console.log('Hue: timed out waiting for button press');
  }

  async discover(): Promise<Light[]> {
    if (!this.api) return [];

    const hueLights = await this.api.lights.getAll();
    const lights: Light[] = [];

    for (const hueLight of hueLights) {
      const id = `hue:${hueLight.id}`;
      this.lights.set(id, hueLight);

      lights.push({
        id,
        name: hueLight.name,
        brand: 'hue',
        capabilities: this.getCapabilities(hueLight),
        state: this.mapState(hueLight.state),
        reachable: hueLight.state.reachable ?? true,
      });
    }

    return lights;
  }

  async getState(deviceId: string): Promise<LightState> {
    if (!this.api) return { on: false };

    const hueId = parseInt(deviceId);
    const hueLight = await this.api.lights.getLight(hueId);
    return this.mapState(hueLight.state);
  }

  async setState(deviceId: string, state: Partial<LightState>, transition?: number): Promise<void> {
    if (!this.api) throw new Error('Hue not connected');

    const hueId = parseInt(deviceId);
    const lightState = new v3.lightStates.LightState();

    if (state.on !== undefined) {
      state.on ? lightState.on() : lightState.off();
    }
    if (state.brightness !== undefined) {
      lightState.brightness(state.brightness);
    }
    if (state.color !== undefined) {
      // Hue uses 0-65535 for hue, 0-254 for saturation
      lightState.hue(Math.round(state.color.h * 182.04));
      lightState.sat(Math.round(state.color.s * 2.54));
    }
    if (state.temperature !== undefined) {
      // Convert Kelvin to mired
      const mired = Math.round(1000000 / state.temperature);
      lightState.ct(Math.max(153, Math.min(500, mired)));
    }
    if (transition !== undefined) {
      // Hue uses 100ms units
      lightState.transitiontime(Math.round(transition / 100));
    }

    await this.api.lights.setLightState(hueId, lightState);
  }

  async dispose(): Promise<void> {
    // Nothing to clean up
  }

  private getCapabilities(hueLight: any): Capability[] {
    const caps: Capability[] = ['on_off'];
    const state = hueLight.state;

    if (state.bri !== undefined) caps.push('brightness');
    if (state.hue !== undefined || state.xy !== undefined) caps.push('color');
    if (state.ct !== undefined) caps.push('temperature');

    return caps;
  }

  private mapState(hueState: any): LightState {
    const state: LightState = {
      on: hueState.on,
    };

    if (hueState.bri !== undefined) {
      state.brightness = Math.round(hueState.bri / 2.54);
    }
    if (hueState.hue !== undefined && hueState.sat !== undefined) {
      state.color = {
        h: Math.round(hueState.hue / 182.04),
        s: Math.round(hueState.sat / 2.54),
      };
    }
    if (hueState.ct !== undefined) {
      state.temperature = Math.round(1000000 / hueState.ct);
    }

    return state;
  }
}
