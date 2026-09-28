import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, emailOf, idOf, loginAs, one, run, setup } from './helpers.ts';
import { discountFor, runBilling } from '../src/modules/prime/core.ts';
import { addDays, addMonths, nowIso } from '../src/lib/util.ts';
import { tx } from '../src/db/db.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });

const OFF = { enabled: false, channels: { app: false, email: false, whatsapp: false } };
const NO_PREFS = { LEMBRETES: OFF, RESUMO_MENSAL: OFF, OFERTAS: OFF };

async function patient(key: 'paciente' | 'responsavel' = 'paciente') {
  const c = new Client(app); await c.login(emailOf(key)); return c;
}
async function subscribe(c: Client, method = 'SANDBOX_APROVADO', prefs: any = NO_PREFS) {
  const offer = await c.get('/api/prime/offer');
  return c.post('/api/prime/subscriptions', {
    acceptTerms: true, termsTextId: offer.body.terms.id, privacyTextId: offer.body.privacy.id, paymentMethod: method, preferences: prefs,
  }, true);
}
async function order(c: Client, itemCode: string, method = 'SANDBOX_APROVADO') {
  const q = await c.post('/api/prime/orders/quote', { itemCode });
  return { q, o: await c.post('/api/prime/orders', { itemCode, paymentMethod: method, expectedFinalPriceCents: q.body.finalPriceCents }, true) };
}

describe('Adesão', () => {
  it('aceite obrigatório não pode vir desmarcado; oferta traz T1/T2 integrais e parâmetros vigentes', async () => {
    const c = await patient();
    const offer = await c.get('/api/prime/offer');
    expect(offer.body.monthlyPriceCents).toBe(3490);
    expect(offer.body.discountBps).toBe(500);
    expect(offer.body.discountCapCents).toBe(2000);
    const t1 = await c.get('/api/prime/texts/T1');
    expect(JSON.parse(t1.body.body).sections).toHaveLength(11);
    const r = await c.post('/api/prime/subscriptions', { acceptTerms: false, termsTextId: offer.body.terms.id, privacyTextId: offer.body.privacy.id, paymentMethod: 'SANDBOX_APROVADO', preferences: NO_PREFS }, true);
    expect(r.status).toBe(400);
    expect((await one<any>('SELECT COUNT(*) AS n FROM subscriptions')).n).toBe(0);
  });

  it('A02: adesão com marketing desmarcado e sem convite: assinatura ativa, marketing e compartilhamento ausentes', async () => {
    const c = await patient();
    const r = await subscribe(c);
    expect(r.status).toBe(201);
    expect(r.body.paid).toBe(true);
    const s = r.body.subscription;
    expect(s.status).toBe('ACTIVE');
    expect(s.benefit.active).toBe(true);
    expect(s.benefit.usesRemaining).toBe(1);
    expect(new Date(s.cycle.endsAt).getTime()).toBeGreaterThan(Date.now() + 27 * 86400000);
    const prefs = await c.get('/api/prime/preferences');
    expect(prefs.body.preferences.OFERTAS.enabled).toBe(false);
    expect((await c.get('/api/prime/share')).body.grants).toHaveLength(0);
    const me = await c.get('/api/prime/me');
    expect(me.body.receipts[0].text).toMatch(/Seu ONEMA PRIME foi ativado\. Mensalidade: R\$ 34,90/);
    const sub = await one<any>('SELECT acceptance_json FROM subscriptions');
    expect(JSON.parse(sub.acceptance_json)).toMatchObject({ termsVersion: '2.0', privacyVersion: '2.0' });
  });

  it('pagamento recusado: nenhum benefício consumido; regularização ativa; replay não duplica assinatura', async () => {
    const c = await patient();
    const r = await subscribe(c, 'SANDBOX_RECUSADO');
    expect(r.body.paid).toBe(false);
    expect(r.body.message).toMatch(/nenhum benefício foi consumido/);
    expect(r.body.subscription.benefit.active).toBe(false);
    expect((await subscribe(c)).status).toBe(409);
    const pay = await c.post('/api/prime/subscriptions/current/pay', { paymentMethod: 'SANDBOX_APROVADO' }, true);
    expect(pay.body.subscription.status).toBe('ACTIVE');
  });

  it('A01: sem PRIME e após cancelamento o paciente mantém acesso à Minha ONEMA e registros', async () => {
    const c = await patient();
    expect((await c.get('/api/prime/hub')).status).toBe(200);
    await subscribe(c);
    await c.post('/api/prime/subscriptions/current/cancel', {}, true);
    const hub = await c.get('/api/prime/hub');
    expect(hub.status).toBe(200);
    expect((await c.get('/api/prime/me')).status).toBe(200);
  });
});

