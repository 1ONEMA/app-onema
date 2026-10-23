/**
 * Homologação técnica da precificação — casos P01–P15 do
 * "Comando Oficial de Implantação da Precificação no PWA/App" (RT, 30/09/2026).
 * Cada `describe` corresponde a um caso; o relatório (docs/HOMOLOGACAO_PRECIFICACAO.md) cita estes nomes.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, all, emailOf, idOf, loginAs, one, run, setup } from './helpers.ts';
import { EXPECTED_PAYOUT, PRICING_V1, SECTION7_REFERENCE } from '../src/db/content/pricing-v1.ts';
import { seedPricingV1 } from '../src/modules/care/catalog.ts';
import { contribution } from '../src/modules/care/core.ts';
import { discountFor } from '../src/modules/prime/core.ts';
import { hmac } from '../src/lib/security.ts';
import { config } from '../src/config.ts';
import { exportDatabase, restoreDatabase } from '../src/lib/backup.ts';
import { karyReply } from '../src/modules/kary/routes.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });

const OFF = { enabled: false, channels: { app: false, email: false, whatsapp: false } };
const NO_PREFS = { LEMBRETES: OFF, RESUMO_MENSAL: OFF, OFERTAS: OFF };

async function patient(key: 'paciente' | 'responsavel' = 'paciente') { const c = new Client(app); await c.login(emailOf(key)); return c; }
async function subscribe(c: Client) {
  const offer = await c.get('/api/prime/offer');
  const r = await c.post('/api/prime/subscriptions', { acceptTerms: true, termsTextId: offer.body.terms.id, privacyTextId: offer.body.privacy.id, paymentMethod: 'SANDBOX_APROVADO', preferences: NO_PREFS }, true);
  expect(r.status).toBe(201);
}
const NEED_OF = Object.fromEntries(PRICING_V1.map((d) => [d.code, d.need]));
function form(itemCode: string, extra: Record<string, unknown> = {}) {
  return {
    need: NEED_OF[itemCode], itemCode, infoText: 'Teste de homologação (fictício)', materials: 'SIM', materialsDetail: '', materialsSupplyRequested: false,
    patientName: 'Paciente Fictício', phone: '(11) 99999-0000', location: 'Vila Mariana', whenPref: 'PROXIMOS_DIAS', whenDate: null, notes: '',
    forSelf: true, responsibleAuthorized: false, ...extra,
  };
}
/** Solicitação → aceite → checkout. Retorna a resposta do checkout. */
async function contract(c: Client, itemCode: string, method = 'SANDBOX_APROVADO', key?: string) {
  const r = await c.post('/api/care/requests', form(itemCode), true);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const req = r.body.request;
  const acc = await c.post(`/api/care/requests/${req.id}/accept`, { quoteVersion: req.quoteVersion });
  expect(acc.status).toBe(200);
  const pay = await c.post(`/api/care/requests/${req.id}/checkout`, { quoteVersion: req.quoteVersion, paymentMethod: method, expectedTotalCents: req.quote.totalCents }, key ?? true);
  return { req, pay };
}

describe('P01 — Carga dos registros', () => {
  it('11 serviços/continuidade + 8 pacotes com os valores das seções 2 e 3; monitoramento sem duplicação', async () => {
    const items = await all<any>(`SELECT i.code, i.kind, i.canonical_code, v.price_cents, v.payout_total_cents, v.acts_total, v.prime_eligible
      FROM catalog_items i JOIN catalog_item_versions v ON v.catalog_item_id = i.id WHERE i.need IS NOT NULL ORDER BY i.code`);
    expect(items.filter((i) => i.kind === 'SERVICO')).toHaveLength(11);
    expect(items.filter((i) => i.kind === 'PACOTE')).toHaveLength(8);
    for (const d of PRICING_V1) {
      const it = items.find((i) => i.code === d.code)!;
      expect(it.price_cents, d.code).toBe(d.price);
      expect([it.payout_total_cents, it.acts_total], d.code).toEqual(EXPECTED_PAYOUT[d.code]);
      expect(it.prime_eligible, d.code).toBe(1);
    }
    const mon = items.filter((i) => i.code === 'CAT-08' || i.code === 'PAC-05');
    expect(new Set(mon.map((m) => m.canonical_code)).size).toBe(1);
    // Vitrine do paciente mostra a oferta de monitoramento UMA vez, com os dois códigos.
    const needs = (await new Client(app).get('/api/care/needs')).body.needs;
    const monitoring = needs.find((n: any) => n.key === 'MONITORAMENTO').offers.filter((o: any) => o.canonicalCode === mon[0].canonical_code);
    expect(monitoring).toHaveLength(1);
    expect([monitoring[0].code, ...monitoring[0].alsoCodes].sort()).toEqual(['CAT-08', 'PAC-05']);
    // Itens fictícios antigos fora de venda
    expect((await all(`SELECT 1 FROM catalog_items WHERE is_demo = 1 AND active = 1`))).toHaveLength(0);
  });
});

