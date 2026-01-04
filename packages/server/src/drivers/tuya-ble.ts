/**
 * Tuya BLE Driver for BT-only devices (sunset lamps, etc.)
 *
 * Protocol based on reverse-engineering of Home Assistant Tuya BLE integration.
 * Uses encrypted communication with local key from Tuya cloud.
 */

import type { Light, LightState, LightDriver, Brand, Capability } from '@lightbox/shared';

// Dynamic import for noble - may not be available on all platforms
let noble: typeof import('@abandonware/noble') | null = null;
let nobleLoadError: Error | null = null;

try {
  noble = (await import('@abandonware/noble')).default;
} catch (err) {
  nobleLoadError = err as Error;
  console.warn('Tuya BLE: noble not available, BLE devices will be disabled');
  console.warn('  Reason:', (err as Error).message);
}
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  deriveLoginKey,
  deriveSessionKey,
  buildPacket,
  parsePacket,
  segmentPacket,
  FUNC,
  SECURITY,
} from '../lib/tuya-ble-crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(__dirname, '../../data');
const DEVICES_FILE = join(CONFIG_DIR, 'tuya-devices.json');

// Tuya BLE UUIDs
const TUYA_SERVICE_UUID = 'fd50';
const TUYA_WRITE_UUID = '00000001000010018001000805f9b07d0';
const TUYA_NOTIFY_UUID = '00000002000010018001000805f9b07d0';

interface TuyaBLEDeviceConfig {
  name: string;
  id: string;
  key: string;
  protocol: 'ble';
  category?: string;
  mac?: string;
}

interface TuyaBLEDevice {
  config: TuyaBLEDeviceConfig;
  peripheral: any | null;  // noble.Peripheral when available
  writeChar: any | null;   // noble.Characteristic when available
  notifyChar: any | null;  // noble.Characteristic when available
  state: LightState;
  connected: boolean;
  paired: boolean;
  loginKey: Buffer;
  sessionKey: Buffer | null;
  seqNum: number;
  pendingResponses: Map<number, { resolve: (payload: Buffer) => void; reject: (err: Error) => void }>;
  reconnectTimer?: NodeJS.Timeout;
  // For reassembling chunked responses
  rxBuffer: Buffer;
  rxExpectedLength: number;
}

/**
 * Tuya BLE Driver
 */
export class TuyaBLEDriver implements LightDriver {
  // Use distinct brand to avoid conflicts with WiFi TuyaDriver
  readonly brand: Brand = 'tuya-ble' as Brand;

  private devices: Map<string, TuyaBLEDevice> = new Map();
  private configs: TuyaBLEDeviceConfig[] = [];
  private scanning = false;
  private initialized = false;

  // Callback for real-time updates
  onUpdate?: (deviceId: string, state: LightState) => void;

  // Callbacks for debug messages
  onDebug?: (id: string, deviceName: string, message: string, direction: 'in' | 'out') => void;
  onDebugUpdate?: (id: string, message: string) => void;

  // Callback for connection state changes
  onDiagnosticsChange?: () => void;

  private debugSeq = 0;

  private emitDebug(deviceName: string, message: string, direction: 'in' | 'out'): string {
    const id = `tuya-ble-${++this.debugSeq}`;
    if (this.onDebug) {
      this.onDebug(id, deviceName, message, direction);
    }
    return id;
  }

