/**
 * Tuya BLE Protocol Encryption Helpers
 *
 * Based on reverse-engineering of the Tuya BLE protocol:
 * - Login Key: MD5(local_key[0:6]) for initial handshake
 * - Session Key: MD5(local_key + device_random_seed) for commands
 * - Cipher: AES-128-CBC with random 16-byte IV
 * - CRC16: CCITT polynomial for message integrity
 */

import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Derive login key from local key (first 6 bytes, MD5 hashed)
 */
export function deriveLoginKey(localKey: string): Buffer {
  const hash = createHash('md5');
  hash.update(localKey.slice(0, 6));
  return hash.digest();
}

/**
 * Derive session key from local key + device random seed
 */
export function deriveSessionKey(localKey: string, seed: Buffer): Buffer {
  const hash = createHash('md5');
  hash.update(localKey);
  hash.update(seed);
  return hash.digest();
}

/**
 * Encrypt data using AES-128-CBC with random IV
 * Returns: [IV (16 bytes)] + [encrypted data]
 */
export function encrypt(data: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(true);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, encrypted]);
}

/**
 * Decrypt data using AES-128-CBC
 * Input: [IV (16 bytes)] + [encrypted data]
 */
export function decrypt(data: Buffer, key: Buffer): Buffer {
  const iv = data.subarray(0, 16);
  const encrypted = data.subarray(16);
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

/**
 * CRC16-CCITT calculation (polynomial 0x1021)
 */
export function crc16(data: Buffer): number {
  let crc = 0xFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = (crc << 1) ^ 0x1021;
      } else {
        crc <<= 1;
      }
      crc &= 0xFFFF;
    }
  }
  return crc;
}

/**
 * Build a Tuya BLE protocol packet
 *
 * Structure:
 * - Security flag (1 byte): 0x04 = login_key, 0x05 = session_key
 * - IV (16 bytes): random
 * - Encrypted payload: AES-CBC([header] + [data] + [CRC16])
 *
 * Header structure (12 bytes):
 * - Sequence number (4 bytes, big-endian)
 * - Response to (4 bytes, big-endian) - 0 for requests
 * - Function code (2 bytes, big-endian)
 * - Data length (2 bytes, big-endian)
 */
export function buildPacket(
  seqNum: number,
  functionCode: number,
  payload: Buffer,
  key: Buffer,
  securityFlag: number = 0x05
): Buffer {
  // Build header
  const header = Buffer.alloc(12);
  header.writeUInt32BE(seqNum, 0);      // Sequence number
  header.writeUInt32BE(0, 4);            // Response to (0 for requests)
  header.writeUInt16BE(functionCode, 8); // Function code
  header.writeUInt16BE(payload.length, 10); // Data length

  // Combine header + payload
  const message = Buffer.concat([header, payload]);

  // Calculate CRC16
  const crc = crc16(message);
  const crcBuf = Buffer.alloc(2);
  crcBuf.writeUInt16BE(crc, 0);

  // Combine message + CRC
  const fullMessage = Buffer.concat([message, crcBuf]);

  // Encrypt
  const encrypted = encrypt(fullMessage, key);

  // Prepend security flag
  return Buffer.concat([Buffer.from([securityFlag]), encrypted]);
}

/**
 * Parse a Tuya BLE protocol packet
 * Returns: { seqNum, responseTo, functionCode, payload }
 */
export function parsePacket(
  data: Buffer,
  key: Buffer
): { seqNum: number; responseTo: number; functionCode: number; payload: Buffer } | null {
  if (data.length < 17) return null; // Min: 1 (flag) + 16 (IV)

  const securityFlag = data[0];
  const encrypted = data.subarray(1);

  try {
    const decrypted = decrypt(encrypted, key);
    if (decrypted.length < 14) return null; // Min: 12 (header) + 2 (CRC)

    // Verify CRC
    const message = decrypted.subarray(0, -2);
    const receivedCrc = decrypted.readUInt16BE(decrypted.length - 2);
    const calculatedCrc = crc16(message);
    if (receivedCrc !== calculatedCrc) {
      console.warn('Tuya BLE: CRC mismatch');
      return null;
    }

    // Parse header
    const seqNum = decrypted.readUInt32BE(0);
    const responseTo = decrypted.readUInt32BE(4);
    const functionCode = decrypted.readUInt16BE(8);
    const dataLength = decrypted.readUInt16BE(10);

    // Extract payload
    const payload = decrypted.subarray(12, 12 + dataLength);

    return { seqNum, responseTo, functionCode, payload };
  } catch (err) {
    console.error('Tuya BLE: Failed to decrypt packet:', err);
    return null;
  }
}

// Tuya BLE function codes
export const FUNC = {
  DEVICE_INFO: 0x0000,
  PAIR: 0x0001,
  SEND_DP: 0x0002,
  REPORT_DP: 0x0003,
  TIME_SYNC: 0x0010,
} as const;

// Security flags
export const SECURITY = {
  LOGIN_KEY: 0x04,
  SESSION_KEY: 0x05,
} as const;

// BLE MTU size
export const GATT_MTU = 20;

/**
 * Segment a packet into MTU-sized chunks for BLE transmission
 * First chunk: [packet_num][length_hi][length_lo][proto_ver << 4][data...]
 * Subsequent: [packet_num][data...]
 */
export function segmentPacket(packet: Buffer, protocolVersion: number = 3): Buffer[] {
  const chunks: Buffer[] = [];
  let offset = 0;
  let packetNum = 0;

  while (offset < packet.length) {
    if (packetNum === 0) {
      // First chunk has 4-byte header
      const headerSize = 4;
      const dataSize = Math.min(GATT_MTU - headerSize, packet.length - offset);
      const chunk = Buffer.alloc(headerSize + dataSize);
      chunk[0] = packetNum;
      chunk.writeUInt16BE(packet.length, 1); // Total length
      chunk[3] = protocolVersion << 4;
      packet.copy(chunk, headerSize, offset, offset + dataSize);
      chunks.push(chunk);
      offset += dataSize;
    } else {
      // Subsequent chunks have 1-byte header
      const headerSize = 1;
      const dataSize = Math.min(GATT_MTU - headerSize, packet.length - offset);
      const chunk = Buffer.alloc(headerSize + dataSize);
      chunk[0] = packetNum;
      packet.copy(chunk, headerSize, offset, offset + dataSize);
      chunks.push(chunk);
      offset += dataSize;
    }
    packetNum++;
  }

  return chunks;
}