describe('P02 — Pós-alta 7/14/30 dias', () => {
  it('2/4/6 atos; repasses R$ 220/440/660; composição e rótulos corretos; sem textos antigos', async () => {
    const adm = await loginAs(app, 'financeiro');
    const cat = (await adm.get('/api/admin/care/catalog')).body.items;
    const exp: Record<string, [number, number, string[]]> = {
      'PAC-01': [2, 22000, ['Avaliação inicial']],
      'PAC-02': [4, 44000, ['Avaliação inicial', 'Avaliação final']],
      'PAC-03': [6, 66000, ['Avaliação inicial', 'Avaliação intermediária', 'Avaliação final']],
    };
    for (const [code, [acts, payout, labels]] of Object.entries(exp)) {
      const it = cat.find((i: any) => i.code === code).current;
      expect(it.actsTotal).toBe(acts);
      expect(it.payoutTotalCents).toBe(payout);
      const pres = it.components.find((c: any) => c.modality === 'PRESENCIAL');
      const rem = it.components.find((c: any) => c.modality === 'REMOTO');
      expect([pres.qty, pres.unit, rem.qty, rem.unit]).toEqual([acts / 2, 17000, acts / 2, 5000]);
      expect(pres.unitLabels).toEqual(labels);
      const text = JSON.stringify(it);
      for (const old of ['3 atos', '5 atos', '9 atos', '27000', '37000', '57000']) expect(text, `${code} contém "${old}"`).not.toContain(old);
    }
  });
});

describe('P03 — Composição de pacotes', () => {
  it('soma de quantidades e repasses exata; eventos filhos não geram cobrança nem desconto', async () => {
    for (const d of PRICING_V1) {
      const payout = d.components.reduce((s, c) => s + c.qty * c.unit, 0), acts = d.components.reduce((s, c) => s + c.qty, 0);
      expect([payout, acts], d.code).toEqual(EXPECTED_PAYOUT[d.code]);
    }
    const c = await patient();
    await subscribe(c);
    const { pay } = await contract(c, 'PAC-08');
    expect(pay.status).toBe(201);
    const order = await one<any>('SELECT * FROM service_orders WHERE id = ?', pay.body.order.id);
    const events = await all<any>('SELECT * FROM care_events WHERE order_id = ?', order.id);
    const payouts = await all<any>('SELECT * FROM payout_entries WHERE order_id = ?', order.id);
    expect(events).toHaveLength(21);
    expect(payouts).toHaveLength(21);
    expect(payouts.reduce((s, p) => s + p.amount_cents, 0)).toBe(378000);
    expect(order.final_price_cents).toBe(587990); // um único desconto (R$ 20) para o pacote inteiro
    expect((await all('SELECT 1 FROM discount_reservations WHERE order_id = ?', order.id))).toHaveLength(1);
    expect((await all(`SELECT 1 FROM service_orders WHERE patient_id = ? AND status = 'PAID'`, order.patient_id))).toHaveLength(1);
  });
});

describe('P04 — Descontos da seção 7', () => {
  it('os 19 exemplos (fórmula do servidor e motor de orçamento)', async () => {
    expect(Object.keys(SECTION7_REFERENCE)).toHaveLength(19);
    for (const [code, [full, disc, fin]] of Object.entries(SECTION7_REFERENCE)) {
      expect(Math.min(Math.floor((full * 5 + 50) / 100), 2000), code).toBe(disc); // fórmula literal do comando
      expect(discountFor(full, 500, 2000), code).toBe(disc);
      expect(full - disc, code).toBe(fin);
    }
    // Pelo motor real, para um assinante com benefício disponível
    const c = await patient();
    await subscribe(c);
    for (const [code, [full, disc, fin]] of Object.entries(SECTION7_REFERENCE)) {
      const p = await c.get(`/api/care/price?itemCode=${code}`);
      expect([p.body.offer.priceCents, p.body.personal.discountCents, p.body.personal.totalCents], code).toEqual([full, disc, fin]);
    }
    const adm = await loginAs(app, 'rt');
    const self = await adm.get('/api/admin/care/selfcheck');
    expect(self.body.results.map((r: any) => [r.id, r.pass])).toEqual([['P01', true], ['P02', true], ['P03', true], ['P04', true]]);
  });
});