describe('Desconto PRIME', () => {
  it('A04: 5% com arredondamento a centavos e teto de R$ 20', () => {
    expect(discountFor(8990, 500, 2000)).toBe(450);
    expect(discountFor(26990, 500, 2000)).toBe(1350);
    expect(discountFor(44990, 500, 2000)).toBe(2000);
    expect(discountFor(72990, 500, 2000)).toBe(2000);
  });

  it('A03/A04: pedido com desconto preserva repasse; segundo pedido do ciclo sem desconto e com motivo', async () => {
    const c = await patient(); await subscribe(c);
    const { q, o } = await order(c, 'DEMO-PACOTE');
    expect(q.body).toMatchObject({ fullPriceCents: 72990, discountCents: 2000, finalPriceCents: 70990, usesRemaining: 1 });
    expect(o.body.order).toMatchObject({ status: 'PAID', discount_cents: 2000, payout_basis_cents: 72990 });
    const second = await c.post('/api/prime/orders/quote', { itemCode: 'DEMO-SERV-A' });
    expect(second.body.discountCents).toBe(0);
    expect(second.body.noDiscountReason).toBe('O desconto PRIME já foi usado neste ciclo');
    const me = await c.get('/api/prime/me');
    expect(me.body.subscription.benefit.savingsThisCycleCents).toBe(2000);
    expect(me.body.subscription.benefit.usesRemaining).toBe(0);
  });

  it('A05: checkouts paralelos e duplo clique resultam em um único benefício por ciclo', async () => {
    const c = await patient(); await subscribe(c);
    const q = await c.post('/api/prime/orders/quote', { itemCode: 'DEMO-SERV-B' });
    const body = { itemCode: 'DEMO-SERV-B', paymentMethod: 'SANDBOX_APROVADO', expectedFinalPriceCents: q.body.finalPriceCents };
    const [a, b] = await Promise.all([c.post('/api/prime/orders', body, 'dup-click-1'), c.post('/api/prime/orders', body, 'dup-click-1')]);
    expect(b.body.order.id).toBe(a.body.order.id);
    const [x, y] = await Promise.all([c.post('/api/prime/orders', body, true), c.post('/api/prime/orders', body, true)]);
    // a primeira já consumiu o desconto: as seguintes são rejeitadas por preço divergente (não cobram valor diferente do exibido)
    expect([x.status, y.status]).toEqual([409, 409]);
    expect(x.body.error.code).toBe('PRICE_CHANGED');
    expect((await one<any>(`SELECT COUNT(*) AS n FROM discount_reservations WHERE status IN ('RESERVED','USED')`)).n).toBe(1);
    expect((await one<any>('SELECT COUNT(*) AS n FROM service_orders')).n).toBe(1);
  });

  it('falha de pagamento libera a reserva de forma auditável; estorno do pedido também', async () => {
    const c = await patient(); await subscribe(c);
    const { o } = await order(c, 'DEMO-SERV-A', 'SANDBOX_RECUSADO');
    expect(o.body.paid).toBe(false);
    expect(await one<any>(`SELECT status, release_reason FROM discount_reservations`)).toMatchObject({ status: 'RELEASED', release_reason: 'PAGAMENTO_NAO_CONFIRMADO' });
    const ok = await order(c, 'DEMO-SERV-A');
    expect(ok.o.body.order.discount_cents).toBe(450);
    const fin = await loginAs(app, 'financeiro');
    const r = await fin.post(`/api/admin/prime/orders/${ok.o.body.order.id}/refund`, { note: 'Estorno de teste' });
    expect(r.body.discountReleased).toBe(true);
    expect((await one<any>(`SELECT COUNT(*) AS n FROM audit_events WHERE action IN ('DESCONTO_LIBERADO','ORDER_REFUNDED')`)).n).toBe(2);
  });

  it('sem PRIME: preço cheio e nenhum desconto', async () => {
    const c = await patient();
    const q = await c.post('/api/prime/orders/quote', { itemCode: 'DEMO-SERV-A' });
    expect(q.body).toMatchObject({ discountCents: 0, finalPriceCents: 8990, primeActive: false });
  });
});

