/**
 * Exercita o driver `pg` (usado na Netlify/Neon) contra um servidor Postgres de protocolo real (PGlite via socket).
 * Cobre: migrations, seed, conversão de tipos, transação com rollback e fluxo HTTP completo de login + PRIME.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { getDriver, one, run, setDriver, tx } from '../src/db/db.ts';
import { migrate } from '../src/db/migrate.ts';
import { seedDemo } from '../src/db/seed.ts';
import { Client, emailOf } from './helpers.ts';

let server: PGLiteSocketServer;
let db: PGlite;
let app: FastifyInstance;
const PORT = 55432 + Number(process.env.VITEST_POOL_ID ?? 0);

beforeAll(async () => {
  db = await PGlite.create();
  server = new PGLiteSocketServer({ db, port: PORT, host: '127.0.0.1' });
  await server.start();
  process.env.DATABASE_URL = `postgres://postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;
  process.env.DB_POOL_MAX = '1';
  setDriver(null);
  const d = await getDriver();
  expect(d.kind).toBe('pg');
  await migrate();
  await seedDemo();
  app = await buildApp();
});
afterAll(async () => {
  await (await getDriver()).close();
  await server.stop();
  await db.close();
  delete process.env.DATABASE_URL;
});

describe('driver pg (produção)', () => {
  it('tipos numéricos, contagens e rollback', async () => {
    const r = await one<any>('SELECT COUNT(*) AS n, SUM(price_cents) AS s FROM catalog_items');
    expect(r.n).toBe(4);
    expect(typeof r.s).toBe('number');
    await expect(tx(async () => { await run(`UPDATE catalog_items SET name = 'x'`); throw new Error('abort'); })).rejects.toThrow('abort');
    expect((await one<any>(`SELECT COUNT(*) AS n FROM catalog_items WHERE name = 'x'`)).n).toBe(0);
  });

  it('fluxo HTTP: login, adesão PRIME e pedido com desconto', async () => {
    const c = new Client(app);
    await c.login(emailOf('paciente'));
    const offer = await c.get('/api/prime/offer');
    const s = await c.post('/api/prime/subscriptions', {
      acceptTerms: true, termsTextId: offer.body.terms.id, privacyTextId: offer.body.privacy.id, paymentMethod: 'SANDBOX_APROVADO',
      preferences: { LEMBRETES: { enabled: false, channels: { app: false, email: false, whatsapp: false } }, RESUMO_MENSAL: { enabled: false, channels: { app: false, email: false, whatsapp: false } }, OFERTAS: { enabled: false, channels: { app: false, email: false, whatsapp: false } } },
    }, true);
    expect(s.status).toBe(201);
    const q = await c.post('/api/prime/orders/quote', { itemCode: 'DEMO-SERV-C' });
    expect(q.body.discountCents).toBe(2000);
    const o = await c.post('/api/prime/orders', { itemCode: 'DEMO-SERV-C', paymentMethod: 'SANDBOX_APROVADO', expectedFinalPriceCents: q.body.finalPriceCents }, true);
    expect(o.body.order.status).toBe('PAID');
    const dup = await c.post('/api/prime/orders', { itemCode: 'DEMO-SERV-C', paymentMethod: 'SANDBOX_APROVADO', expectedFinalPriceCents: q.body.finalPriceCents }, true);
    expect(dup.status).toBe(409);
    await expect(run('DELETE FROM audit_events')).rejects.toThrow(/append-only/);
  });
});
