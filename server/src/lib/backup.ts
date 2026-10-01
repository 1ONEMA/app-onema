/**
 * Backup lógico do banco (todas as tabelas do schema da aplicação) em JSON compactado.
 *  - Netlify: armazenado no Netlify Blobs (store privado "onema-backups"); local: diretório data/backups.
 *  - Retenção: os BACKUP_KEEP mais recentes (padrão 30).
 *  - Restauração: somente por linha de comando (`npm run db:restore`), nunca pela interface.
 * Tabelas transitórias (sessões, limites de taxa, chaves de idempotência) não entram no backup.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { all, exec, insertMany, one, run, tx } from '../db/db.ts';
import { MIGRATIONS } from '../db/migrations.ts';

const SKIP = new Set(['sessions', 'rate_limits', 'idempotency_keys']);
const KEEP = () => Number(process.env.BACKUP_KEEP ?? 30);
const LOCAL_DIR = () => path.resolve(process.env.BACKUP_DIR ?? 'data/backups');
const onNetlify = () => !!(process.env.NETLIFY_BLOBS_CONTEXT || process.env.NETLIFY || process.env.SITE_ID);

async function store() {
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: 'onema-backups', consistency: 'strong' });
}

async function appTables() {
  return (await all<any>(`SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`)).map((t) => t.table_name as string);
}

/** Ordem de inserção respeitando chaves estrangeiras (pais antes dos filhos). */
async function insertionOrder(tables: string[]) {
  const fks = await all<any>(`SELECT tc.table_name AS child, ccu.table_name AS parent
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = current_schema()`);
  const deps = new Map(tables.map((t) => [t, new Set<string>()]));
  for (const f of fks) if (f.child !== f.parent && deps.has(f.child) && deps.has(f.parent)) deps.get(f.child)!.add(f.parent);
  const out: string[] = [], seen = new Set<string>();
  const visit = (t: string) => { if (seen.has(t)) return; seen.add(t); for (const p of deps.get(t) ?? []) visit(p); out.push(t); };
  tables.forEach(visit);
  return out;
}

export async function exportDatabase() {
  const tables = (await appTables()).filter((t) => !SKIP.has(t));
  const data: Record<string, any[]> = {};
  for (const t of tables) data[t] = await all(`SELECT * FROM "${t}"`);
  return {
    format: 'onema-backup/1',
    exportedAt: new Date().toISOString(),
    schemaHead: MIGRATIONS[MIGRATIONS.length - 1].name,
    tables: data,
  };
}

export type Dump = Awaited<ReturnType<typeof exportDatabase>>;
export const compress = (d: Dump) => zlib.gzipSync(Buffer.from(JSON.stringify(d)));
export const decompress = (b: Buffer): Dump => JSON.parse(zlib.gunzipSync(b).toString('utf8'));

export interface BackupInfo { key: string; size: number; createdAt: string }

export async function runBackup(): Promise<BackupInfo & { tables: number; rows: number }> {
  const dump = await exportDatabase();
  const buf = compress(dump);
  const key = `onema-${dump.exportedAt.replace(/[:.]/g, '-')}.json.gz`;
  if (onNetlify()) {
    const s = await store();
    await s.set(key, new Uint8Array(buf).buffer as ArrayBuffer, { metadata: { size: buf.length, createdAt: dump.exportedAt } });
  } else {
    fs.mkdirSync(LOCAL_DIR(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(LOCAL_DIR(), key), buf, { mode: 0o600 });
  }
  // Retenção
  const list = await listBackups();
  for (const old of list.slice(KEEP())) await deleteBackup(old.key);
  const rows = Object.values(dump.tables).reduce((n, r) => n + r.length, 0);
  return { key, size: buf.length, createdAt: dump.exportedAt, tables: Object.keys(dump.tables).length, rows };
}

const validKey = (k: string) => /^onema-[0-9TZ-]+\.json\.gz$/.test(k);

export async function listBackups(): Promise<BackupInfo[]> {
  let items: BackupInfo[];
  if (onNetlify()) {
    const s = await store();
    const { blobs } = await s.list();
    items = await Promise.all(blobs.filter((b) => validKey(b.key)).map(async (b) => {
      const m = await s.getMetadata(b.key);
      return { key: b.key, size: Number(m?.metadata?.size ?? 0), createdAt: String(m?.metadata?.createdAt ?? '') };
    }));
  } else {
    const dir = LOCAL_DIR();
    items = fs.existsSync(dir) ? fs.readdirSync(dir).filter(validKey).map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { key: f, size: st.size, createdAt: st.mtime.toISOString() };
    }) : [];
  }
  return items.sort((a, b) => b.key.localeCompare(a.key));
}

export async function readBackup(key: string): Promise<Buffer | null> {
  if (!validKey(key)) return null;
  if (onNetlify()) {
    const v = await (await store()).get(key, { type: 'arrayBuffer' });
    return v ? Buffer.from(v) : null;
  }
  const f = path.join(LOCAL_DIR(), key);
  return fs.existsSync(f) ? fs.readFileSync(f) : null;
}

export async function deleteBackup(key: string) {
  if (!validKey(key)) return;
  if (onNetlify()) await (await store()).delete(key);
  else fs.rmSync(path.join(LOCAL_DIR(), key), { force: true });
}

export async function lastBackup() {
  return (await listBackups())[0] ?? null;
}

/**
 * Restaura um backup: apaga os dados atuais das tabelas incluídas e insere o conteúdo do arquivo,
 * tudo numa única transação (falha = nada muda). Exige o mesmo nível de migrations.
 */
export async function restoreDatabase(dump: Dump) {
  if (dump.format !== 'onema-backup/1') throw new Error('Arquivo de backup em formato desconhecido.');
  const head = MIGRATIONS[MIGRATIONS.length - 1].name;
  if (dump.schemaHead !== head) throw new Error(`Backup gerado no schema ${dump.schemaHead}; banco atual em ${head}. Aplique as migrations correspondentes antes.`);
  const existing = await appTables();
  const tables = Object.keys(dump.tables).filter((t) => existing.includes(t));
  const order = await insertionOrder(tables);
  return tx(async () => {
    await exec(`TRUNCATE ${[...tables, ...existing.filter((t) => SKIP.has(t))].map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
    let rows = 0;
    for (const t of order) {
      const data = dump.tables[t];
      if (!data.length) continue;
      const cols = Object.keys(data[0]);
      const identity = await all<any>(`SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = ? AND is_identity = 'YES'`, t);
      const per = Math.max(1, Math.floor(30000 / cols.length));
      for (let i = 0; i < data.length; i += per) {
        const chunk = data.slice(i, i + per).map((r) => cols.map((c) => r[c]));
        if (identity.length) {
          const ph = `(${cols.map(() => '?').join(',')})`;
          await run(`INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(', ')}) OVERRIDING SYSTEM VALUE VALUES ${chunk.map(() => ph).join(', ')}`, ...chunk.flat());
        } else {
          await insertMany(`"${t}"`, cols.map((c) => `"${c}"`), chunk);
        }
      }
      for (const id of identity) {
        await one(`SELECT setval(pg_get_serial_sequence(?, ?), COALESCE((SELECT MAX("${id.column_name}") FROM "${t}"), 0) + 1, false)`, t, id.column_name);
      }
      rows += data.length;
    }
    return { tables: order.length, rows };
  });
}