describe('Responsável principal', () => {
  it('A06: permite só agenda, verifica, acessa; documentos/cobrança negados; revogação bloqueia novos acessos e logs permanecem', async () => {
    const p = await patient(); await subscribe(p);
    const inv = await p.post('/api/prime/share/invites', { name: 'Responsável Demonstração', email: emailOf('responsavel'), scopes: { AGENDA: true, DOCUMENTOS: false, COBRANCAS: false }, acknowledge: true }, true);
    expect(inv.status).toBe(201);
    const gid = inv.body.grant.id;
    expect((await p.post('/api/prime/share/invites', { name: 'Outra Pessoa', email: 'outra@exemplo.test', scopes: { AGENDA: true, DOCUMENTOS: false, COBRANCAS: false }, acknowledge: true }, true)).body.error.code).toBe('PRINCIPAL_EXISTS');
    const r = await patient('responsavel');
    expect((await r.get(`/api/prime/share/${gid}/view/AGENDA`)).status).toBe(404); // ainda não aceitou
    expect((await r.post(`/api/prime/share/${gid}/accept`)).status).toBe(200);
    const notVerified = await r.get(`/api/prime/share/${gid}/view/AGENDA`);
    expect(notVerified.body.error.code).toBe('SHARE_NOT_VERIFIED');
    const op = await loginAs(app, 'operador');
    expect((await op.post(`/api/admin/prime/share-grants/${gid}/verify`, { approve: true, note: 'Autorização conferida em teste' })).status).toBe(200);
    const agenda = await r.get(`/api/prime/share/${gid}/view/AGENDA`);
    expect(agenda.status).toBe(200);
    expect(agenda.body.available).toBe(false); // integração pendente, sem dado inventado
    expect((await r.get(`/api/prime/share/${gid}/view/DOCUMENTOS`)).status).toBe(403);
    expect((await r.get(`/api/prime/share/${gid}/view/COBRANCAS`)).status).toBe(403);
    const rev = await p.post(`/api/prime/share/${gid}/revoke`);
    expect(rev.body.text).toMatch(/foi revogada em/);
    expect((await r.get(`/api/prime/share/${gid}/view/AGENDA`)).status).toBe(403);
    const log = await p.get('/api/prime/share');
    expect(log.body.accessLog.length).toBeGreaterThanOrEqual(4);
    await expect(run('DELETE FROM share_access_log')).rejects.toThrow(/append-only/);
  });

  it('escopo de cobranças mostra somente dados financeiros do titular; convite exige PRIME ativo', async () => {
    const p = await patient();
    const noPrime = await p.post('/api/prime/share/invites', { name: 'Responsável Demonstração', email: emailOf('responsavel'), scopes: { AGENDA: false, DOCUMENTOS: false, COBRANCAS: true }, acknowledge: true }, true);
    expect(noPrime.body.error.code).toBe('PRIME_REQUIRED');
    await subscribe(p);
    const inv = await p.post('/api/prime/share/invites', { name: 'Responsável Demonstração', email: emailOf('responsavel'), scopes: { AGENDA: false, DOCUMENTOS: false, COBRANCAS: true }, acknowledge: true }, true);
    const r = await patient('responsavel');
    await r.post(`/api/prime/share/${inv.body.grant.id}/accept`);
    const op = await loginAs(app, 'operador');
    await op.post(`/api/admin/prime/share-grants/${inv.body.grant.id}/verify`, { approve: true, note: 'Autorização conferida em teste' });
    const view = await r.get(`/api/prime/share/${inv.body.grant.id}/view/COBRANCAS`);
    expect(view.body.charges).toHaveLength(1);
    expect(JSON.stringify(view.body)).not.toMatch(/acceptance|email|password/i);
  });
});

