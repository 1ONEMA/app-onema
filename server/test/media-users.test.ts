import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, emailOf, idOf, loginAs, one, setup } from './helpers.ts';
import { config } from '../src/config.ts';
import { MEDIA_CHUNK_BYTES } from '../src/lib/storage.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

describe('Mídia em partes (vídeos maiores que o limite de uma requisição)', () => {
  it('envia em partes, conclui, aprova e serve por faixas com verificação por parte', async () => {
    const gestor = await loginAs(app, 'gestor');
    const file = crypto.randomBytes(MEDIA_CHUNK_BYTES * 2 + 1234);
    const init = await gestor.post('/api/admin/academy/media/uploads', { kind: 'VIDEO', title: 'Aula longa', filename: 'aula.mp4', mime: 'video/mp4', size: file.length, checksum: sha(file) });
    expect(init.status).toBe(200);
    expect(init.body.chunkCount).toBe(3);
    const put = (n: number, buf: Buffer) => app.inject({ method: 'PUT', url: `/api/admin/academy/media/uploads/${init.body.id}/chunks/${n}`, payload: buf,
      headers: { cookie: gestor.cookie, 'x-csrf-token': gestor.csrf, 'content-type': 'application/octet-stream' } });
    // conclusão antes de todas as partes é recusada
    expect((await put(0, file.subarray(0, MEDIA_CHUNK_BYTES))).statusCode).toBe(200);
    expect((await gestor.post(`/api/admin/academy/media/uploads/${init.body.id}/complete`)).body.error.code).toBe('UPLOAD_INCOMPLETE');
    // parte com tamanho errado é recusada; reenvio da mesma parte é aceito (idempotente)
    expect((await put(1, file.subarray(0, 10))).statusCode).toBe(400);
    for (let n = 1; n < 3; n++) expect((await put(n, file.subarray(n * MEDIA_CHUNK_BYTES, (n + 1) * MEDIA_CHUNK_BYTES))).statusCode).toBe(200);
    expect((await put(2, file.subarray(2 * MEDIA_CHUNK_BYTES))).statusCode).toBe(200);
    const done = await gestor.post(`/api/admin/academy/media/uploads/${init.body.id}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.state).toBe('PENDING');
    const rt = await loginAs(app, 'rt');
    expect((await rt.post(`/api/admin/academy/media/${init.body.id}/approve`)).status).toBe(200);
    const url = (await gestor.get(`/api/admin/academy/media/${init.body.id}/preview`)).body.url;
    // faixa no meio da segunda parte: resposta limitada ao fim da parte
    const start = MEDIA_CHUNK_BYTES + 100;
    const r = await app.inject({ url, headers: { range: `bytes=${start}-` } });
    expect(r.statusCode).toBe(206);
    expect(r.headers['content-range']).toBe(`bytes ${start}-${2 * MEDIA_CHUNK_BYTES - 1}/${file.length}`);
    expect(Buffer.compare(r.rawPayload, file.subarray(start, 2 * MEDIA_CHUNK_BYTES))).toBe(0);
    const last = await app.inject({ url, headers: { range: `bytes=${file.length - 10}-${file.length - 1}` } });
    expect(Buffer.compare(last.rawPayload, file.subarray(file.length - 10))).toBe(0);
    expect((await app.inject({ url, headers: { range: `bytes=${file.length}-` } })).statusCode).toBe(416);
    // parte adulterada no armazenamento: bloqueio ao servir
    fs.writeFileSync(path.join(config.mediaDir, `${init.body.id}.1`), 'x');
    expect((await app.inject({ url, headers: { range: `bytes=${start}-` } })).statusCode).toBe(409);
    expect((await one<any>('SELECT state FROM academy_media_assets WHERE id = ?', init.body.id)).state).toBe('BLOCKED');
  });

  it('checksum esperado divergente bloqueia; mídia pode ser excluída se não estiver em aula; somente o autor envia partes', async () => {
    const gestor = await loginAs(app, 'gestor');
    const file = Buffer.from('legenda WEBVTT ficticia');
    const init = await gestor.post('/api/admin/academy/media/uploads', { kind: 'CAPTION', title: 'Legenda', filename: 'a.vtt', mime: 'text/vtt', size: file.length, checksum: sha(file) });
    const admin = await loginAs(app, 'adminAcademy');
    const other = await app.inject({ method: 'PUT', url: `/api/admin/academy/media/uploads/${init.body.id}/chunks/0`, payload: file,
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': 'application/octet-stream' } });
    expect(other.statusCode).toBe(404);
    await app.inject({ method: 'PUT', url: `/api/admin/academy/media/uploads/${init.body.id}/chunks/0`, payload: file,
      headers: { cookie: gestor.cookie, 'x-csrf-token': gestor.csrf, 'content-type': 'application/octet-stream' } });
    const done = await gestor.post(`/api/admin/academy/media/uploads/${init.body.id}/complete`, { expectedChecksum: 'b'.repeat(64) });
    expect(done.status).toBe(409);
    expect((await one<any>('SELECT state FROM academy_media_assets WHERE id = ?', init.body.id)).state).toBe('BLOCKED');
    expect((await gestor.req('DELETE', `/api/admin/academy/media/${init.body.id}`)).status).toBe(200);
    expect(await one('SELECT 1 FROM academy_media_assets WHERE id = ?', init.body.id)).toBeUndefined();
  });
});

describe('Aulas em rascunho', () => {
  it('adiciona e remove aula somente em rascunho, com auditoria', async () => {
    const gestor = await loginAs(app, 'gestor');
    const draft = await gestor.post('/api/admin/academy/course-versions', { courseCode: 'C02' });
    const add = await gestor.post(`/api/admin/academy/course-versions/${draft.body.id}/lessons`, { title: 'Aula complementar' });
    expect(add.status).toBe(200);
    expect(add.body.code).toMatch(/^C02-A\d{2}$/);
    expect((await one<any>(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'LESSON_ADDED'`)).n).toBe(1);
    expect((await gestor.req('DELETE', `/api/admin/academy/lessons/${add.body.id}`)).status).toBe(200);
    const published = await one<any>(`SELECT l.id FROM academy_lessons l JOIN academy_course_versions cv ON cv.id = l.course_version_id WHERE cv.state = 'PUBLISHED' LIMIT 1`);
    expect((await gestor.req('DELETE', `/api/admin/academy/lessons/${published.id}`)).status).toBe(409);
  });
});