  async initialize(): Promise<void> {
    if (!existsSync(DEVICES_FILE)) {
      console.log('Tuya BLE: no devices.json found');
      return;
    }

    try {
      const allConfigs = JSON.parse(readFileSync(DEVICES_FILE, 'utf-8'));
      // Filter to only BLE devices
      this.configs = allConfigs.filter((c: any) => c.protocol === 'ble');
      console.log(`Tuya BLE: loaded ${this.configs.length} BLE device configs`);
    } catch (err) {
      console.error('Tuya BLE: failed to parse devices.json:', err);
    }

    // Skip noble initialization if not available
    if (!noble) {
      return;
    }

    // Initialize noble (we know it's non-null after the check above)
    const n = noble!;
    n.on('stateChange', (state: string) => {
      console.log(`Tuya BLE: adapter state: ${state}`);
      if (state === 'poweredOn' && !this.initialized) {
        this.initialized = true;
      }
    });

    // Wait for noble to be ready
    await new Promise<void>((resolve) => {
      if ((n as any).state === 'poweredOn') {
        this.initialized = true;
        resolve();
      } else {
        n.once('stateChange', (state: string) => {
          if (state === 'poweredOn') {
            this.initialized = true;
            resolve();
          }
        });
      }
    });
  }

  async discover(): Promise<Light[]> {
    if (!noble) {
      console.log('Tuya BLE: skipping discovery (noble not available)');
      return [];
    }
    const n = noble!;

    if (this.configs.length === 0) {
      return [];
    }

    const lights: Light[] = [];
    const foundPeripherals = new Map<string, any>(); // noble.Peripheral
    const allPeripherals: any[] = []; // For debug logging

    // Build a map of MAC addresses we're looking for (normalized to lowercase, no colons)
    const macToConfig = new Map<string, TuyaBLEDeviceConfig>();
    for (const config of this.configs) {
      if (config.mac) {
        const normalizedMac = config.mac.toLowerCase().replace(/:/g, '');
        macToConfig.set(normalizedMac, config);
        console.log(`Tuya BLE: looking for ${config.name} with MAC ${config.mac}`);
      }
    }

    // Set up discovery handler - log ALL devices to help debug
    const handleDiscover = (peripheral: any) => {
      const name = peripheral.advertisement.localName || '';
      const mfrData = peripheral.advertisement.manufacturerData;
      const uuid = peripheral.uuid || peripheral.id || '';
      const addr = peripheral.address || '';

      // Log all discovered devices for debugging (first 5 only to avoid spam)
      if (allPeripherals.length < 10) {
        allPeripherals.push({ name, uuid, addr, mfrData: mfrData?.toString('hex') });
      }

      // Try to match by MAC address first
      const normalizedUuid = uuid.toLowerCase().replace(/:/g, '');
      const normalizedAddr = addr.toLowerCase().replace(/:/g, '');

      // Check if UUID or address matches any of our device MACs
      for (const [mac, config] of macToConfig) {
        if (normalizedUuid.includes(mac) || normalizedAddr.includes(mac) || mac.includes(normalizedUuid)) {
          console.log(`Tuya BLE: found ${config.name} by MAC match! uuid=${uuid} addr=${addr}`);
          foundPeripherals.set(config.id, peripheral);
          return;
        }
      }

      // Check for Tuya manufacturer ID (0x07D0 = 2000)
      if (mfrData && mfrData.length >= 2) {
        const mfrId = mfrData.readUInt16LE(0);
        if (mfrId === 2000) {
          console.log(`Tuya BLE: found Tuya device by mfr ID: ${name || 'unnamed'} uuid=${uuid}`);
          foundPeripherals.set(uuid, peripheral);
          return;
        }
      }

      // Check for Tuya in name
      if (name.toUpperCase().includes('TUYA')) {
        console.log(`Tuya BLE: found Tuya device by name: ${name} uuid=${uuid}`);
        foundPeripherals.set(uuid, peripheral);
      }
    };

    n.on('discover', handleDiscover);

    // First try scanning with service UUID filter
    console.log('Tuya BLE: scanning for devices (with FD50 filter)...');
    await n.startScanningAsync([TUYA_SERVICE_UUID], false);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await n.stopScanningAsync();

    // If nothing found, try a permissive scan
    if (foundPeripherals.size === 0) {
      console.log('Tuya BLE: no devices found with FD50, trying permissive scan...');
      await n.startScanningAsync([], true); // Allow duplicates to get more data
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await n.stopScanningAsync();
    }

    n.removeListener('discover', handleDiscover);

    // Log what we found for debugging
    console.log(`Tuya BLE: scan complete. Found ${foundPeripherals.size} Tuya devices`);
    if (allPeripherals.length > 0) {
      console.log('Tuya BLE: nearby BLE devices:');
      for (const p of allPeripherals.slice(0, 5)) {
        console.log(`  - name="${p.name}" uuid=${p.uuid} addr=${p.addr} mfr=${p.mfrData || 'none'}`);
      }
      if (allPeripherals.length > 5) {
        console.log(`  ... and ${allPeripherals.length - 5} more`);
      }
    }

    // Match found peripherals to config
    for (const config of this.configs) {
      const id = `tuya-ble:${config.id}`;

      // Try to find matching peripheral by device ID first, then any unmatched
      let peripheral = foundPeripherals.get(config.id) || null;
      if (!peripheral) {
        // Fall back to any unmatched peripheral
        for (const [key, p] of foundPeripherals) {
          if (!Array.from(this.devices.values()).some((d) => d.peripheral === p)) {
            peripheral = p;
            break;
          }
        }
      }

      const device: TuyaBLEDevice = {
        config,
        peripheral,
        writeChar: null,
        notifyChar: null,
        state: { on: false },
        connected: false,
        paired: false,
        loginKey: deriveLoginKey(config.key),
        sessionKey: null,
        seqNum: 0,
        pendingResponses: new Map(),
        rxBuffer: Buffer.alloc(0),
        rxExpectedLength: 0,
      };

      this.devices.set(id, device);

      if (peripheral) {
        // Try to connect and pair
        console.log(`Tuya BLE: will try to connect ${config.name} to peripheral uuid=${peripheral.uuid}`);
        try {
          await this.connectDevice(device, id);
        } catch (err: any) {
          console.error(`Tuya BLE: failed to connect to ${config.name}:`, err.message);
          this.scheduleReconnect(device, id);
        }
      } else {
        console.log(`Tuya BLE: ${config.name} not found in scan`);
      }

      lights.push({
        id,
        name: config.name,
        brand: 'tuya',
        capabilities: ['on_off', 'brightness', 'color'] as Capability[],
        state: device.state,
        reachable: device.connected && device.paired,
      });
    }

    return lights;
  }