describe('Preferências', () => {
  it('A07: WhatsApp desabilitado até integração oficial; ofertas recusadas', async () => {
    const c = await patient();
    const r = await c.put('/api/prime/preferences', { ...NO_PREFS, LEMBRETES: { enabled: true, channels: { app: true, email: false, whatsapp: true }, frequency: 'MENSAL' } });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('WHATSAPP_DISABLED');
    expect((await one<any>('SELECT COUNT(*) AS n FROM preference_events')).n).toBe(0);
  });

  it('A08: desligar resumo e mudar frequência registram eventos com versão e origem', async () => {
    const c = await patient();
    await subscribe(c, 'SANDBOX_APROVADO', { ...NO_PREFS, RESUMO_MENSAL: { enabled: true, channels: { app: true, email: false, whatsapp: false } }, LEMBRETES: { enabled: true, channels: { app: true, email: true, whatsapp: false }, frequency: 'SEMANAL' } });
    await c.put('/api/prime/preferences', { ...NO_PREFS, RESUMO_MENSAL: OFF, LEMBRETES: { enabled: true, channels: { app: true, email: true, whatsapp: false }, frequency: 'QUINZENAL' } });
    const p = await c.get('/api/prime/preferences');
    expect(p.body.preferences.RESUMO_MENSAL.enabled).toBe(false);
    expect(p.body.preferences.LEMBRETES.frequency).toBe('QUINZENAL');
    const events = p.body.events.map((e: any) => `${e.event}:${e.purpose}:${e.channel ?? ''}`);
    expect(events).toContain('OPT_OUT:RESUMO_MENSAL:');
    expect(events).toContain('CHANGE:LEMBRETES:');
    expect(await one<any>(`SELECT text_version, source FROM preference_events WHERE event = 'OPT_OUT'`)).toMatchObject({ text_version: '2.0', source: 'PREFERENCIAS' });
  });
});

describe('Cancelamento, arrependimento e estorno (A09)', () => {
  it('cancelamento: protocolo imediato, renovação bloqueada, benefícios até o fim do ciclo pago', async () => {
    const c = await patient(); await subscribe(c);
    const r = await c.post('/api/prime/subscriptions/current/cancel', {}, true);
    expect(r.body.protocol).toMatch(/^CANC-/);
    expect(r.body.text).toMatch(/Não haverá renovação após o ciclo atual/);
    expect(r.body.subscription.status).toBe('CANCEL_SCHEDULED');
    expect(r.body.subscription.benefit.active).toBe(true);
    const cycleEnd = (await one<any>('SELECT ends_at FROM subscription_cycles')).ends_at;
    const summary = await tx(() => runBilling(addDays(cycleEnd, 1)));
    expect(summary.cancelled).toBe(1);
    expect((await one<any>('SELECT COUNT(*) AS n FROM charges')).n).toBe(1);
    expect((await one<any>('SELECT status FROM subscriptions')).status).toBe('CANCELLED');
  });

  it('arrependimento em 7 dias referencia a cobrança original e o estorno gera trilha', async () => {
    const c = await patient(); await subscribe(c);
    const r = await c.post('/api/prime/refund-requests', { type: 'ARREPENDIMENTO' }, true);
    expect(r.status).toBe(201);
    const req = await one<any>('SELECT * FROM refund_requests');
    expect(req.charge_id).toBe((await one<any>('SELECT id FROM charges')).id);
    expect((await one<any>('SELECT status FROM subscriptions')).status).toBe('REFUND_PENDING');
    const fin = await loginAs(app, 'financeiro');
    expect((await fin.post(`/api/admin/prime/refunds/${req.id}/decide`, { approve: true, note: 'Aprovado em teste' })).status).toBe(200);
    expect((await one<any>('SELECT status FROM subscriptions')).status).toBe('REFUNDED');
    expect((await one<any>('SELECT status FROM charges')).status).toBe('REFUNDED');
    const me = await c.get('/api/prime/me');
    expect(me.body.refunds[0].status).toBe('REFUNDED');
  });

  it('arrependimento fora do prazo é recusado com orientação', async () => {
    const c = await patient(); await subscribe(c);
    await run('UPDATE subscriptions SET accepted_at = ?', addDays(nowIso(), -8));
    const r = await c.post('/api/prime/refund-requests', { type: 'ARREPENDIMENTO' }, true);
    expect(r.body.error.code).toBe('WITHDRAWAL_EXPIRED');
  });
});

