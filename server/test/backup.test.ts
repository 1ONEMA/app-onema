import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, loginAs, one, setup } from './helpers.ts';
import { all, run } from '../src/db/db.ts';
import { decompress, exportDatabase, restoreDatabase } from '../src/lib/backup.ts';

let app: FastifyInstance;
beforeAll(() => { process.env.BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'onema-bkp-')); });
beforeEach(async () => { app = await setup(); });

describe('Backup e restauração (ACA-T045)', () => {
  it('gera, lista e baixa backup (somente administradores, com auditoria)', async () => {
    const admin = await loginAs(app, 'adminAcademy');
    const made = await admin.post('/api/admin/backups');
    expect(made.status).toBe(200);
    expect(made.body.rows).toBeGreaterThan(10);
    const list = await admin.get('/api/admin/backups');
    expect(list.body.backups[0].key).toBe(made.body.key);
    const dl = await app.inject({ url: `/api/admin/backups/${made.body.key}`, headers: { cookie: admin.cookie } });
    expect(dl.statusCode).toBe(200);
    const dump = JSON.parse(zlib.gunzipSync(dl.rawPayload).toString());
    expect(dump.tables.users.length).toBeGreaterThan(5);
    expect(dump.tables.sessions).toBeUndefined();
    expect((await one<any>(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'BACKUP_DOWNLOADED'`)).n).toBe(1);
    // perfis sem permissão e anônimos
    const gestor = await loginAs(app, 'gestor');
    expect((await gestor.get('/api/admin/backups')).status).toBe(403);
    expect((await app.inject({ url: `/api/admin/backups/${made.body.key}` })).statusCode).toBe(401);
    expect((await admin.get('/api/admin/backups/..%2F..%2Fetc%2Fpasswd')).status).toBe(400);
  });

  it('restaura exatamente o estado do backup, incluindo trilha de auditoria e sequência', async () => {
    for (let i = 0; i < 3; i++) await run(`INSERT INTO audit_events (id, action, subject_type, occurred_at) VALUES (?, 'TEST', 'system', '2026-01-01')`, `x-before-${i}`);
    const before = await exportDatabase();
    const seqBefore = (await one<any>('SELECT MAX(seq) AS s FROM audit_events')).s;
    // alterações após o backup
    await run(`UPDATE users SET name = 'Alterado' WHERE email = 'paciente.demo@exemplo.test'`);
    await run(`DELETE FROM catalog_items`);
    const r = await restoreDatabase(decompress(zlib.gzipSync(Buffer.from(JSON.stringify(before)))));
    expect(r.rows).toBeGreaterThan(10);
    const after = await exportDatabase();
    for (const t of Object.keys(before.tables)) expect(after.tables[t].length, t).toBe(before.tables[t].length);
    expect((await one<any>(`SELECT name FROM users WHERE email = 'paciente.demo@exemplo.test'`)).name).not.toBe('Alterado');
    expect((await all('SELECT 1 FROM catalog_items')).length).toBe(before.tables.catalog_items.length);
    // nova auditoria continua a sequência sem colisão
    await run(`INSERT INTO audit_events (id, action, subject_type, occurred_at) VALUES ('x-after-restore', 'TEST', 'system', '2026-01-01')`);
    expect((await one<any>(`SELECT seq FROM audit_events WHERE id = 'x-after-restore'`)).seq).toBeGreaterThan(seqBefore);
    // login funciona após restauração (sessões foram encerradas)
    expect((await new Client(app).req('POST', '/api/auth/login', { email: 'paciente.demo@exemplo.test', password: 'Onema-Demo-2026' })).status).toBe(200);
  });

  it('recusa backup de outro nível de schema', async () => {
    const d = await exportDatabase();
    await expect(restoreDatabase({ ...d, schemaHead: '001_core' })).rejects.toThrow(/schema/);
  });
});