  private async connectDevice(device: TuyaBLEDevice, id: string): Promise<void> {
    if (!device.peripheral) {
      throw new Error('No peripheral to connect to');
    }

    const peripheral = device.peripheral;
    console.log(`Tuya BLE: attempting to connect to ${device.config.name}...`);
    this.emitDebug(device.config.name, 'connecting...', 'out');

    // Connect with timeout
    const connectPromise = peripheral.connectAsync();
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Connection timeout after 10s')), 10000)
    );

    try {
      await Promise.race([connectPromise, timeoutPromise]);
    } catch (err: any) {
      console.error(`Tuya BLE: connection failed for ${device.config.name}:`, err.message);
      throw err;
    }

    device.connected = true;
    console.log(`Tuya BLE: connected to ${device.config.name}`);
    this.emitDebug(device.config.name, 'connected', 'in');

    // Discover services and characteristics with timeout
    console.log(`Tuya BLE: discovering services for ${device.config.name}...`);
    const discoverPromise = peripheral.discoverSomeServicesAndCharacteristicsAsync([], []);
    const discoverTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Service discovery timeout after 10s')), 10000)
    );

    let services: any[], characteristics: any[];
    try {
      const result = await Promise.race([discoverPromise, discoverTimeout]);
      services = result.services;
      characteristics = result.characteristics;
    } catch (err: any) {
      console.error(`Tuya BLE: service discovery failed for ${device.config.name}:`, err.message);
      throw err;
    }

    console.log(`Tuya BLE: found ${services?.length || 0} services, ${characteristics?.length || 0} characteristics`);
    for (const svc of services || []) {
      console.log(`  Service: ${svc.uuid}`);
    }
    for (const char of characteristics || []) {
      console.log(`  Char: ${char.uuid} props=${JSON.stringify(char.properties)}`);
    }

    for (const char of characteristics || []) {
      const uuid = char.uuid.toLowerCase().replace(/-/g, '');
      // Match on the first 8 characters (the unique part before the common suffix)
      // Write: 00000001-0000-1001-8001-00805F9B07D0
      // Notify: 00000002-0000-1001-8001-00805F9B07D0
      if (uuid.startsWith('00000001')) {
        device.writeChar = char;
        console.log(`Tuya BLE: found write characteristic: ${char.uuid}`);
      } else if (uuid.startsWith('00000002')) {
        device.notifyChar = char;
        console.log(`Tuya BLE: found notify characteristic: ${char.uuid}`);
      }
    }

    if (!device.writeChar || !device.notifyChar) {
      throw new Error(`Required characteristics not found (have write=${!!device.writeChar}, notify=${!!device.notifyChar})`);
    }

    // Subscribe to notifications
    console.log(`Tuya BLE: subscribing to notifications for ${device.config.name}...`);
    await device.notifyChar.subscribeAsync();
    device.notifyChar.on('data', (data: Buffer) => {
      console.log(`Tuya BLE: received data from ${device.config.name}: ${data.toString('hex')}`);
      this.handleNotification(device, id, data);
    });
    console.log(`Tuya BLE: subscribed to notifications for ${device.config.name}`);

    // Set up disconnect handler
    peripheral.once('disconnect', () => {
      device.connected = false;
      device.paired = false;
      this.emitDebug(device.config.name, 'disconnected', 'in');
      if (this.onDiagnosticsChange) this.onDiagnosticsChange();
      this.scheduleReconnect(device, id);
    });

    // Perform pairing handshake
    console.log(`Tuya BLE: starting pairing handshake for ${device.config.name}...`);
    try {
      await this.pairDevice(device, id);
      console.log(`Tuya BLE: pairing complete for ${device.config.name}!`);
    } catch (err: any) {
      console.error(`Tuya BLE: pairing failed for ${device.config.name}:`, err.message);
      throw err;
    }

    if (this.onDiagnosticsChange) this.onDiagnosticsChange();
  }

  private async pairDevice(device: TuyaBLEDevice, id: string): Promise<void> {
    // Step 1: Request device info (encrypted with login key)
    this.emitDebug(device.config.name, 'requesting device info...', 'out');

    const infoPayload = Buffer.alloc(0); // Empty payload for device info
    const seqNum = ++device.seqNum;
    console.log(`Tuya BLE: building device info packet with seqNum=${seqNum}, loginKey=${device.loginKey.toString('hex')}`);

    const infoPacket = buildPacket(
      seqNum,
      FUNC.DEVICE_INFO,
      infoPayload,
      device.loginKey,
      SECURITY.LOGIN_KEY
    );
    console.log(`Tuya BLE: sending packet (${infoPacket.length} bytes): ${infoPacket.toString('hex')}`);

    const infoResponse = await this.sendAndWait(device, infoPacket, seqNum, 5000);

    // Parse device info response to get random seed
    // The seed is typically 6 bytes at offset 0
    if (infoResponse.length < 6) {
      throw new Error('Invalid device info response');
    }

    const seed = infoResponse.subarray(0, 6);
    device.sessionKey = deriveSessionKey(device.config.key, seed);
    this.emitDebug(device.config.name, 'got device info, derived session key', 'in');

    // Step 2: Send pair request (encrypted with session key)
    this.emitDebug(device.config.name, 'sending pair request...', 'out');

    // Pair payload includes device ID
    const pairPayload = Buffer.from(device.config.id, 'utf-8');
    const pairPacket = buildPacket(
      ++device.seqNum,
      FUNC.PAIR,
      pairPayload,
      device.sessionKey,
      SECURITY.SESSION_KEY
    );

    await this.sendAndWait(device, pairPacket, device.seqNum, 5000);
    device.paired = true;
    this.emitDebug(device.config.name, 'paired successfully', 'in');
  }

  private async sendAndWait(
    device: TuyaBLEDevice,
    packet: Buffer,
    seqNum: number,
    timeout: number
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        device.pendingResponses.delete(seqNum);
        reject(new Error('Request timeout'));
      }, timeout);

      device.pendingResponses.set(seqNum, {
        resolve: (payload) => {
          clearTimeout(timer);
          device.pendingResponses.delete(seqNum);
          resolve(payload);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          device.pendingResponses.delete(seqNum);
          reject(err);
        },
      });

      // Segment packet into MTU-sized chunks
      const chunks = segmentPacket(packet);
      console.log(`Tuya BLE: writing ${packet.length} bytes in ${chunks.length} chunks...`);

      // Send all chunks sequentially using writeWithoutResponse for speed
      const sendChunks = async () => {
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          console.log(`Tuya BLE: sending chunk ${i + 1}/${chunks.length} (${chunk.length} bytes): ${chunk.toString('hex')}`);
          await new Promise<void>((resolveWrite, rejectWrite) => {
            // Use writeWithoutResponse (true) for faster writes
            device.writeChar!.write(chunk, true, (err?: Error | null) => {
              if (err) {
                console.error(`Tuya BLE: chunk write failed:`, err);
                rejectWrite(err);
              } else {
                console.log(`Tuya BLE: chunk ${i + 1} written`);
                resolveWrite();
              }
            });
          });
          // Small delay between chunks
          await new Promise(r => setTimeout(r, 50));
        }
        console.log(`Tuya BLE: all chunks sent successfully`);
      };

      sendChunks().catch((err) => {
        clearTimeout(timer);
        device.pendingResponses.delete(seqNum);
        reject(err);
      });
    });
  }

  private handleNotification(device: TuyaBLEDevice, id: string, data: Buffer): void {
    // Reassemble chunked responses
    const packetNum = data[0];

    if (packetNum === 0) {
      // First chunk - extract total length
      if (data.length < 4) {
        console.warn('Tuya BLE: first chunk too short');
        return;
      }
      device.rxExpectedLength = data.readUInt16BE(1);
      const protocolVersion = data[3] >> 4;
      console.log(`Tuya BLE: receiving packet, expected length=${device.rxExpectedLength}, proto=${protocolVersion}`);
      device.rxBuffer = Buffer.from(data.subarray(4));
    } else {
      // Subsequent chunk
      device.rxBuffer = Buffer.concat([device.rxBuffer, data.subarray(1)]);
    }

    // Check if we have the complete packet
    if (device.rxBuffer.length < device.rxExpectedLength) {
      console.log(`Tuya BLE: waiting for more chunks (${device.rxBuffer.length}/${device.rxExpectedLength})`);
      return;
    }

    // We have the complete packet - process it
    const fullPacket = device.rxBuffer.subarray(0, device.rxExpectedLength);
    device.rxBuffer = Buffer.alloc(0);
    device.rxExpectedLength = 0;

    console.log(`Tuya BLE: complete packet received (${fullPacket.length} bytes): ${fullPacket.toString('hex')}`);

    // Determine which key to use based on security flag
    const securityFlag = fullPacket[0];
    const key = securityFlag === SECURITY.LOGIN_KEY ? device.loginKey : device.sessionKey;

    if (!key) {
      console.warn('Tuya BLE: received notification but no key available');
      return;
    }

    const parsed = parsePacket(fullPacket, key);
    if (!parsed) {
      console.warn('Tuya BLE: failed to parse notification');
      return;
    }

    const { seqNum, responseTo, functionCode, payload } = parsed;

    // Check if this is a response to a pending request
    if (responseTo > 0) {
      const pending = device.pendingResponses.get(responseTo);
      if (pending) {
        pending.resolve(payload);
        return;
      }
    }

    // Handle unsolicited notifications (state updates)
    if (functionCode === FUNC.REPORT_DP) {
      this.handleDataPointReport(device, id, payload);
    }
  }

  private handleDataPointReport(device: TuyaBLEDevice, id: string, payload: Buffer): void {
    // Parse data points from payload
    // Format: [dp_id(1)] [type(1)] [len(2)] [value(len)]
    let offset = 0;
    while (offset < payload.length) {
      if (offset + 4 > payload.length) break;

      const dpId = payload[offset];
      const dpType = payload[offset + 1];
      const dpLen = payload.readUInt16BE(offset + 2);
      const dpValue = payload.subarray(offset + 4, offset + 4 + dpLen);

      this.applyDataPoint(device, dpId, dpType, dpValue);
      offset += 4 + dpLen;
    }

    // Notify of state update
    if (this.onUpdate) {
      this.onUpdate(device.config.id, device.state);
    }
  }

  private applyDataPoint(device: TuyaBLEDevice, dpId: number, dpType: number, value: Buffer): void {
    // Common Tuya light data points (may need adjustment per device)
    switch (dpId) {
      case 20: // switch_led
        device.state.on = value[0] === 1;
        break;
      case 22: // bright_value
        device.state.brightness = Math.round((value.readUInt32BE(0) / 1000) * 100);
        break;
      case 24: // colour_data
        // Parse HSV from value (format varies)
        if (value.length >= 12) {
          // Hex format: HHHHSSSSVVVV
          const hex = value.toString('hex');
          const h = parseInt(hex.slice(0, 4), 16);
          const s = parseInt(hex.slice(4, 8), 16);
          device.state.color = { h, s: Math.round(s / 10) };
        }
        break;
      case 23: // temp_value
        const temp = value.readUInt32BE(0);
        device.state.temperature = 2700 + Math.round((temp / 1000) * 3800);
        break;
    }
  }

  private scheduleReconnect(device: TuyaBLEDevice, id: string): void {
    if (device.reconnectTimer) {
      clearTimeout(device.reconnectTimer);
    }

    device.reconnectTimer = setTimeout(async () => {
      if (device.connected) return;

      try {
        // Re-scan to find the device
        console.log(`Tuya BLE: attempting to reconnect to ${device.config.name}...`);
        await this.rescanForDevice(device, id);
        await this.connectDevice(device, id);
        console.log(`Tuya BLE: reconnected to ${device.config.name}`);

        if (this.onUpdate) {
          this.onUpdate(device.config.id, device.state);
        }
        if (this.onDiagnosticsChange) this.onDiagnosticsChange();
      } catch {
        this.scheduleReconnect(device, id);
      }
    }, 1000); // Retry every 1 second
  }

  private async rescanForDevice(device: TuyaBLEDevice, id: string): Promise<void> {
    if (!noble) {
      throw new Error('BLE not available');
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        noble!.stopScanning();
        noble!.removeListener('discover', handleDiscover);
        reject(new Error('Device not found'));
      }, 10000);

      const handleDiscover = (peripheral: any) => {
        const mfrData = peripheral.advertisement.manufacturerData;
        if (mfrData && mfrData.length >= 2) {
          const mfrId = mfrData.readUInt16LE(0);
          if (mfrId === 2000) {
            clearTimeout(timeout);
            noble!.stopScanning();
            noble!.removeListener('discover', handleDiscover);
            device.peripheral = peripheral;
            resolve();
          }
        }
      };

      noble!.on('discover', handleDiscover);
      noble!.startScanning([TUYA_SERVICE_UUID], false);
    });
  }

  async getState(deviceId: string): Promise<LightState> {
    const device = this.devices.get(`tuya:${deviceId}`);
    return device?.state || { on: false };
  }

  async setState(deviceId: string, state: Partial<LightState>, transition?: number): Promise<void> {
    const fullId = deviceId.startsWith('tuya:') ? deviceId : `tuya:${deviceId}`;
    const device = this.devices.get(fullId);

    if (!device) {
      throw new Error('Tuya BLE device not found');
    }

    if (!device.connected || !device.paired || !device.sessionKey) {
      throw new Error(`Tuya BLE device ${device.config.name} not connected`);
    }

    // Build data points payload
    const dps = this.buildDataPoints(state, device.state);
    if (dps.length === 0) return;

    const packet = buildPacket(
      ++device.seqNum,
      FUNC.SEND_DP,
      dps,
      device.sessionKey,
      SECURITY.SESSION_KEY
    );

    const logId = this.emitDebug(device.config.name, `setting ${JSON.stringify(state)} (...)`, 'out');
    const startTime = Date.now();

    try {
      await this.sendAndWait(device, packet, device.seqNum, 5000);
      const elapsed = Date.now() - startTime;
      if (this.onDebugUpdate) {
        this.onDebugUpdate(logId, `setting ${JSON.stringify(state)} (✓ ${elapsed}ms)`);
      }

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
      if (this.onDebugUpdate) {
        this.onDebugUpdate(logId, `setting ${JSON.stringify(state)} (✗ ${elapsed}ms)`);
      }
      throw err;
    }
  }

  private buildDataPoints(state: Partial<LightState>, currentState: LightState): Buffer {
    const dps: Buffer[] = [];

    // Helper to build a single data point
    const addDp = (dpId: number, type: number, value: Buffer) => {
      const header = Buffer.alloc(4);
      header[0] = dpId;
      header[1] = type;
      header.writeUInt16BE(value.length, 2);
      dps.push(Buffer.concat([header, value]));
    };

    if (state.on !== undefined) {
      addDp(20, 1, Buffer.from([state.on ? 1 : 0])); // Boolean type
    }

    if (state.brightness !== undefined) {
      const value = Buffer.alloc(4);
      value.writeUInt32BE(Math.round(state.brightness * 10), 0);
      addDp(22, 2, value); // Integer type
    }

    if (state.color !== undefined) {
      // Build hex format: HHHHSSSSVVVV
      const h = state.color.h.toString(16).padStart(4, '0');
      const s = Math.round(state.color.s * 10).toString(16).padStart(4, '0');
      const v = ((currentState.brightness ?? 100) * 10).toString(16).padStart(4, '0');
      const hex = h + s + v;
      addDp(24, 3, Buffer.from(hex, 'hex')); // String type (as hex)
    }

    if (state.temperature !== undefined) {
      const value = Buffer.alloc(4);
      const normalized = Math.round(((state.temperature - 2700) / 3800) * 1000);
      value.writeUInt32BE(Math.max(0, Math.min(1000, normalized)), 0);
      addDp(23, 2, value); // Integer type
    }

    return Buffer.concat(dps);
  }

  getDiagnostics(): Record<string, { connected: boolean; reachable: boolean }> {
    const result: Record<string, { connected: boolean; reachable: boolean }> = {};
    for (const [id, device] of this.devices) {
      result[id] = {
        connected: device.connected && device.paired,
        reachable: device.connected && device.paired,
      };
    }
    return result;
  }

  async dispose(): Promise<void> {
    for (const [, device] of this.devices) {
      if (device.reconnectTimer) {
        clearTimeout(device.reconnectTimer);
      }
      if (device.peripheral && device.connected) {
        try {
          await device.peripheral.disconnectAsync();
        } catch {
          // Ignore disconnect errors
        }
      }
    }
    this.devices.clear();
    if (noble) {
      await noble.stopScanningAsync().catch(() => {});
    }
  }
}