describe('Exclusão de usuários', () => {
  it('apaga conta sem histórico, anonimiza conta com histórico e respeita permissões', async () => {
    const admin = await loginAs(app, 'adminAcademy');
    const created = await admin.post('/api/admin/users', { name: 'Pessoa Ficticia', email: 'pessoa.ficticia@exemplo.test', roles: ['SUPORTE_ACADEMY'] });
    expect((await admin.req('DELETE', `/api/admin/users/${created.body.id}`)).body.mode).toBe('removed');
    expect(await one('SELECT 1 FROM users WHERE id = ?', created.body.id)).toBeUndefined();
    // especialista com matrícula/pagamento na demonstração: anonimizado
    const esp = await idOf('especialista');
    const r = await admin.req('DELETE', `/api/admin/users/${esp}`);
    expect(r.status).toBe(200);
    const u = await one<any>('SELECT name, email, status, deleted_at FROM users WHERE id = ?', esp);
    if (r.body.mode === 'anonymized') {
      expect(u.email).toMatch(/@removido\.invalid$/);
      expect(u.status).toBe('DISABLED');
    } else expect(u).toBeUndefined();
    expect((await new Client(app).req('POST', '/api/auth/login', { email: emailOf('especialista'), password: 'Onema-Demo-2026' })).status).toBe(401);
    const list = await admin.get('/api/admin/users?q=');
    expect(list.body.users.some((x: any) => x.id === esp)).toBe(false);
    // não exclui a si mesmo; não exclui perfil que não pode atribuir
    expect((await admin.req('DELETE', `/api/admin/users/${await idOf('adminAcademy')}`)).status).toBe(409);
    expect((await admin.req('DELETE', `/api/admin/users/${await idOf('operador')}`)).status).toBe(403);
    expect((await one<any>(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'USER_DELETED'`)).n).toBe(2);
  });
});