describe('P05 — Um uso por ciclo', () => {
  it('duplo clique (mesma chave) devolve o mesmo pedido; pedidos concorrentes e webhook repetido não consomem duas vezes', async () => {
    const c = await patient();
    await subscribe(c);
    const a = await c.post('/api/care/requests', form('CAT-01'), true);
    const b = await c.post('/api/care/requests', form('CAT-02A'), true);
    for (const r of [a, b]) await c.post(`/api/care/requests/${r.body.request.id}/accept`, { quoteVersion: 1 });
    // duplo clique
    const body = { quoteVersion: 1, paymentMethod: 'SANDBOX_APROVADO', expectedTotalCents: a.body.request.quote.totalCents };
    const [p1, p2] = await Promise.all([c.post(`/api/care/requests/${a.body.request.id}/checkout`, body, 'dup-click-key-1'), c.post(`/api/care/requests/${a.body.request.id}/checkout`, body, 'dup-click-key-1')]);
    expect([p1.status, p2.status].filter((s) => s === 201).length + [p1.status, p2.status].filter((s) => s === 409).length).toBe(2);
    expect((await all(`SELECT 1 FROM service_orders WHERE request_id = ?`, a.body.request.id))).toHaveLength(1);
    // segundo pedido no mesmo ciclo: o orçamento antigo (com desconto) não vale mais → PRICE_CHANGED
    const second = await c.post(`/api/care/requests/${b.body.request.id}/checkout`, { quoteVersion: 1, paymentMethod: 'SANDBOX_APROVADO', expectedTotalCents: b.body.request.quote.totalCents }, true);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('PRICE_CHANGED');
    expect(second.body.error.details.quote.discountCents).toBe(0);
    expect((await all(`SELECT 1 FROM discount_reservations WHERE status IN ('RESERVED','USED')`))).toHaveLength(1);
    // webhook repetido (assinado) não altera nada
    const orderId = (await one<any>(`SELECT id FROM service_orders WHERE request_id = ?`, a.body.request.id)).id;
    const ev = { eventId: 'evt_repeat_001', orderId, type: 'PAYMENT_CONFIRMED' };
    const sig = hmac(JSON.stringify(ev), config.paymentWebhookSecret);
    const w1 = await c.req('POST', '/api/care/payment-webhooks', ev, { 'x-onema-signature': sig });
    const w2 = await c.req('POST', '/api/care/payment-webhooks', ev, { 'x-onema-signature': sig });
    expect(w1.body.applied).toBe(false); // pedido já pago: ignorado
    expect(w2.body.duplicate).toBe(true);
    expect((await all(`SELECT 1 FROM payout_entries WHERE order_id = ?`, orderId))).toHaveLength(1);
    const bad = await c.req('POST', '/api/care/payment-webhooks', ev, { 'x-onema-signature': 'x' });
    expect(bad.status).toBe(403);
  });

  it('pedidos concorrentes com chaves diferentes: no máximo um desconto no ciclo', async () => {
    const c = await patient();
    await subscribe(c);
    const reqs = [];
    for (const code of ['CAT-03', 'CAT-04', 'CAT-05']) {
      const r = await c.post('/api/care/requests', form(code), true);
      await c.post(`/api/care/requests/${r.body.request.id}/accept`, { quoteVersion: 1 });
      reqs.push(r.body.request);
    }
    const res = await Promise.all(reqs.map((r) => c.post(`/api/care/requests/${r.id}/checkout`, { quoteVersion: 1, paymentMethod: 'SANDBOX_APROVADO', expectedTotalCents: r.quote.totalCents }, true)));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect((await all(`SELECT 1 FROM discount_reservations WHERE status IN ('RESERVED','USED')`))).toHaveLength(1);
  });
});

