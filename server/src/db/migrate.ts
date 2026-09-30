import { all, exec, one, run, tx } from './db.ts';
import { MIGRATIONS } from './migrations.ts';

/**
 * Aplica migrations pendentes, cada uma em sua própria transação (progresso persistido entre tentativas).
 * Seguro para instâncias concorrentes (advisory lock). `canContinue` permite interromper entre migrations.
 */
export async function migrate(canContinue: () => boolean = () => true): Promise<string[]> {
  await exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const already = new Set((await all<any>('SELECT name FROM schema_migrations')).map((r) => r.name));
  const pending = MIGRATIONS.filter((m) => !already.has(m.name));
  if (!pending.length || !canContinue()) return [];
  // Todas as pendentes numa única transação (poucas idas ao banco); advisory lock contra instâncias concorrentes.
  return tx(async () => {
    await exec('SELECT pg_advisory_xact_lock(724113)');
    const done = new Set((await all<any>('SELECT name FROM schema_migrations')).map((r) => r.name));
    const applied: string[] = [];
    for (const m of pending) {
      if (done.has(m.name)) continue;
      await exec(m.sql);
      await run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', m.name, new Date().toISOString());
      applied.push(m.name);
    }
    return applied;
  });
}

export async function pendingMigrations(): Promise<string[]> {
  const done = new Set((await all<any>('SELECT name FROM schema_migrations')).map((r) => r.name));
  return MIGRATIONS.map((m) => m.name).filter((n) => !done.has(n));
}
