import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, emailOf, loginAs, one, setup } from './helpers.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });

async function login(key: Parameters<typeof emailOf>[0]) {
  const c = new Client(app);
  await c.login(emailOf(key));
  return c;
}

async function uploadVideo(gestor: Client, bytes: Buffer) {
  const sha = createHash('sha256').update(bytes).digest('hex');
  const up = (await gestor.post('/api/admin/academy/media/uploads', { kind: 'VIDEO', title: 'C05 · Seu primeiro atendimento', filename: 'AULA 05.mp4', mime: 'video/mp4', size: bytes.length, checksum: sha })).body;
  const put = await app.inject({ method: 'PUT', url: `/api/admin/academy/media/uploads/${up.id}/chunks/0`, payload: bytes,
    headers: { cookie: gestor.cookie, 'x-csrf-token': gestor.csrf, 'content-type': 'application/octet-stream' } });
  expect(put.statusCode).toBe(200);
  expect((await gestor.post(`/api/admin/academy/media/uploads/${up.id}/complete`, {})).body.state).toBe('PENDING');
  return up.id as string;
}

describe('C05 · vídeo de orientação (não é curso)', () => {
  it('sem configuração: especialista não recebe URL', async () => {
    const esp = await login('especialista');
    const r = await esp.get('/api/academy/orientation-video');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ configured: false, video: null });
  });

  it('gestor configura → especialista recebe URL reproduzível; jornada continua com 4 cursos', async () => {
    const gestor = await loginAs(app, 'gestor');
    const bytes = Buffer.from('video-ficticio-c05-primeiro-atendimento');
    const id = await uploadVideo(gestor, bytes);
    const set = await gestor.put('/api/admin/academy/orientation-video', { assetId: id });
    expect(set.status).toBe(200);
    expect((await one<any>(`SELECT value FROM system_settings WHERE key = 'academy_c05_video_asset'`)).value).toBe(id);
    expect(await one<any>(`SELECT 1 AS ok FROM audit_events WHERE action = 'ACADEMY_C05_VIDEO_SET' AND subject_id = 'academy_c05_video_asset'`)).toBeTruthy();
    // não passa a ser mídia "aprovada pelo RT"
    expect((await one<any>('SELECT state FROM academy_media_assets WHERE id = ?', id)).state).toBe('PENDING');

    const adminView = await gestor.get('/api/admin/academy/orientation-video');
    expect(adminView.body.configured).toBe(true);
    expect(adminView.body.asset.id).toBe(id);

    const esp = await login('especialista');
    const r = await esp.get('/api/academy/orientation-video');
    expect(r.body.configured).toBe(true);
    expect(r.body.video.mime).toBe('video/mp4');
    const play = await app.inject({ method: 'GET', url: r.body.video.url });
    expect(play.statusCode).toBe(200);
    expect(play.rawPayload.equals(bytes)).toBe(true);
    const ranged = await app.inject({ method: 'GET', url: r.body.video.url, headers: { range: 'bytes=0-4' } });
    expect(ranged.statusCode).toBe(206);
    // URL adulterada é recusada
    expect((await app.inject({ method: 'GET', url: r.body.video.url.replace(/sig=\w/, 'sig=0') })).statusCode).toBe(403);

    // fora da lógica de cursos: jornada, contagem e certificado inalterados
    const j = await esp.get('/api/academy/journey');
    expect(j.body.courses.map((c: any) => c.code)).toEqual(['C01', 'C02', 'C03', 'C04']);

    // troca do vídeo
    const id2 = await uploadVideo(gestor, Buffer.from('video-ficticio-c05-v2'));
    expect((await gestor.put('/api/admin/academy/orientation-video', { assetId: id2 })).status).toBe(200);
    expect((await esp.get('/api/academy/orientation-video')).body.video.url).toContain(id2);
  });

  it('paciente e outros perfis não configuram; paciente não obtém a URL', async () => {
    const gestor = await loginAs(app, 'gestor');
    const id = await uploadVideo(gestor, Buffer.from('video-ficticio-c05'));
    const paciente = await login('paciente');
    expect((await paciente.put('/api/admin/academy/orientation-video', { assetId: id })).status).toBe(403);
    expect((await paciente.get('/api/academy/orientation-video')).status).toBe(403);
    const esp = await login('especialista');
    expect((await esp.put('/api/admin/academy/orientation-video', { assetId: id })).status).toBe(403);
    for (const k of ['rt', 'auditor', 'financeiro'] as const) {
      const c = await loginAs(app, k);
      expect((await c.put('/api/admin/academy/orientation-video', { assetId: id })).status).toBe(403);
    }
    expect(await one<any>(`SELECT 1 AS ok FROM system_settings WHERE key = 'academy_c05_video_asset'`)).toBeFalsy();
    const anon = new Client(app);
    expect((await anon.put('/api/admin/academy/orientation-video', { assetId: id })).status).toBeGreaterThanOrEqual(401);
  });

  it('admin academy também configura; mídia que não é vídeo é recusada', async () => {
    const gestor = await loginAs(app, 'gestor');
    const id = await uploadVideo(gestor, Buffer.from('video-ficticio-c05-admin'));
    const admin = await loginAs(app, 'adminAcademy');
    expect((await admin.put('/api/admin/academy/orientation-video', { assetId: id })).status).toBe(200);
    const vtt = Buffer.from('WEBVTT\n');
    const cap = (await gestor.post('/api/admin/academy/media/uploads', { kind: 'CAPTION', title: 'Legenda C05', filename: 'a.vtt', mime: 'text/vtt', size: vtt.length, checksum: createHash('sha256').update(vtt).digest('hex') })).body;
    await app.inject({ method: 'PUT', url: `/api/admin/academy/media/uploads/${cap.id}/chunks/0`, payload: vtt, headers: { cookie: gestor.cookie, 'x-csrf-token': gestor.csrf, 'content-type': 'application/octet-stream' } });
    await gestor.post(`/api/admin/academy/media/uploads/${cap.id}/complete`, {});
    expect((await gestor.put('/api/admin/academy/orientation-video', { assetId: cap.id })).status).toBe(400);
  });
});