describe('P06 — Pedido falhou / estorno', () => {
  it('falha libera a reserva; estorno reconcilia por evento original, sem uso extra nem nova cobrança', async () => {
    const c = await patient();
    await subscribe(c);
    const r = await c.post('/api/care/requests', form('PAC-02'), true);
    const id = r.body.request.id;
    await c.post(`/api/care/requests/${id}/accept`, { quoteVersion: 1 });
    const fail = await c.post(`/api/care/requests/${id}/checkout`, { quoteVersion: 1, paymentMethod: 'SANDBOX_RECUSADO', expectedTotalCents: 70990 }, true);
    expect(fail.status).toBe(201);
    expect(fail.body.paid).toBe(false);
    expect((await one<any>(`SELECT status FROM discount_reservations`)).status).toBe('RELEASED');
    expect((await all(`SELECT 1 FROM care_events WHERE status <> 'CANCELADO'`))).toHaveLength(0);
    expect((await all(`SELECT 1 FROM payout_entries`))).toHaveLength(0);
    // nova tentativa: desconto ainda disponível
    const ok = await c.post(`/api/care/requests/${id}/checkout`, { quoteVersion: 1, paymentMethod: 'SANDBOX_APROVADO', expectedTotalCents: 70990 }, true);
    expect(ok.body.paid).toBe(true);
    const again = await c.post(`/api/care/requests/${id}/checkout`, { quoteVersion: 1, paymentMethod: 'SANDBOX_APROVADO', expectedTotalCents: 70990 }, true);
    expect(again.status).toBe(409); // não cobra de novo
    // especialista conclui um evento; Financeiro estorna
    const sp = new Client(app); await sp.login(emailOf('especialistaOne'));
    const first = (await sp.get('/api/care/specialist/offers')).body.offers[0];
    await sp.post(`/api/care/specialist/events/${first.id}/accept`);
    await sp.post(`/api/care/specialist/events/${first.id}/complete`);
    const fin = await loginAs(app, 'financeiro');
    const ref = await fin.post(`/api/admin/care/orders/${ok.body.order.id}/refund`, { reason: 'Teste de estorno (homologação)' });
    expect(ref.status).toBe(200);
    const twice = await fin.post(`/api/admin/care/orders/${ok.body.order.id}/refund`, { reason: 'Repetição' });
    expect(twice.status).toBe(409);
    const ord = await one<any>('SELECT * FROM service_orders WHERE id = ?', ok.body.order.id);
    expect(ord.status).toBe('REFUNDED');
    const payouts = await all<any>('SELECT status FROM payout_entries WHERE order_id = ?', ord.id);
    expect(payouts.filter((p) => p.status === 'A_LIQUIDAR')).toHaveLength(1); // ato já realizado mantém o repasse
    expect(payouts.filter((p) => p.status === 'CANCELADO')).toHaveLength(3);
    // o uso do ciclo não volta como novo uso
    const q = await c.get('/api/care/price?itemCode=CAT-01');
    expect(q.body.personal.discountCents).toBe(0);
    expect((await all(`SELECT 1 FROM discount_reservations WHERE status = 'USED'`))).toHaveLength(1);
  });
});

describe('P07 — Jornada de valores', () => {
  it('valores logo após materiais (sem login), mantidos na revisão; total e adicionais antes de pagar', async () => {
    const anon = new Client(app);
    const p = await anon.get('/api/care/price?itemCode=CAT-02B');
    expect(p.status).toBe(200);
    expect(p.body.offer.priceCents).toBe(45990);
    expect(p.body.primeExample).toEqual({ discountCents: 2000, totalCents: 43990 });
    expect(p.body.personal).toBeNull();
    const c = await patient();
    const r = await c.post('/api/care/requests', form('CAT-02B'), true);
    const q = r.body.request.quote;
    expect([q.basePriceCents, q.discountCents, q.totalCents, q.additions]).toEqual([45990, 0, 45990, []]);
    expect(q.noDiscountReason).toMatch(/R\$\s34,90/);
    expect(q.offer.inclusions.length).toBeGreaterThan(0);
    expect(q.offer.exclusions.join(' ')).toMatch(/materiais especiais/);
    // checkout sem aceite é bloqueado
    const no = await c.post(`/api/care/requests/${r.body.request.id}/checkout`, { quoteVersion: 1, paymentMethod: 'SANDBOX_APROVADO', expectedTotalCents: 45990 }, true);
    expect(no.body.error.code).toBe('ACCEPTANCE_REQUIRED');
    // nenhuma cobrança nasce do preenchimento
    expect((await all('SELECT 1 FROM service_orders'))).toHaveLength(0);
    expect((await all('SELECT 1 FROM discount_reservations'))).toHaveLength(0);
  });
});

describe('P08 — Materiais ausentes/indefinidos', () => {
  it('sem taxa presumida; pedido de fornecimento deixa orçamento pendente e impede cobrança', async () => {
    const c = await patient();
    const none = await c.post('/api/care/requests', form('CAT-02A', { materials: 'NAO_SEI' }), true);
    expect(none.body.request.quote.totalCents).toBe(30990);
    expect(none.body.request.status).toBe('ORCADO');
    const pend = await c.post('/api/care/requests', form('CAT-02A', { materials: 'NAO', materialsSupplyRequested: true }), true);
    expect(pend.body.request.status).toBe('ORCAMENTO_PENDENTE');
    expect(pend.body.request.quote.pending).toBe(true);
    const acc = await c.post(`/api/care/requests/${pend.body.request.id}/accept`, { quoteVersion: 1 });
    expect(acc.body.error.code).toBe('QUOTE_PENDING');
    const pay = await c.post(`/api/care/requests/${pend.body.request.id}/checkout`, { quoteVersion: 1, paymentMethod: 'SANDBOX_APROVADO', expectedTotalCents: 30990 }, true);
    expect(pay.body.error.code).toBe('QUOTE_PENDING');
    expect((await all('SELECT 1 FROM service_orders'))).toHaveLength(0);
  });
});

