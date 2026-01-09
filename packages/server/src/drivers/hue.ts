import { v3 } from 'node-hue-api';
import type { Light, LightState, LightDriver, Brand, Capability } from '@lightbox/shared';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

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
 * Philips Hue driver using local bridge API with EventStream for real-time updates.
 */
export class HueDriver implements LightDriver {
  readonly brand: Brand = 'hue';

  private api?: any;
  private config?: HueConfig;
  private lights: Map<string, any> = new Map(); // raw hue light objects
  private v2IdToV1Id: Map<string, string> = new Map(); // CLIP v2 UUID -> v1 numeric ID
  private eventStreamReq?: ReturnType<typeof https.request>;

  // Command coalescing: max 1 in-flight + 1 pending per device
  private inFlight: Record<string, boolean> = {};
  private pending: Record<string, { state: Partial<LightState>; transition?: number }> = {};

  // Callback for pushing real-time updates
  onUpdate?: (deviceId: string, state: LightState) => void;

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
    if (!this.api || !this.config) return [];

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

    // Fetch CLIP v2 lights to build UUID -> v1 ID mapping for EventStream
    await this.buildV2Mapping();

    return lights;
  }

  private async buildV2Mapping(): Promise<void> {
    if (!this.config) return;

    return new Promise((resolve) => {
      const options = {
        hostname: this.config!.bridgeIp,
        path: '/clip/v2/resource/light',
        method: 'GET',
        headers: { 'hue-application-key': this.config!.username },
        rejectUnauthorized: false,
      };

      const req = https.request(options, (res) => {
        if (res.statusCode !== 200) {
          console.log('Hue: failed to fetch CLIP v2 lights for mapping');
          resolve();
          return;
        }

        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data) as { data: Array<{ id: string; id_v1: string }> };
            for (const light of json.data) {
              const v1Id = light.id_v1?.replace('/lights/', '');
              if (v1Id) {
                this.v2IdToV1Id.set(light.id, v1Id);
              }
            }
            console.log(`Hue: mapped ${this.v2IdToV1Id.size} lights for EventStream`);
          } catch {
            console.log('Hue: could not parse v2 mapping response');
          }
          resolve();
        });
      });

      req.on('error', () => {
        console.log('Hue: could not build v2 mapping, will use polling fallback');
        resolve();
      });

      req.end();
    });
  }

  async getState(deviceId: string): Promise<LightState> {
    if (!this.api) return { on: false };

    const hueId = parseInt(deviceId);
    const hueLight = await this.api.lights.getLight(hueId);
    return this.mapState(hueLight.state);
  }

  async setState(deviceId: string, state: Partial<LightState>, transition?: number): Promise<void> {
    if (!this.api) throw new Error('Hue not connected');

    // Command coalescing: if something is in-flight, just update pending
    if (this.inFlight[deviceId]) {
      const existing = this.pending[deviceId];
      this.pending[deviceId] = {
        state: { ...(existing?.state || {}), ...state },
        transition,
      };
      return;
    }

    await this.sendCommand(deviceId, state, transition);
  }

  private async sendCommand(deviceId: string, state: Partial<LightState>, transition?: number): Promise<void> {
    if (!this.api) return;

    this.inFlight[deviceId] = true;

    try {
      const hueId = parseInt(deviceId);
      const lightState = new v3.lightStates.LightState();

      if (state.on !== undefined) {
        lightState.on(state.on);
      }
      if (state.brightness !== undefined) {
        lightState.brightness(state.brightness);
      }
      // Color temperature and color are mutually exclusive - temperature takes priority
      if (state.temperature !== undefined) {
        // Convert Kelvin to mired - this switches the light to CT mode
        const mired = Math.round(1000000 / state.temperature);
        lightState.ct(Math.max(153, Math.min(500, mired)));
        // Don't set color when setting temperature
      } else if (state.color !== undefined) {
        // Convert standard HSV hue to Hue's proprietary hue scale
        // Hue API: Red=0, Green=25500, Blue=46920 (not linear with standard HSV)
        const hueApiValue = this.hsvHueToHueApi(state.color.h);
        lightState.hue(hueApiValue);
        lightState.sat(Math.round(state.color.s * 2.54));
      }
      // Hue uses 100ms units. Default is 4 (400ms) which feels laggy.
      // Use 0 for instant response unless explicitly specified.
      lightState.transitiontime(transition !== undefined ? Math.round(transition / 100) : 0);

      await this.api.lights.setLightState(hueId, lightState);
    } finally {
      this.inFlight[deviceId] = false;

      // Process pending command if any
      const pendingCmd = this.pending[deviceId];
      if (pendingCmd) {
        delete this.pending[deviceId];
        this.sendCommand(deviceId, pendingCmd.state, pendingCmd.transition).catch(() => {});
      }
    }
  }

  async dispose(): Promise<void> {
    // Close EventStream connection
    if (this.eventStreamReq) {
      this.eventStreamReq.destroy();
      this.eventStreamReq = undefined;
    }
  }

  async startListening(): Promise<void> {
    if (!this.config || this.v2IdToV1Id.size === 0) {
      console.log('Hue: EventStream not available, will rely on polling');
      return;
    }

    const url = `https://${this.config.bridgeIp}/eventstream/clip/v2`;
    console.log('Hue: connecting to EventStream...');

    const options = {
      hostname: this.config.bridgeIp,
      path: '/eventstream/clip/v2',
      method: 'GET',
      headers: {
        'hue-application-key': this.config.username,
        'Accept': 'text/event-stream',
      },
      rejectUnauthorized: false, // Hue bridge uses self-signed cert
    };

    this.eventStreamReq = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        console.log(`Hue: EventStream failed with status ${res.statusCode}`);
        return;
      }

      console.log('Hue: EventStream connected');
      let buffer = '';

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();

        // SSE format: "data: {...}\n\n"
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || ''; // Keep incomplete data in buffer

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const events = JSON.parse(line.slice(6));
              this.handleEventStreamData(events);
            } catch {
              // Ignore parse errors
            }
          }
        }
      });

      res.on('end', () => {
        console.log('Hue: EventStream disconnected, reconnecting...');
        setTimeout(() => this.startListening(), 2000);
      });

      res.on('error', (err) => {
        console.log('Hue: EventStream error:', err.message);
        setTimeout(() => this.startListening(), 5000);
      });
    });

    this.eventStreamReq.on('error', (err) => {
      console.log('Hue: EventStream request error:', err.message);
      setTimeout(() => this.startListening(), 5000);
    });

    this.eventStreamReq.end();
  }

  private handleEventStreamData(events: any[]): void {
    for (const event of events) {
      if (event.type !== 'update' || !event.data) continue;

      for (const item of event.data) {
        if (item.type !== 'light') continue;

        const v1Id = this.v2IdToV1Id.get(item.id);
        if (!v1Id || !this.onUpdate) continue;

        // Parse CLIP v2 state format
        const state = this.mapV2State(item);
        if (state) {
          this.onUpdate(v1Id, state);
        }
      }
    }
  }

  private mapV2State(v2Light: any): LightState | null {
    const state: LightState = { on: true };
    let hasData = false;

    if (v2Light.on !== undefined) {
      state.on = v2Light.on.on;
      hasData = true;
    }

    if (v2Light.dimming !== undefined) {
      state.brightness = Math.round(v2Light.dimming.brightness);
      hasData = true;
    }

    if (v2Light.color !== undefined && v2Light.color.xy) {
      // Convert CIE xy to HSV (approximate)
      const { x, y } = v2Light.color.xy;
      const hs = this.xyToHs(x, y);
      state.color = hs;
      hasData = true;
    }

    if (v2Light.color_temperature !== undefined && v2Light.color_temperature.mirek) {
      state.temperature = Math.round(1000000 / v2Light.color_temperature.mirek);
      hasData = true;
    }

    return hasData ? state : null;
  }

  private xyToHs(x: number, y: number): { h: number; s: number } {
    // Convert CIE xy to approximate HSV
    // This is a simplified conversion - CIE xy to RGB to HSV
    const z = 1 - x - y;
    const Y = 1; // Brightness normalized
    const X = (Y / y) * x;
    const Z = (Y / y) * z;

    // XYZ to sRGB (D65)
    let r = X * 3.2406 - Y * 1.5372 - Z * 0.4986;
    let g = -X * 0.9689 + Y * 1.8758 + Z * 0.0415;
    let b = X * 0.0557 - Y * 0.2040 + Z * 1.0570;

    // Gamma correction
    r = r > 0.0031308 ? 1.055 * Math.pow(r, 1 / 2.4) - 0.055 : 12.92 * r;
    g = g > 0.0031308 ? 1.055 * Math.pow(g, 1 / 2.4) - 0.055 : 12.92 * g;
    b = b > 0.0031308 ? 1.055 * Math.pow(b, 1 / 2.4) - 0.055 : 12.92 * b;

    // Clamp
    r = Math.max(0, Math.min(1, r));
    g = Math.max(0, Math.min(1, g));
    b = Math.max(0, Math.min(1, b));

    // RGB to HSV
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;

    let h = 0;
    const s = max === 0 ? 0 : d / max;

    if (d !== 0) {
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: h = ((b - r) / d + 2) / 6; break;
        case b: h = ((r - g) / d + 4) / 6; break;
      }
    }

    return {
      h: Math.round(h * 360),
      s: Math.round(s * 100),
    };
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
        h: this.hueApiToHsvHue(hueState.hue),
        s: Math.round(hueState.sat / 2.54),
      };
    }
    if (hueState.ct !== undefined) {
      state.temperature = Math.round(1000000 / hueState.ct);
    }

    return state;
  }

  // Convert standard HSV hue (0-360) to Hue API value (0-65535)
  // Hue API uses non-linear mapping: Red=0, Green=25500, Blue=46920
  private hsvHueToHueApi(h: number): number {
    h = ((h % 360) + 360) % 360; // Normalize to 0-360

    if (h <= 120) {
      // Red (0°) to Green (120°) → 0 to 25500
      return Math.round((h / 120) * 25500);
    } else if (h <= 240) {
      // Green (120°) to Blue (240°) → 25500 to 46920
      return Math.round(25500 + ((h - 120) / 120) * (46920 - 25500));
    } else {
      // Blue (240°) to Red (360°) → 46920 to 65535
      return Math.round(46920 + ((h - 240) / 120) * (65535 - 46920));
    }
  }

  // Convert Hue API value (0-65535) to standard HSV hue (0-360)
  private hueApiToHsvHue(hueApi: number): number {
    if (hueApi <= 25500) {
      // 0 to 25500 → Red (0°) to Green (120°)
      return Math.round((hueApi / 25500) * 120);
    } else if (hueApi <= 46920) {
      // 25500 to 46920 → Green (120°) to Blue (240°)
      return Math.round(120 + ((hueApi - 25500) / (46920 - 25500)) * 120);
    } else {
      // 46920 to 65535 → Blue (240°) to Red (360°)
      return Math.round(240 + ((hueApi - 46920) / (65535 - 46920)) * 120);
    }
  }
}
