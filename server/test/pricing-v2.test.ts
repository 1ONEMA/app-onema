import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, all, emailOf, loginAs, one, setup } from './helpers.ts';
import { PRICING_V1 } from '../src/db/content/pricing-v1.ts';
import { PRICING_V2_SOURCE, seedPricingV2 } from '../src/modules/care/catalog.ts';
import { config } from '../src/config.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });

describe('Reajuste nov/2026 (+R$ 10 em todo o catálogo)', () => {
  it('nova versão para os 19 itens com +R$ 10, repasses e composição iguais; idempotente; pedidos usam o preço novo', async () => {
    const r = await seedPricingV2({ force: true });
    expect(r).toEqual({ created: PRICING_V1.length, divergences: [] });
    expect((await seedPricingV2({ force: true })).created).toBe(0);
    for (const d of PRICING_V1) {
      const v = await all<any>(`SELECT v.price_cents, v.payout_total_cents, v.acts_total, v.source FROM catalog_item_versions v JOIN catalog_items i ON i.id = v.catalog_item_id WHERE i.code = ? ORDER BY v.version`, d.code);
      expect(v).toHaveLength(2);
      expect(v[1]).toMatchObject({ price_cents: d.price + 1000, payout_total_cents: v[0].payout_total_cents, acts_total: v[0].acts_total, source: PRICING_V2_SOURCE });
    }
    const c = new Client(app); await c.login(emailOf('paciente'));
    const cat01 = PRICING_V1.find((d) => d.code === 'CAT-01')!;
    expect((await c.get('/api/care/price?itemCode=CAT-01')).body.offer.priceCents).toBe(cat01.price + 1000);
    expect((await one<any>(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'PRICING_V2_LOADED'`)).n).toBe(1);
    // Academy R$ 29,90 e PRIME inalterado (R$ 34,90)
    expect(config.academyFeeCents).toBe(2990);
    expect((await c.get('/api/prime/offer')).body.monthlyPriceCents).toBe(3490);
    // autoteste da Central reconhece a tabela reajustada (repasses inalterados)
    const fin = await loginAs(app, 'financeiro');
    const check = (await fin.get('/api/admin/care/selfcheck')).body.results;
    expect(check.filter((x: any) => !x.pass).map((x: any) => `${x.id}: ${x.details.join(' | ')}`)).toEqual([]);
  });
});
