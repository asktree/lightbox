import { v3 } from 'node-hue-api';
import type { Light, LightState, LightDriver, Brand, Capability } from '@lightbox/shared';
import { hsToXy, xyToHs, clipToGamut, GAMUTS, type Gamut } from '@lightbox/shared';
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
  // Non-light CLIP v2 EventStream items (button, relative_rotary). The
  // tap-dial service consumes these.
  onRemoteEvent?: (item: any) => void;

  // Debug logging callbacks (initialized so 'in' check works)
  onDebug: ((id: string, deviceName: string, message: string, direction: 'in' | 'out') => void) | undefined = undefined;
  onDebugUpdate: ((id: string, message: string) => void) | undefined = undefined;
  private debugSeq = 0;

  private emitDebug(deviceName: string, message: string, direction: 'in' | 'out'): string {
    const id = `hue-${++this.debugSeq}`;
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
      // Store by numeric ID (what setState receives after prefix stripping)
      this.lights.set(String(hueLight.id), hueLight);

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

  // Generic bounded CLIP v2 GET. The tap-dial service uses it to map button
  // resource ids to control ids.
  async getClipResource(rtype: string): Promise<any[]> {
    if (!this.config) return [];
    return new Promise((resolve) => {
      const req = https.request({
        hostname: this.config!.bridgeIp,
        path: `/clip/v2/resource/${rtype}`,
        method: 'GET',
        headers: { 'hue-application-key': this.config!.username },
        rejectUnauthorized: false,
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data).data ?? []); } catch { resolve([]); }
        });
      });
      req.on('error', () => resolve([]));
      req.setTimeout(10000, () => { req.destroy(); resolve([]); });
      req.end();
    });
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

      // Bounded like every other outbound call — a SYN blackhole here would
      // otherwise hang connect() forever.
      req.setTimeout(10_000, () => req.destroy(new Error('v2 mapping request timeout')));

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
    const hueId = parseInt(deviceId);
    const light = this.lights.get(deviceId);
    const deviceName = light?.name || `Light ${hueId}`;

    // Build summary for debug log
    const parts: string[] = [];
    if (state.on !== undefined) parts.push(state.on ? 'on' : 'off');
    if (state.brightness !== undefined) parts.push(`bri:${state.brightness}`);
    if (state.color !== undefined) parts.push(`h:${state.color.h} s:${state.color.s}`);
    if (state.temperature !== undefined) parts.push(`ct:${state.temperature}K`);
    const summary = parts.join(' ');

    const logId = this.emitDebug(deviceName, `${summary} (...)`, 'out');
    const startTime = Date.now();

    try {
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
        // The UI shows sRGB colours. Send the exact chromaticity of that sRGB
        // colour as CIE xy (clipped to this bulb's gamut) instead of Hue's
        // hue/sat, whose scale is bulb-defined and doesn't match the wheel.
        const xy = clipToGamut(hsToXy(state.color.h, state.color.s), this.gamutFor(hueId));
        lightState.xy(xy.x, xy.y);
      }
      // Hue uses 100ms units. Default is 4 (400ms) which feels laggy.
      // Use 0 for instant response unless explicitly specified.
      lightState.transitiontime(transition !== undefined ? Math.round(transition / 100) : 0);

      await this.api.lights.setLightState(hueId, lightState);
      const elapsed = Date.now() - startTime;
      this.updateDebug(logId, `${summary} (✓ ${elapsed}ms)`);
    } catch (err: any) {
      const elapsed = Date.now() - startTime;
      this.updateDebug(logId, `${summary} (✗ ${elapsed}ms)`);
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

    // Connect-phase timeout only: once headers arrive the stream may sit
    // silent indefinitely (that's normal SSE), so an idle timeout would kill
    // healthy connections — but a connect that never answers must not hang.
    const connectTimer = setTimeout(() => {
      console.log('Hue: EventStream connect timeout');
      this.eventStreamReq?.destroy(new Error('EventStream connect timeout'));
    }, 10_000);

    this.eventStreamReq = https.request(options, (res) => {
      clearTimeout(connectTimer);
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
      clearTimeout(connectTimer);
      console.log('Hue: EventStream request error:', err.message);
      setTimeout(() => this.startListening(), 5000);
    });

    this.eventStreamReq.end();
  }

  private handleEventStreamData(events: any[]): void {
    for (const event of events) {
      if (event.type !== 'update' || !event.data) continue;

      for (const item of event.data) {
        if (item.type === 'button' || item.type === 'relative_rotary') {
          this.onRemoteEvent?.(item);
          continue;
        }
        if (item.type !== 'light') continue;

        const v1Id = this.v2IdToV1Id.get(item.id);
        if (!v1Id) continue;

        // Parse CLIP v2 state format
        const state = this.mapV2State(item);
        if (state) {
          // Log incoming state update
          const light = this.lights.get(v1Id);
          const deviceName = light?.name || `Light ${v1Id}`;
          const parts: string[] = [];
          if (state.on !== undefined) parts.push(state.on ? 'on' : 'off');
          if (state.brightness !== undefined) parts.push(`bri:${state.brightness}`);
          if (state.color !== undefined) parts.push(`h:${state.color.h} s:${state.color.s}`);
          if (state.temperature !== undefined) parts.push(`ct:${state.temperature}K`);
          if (parts.length > 0) {
            this.emitDebug(deviceName, parts.join(' '), 'in');
          }

          if (this.onUpdate) {
            this.onUpdate(v1Id, state);
          }
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
      state.color = xyToHs({ x: v2Light.color.xy.x, y: v2Light.color.xy.y });
      hasData = true;
    }

    if (v2Light.color_temperature !== undefined && v2Light.color_temperature.mirek) {
      state.temperature = Math.round(1000000 / v2Light.color_temperature.mirek);
      hasData = true;
    }

    return hasData ? state : null;
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
    if (Array.isArray(hueState.xy) && hueState.xy.length === 2) {
      state.color = xyToHs({ x: hueState.xy[0], y: hueState.xy[1] });
    } else if (hueState.hue !== undefined && hueState.sat !== undefined) {
      // very old firmware without xy: fall back to Hue's own hue/sat scale
      state.color = {
        h: Math.round((hueState.hue / 65535) * 360),
        s: Math.round(hueState.sat / 2.54),
      };
    }
    if (hueState.ct !== undefined) {
      state.temperature = Math.round(1000000 / hueState.ct);
    }

    return state;
  }

  /** Gamut triangle reported by the bridge for this bulb (defaults to Gamut C). */
  private gamutFor(hueId: string | number): Gamut {
    const raw = this.lights.get(String(hueId));
    const ctl = raw?.capabilities?.control ?? raw?._data?.capabilities?.control ?? raw?.data?.capabilities?.control;
    const pts: number[][] | undefined = ctl?.colorgamut;
    if (pts && pts.length === 3) {
      return { r: { x: pts[0][0], y: pts[0][1] }, g: { x: pts[1][0], y: pts[1][1] }, b: { x: pts[2][0], y: pts[2][1] } };
    }
    if (ctl?.colorgamuttype === 'A') return GAMUTS.hueA;
    if (ctl?.colorgamuttype === 'B') return GAMUTS.hueB;
    return GAMUTS.hueC;
  }
}
