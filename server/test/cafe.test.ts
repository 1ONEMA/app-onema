import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, loginAs, one, setup } from './helpers.ts';
import { run } from '../src/db/db.ts';
import { CAFE_LIBRARY } from '../src/modules/cafe/library.ts';
import { seedCafeLibrary } from '../src/modules/cafe/routes.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });

describe('Café com a ONEMA', () => {
  it('biblioteca anual: 366 dias, um devocional diferente por dia, sem repetir versículo', async () => {
    expect(CAFE_LIBRARY).toHaveLength(366);
    expect(new Set(CAFE_LIBRARY.map((d) => d.day)).size).toBe(366);
    expect(new Set(CAFE_LIBRARY.map((d) => d.ref)).size).toBe(366);
    for (const d of CAFE_LIBRARY) {
      const words = d.reflection.split(/\s+/).length;
      expect(words, d.ref).toBeGreaterThanOrEqual(80);
      expect(d.reflection.includes('\n'), d.ref).toBe(false); // 1 parágrafo
    }
    expect((await one<any>('SELECT COUNT(*) AS n FROM devotionals WHERE day_key IS NOT NULL')).n).toBe(366);
    expect(await seedCafeLibrary()).toBe(0); // idempotente
  });

  it('público por data local; troca de um dia para o outro; equipe publica e desfaz por data', async () => {
    const anon = new Client(app);
    const a = (await anon.get('/api/public/cafe?date=2026-10-27')).body;
    const b = (await anon.get('/api/public/cafe?date=2026-10-28')).body;
    expect(a).toMatchObject({ date: '2026-10-27', ref: expect.any(String), verse: expect.any(String), reflection: expect.any(String) });
    expect(a.ref).not.toBe(b.ref);
    expect((await anon.get('/api/public/cafe?date=2026-02-29')).status).toBe(200);
    expect((await anon.get('/api/public/cafe?date=27/10/2026')).status).toBe(400);

    const body = { ref: 'Salmos 23:1', verse: 'O Senhor é o meu pastor; nada me faltará.', reflection: 'Texto autoral de teste com reflexão suficiente para o devocional do dia, escrito pela equipe de conteúdo da ONEMA para esta data específica.' };
    expect((await anon.put('/api/admin/cafe/2026-10-27', body)).status).toBe(401);
    const aud = await loginAs(app, 'auditor');
    expect((await aud.put('/api/admin/cafe/2026-10-27', body)).status).toBe(403);
    const g = await loginAs(app, 'gestor');
    expect((await g.put('/api/admin/cafe/2026-10-27', { ...body, reflection: 'curto' })).status).toBe(400);
    expect((await g.put('/api/admin/cafe/2026-10-27', body)).body.day).toMatchObject({ ref: 'Salmos 23:1', source: 'PUBLICACAO' });
    expect((await anon.get('/api/public/cafe?date=2026-10-27')).body.ref).toBe('Salmos 23:1');
    expect((await g.get('/api/admin/cafe?from=2026-10-27')).body.days).toHaveLength(14);
    await g.req('DELETE', '/api/admin/cafe/2026-10-27');
    expect((await anon.get('/api/public/cafe?date=2026-10-27')).body.ref).toBe(a.ref);
    expect((await one<any>(`SELECT COUNT(*) AS n FROM audit_events WHERE action IN ('CAFE_PUBLICADO','CAFE_REMOVIDO')`)).n).toBe(2);
  });

  it('lote 07/11–06/12: 30 datas com 2 parágrafos, sem sobrescrever data já publicada; importação idempotente', async () => {
    const { importCafeBatches } = await import('../src/modules/cafe/routes.ts');
    const anon = new Client(app);
    const d = (await anon.get('/api/public/cafe?date=2026-11-07')).body;
    expect(d).toMatchObject({ ref: 'Salmos 92:2', scriptureEdition: 'Almeida 1911 (ortografia atualizada)' });
    expect(d.paragraphs).toHaveLength(2);
    expect((await anon.get('/api/public/cafe?date=2026-12-06')).body.paragraphs).toHaveLength(2);
    expect((await one<any>(`SELECT COUNT(*) AS n FROM devotionals WHERE batch = '2026-11-07_2026-12-06'`)).n).toBe(30);
    // data já publicada pela equipe é preservada
    await run(`UPDATE devotionals SET ref = 'Equipe 1:1' WHERE publish_date = '2026-11-08'`);
    expect(await importCafeBatches()).toBe(0);
    expect((await anon.get('/api/public/cafe?date=2026-11-08')).body.ref).toBe('Equipe 1:1');
  });
});