describe('P09 — Editar solicitação cotada', () => {
  it('recalcula, invalida o aceite anterior e pede nova confirmação', async () => {
    const c = await patient();
    const r = await c.post('/api/care/requests', form('CAT-01'), true);
    const id = r.body.request.id;
    await c.post(`/api/care/requests/${id}/accept`, { quoteVersion: 1 });
    const ed = await c.put(`/api/care/requests/${id}`, form('CONT-02'));
    expect(ed.body.quoteReissued).toBe(true);
    expect(ed.body.acceptanceInvalidated).toBe(true);
    expect(ed.body.request.quoteVersion).toBe(2);
    expect(ed.body.request.quote.totalCents).toBe(24990);
    expect(ed.body.request.acceptanceValid).toBe(false);
    const stale = await c.post(`/api/care/requests/${id}/accept`, { quoteVersion: 1 });
    expect(stale.body.error.code).toBe('QUOTE_OUTDATED');
    const pay = await c.post(`/api/care/requests/${id}/checkout`, { quoteVersion: 2, paymentMethod: 'SANDBOX_APROVADO', expectedTotalCents: 24990 }, true);
    expect(pay.body.error.code).toBe('ACCEPTANCE_REQUIRED');
    // edição só de logística não reemite orçamento
    await c.post(`/api/care/requests/${id}/accept`, { quoteVersion: 2 });
    const log = await c.put(`/api/care/requests/${id}`, form('CONT-02', { location: 'Moema' }));
    expect(log.body.quoteReissued).toBe(false);
    expect(log.body.request.quoteVersion).toBe(2);
  });
});

describe('P10 — PRIME opcional', () => {
  it('R$ 34,90 exibido antes de aderir; sem inclusão silenciosa; repasse integral com desconto', async () => {
    const c = await patient();
    const offer = await c.get('/api/prime/offer');
    expect(offer.body.monthlyPriceCents).toBe(3490);
    const { pay } = await contract(c, 'CAT-01');
    expect(pay.body.order.discountCents).toBe(0);
    expect((await all('SELECT 1 FROM subscriptions'))).toHaveLength(0);
    expect((await all('SELECT 1 FROM charges'))).toHaveLength(0);
    const c2 = await patient('responsavel');
    await subscribe(c2);
    const { pay: p2 } = await contract(c2, 'CAT-01');
    expect([p2.body.order.discountCents, p2.body.order.totalCents]).toEqual([1350, 25640]);
    const pays = await all<any>('SELECT o.discount_cents, p.amount_cents FROM payout_entries p JOIN service_orders o ON o.id = p.order_id');
    expect(pays.map((p) => p.amount_cents)).toEqual([17000, 17000]); // com e sem desconto
  });
});

describe('P11 — Perfis e documentos', () => {
  it('paciente não vê repasses; especialista vê repasse do evento; tabela completa só para perfis autorizados', async () => {
    const anon = new Client(app);
    const needs = JSON.stringify((await anon.get('/api/care/needs')).body);
    expect(needs).not.toMatch(/payout|repasse|margin|contribution/i);
    const c = await patient();
    const { req } = await contract(c, 'CAT-07');
    const detail = JSON.stringify((await c.get(`/api/care/requests/${req.id}`)).body);
    expect(detail).not.toMatch(/payout|repasse|unit_payout|contribution/i);
    expect((await c.get('/api/admin/care/catalog')).status).toBe(403);
    const sp = new Client(app); await sp.login(emailOf('especialistaOne'));
    const offers = (await sp.get('/api/care/specialist/offers')).body.offers;
    expect(offers[0].unit_payout_cents).toBe(23000);
    expect(JSON.stringify(offers)).not.toMatch(/final_price|discount|price_cents/);
    const sp2 = new Client(app); await sp2.login(emailOf('especialista2'));
    expect((await sp2.get('/api/care/specialist/offers')).status).toBe(403);
    // Academy liberada, mas sem decisão de credenciamento APTO: ainda não recebe ofertas.
    const sp3 = new Client(app); await sp3.login(emailOf('especialista'));
    const blocked = await sp3.get('/api/care/specialist/offers');
    expect([blocked.status, blocked.body.error.code]).toEqual([403, 'NOT_CREDENTIALED']);
    const op = await loginAs(app, 'operador');
    const ov = await op.get('/api/admin/care/overview');
    expect(ov.status).toBe(200);
    expect(JSON.stringify(ov.body.orders)).not.toMatch(/payout/);
    expect((await op.get('/api/admin/care/catalog')).status).toBe(403);
    // responsável sem autorização declarada não cria solicitação para terceiro
    const bad = await c.post('/api/care/requests', form('CAT-01', { forSelf: false, responsibleAuthorized: false }), true);
    expect(bad.status).toBe(400);
  });
});

