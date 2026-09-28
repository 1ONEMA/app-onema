/**
 * Camada de dados PostgreSQL.
 *  - Produção/Netlify: `pg` (DATABASE_URL ou NETLIFY_DATABASE_URL — Netlify DB/Neon ou qualquer Postgres).
 *  - Desenvolvimento local e testes: PGlite (Postgres em WASM), persistido em disco ou em memória.
 * As consultas usam `?` como marcador (convertido para $1..$n). Transações são propagadas por
 * AsyncLocalStorage: dentro de `tx()`, one/all/run usam automaticamente a mesma conexão.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';

type Row = Record<string, any>;
interface QResult { rows: any[]; rowCount: number }
export interface Client { query(sql: string, params: any[]): Promise<QResult>; exec(sql: string): Promise<void>; release(): void }
export interface Driver { acquire(): Promise<Client>; close(): Promise<void>; kind: 'pg' | 'pglite' }

// ---------------- Drivers ----------------
async function pgDriver(url: string): Promise<Driver> {
  const { default: pg } = await import('pg');
  // BIGINT (COUNT/SUM) como número JS
  pg.types.setTypeParser(20, (v: string) => Number(v));
  pg.types.setTypeParser(1700, (v: string) => Number(v));
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.DB_POOL_MAX ?? 3),
    ssl: /sslmode=disable|localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
    // Limites explícitos: sem eles uma conexão travada só termina quando a Function é abortada (HTTP 502).
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 6000),
    query_timeout: Number(process.env.DB_QUERY_TIMEOUT_MS ?? 8000),
    idleTimeoutMillis: 10000,
    allowExitOnIdle: true,
  });
  pool.on('error', (e: any) => console.error('Erro em conexão ociosa do Postgres:', e?.message));
  return {
    kind: 'pg',
    async acquire() {
      const c = await pool.connect();
      return {
        query: async (sql, params) => { const r = await c.query(sql, params); return { rows: r.rows, rowCount: r.rowCount ?? 0 }; },
        exec: async (sql) => { await c.query(sql); },
        release: () => c.release(),
      };
    },
    close: () => pool.end(),
  };
}

async function pgliteDriver(dataDir: string | null): Promise<Driver> {
  // Import dinâmico por variável: o PGlite (WASM) não é empacotado nas Netlify Functions, que usam `pg`.
  const mod = '@electric-sql/pglite';
  const { PGlite } = (await import(/* @vite-ignore */ mod)) as typeof import('@electric-sql/pglite');
  if (dataDir) fs.mkdirSync(path.dirname(dataDir), { recursive: true });
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  await db.waitReady;
  // Conexão única: um mutex impede que transações concorrentes se misturem.
  let chain = Promise.resolve();
  const conv = (v: any) => (typeof v === 'bigint' ? Number(v) : v);
  return {
    kind: 'pglite',
    async acquire() {
      let unlock!: () => void;
      const prev = chain;
      chain = new Promise<void>((r) => (unlock = r));
      await prev;
      return {
        query: async (sql, params) => {
          const r: any = await db.query(sql, params);
          const rows = r.rows.map((row: any) => { for (const k in row) row[k] = conv(row[k]); return row; });
          return { rows, rowCount: r.affectedRows ?? rows.length };
        },
        exec: async (sql) => { await db.exec(sql); },
        release: () => unlock(),
      };
    },
    close: () => db.close(),
  };
}

let driverPromise: Promise<Driver> | null = null;
export function databaseUrl() {
  return process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL || '';
}
export function getDriver(): Promise<Driver> {
  if (!driverPromise) {
    const url = databaseUrl();
    driverPromise = url ? pgDriver(url) : pgliteDriver(config.databasePath === ':memory:' ? null : config.databasePath);
  }
  return driverPromise;
}
/** Substitui o driver (testes). */
export function setDriver(d: Promise<Driver> | null) { driverPromise = d; }
export async function newMemoryDriver() { return pgliteDriver(null); }

// ---------------- Consultas ----------------
const store = new AsyncLocalStorage<{ client: Client; depth: number }>();

/** Converte `?` em `$n` (ignora `?` dentro de literais entre aspas simples). */
export function toPg(sql: string) {
  let n = 0, out = '', inStr = false;
  for (const ch of sql) {
    if (ch === "'") inStr = !inStr;
    out += ch === '?' && !inStr ? `$${++n}` : ch;
  }
  return out;
}
const norm = (params: any[]) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const cur = store.getStore();
  if (cur) return fn(cur.client);
  const c = await (await getDriver()).acquire();
  try { return await fn(c); } finally { c.release(); }
}

export async function all<T = Row>(sql: string, ...params: any[]): Promise<T[]> {
  return withClient(async (c) => (await c.query(toPg(sql), norm(params))).rows as T[]);
}
export async function one<T = Row>(sql: string, ...params: any[]): Promise<T | undefined> {
  return (await all<T>(sql, ...params))[0];
}
export async function run(sql: string, ...params: any[]): Promise<{ changes: number }> {
  return withClient(async (c) => ({ changes: (await c.query(toPg(sql), norm(params))).rowCount }));
}
export async function exec(sql: string): Promise<void> {
  return withClient((c) => c.exec(sql));
}

/** Transação atômica; aninhamento usa SAVEPOINT (um erro interno pode ser tratado sem abortar a externa). */
export async function tx<T>(fn: () => Promise<T>): Promise<T> {
  const cur = store.getStore();
  if (cur) {
    const sp = `sp${cur.depth + 1}`;
    await cur.client.exec(`SAVEPOINT ${sp}`);
    try {
      const r = await store.run({ client: cur.client, depth: cur.depth + 1 }, fn);
      await cur.client.exec(`RELEASE SAVEPOINT ${sp}`);
      return r;
    } catch (e) {
      await cur.client.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
      throw e;
    }
  }
  const c = await (await getDriver()).acquire();
  try {
    await c.exec('BEGIN');
    const r = await store.run({ client: c, depth: 0 }, fn);
    await c.exec('COMMIT');
    return r;
  } catch (e) {
    await c.exec('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Violação de unicidade do Postgres (23505). */
export const isUniqueViolation = (e: any) => e?.code === '23505';

/** Inserção em lote (uma única ida ao banco). */
export async function insertMany(table: string, cols: string[], rows: any[][]) {
  if (!rows.length) return;
  const ph = `(${cols.map(() => '?').join(',')})`;
  await run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${rows.map(() => ph).join(', ')}`, ...rows.flat());
}