describe('Motor de ciclos', () => {
  it('renovação, até 3 novas tentativas em 7 dias, suspensão só dos benefícios; regularização não cria segundo uso', async () => {
    const c = await patient(); await subscribe(c);
    await order(c, 'DEMO-SERV-A'); // usa o desconto do ciclo 1
    const end1 = (await one<any>('SELECT ends_at FROM subscription_cycles WHERE cycle_no = 1')).ends_at;
    await run(`UPDATE subscriptions SET payment_method = 'SANDBOX_RECUSADO'`);
    let t = addDays(end1, 0.01);
    expect((await tx(() => runBilling(t))).failed).toBe(1);
    expect((await one<any>('SELECT status FROM subscriptions')).status).toBe('PAYMENT_PENDING');
    for (let i = 0; i < 3; i++) { t = addDays(t, 2); await tx(() => runBilling(t)); }
    expect((await one<any>(`SELECT COUNT(*) AS n FROM charges WHERE cycle_id = (SELECT current_cycle_id FROM subscriptions)`)).n).toBe(4);
    await tx(() => runBilling(addDays(t, 0.5)));
    expect((await one<any>('SELECT status FROM subscriptions')).status).toBe('SUSPENDED');
    const me = await c.get('/api/prime/me');
    expect(me.body.subscription.benefit.reason).toMatch(/benefícios suspensos/);
    expect((await c.get('/api/prime/hub')).status).toBe(200); // acesso ao próprio histórico mantido
    const pay = await c.post('/api/prime/subscriptions/current/pay', { paymentMethod: 'SANDBOX_APROVADO' }, true);
    expect(pay.body.subscription.status).toBe('ACTIVE');
    expect((await one<any>(`SELECT COUNT(*) AS n FROM discount_reservations WHERE status = 'USED'`)).n).toBe(1);
    // renovação normal do ciclo 3
    const end2 = (await one<any>('SELECT ends_at FROM subscription_cycles WHERE cycle_no = 2')).ends_at;
    expect(end2).toBe(addMonths(end1, 1));
  });
});

describe('Gates e privacidade (A10, A11)', () => {
  it('A11: produção bloqueada sem identificação do fornecedor e revisão jurídica', async () => {
    const ap = await loginAs(app, 'adminPrime');
    const o = await ap.get('/api/admin/prime/overview');
    expect(o.body.productionReady).toBe(false);
    expect(o.body.gates.find((g: any) => g.id === 'G6-FORNECEDOR').ok).toBe(false);
    const bad = await ap.put('/api/admin/prime/provider-identity', { legalName: 'Empresa', cnpj: null, address: null, supportChannel: null, validated: true });
    expect(bad.status).toBe(422);
    const c = await patient();
    const offer = await c.get('/api/prime/offer');
    expect(offer.body.provider).toMatchObject({ validated: false, legalName: null, cnpj: null });
  });

  it('A10: Minha ONEMA não gera tarefas/recomendações clínicas sem registro profissional', async () => {
    const c = await patient();
    const hub = await c.get('/api/prime/hub');
    expect(hub.body.timeline).toEqual([]);
    expect(hub.body.integrations.continuidade.available).toBe(false);
  });

  it('parâmetros alterados não retroagem a assinaturas existentes', async () => {
    const c = await patient(); await subscribe(c);
    const ap = await loginAs(app, 'adminPrime');
    const r = await ap.post('/api/admin/prime/parameters', { monthlyPriceCents: 3990, discountBps: 500, discountCapCents: 2000, usesPerCycle: 1, retryMax: 3, retryWindowDays: 7, refundWithdrawalDays: 7, sourceNote: 'Alteração de teste automatizado' });
    expect(r.body.version).toBe(2);
    expect((await c.get('/api/prime/me')).body.subscription.monthlyPriceCents).toBe(3490);
    expect(await idOf('paciente')).toBeTruthy();
  });
});
