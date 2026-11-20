/** Foto do perfil do paciente/responsável (Ajuste 04): opcional, sempre "minha", nunca atribuída automaticamente. */
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, all, emailOf, idOf, setup } from './helpers.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8]);

function putPhoto(c: Client, body: Buffer, filename = 'foto.png') {
  const b = '----onema' + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), body, Buffer.from(`\r\n--${b}--\r\n`)]);
  return app.inject({ method: 'PUT', url: '/api/me/photo', payload, headers: { cookie: c.cookie, 'x-csrf-token': c.csrf, 'content-type': `multipart/form-data; boundary=${b}` } });
}
async function login(key: 'paciente' | 'responsavel' | 'especialista') {
  const c = new Client(app);
  await c.login(emailOf(key));
  return c;
}

describe('foto do perfil (/api/me/photo)', () => {
  it('sem foto → 404; envio → 200 com a imagem; remover → 404 (registro mantido)', async () => {
    const p = await login('paciente');
    expect((await p.get('/api/me/photo')).status).toBe(404);

    const up = await putPhoto(p, PNG);
    expect(up.statusCode).toBe(200);
    const g = await app.inject({ method: 'GET', url: '/api/me/photo', headers: { cookie: p.cookie } });
    expect(g.statusCode).toBe(200);
    expect(g.headers['content-type']).toBe('image/png');
    expect(g.headers['cache-control']).toBe('private, no-store');
    expect(Buffer.compare(g.rawPayload, PNG)).toBe(0);

    // Trocar foto: a nova passa a valer.
    expect((await putPhoto(p, JPEG, 'nova.jpg')).statusCode).toBe(200);
    const g2 = await app.inject({ method: 'GET', url: '/api/me/photo', headers: { cookie: p.cookie } });
    expect(g2.headers['content-type']).toBe('image/jpeg');

    expect((await p.req('DELETE', '/api/me/photo')).status).toBe(200);
    expect((await p.get('/api/me/photo')).status).toBe(404);
    expect((await p.req('DELETE', '/api/me/photo')).status).toBe(404);

    const uid = await idOf('paciente');
    const rows = await all<any>('SELECT * FROM user_photos WHERE user_id = ?', uid);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.removed_at)).toBe(true);
    const audits = await all<any>(`SELECT action FROM audit_events WHERE subject_type = 'user_photo' ORDER BY occurred_at, seq`);
    expect(audits.map((a) => a.action)).toEqual(['USER_PHOTO_ADDED', 'USER_PHOTO_CHANGED', 'USER_PHOTO_REMOVED']);
  });

  it('outra pessoa não vê a foto (a rota é sempre "minha")', async () => {
    const p = await login('paciente');
    expect((await putPhoto(p, PNG)).statusCode).toBe(200);
    const r = await login('responsavel');
    expect((await r.get('/api/me/photo')).status).toBe(404);
    expect((await r.req('DELETE', '/api/me/photo')).status).toBe(404);
    // A foto da paciente continua lá.
    expect((await app.inject({ method: 'GET', url: '/api/me/photo', headers: { cookie: p.cookie } })).statusCode).toBe(200);
    // Sem sessão: 401.
    expect((await new Client(app).get('/api/me/photo')).status).toBe(401);
  });

  it('recusa arquivo que não é imagem e perfil que não é paciente', async () => {
    const p = await login('paciente');
    expect((await putPhoto(p, Buffer.from('%PDF-1.4 x'), 'doc.pdf')).statusCode).toBe(400);
    expect((await putPhoto(p, Buffer.from('texto qualquer'), 'a.png')).statusCode).toBe(400);
    expect((await p.get('/api/me/photo')).status).toBe(404);
    const e = await login('especialista');
    expect((await putPhoto(e, PNG)).statusCode).toBe(403);
  });
});
