/**
 * Tuya BLE Service - Standalone process for BLE device management
 *
 * Communicates with main server via stdio JSON-RPC:
 * - Reads JSON commands from stdin (one per line)
 * - Writes JSON events/responses to stdout (one per line)
 *
 * Run with: pnpm ble (or: tsx src/services/ble-service.ts)
 */

// Redirect console.log to stderr BEFORE importing anything else
// This ensures driver logs don't break the JSON protocol on stdout
const originalLog = console.log;
console.log = (...args: unknown[]) => {
  console.error('[log]', ...args);
};

import * as readline from 'readline';
import { TuyaBLEDriver } from '../drivers/tuya-ble.js';
import type { LightState } from '@lightbox/shared';

// Message types
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

// Send a message to stdout (main server)
function send(msg: BLEResponse | BLEEvent): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// Log to stderr (for debugging - doesn't interfere with protocol)
function log(...args: unknown[]): void {
  console.error('[BLE Service]', ...args);
}

// Create the driver instance
const driver = new TuyaBLEDriver();

// Wire up callbacks to emit events
driver.onUpdate = (deviceId: string, state: LightState) => {
  send({ event: 'update', data: { deviceId, state } });
};

driver.onDebug = (id: string, deviceName: string, message: string, direction: 'in' | 'out') => {
  send({ event: 'debug', data: { id, deviceName, message, direction } });
};

driver.onDebugUpdate = (id: string, message: string) => {
  send({ event: 'debug_update', data: { id, message } });
};

driver.onDiagnosticsChange = () => {
  send({ event: 'diagnostics', data: driver.getDiagnostics() });
};

// Handle incoming commands
async function handleCommand(cmd: BLECommand): Promise<void> {
  try {
    let result: unknown;

    switch (cmd.method) {
      case 'initialize':
        await driver.initialize();
        result = { ok: true };
        break;

      case 'discover':
        result = await driver.discover();
        break;

      case 'setState':
        if (!cmd.params?.deviceId) {
          throw new Error('deviceId required');
        }
        await driver.setState(
          cmd.params.deviceId,
          cmd.params.state || {},
          cmd.params.transition
        );
        result = { ok: true };
        break;

      case 'getState':
        if (!cmd.params?.deviceId) {
          throw new Error('deviceId required');
        }
        result = await driver.getState(cmd.params.deviceId);
        break;

      case 'dispose':
        await driver.dispose();
        result = { ok: true };
        // Exit after dispose
        setTimeout(() => process.exit(0), 100);
        break;

      default:
        throw new Error(`Unknown method: ${cmd.method}`);
    }

    send({ id: cmd.id, result });
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    send({ id: cmd.id, error });
  }
}

// Set up stdin reading
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', (line: string) => {
  if (!line.trim()) return;

  try {
    const cmd = JSON.parse(line) as BLECommand;
    handleCommand(cmd).catch((err) => {
      log('Command handler error:', err);
    });
  } catch (err) {
    log('Failed to parse command:', line, err);
  }
});

rl.on('close', () => {
  log('stdin closed, shutting down...');
  driver.dispose().finally(() => process.exit(0));
});

// Handle signals
process.on('SIGTERM', () => {
  log('Received SIGTERM, shutting down...');
  driver.dispose().finally(() => process.exit(0));
});

process.on('SIGINT', () => {
  log('Received SIGINT, shutting down...');
  driver.dispose().finally(() => process.exit(0));
});

// Notify that we're ready
log('BLE Service starting...');
send({ event: 'ready', data: { pid: process.pid } });
