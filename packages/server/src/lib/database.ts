import BetterSqlite3 from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type { Group, Palette, PaletteNode } from '@lightbox/shared';
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
    `);
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
  }

  close(): void {
    this.db.close();
  }
}
