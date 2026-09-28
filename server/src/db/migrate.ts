import { exec, one, run, tx } from './db.ts';
import { MIGRATIONS } from './migrations.ts';

/** Aplica migrations pendentes. Seguro para instâncias concorrentes (advisory lock). */
export async function migrate(): Promise<string[]> {
  return tx(async () => {
    await exec('SELECT pg_advisory_xact_lock(724113)');
    await exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied: string[] = [];
    for (const m of MIGRATIONS) {
      if (await one('SELECT 1 FROM schema_migrations WHERE name = ?', m.name)) continue;
      await exec(m.sql);
      await run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', m.name, new Date().toISOString());
      applied.push(m.name);
    }
    return applied;
  });
}
