import BetterSqlite3 from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type { Group, Scene, LightState } from '@lightbox/shared';
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

      CREATE TABLE IF NOT EXISTS scenes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        states TEXT NOT NULL
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

  // Scenes
  getScenes(): Scene[] {
    const rows = this.db.prepare('SELECT * FROM scenes').all() as Array<{
      id: string;
      name: string;
      states: string;
    }>;
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      states: JSON.parse(row.states),
    }));
  }

  getScene(id: string): Scene | undefined {
    const row = this.db.prepare('SELECT * FROM scenes WHERE id = ?').get(id) as {
      id: string;
      name: string;
      states: string;
    } | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      states: JSON.parse(row.states),
    };
  }

  createScene(name: string, states: Record<string, LightState>): Scene {
    const id = randomUUID();
    this.db.prepare('INSERT INTO scenes (id, name, states) VALUES (?, ?, ?)').run(
      id,
      name,
      JSON.stringify(states)
    );
    return { id, name, states };
  }

  deleteScene(id: string): void {
    this.db.prepare('DELETE FROM scenes WHERE id = ?').run(id);
  }

  close(): void {
    this.db.close();
  }
}
