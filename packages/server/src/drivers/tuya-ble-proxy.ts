/**
 * Tuya BLE Proxy Driver
 *
 * Implements LightDriver interface by spawning ble-service as a child process
 * and communicating via stdio JSON-RPC.
 */

import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { Light, LightState, LightDriver, Brand, Capability } from '@lightbox/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Message types (must match ble-service.ts)
interface BLECommand {
  id: number;
  method: 'initialize' | 'discover' | 'setState' | 'getState' | 'dispose';
  params?: {
    deviceId?: string;
    state?: Partial<LightState>;
    transition?: number;
  };
}

interface BLEResponse {
  id: number;
  result?: unknown;
  error?: string;
}

interface BLEEvent {
  event: 'update' | 'debug' | 'debug_update' | 'diagnostics' | 'ready' | 'log';
  data: unknown;
}

type BLEMessage = BLEResponse | BLEEvent;

function isEvent(msg: BLEMessage): msg is BLEEvent {
  return 'event' in msg;
}

/**
 * Tuya BLE Proxy Driver
 */
export class TuyaBLEProxyDriver implements LightDriver {
  readonly brand: Brand = 'tuya-ble' as Brand;

  private process: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private commandId = 0;
  private pendingCommands = new Map<number, {
    resolve: (result: unknown) => void;
    reject: (err: Error) => void;
  }>();
  private lights: Light[] = [];
  private diagnosticsCache: Record<string, { connected: boolean; reachable: boolean }> = {};
  private respawning = false;

  // Callbacks for real-time updates
  onUpdate?: (deviceId: string, state: LightState) => void;
  onDebug?: (id: string, deviceName: string, message: string, direction: 'in' | 'out') => void;
  onDebugUpdate?: (id: string, message: string) => void;
  onDiagnosticsChange?: () => void;

  private spawnProcess(): void {
    // Use tsx for TypeScript execution in development
    const servicePath = join(__dirname, '../services/ble-service.ts');

    console.log('Tuya BLE Proxy: spawning BLE service...');
    this.process = spawn('npx', ['tsx', servicePath], {
      stdio: ['pipe', 'pipe', 'inherit'], // stdin, stdout piped; stderr inherited
      cwd: join(__dirname, '../..'),
    });

    // Set up stdout reading
    this.rl = readline.createInterface({
      input: this.process.stdout!,
      terminal: false,
    });

    this.rl.on('line', (line: string) => {
      this.handleMessage(line);
    });

    // Handle process exit
    this.process.on('exit', (code, signal) => {
      console.log(`Tuya BLE Proxy: BLE service exited (code=${code}, signal=${signal})`);
      this.handleProcessExit();
    });

    this.process.on('error', (err) => {
      console.error('Tuya BLE Proxy: BLE service error:', err);
    });
  }

  private handleMessage(line: string): void {
    if (!line.trim()) return;

    try {
      const msg = JSON.parse(line) as BLEMessage;

      if (isEvent(msg)) {
        this.handleEvent(msg);
      } else {
        this.handleResponse(msg);
      }
    } catch (err) {
      console.error('Tuya BLE Proxy: failed to parse message:', line);
    }
  }

  private handleEvent(event: BLEEvent): void {
    switch (event.event) {
      case 'ready':
        console.log('Tuya BLE Proxy: BLE service ready');
        break;

      case 'update': {
        const { deviceId, state } = event.data as { deviceId: string; state: LightState };
        if (this.onUpdate) {
          this.onUpdate(deviceId, state);
        }
        break;
      }

      case 'debug': {
        const { id, deviceName, message, direction } = event.data as {
          id: string;
          deviceName: string;
          message: string;
          direction: 'in' | 'out';
        };
        if (this.onDebug) {
          this.onDebug(id, deviceName, message, direction);
        }
        break;
      }

      case 'debug_update': {
        const { id, message } = event.data as { id: string; message: string };
        if (this.onDebugUpdate) {
          this.onDebugUpdate(id, message);
        }
        break;
      }

      case 'diagnostics': {
        this.diagnosticsCache = event.data as Record<string, { connected: boolean; reachable: boolean }>;
        if (this.onDiagnosticsChange) {
          this.onDiagnosticsChange();
        }
        break;
      }

      case 'log':
        console.log('Tuya BLE Proxy [service]:', event.data);
        break;
    }
  }