describe('P12 — Estado da assinatura', () => {
  it('pendente/suspensa não dão desconto e explicam o motivo; ativa dá', async () => {
    const c = await patient();
    await subscribe(c);
    const sub = await one<any>('SELECT id FROM subscriptions');
    for (const [status, re] of [['PAYMENT_PENDING', /cobrança pendente/], ['SUSPENDED', /suspensos/]] as const) {
      await run('UPDATE subscriptions SET status = ? WHERE id = ?', status, sub.id);
      const r = await c.post('/api/care/requests', form('CAT-06'), true);
      expect(r.body.request.quote.discountCents, status).toBe(0);
      expect(r.body.request.quote.noDiscountReason, status).toMatch(re);
    }
    await run(`UPDATE subscriptions SET status = 'CANCEL_SCHEDULED' WHERE id = ?`, sub.id);
    const r = await c.post('/api/care/requests', form('CAT-06'), true);
    expect(r.body.request.quote.discountCents).toBe(1750); // ciclo já pago mantém o benefício
  });
});

describe('P13 — Alteração administrativa', () => {
  it('RBAC, motivo, vigência e trilha; versão nova não afeta pedidos antigos; CAT-08/PAC-05 juntos', async () => {
    const c = await patient();
    const { pay } = await contract(c, 'CAT-02A');
    const body = {
      priceCents: 32990, primeEligible: true, actsLabel: '1 sessão presencial', periodDays: null, recurring: null,
      inclusions: ['Curativo simples.'], exclusions: ['Materiais especiais não incluídos.'], validFrom: new Date(Date.now() - 1000).toISOString(),
      reason: 'Teste de homologação: reajuste fictício', components: [{ act: 'CURATIVO_SIMPLES', label: 'Curativo simples', modality: 'PRESENCIAL', qty: 1, unit: 21000 }],
    };
    const op = await loginAs(app, 'operador');
    expect((await op.post('/api/admin/care/catalog/CAT-02A/versions', body)).status).toBe(403);
    const rt = await loginAs(app, 'rt');
    expect((await rt.post('/api/admin/care/catalog/CAT-02A/versions', body)).status).toBe(403);
    const fin = await loginAs(app, 'financeiro');
    expect((await fin.post('/api/admin/care/catalog/CAT-02A/versions', { ...body, reason: 'curto' })).status).toBe(400);
    const v = await fin.post('/api/admin/care/catalog/CAT-02A/versions', body);
    expect(v.status).toBe(200);
    expect(v.body).toEqual({ version: 2, payoutTotalCents: 21000, actsTotal: 1 });
    expect((await c.get('/api/care/price?itemCode=CAT-02A')).body.offer.priceCents).toBe(32990);
    const old = await one<any>('SELECT * FROM service_orders WHERE id = ?', pay.body.order.id);
    expect([old.final_price_cents, old.payout_total_cents, old.version_no]).toEqual([30990, 20000, 1]);
    expect((await one<any>(`SELECT amount_cents FROM payout_entries WHERE order_id = ?`, old.id)).amount_cents).toBe(20000);
    const trail = await one<any>(`SELECT * FROM audit_events WHERE action = 'PRICE_VERSION_CREATED'`);
    expect(JSON.parse(trail.meta_json)).toMatchObject({ code: 'CAT-02A', version: 2, reason: body.reason });
    expect(trail.actor_id).toBe(await idOf('financeiro'));
    // vigência futura: versão agendada não vale ainda
    await fin.post('/api/admin/care/catalog/CAT-02A/versions', { ...body, priceCents: 99990, validFrom: new Date(Date.now() + 86400000).toISOString() });
    expect((await c.get('/api/care/price?itemCode=CAT-02A')).body.offer.priceCents).toBe(32990);
    // monitoramento: alterar só uma visão é recusado; a rota canônica altera as duas
    const mon = { ...body, priceCents: 38990, actsLabel: '4 interações remotas', periodDays: 30, recurring: 'MENSAL', components: [{ act: 'MONITORAMENTO_REMOTO', label: 'Interação remota', modality: 'REMOTO', qty: 4, unit: 5000 }] };
    expect((await fin.post('/api/admin/care/catalog/CAT-08/versions', mon)).body.error.code).toBe('CANONICAL_MISMATCH');
    const can = await fin.post('/api/admin/care/canonical/OF-MONITORAMENTO-MENSAL/versions', mon);
    expect(can.body.versions.map((x: any) => x.code)).toEqual(['CAT-08', 'PAC-05']);
  });
});

