import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';

export type DB = DatabaseSync;
type Row = Record<string, any>;

let instance: DatabaseSync | null = null;

export function openDb(file = config.databasePath): DatabaseSync {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  return db;
}

export function getDb(): DatabaseSync {
  if (!instance) instance = openDb();
  return instance;
}

export function setDb(db: DatabaseSync) {
  instance = db;
}

export function one<T = Row>(sql: string, ...params: any[]): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined;
}
export function all<T = Row>(sql: string, ...params: any[]): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}
export function run(sql: string, ...params: any[]) {
  return getDb().prepare(sql).run(...params);
}

let depth = 0;
/** Transação atômica (BEGIN IMMEDIATE) - aninhamento usa SAVEPOINT. */
export function tx<T>(fn: () => T): T {
  const db = getDb();
  const sp = `sp${depth}`;
  if (depth === 0) db.exec('BEGIN IMMEDIATE');
  else db.exec(`SAVEPOINT ${sp}`);
  depth++;
  try {
    const r = fn();
    depth--;
    if (depth === 0) db.exec('COMMIT');
    else db.exec(`RELEASE ${sp}`);
    return r;
  } catch (e) {
    depth--;
    if (depth === 0) db.exec('ROLLBACK');
    else db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw e;
  }
}
