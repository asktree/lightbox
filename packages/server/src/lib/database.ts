import BetterSqlite3 from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type { Group, Palette, PaletteNode, RoomState, PalettePositions } from '@lightbox/shared';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../../data');

export class Database {
  private db!: BetterSqlite3Database;

  initialize(): void {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }

    this.db = new BetterSqlite3(join(DATA_DIR, 'lightbox.db'));

    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        light_ids TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS palettes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        nodes TEXT NOT NULL,
        tension REAL DEFAULT 0.5,
        seconds_per_node REAL DEFAULT 2
      );

      CREATE TABLE IF NOT EXISTS palette_positions (
        palette_id TEXT NOT NULL,
        light_id TEXT NOT NULL,
        position REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (palette_id, light_id)
      );

      CREATE TABLE IF NOT EXISTS room_state (
        room_id TEXT PRIMARY KEY,
        active_palette_id TEXT,
        is_playing INTEGER DEFAULT 0,
        seconds_per_node REAL DEFAULT 2
      );
    `);

    // Migration: add seconds_per_node column if missing
    try {
      this.db.exec(`ALTER TABLE room_state ADD COLUMN seconds_per_node REAL DEFAULT 2`);
    } catch {
      // Column already exists
    }
  }

  // Groups
  getGroups(): Group[] {
    const rows = this.db.prepare('SELECT * FROM groups').all() as Array<{
      id: string;
      name: string;
      light_ids: string;
    }>;
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      lightIds: JSON.parse(row.light_ids),
    }));
  }

  getGroup(id: string): Group | undefined {
    const row = this.db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as {
      id: string;
      name: string;
      light_ids: string;
    } | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      lightIds: JSON.parse(row.light_ids),
    };
  }

  createGroup(name: string, lightIds: string[]): Group {
    const id = randomUUID();
    this.db.prepare('INSERT INTO groups (id, name, light_ids) VALUES (?, ?, ?)').run(
      id,
      name,
      JSON.stringify(lightIds)
    );
    return { id, name, lightIds };
  }

  updateGroup(id: string, name: string, lightIds: string[]): void {
    this.db.prepare('UPDATE groups SET name = ?, light_ids = ? WHERE id = ?').run(
      name,
      JSON.stringify(lightIds),
      id
    );
  }

  deleteGroup(id: string): void {
    this.db.prepare('DELETE FROM groups WHERE id = ?').run(id);
  }

  // Palettes
  private parsePaletteRow(row: {
    id: string;
    name: string;
    nodes: string;
    tension: number;
    seconds_per_node: number;
  }): Palette {
    return {
      id: row.id,
      name: row.name,
      nodes: JSON.parse(row.nodes),
      tension: row.tension,
      secondsPerNode: row.seconds_per_node,
    };
  }

  getPalettes(): Palette[] {
    const rows = this.db.prepare('SELECT * FROM palettes').all() as Array<{
      id: string;
      name: string;
      nodes: string;
      tension: number;
      seconds_per_node: number;
    }>;
    return rows.map(row => this.parsePaletteRow(row));
  }

  getPalette(id: string): Palette | undefined {
    const row = this.db.prepare('SELECT * FROM palettes WHERE id = ?').get(id) as {
      id: string;
      name: string;
      nodes: string;
      tension: number;
      seconds_per_node: number;
    } | undefined;
    if (!row) return undefined;
    return this.parsePaletteRow(row);
  }

  createPalette(
    name: string,
    nodes: PaletteNode[],
    tension = 0.5,
    secondsPerNode = 2
  ): Palette {
    const id = randomUUID();
    this.db.prepare(
      'INSERT INTO palettes (id, name, nodes, tension, seconds_per_node) VALUES (?, ?, ?, ?, ?)'
    ).run(id, name, JSON.stringify(nodes), tension, secondsPerNode);
    return { id, name, nodes, tension, secondsPerNode };
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
    const palette = this.getPalette(id);
    if (!palette) return;

    const newName = updates.name ?? palette.name;
    const newNodes = updates.nodes ?? palette.nodes;
    const newTension = updates.tension ?? palette.tension;
    const newSpeed = updates.secondsPerNode ?? palette.secondsPerNode;

    this.db.prepare(
      'UPDATE palettes SET name = ?, nodes = ?, tension = ?, seconds_per_node = ? WHERE id = ?'
    ).run(newName, JSON.stringify(newNodes), newTension, newSpeed, id);
  }

  deletePalette(id: string): void {
    this.db.prepare('DELETE FROM palettes WHERE id = ?').run(id);
    // Also clean up positions for this palette
    this.db.prepare('DELETE FROM palette_positions WHERE palette_id = ?').run(id);
    // Clear from any room state
    this.db.prepare('UPDATE room_state SET active_palette_id = NULL, is_playing = 0 WHERE active_palette_id = ?').run(id);
  }

  // Palette Positions (light positions on track)
  getPalettePositions(paletteId: string): PalettePositions {
    const rows = this.db.prepare(
      'SELECT light_id, position FROM palette_positions WHERE palette_id = ?'
    ).all(paletteId) as Array<{ light_id: string; position: number }>;

    const positions: PalettePositions = {};
    for (const row of rows) {
      positions[row.light_id] = row.position;
    }
    return positions;
  }

  setPalettePosition(paletteId: string, lightId: string, position: number): void {
    this.db.prepare(`
      INSERT INTO palette_positions (palette_id, light_id, position)
      VALUES (?, ?, ?)
      ON CONFLICT (palette_id, light_id) DO UPDATE SET position = excluded.position
    `).run(paletteId, lightId, position);
  }

  savePalettePositions(paletteId: string, positions: PalettePositions): void {
    const stmt = this.db.prepare(`
      INSERT INTO palette_positions (palette_id, light_id, position)
      VALUES (?, ?, ?)
      ON CONFLICT (palette_id, light_id) DO UPDATE SET position = excluded.position
    `);

    const saveAll = this.db.transaction(() => {
      for (const [lightId, position] of Object.entries(positions)) {
        stmt.run(paletteId, lightId, position);
      }
    });
    saveAll();
  }

  // Room State
  getRoomState(roomId: string): RoomState {
    const row = this.db.prepare(
      'SELECT room_id, active_palette_id, is_playing, seconds_per_node FROM room_state WHERE room_id = ?'
    ).get(roomId) as { room_id: string; active_palette_id: string | null; is_playing: number; seconds_per_node: number } | undefined;

    if (!row) {
      return { roomId, activePaletteId: null, isPlaying: false, secondsPerNode: 2 };
    }
    return {
      roomId: row.room_id,
      activePaletteId: row.active_palette_id,
      isPlaying: row.is_playing === 1,
      secondsPerNode: row.seconds_per_node ?? 2,
    };
  }

  getAllRoomStates(): RoomState[] {
    const rows = this.db.prepare('SELECT room_id, active_palette_id, is_playing, seconds_per_node FROM room_state').all() as Array<{
      room_id: string;
      active_palette_id: string | null;
      is_playing: number;
      seconds_per_node: number;
    }>;
    return rows.map(row => ({
      roomId: row.room_id,
      activePaletteId: row.active_palette_id,
      isPlaying: row.is_playing === 1,
      secondsPerNode: row.seconds_per_node ?? 2,
    }));
  }

  setRoomState(roomId: string, activePaletteId: string | null, isPlaying: boolean): void {
    this.db.prepare(`
      INSERT INTO room_state (room_id, active_palette_id, is_playing)
      VALUES (?, ?, ?)
      ON CONFLICT (room_id) DO UPDATE SET
        active_palette_id = excluded.active_palette_id,
        is_playing = excluded.is_playing
    `).run(roomId, activePaletteId, isPlaying ? 1 : 0);
  }

  setRoomSpeed(roomId: string, secondsPerNode: number): void {
    this.db.prepare(`
      INSERT INTO room_state (room_id, seconds_per_node)
      VALUES (?, ?)
      ON CONFLICT (room_id) DO UPDATE SET
        seconds_per_node = excluded.seconds_per_node
    `).run(roomId, secondsPerNode);
  }

  close(): void {
    this.db.close();
  }
}