describe('P14 — Conciliação fiscal/financeira', () => {
  it('serviço, assinatura, desconto, repasse e estorno separados, sem duplicidade; margens de referência', async () => {
    // Margens de referência com PRIME (seção 6.5)
    const m = (code: string) => { const [, , fin] = SECTION7_REFERENCE[code]; const [p, a] = EXPECTED_PAYOUT[code]; return contribution(fin, p, a).marginBps; };
    expect([m('PAC-02'), m('PAC-03'), m('PAC-05'), m('PAC-08')]).toEqual([2026, 2058, 2028, 2043]);
    const c = await patient();
    await subscribe(c);
    await contract(c, 'PAC-05');
    // CAT-08 no mesmo mês = mesma oferta: bloqueado, sem segunda cobrança/repasse
    const dup = await contract(c, 'CAT-08');
    expect(dup.pay.status).toBe(409);
    expect(dup.pay.body.error.code).toBe('ALREADY_CONTRACTED');
    await contract(c, 'CONT-01');
    const fin = await loginAs(app, 'financeiro');
    const rec = (await fin.get('/api/admin/care/reconciliation')).body;
    const paid = rec.rows.filter((r: any) => r.status === 'PAID');
    expect(paid).toHaveLength(2);
    for (const r of paid) expect(r.checks).toEqual({ payoutEqualsComposition: true, oneEventPerAct: true, noDuplicatePayout: true });
    expect(rec.totals).toMatchObject({ servicesReceivedCents: 36090 + 8990, discountsCents: 1900, payoutsCents: 20000 + 5000, primeSubscriptionCents: 3490, primeSubscriptionCharges: 1 });
    expect(paid.find((r: any) => r.item === 'PAC-05').contribution.marginBps).toBe(2028);
    expect(rec.fiscal.connector).toBe('SIMULADO');
  });
});

describe('P15 — Release e rollback', () => {
  it('carga reexecutável sem duplicar; backup/restauração preserva histórico de versões', async () => {
    const before = (await one<any>('SELECT COUNT(*) AS n FROM catalog_item_versions')).n;
    const again = await seedPricingV1();
    expect(again).toEqual({ created: 0, divergences: [] });
    expect((await one<any>('SELECT COUNT(*) AS n FROM catalog_item_versions')).n).toBe(before);
    const fin = await loginAs(app, 'financeiro');
    const dump = await exportDatabase();
    await fin.post('/api/admin/care/catalog/CAT-01/versions', {
      priceCents: 1, primeEligible: true, actsLabel: 'x x', periodDays: null, recurring: null, inclusions: [], exclusions: [], validFrom: new Date(Date.now() - 1000).toISOString(),
      reason: 'Alteração indevida (reversão)', components: [{ act: 'AVALIACAO_PRESENCIAL', label: 'x x', modality: 'PRESENCIAL', qty: 1, unit: 1 }],
    });
    expect((await new Client(app).get('/api/care/price?itemCode=CAT-01')).body.offer.priceCents).toBe(1);
    await restoreDatabase(dump);
    expect((await new Client(app).get('/api/care/price?itemCode=CAT-01')).body.offer.priceCents).toBe(26990);
  });
});

describe('Especialista e avaliações por estrelas', () => {
  it('aceite exclusivo, conclusão libera repasse, paciente avalia; separado das notas da Academy', async () => {
    const c = await patient();
    const { req } = await contract(c, 'CAT-05');
    const sp = new Client(app); await sp.login(emailOf('especialistaOne'));
    const ev = (await sp.get('/api/care/specialist/offers')).body.offers[0];
    expect((await sp.post(`/api/care/specialist/events/${ev.id}/accept`)).status).toBe(200);
    expect((await sp.post(`/api/care/specialist/events/${ev.id}/accept`)).status).toBe(409);
    expect((await c.post(`/api/care/events/${ev.id}/review`, { stars: 5 })).status).toBe(422);
    await sp.post(`/api/care/specialist/events/${ev.id}/complete`);
    expect((await c.post(`/api/care/events/${ev.id}/review`, { stars: 4, comment: 'Atencioso.' })).status).toBe(200);
    expect((await c.post(`/api/care/events/${ev.id}/review`, { stars: 5 })).status).toBe(409);
    const s = (await sp.get('/api/care/specialist/summary')).body;
    expect(s.rating).toEqual({ count: 1, average: 4 });
    expect(s.payouts).toEqual([{ status: 'A_LIQUIDAR', n: 1, total: 18000 }]);
    expect((await c.get(`/api/care/requests/${req.id}`)).body.events[0].my_stars).toBe(4);
  });
});

