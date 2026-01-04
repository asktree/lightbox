import { createSocket, Socket } from 'dgram';
import type { Light, LightState, LightDriver, Brand, Capability } from '@lightbox/shared';

/**
 * Govee LAN control driver.
 *
 * Protocol overview:
 * - Discovery: Send UDP broadcast to port 4001, devices respond with info
 * - Control: Send JSON commands to device IP on port 4003
 *
 * Devices must have LAN control enabled in the Govee app.
 */

const DISCOVERY_PORT = 4001;
const CONTROL_PORT = 4003;
const BROADCAST_ADDR = '239.255.255.250';

interface GoveeDevice {
  ip: string;
  device: string; // device ID
  model: string;
  state: {
    onOff: number;
    brightness: number;
    color: { r: number; g: number; b: number };
    colorTemInKelvin: number;
  };
}

export class GoveeDriver implements LightDriver {
  readonly brand: Brand = 'govee';

  private socket?: Socket;
  private devices: Map<string, GoveeDevice> = new Map();

  async initialize(): Promise<void> {
    // Create UDP socket for discovery and control
    this.socket = createSocket('udp4');

    this.socket.on('error', (err) => {
      console.error('Govee UDP error:', err);
    });

    await new Promise<void>((resolve) => {
      this.socket!.bind(() => {
        this.socket!.setBroadcast(true);
        resolve();
      });
    });

    console.log('Govee driver: initialized UDP socket');
  }

  async discover(): Promise<Light[]> {
    // Send discovery message
    const scanMsg = JSON.stringify({
      msg: {
        cmd: 'scan',
        data: {
          account_topic: 'reserve',
        },
      },
    });

    return new Promise((resolve) => {
      const discovered: Light[] = [];
      const timeout = setTimeout(() => {
        this.socket?.removeAllListeners('message');
        resolve(discovered);
      }, 3000);

      this.socket?.on('message', (msg, rinfo) => {
        try {
          const data = JSON.parse(msg.toString());
          if (data.msg?.cmd === 'scan' && data.msg?.data) {
            const device = data.msg.data as GoveeDevice;
            device.ip = rinfo.address;

            this.devices.set(device.device, device);

            discovered.push({
              id: `govee:${device.device}`,
              name: `Govee ${device.model}`,
              brand: 'govee',
              capabilities: this.getCapabilities(device.model),
              state: this.mapState(device.state),
              reachable: true,
            });
          }
        } catch {
          // Ignore parse errors
        }
      });

      // Send to multicast address
      this.socket?.send(scanMsg, DISCOVERY_PORT, BROADCAST_ADDR);
    });
  }

  async getState(deviceId: string): Promise<LightState> {
    const device = this.devices.get(deviceId);
    if (!device) {
      return { on: false };
    }

    // Request current state
    const statusMsg = JSON.stringify({
      msg: {
        cmd: 'devStatus',
        data: {},
      },
    });

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(this.mapState(device.state));
      }, 1000);

      const handler = (msg: Buffer) => {
        try {
          const data = JSON.parse(msg.toString());
          if (data.msg?.cmd === 'devStatus' && data.msg?.data) {
            clearTimeout(timeout);
            this.socket?.removeListener('message', handler);
            device.state = data.msg.data;
            resolve(this.mapState(data.msg.data));
          }
        } catch {
          // Ignore
        }
      };

      this.socket?.on('message', handler);
      this.socket?.send(statusMsg, CONTROL_PORT, device.ip);
    });
  }

  async setState(deviceId: string, state: Partial<LightState>, transition?: number): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) {
      throw new Error(`Device not found: ${deviceId}`);
    }

    // Send commands for each property
    const commands: any[] = [];

    if (state.on !== undefined) {
      commands.push({
        msg: {
          cmd: 'turn',
          data: { value: state.on ? 1 : 0 },
        },
      });
    }

    if (state.brightness !== undefined) {
      commands.push({
        msg: {
          cmd: 'brightness',
          data: { value: state.brightness },
        },
      });
    }

    if (state.color !== undefined) {
      // Convert HSV to RGB
      const rgb = this.hsvToRgb(state.color.h, state.color.s, 100);
      commands.push({
        msg: {
          cmd: 'colorwc',
          data: {
            color: rgb,
            colorTemInKelvin: 0,
          },
        },
      });
    }

    if (state.temperature !== undefined) {
      commands.push({
        msg: {
          cmd: 'colorwc',
          data: {
            color: { r: 0, g: 0, b: 0 },
            colorTemInKelvin: state.temperature,
          },
        },
      });
    }

    // Send all commands
    for (const cmd of commands) {
      this.socket?.send(JSON.stringify(cmd), CONTROL_PORT, device.ip);
      // Small delay between commands
      await new Promise((r) => setTimeout(r, 50));
    }

    // Update local state
    if (state.on !== undefined) device.state.onOff = state.on ? 1 : 0;
    if (state.brightness !== undefined) device.state.brightness = state.brightness;
    if (state.color !== undefined) {
      const rgb = this.hsvToRgb(state.color.h, state.color.s, 100);
      device.state.color = rgb;
    }
    if (state.temperature !== undefined) {
      device.state.colorTemInKelvin = state.temperature;
    }
  }

  async dispose(): Promise<void> {
    this.socket?.close();
  }

  private getCapabilities(model: string): Capability[] {
    // Most Govee lights support all these
    return ['on_off', 'brightness', 'color', 'temperature'];
  }

  private mapState(goveeState: GoveeDevice['state']): LightState {
    const state: LightState = {
      on: goveeState.onOff === 1,
      brightness: goveeState.brightness,
    };

    if (goveeState.colorTemInKelvin > 0) {
      state.temperature = goveeState.colorTemInKelvin;
    } else if (goveeState.color) {
      const hsv = this.rgbToHsv(goveeState.color.r, goveeState.color.g, goveeState.color.b);
      state.color = { h: hsv.h, s: hsv.s };
    }

    return state;
  }

  private hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
    h = h / 360;
    s = s / 100;
    v = v / 100;

    let r = 0, g = 0, b = 0;
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);

    switch (i % 6) {
      case 0: r = v; g = t; b = p; break;
      case 1: r = q; g = v; b = p; break;
      case 2: r = p; g = v; b = t; break;
      case 3: r = p; g = q; b = v; break;
      case 4: r = t; g = p; b = v; break;
      case 5: r = v; g = p; b = q; break;
    }

    return {
      r: Math.round(r * 255),
      g: Math.round(g * 255),
      b: Math.round(b * 255),
    };
  }

  private rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
    r /= 255;
    g /= 255;
    b /= 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;

    let h = 0;
    const s = max === 0 ? 0 : d / max;
    const v = max;

    if (max !== min) {
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h /= 6;
    }

    return {
      h: Math.round(h * 360),
      s: Math.round(s * 100),
      v: Math.round(v * 100),
    };
  }
}