  private handleResponse(response: BLEResponse): void {
    const pending = this.pendingCommands.get(response.id);
    if (!pending) {
      console.warn('Tuya BLE Proxy: received response for unknown command:', response.id);
      return;
    }

    this.pendingCommands.delete(response.id);

    if (response.error) {
      pending.reject(new Error(response.error));
    } else {
      pending.resolve(response.result);
    }
  }

  private handleProcessExit(): void {
    // Mark all lights as unreachable
    for (const id of Object.keys(this.diagnosticsCache)) {
      this.diagnosticsCache[id] = { connected: false, reachable: false };
    }
    if (this.onDiagnosticsChange) {
      this.onDiagnosticsChange();
    }

    // Reject all pending commands
    for (const [id, pending] of this.pendingCommands) {
      pending.reject(new Error('BLE service exited'));
    }
    this.pendingCommands.clear();

    // Respawn after a delay
    if (!this.respawning) {
      this.respawning = true;
      console.log('Tuya BLE Proxy: will respawn BLE service in 2 seconds...');
      setTimeout(() => {
        this.respawning = false;
        this.spawnProcess();
        // Re-initialize after respawn
        this.sendCommand('initialize', {}).catch((err) => {
          console.error('Tuya BLE Proxy: failed to reinitialize after respawn:', err);
        });
      }, 2000);
    }
  }

  private async sendCommand(method: BLECommand['method'], params?: BLECommand['params']): Promise<unknown> {
    if (!this.process || !this.process.stdin) {
      throw new Error('BLE service not running');
    }

    const id = ++this.commandId;
    const cmd: BLECommand = { id, method, params };

    return new Promise((resolve, reject) => {
      this.pendingCommands.set(id, { resolve, reject });

      const json = JSON.stringify(cmd) + '\n';
      this.process!.stdin!.write(json, (err) => {
        if (err) {
          this.pendingCommands.delete(id);
          reject(err);
        }
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingCommands.has(id)) {
          this.pendingCommands.delete(id);
          reject(new Error('Command timeout'));
        }
      }, 30000);
    });
  }

  async initialize(): Promise<void> {
    this.spawnProcess();

    // Wait for ready event (with timeout)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('BLE service did not become ready'));
      }, 10000);

      const checkReady = setInterval(() => {
        // Process should be running
        if (this.process && !this.process.killed) {
          clearInterval(checkReady);
          clearTimeout(timeout);
          resolve();
        }
      }, 100);
    });

    await this.sendCommand('initialize');
  }

  async discover(): Promise<Light[]> {
    const result = await this.sendCommand('discover') as Light[];
    this.lights = result;

    // Initialize diagnostics cache
    for (const light of result) {
      const deviceId = light.id.replace('tuya-ble:', '');
      this.diagnosticsCache[light.id] = {
        connected: light.reachable,
        reachable: light.reachable,
      };
    }

    return result;
  }

  async getState(deviceId: string): Promise<LightState> {
    const result = await this.sendCommand('getState', { deviceId });
    return result as LightState;
  }

  async setState(deviceId: string, state: Partial<LightState>, transition?: number): Promise<void> {
    await this.sendCommand('setState', { deviceId, state, transition });
  }

  getDiagnostics(): Record<string, { connected: boolean; reachable: boolean }> {
    return { ...this.diagnosticsCache };
  }

  async dispose(): Promise<void> {
    if (this.process) {
      try {
        await this.sendCommand('dispose');
      } catch {
        // Ignore errors during dispose
      }

      // Give it a moment to clean up
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Force kill if still running
      if (this.process && !this.process.killed) {
        this.process.kill('SIGTERM');
      }
    }

    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }

    this.process = null;
    this.pendingCommands.clear();
  }
}