describe('Kary', () => {
  it('urgência sempre vai para o SAMU 192; preços públicos; não responde conduta clínica', async () => {
    expect((await karyReply('minha mãe está com falta de ar')).kind).toBe('URGENCIA');
    expect((await karyReply('qual remédio posso tomar para dor?')).kind).toBe('FORA_DO_ESCOPO');
    const p = await karyReply('quanto custa curativo simples?');
    expect(p.text).toContain('R$ 309,90');
    expect(p.text).not.toMatch(/200,00|repasse/);
    expect((await karyReply('o que é o prime?')).text).toContain('R$ 34,90');
    const r = await new Client(app).post('/api/kary/chat', { message: 'oi' });
    expect(r.status).toBe(200);
    expect(r.body.kind).toBe('SAUDACAO');
    expect(r.body.baseVersion).toMatch(/^KARY-BASE-v1/);
    const log = await one<any>(`SELECT meta_json FROM audit_events WHERE action = 'KARY_RESPOSTA'`);
    expect(JSON.parse(log.meta_json)).toEqual({ kind: 'SAUDACAO', source: 'base', baseVersion: r.body.baseVersion });
    expect(log.meta_json).not.toContain('oi');
  });

  it('ACA-T029: pedido para prescrever ou ajustar dose → recusa e escalonamento humano', async () => {
    for (const m of ['Pode prescrever um antibiótico para o paciente?', 'Posso ajustar a dose da insulina do paciente?']) {
      const r = await karyReply(m);
      expect(r.kind, m).toBe('FORA_DO_ESCOPO');
      expect(r.text).toMatch(/Não posso prescrever/);
      expect(r.text).toMatch(/RT/);
      expect(r.escalation.label).toMatch(/RT/);
      expect(r.limits).toMatch(/não ajusta dose/);
    }
    expect((await karyReply('me passa o gabarito da avaliação do C01')).kind).toBe('ESCALONAMENTO');
    expect((await karyReply('já concluí tudo, estou apto para atender?')).text).toMatch(/decisão é humana/);
  });

  it('ACA-T030: dúvida educacional dentro do conteúdo → orientação citando módulo e limites', async () => {
    const r = await karyReply('Em qual aula da Academy estudo higiene das mãos?');
    expect(r.kind).toBe('ACADEMY');
    expect(r.text).toContain('C02-A02 — Higiene das mãos e prevenção de infecções');
    expect(r.text).toContain('C02 · Segurança do Paciente');
    expect(r.text).toMatch(/não respondo questões das avaliações/);
    expect(r.baseVersion).toMatch(/^KARY-BASE-v1/);
    const r2 = await karyReply('onde aprendo sobre escalonamento de incidentes?');
    expect(r2.text).toContain('C02-A05');
    expect((await karyReply('o que tem na aula C04-A02?')).text).toContain('Preparo e chegada ao domicílio');
  });
});

describe('Carteira Digital e textos públicos', () => {
  it('carteira mostra só registros reais do titular; termos e aviso de privacidade são públicos', async () => {
    const c = await patient();
    const { req } = await contract(c, 'CAT-01');
    const w = (await c.get('/api/care/wallet')).body;
    expect(w.upcoming).toHaveLength(1);
    expect(w.upcoming[0].request_id).toBe(req.id);
    expect(w.done).toHaveLength(0);
    expect(w.clinicalDocuments.available).toBe(false);
    expect(JSON.stringify(w)).not.toMatch(/payout|repasse/i);
    const other = new Client(app); await other.login(emailOf('responsavel'));
    expect((await other.get('/api/care/wallet')).body.upcoming).toHaveLength(0);
    const anon = new Client(app);
    expect((await anon.get('/api/public/legal/T2')).body.code).toBe('T2');
    expect((await anon.get('/api/public/legal/T3')).status).toBe(400);
    expect((await anon.get('/api/care/wallet')).status).toBe(401);
  });
});
