import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export function migrate(db: DatabaseSync): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set((db.prepare('SELECT name FROM schema_migrations').all() as any[]).map((r) => r.name));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, new Date().toISOString());
      db.exec('COMMIT');
      applied.push(f);
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Falha na migration ${f}: ${(e as Error).message}`);
    }
  }
  return applied;
}
