import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, all, emailOf, loginAs, one, setup } from './helpers.ts';
import { config } from '../src/config.ts';
import { setAsaasTransport } from '../src/lib/asaas.ts';
import { PRICING_V1 } from '../src/db/content/pricing-v1.ts';

/** Asaas simulado: mesmas rotas e formatos da API v3 usados pelo app. */
function fakeAsaas() {
  const calls: { method: string; path: string; body: any }[] = [];
  const customers: any[] = [], payments: any[] = [], subs: any[] = [];
  let n = 0;
  setAsaasTransport(async (method, url, headers, raw) => {
    const path = url.replace(/^https:\/\/api(-sandbox)?\.asaas\.com\/v3/, '');
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ method, path, body });
    if (headers.access_token !== '$aact_hmlg_chave_ficticia') return { status: 401, json: { errors: [{ description: 'invalid key' }] } };
    if (method === 'GET' && path.startsWith('/customers')) return { status: 200, json: { data: [] } };
    if (method === 'POST' && path === '/customers') { const c = { id: `cus_${++n}`, ...body }; customers.push(c); return { status: 200, json: c }; }
    if (method === 'POST' && path === '/payments') { const p = { id: `pay_${++n}`, status: 'PENDING', invoiceUrl: `https://sandbox.asaas.com/i/${n}`, ...body }; payments.push(p); return { status: 200, json: p }; }
    if (method === 'DELETE' && path.startsWith('/payments/')) return { status: 200, json: { deleted: true } };
    if (method === 'POST' && /\/payments\/.+\/refund/.test(path)) return { status: 200, json: { status: 'REFUNDED' } };
    if (method === 'POST' && path === '/subscriptions') {
      const s = { id: `sub_${++n}`, ...body }; subs.push(s);
      payments.push({ id: `pay_${++n}`, subscription: s.id, status: 'PENDING', value: body.value, invoiceUrl: `https://sandbox.asaas.com/i/${n}` });
      return { status: 200, json: s };
    }
    if (method === 'GET' && /\/subscriptions\/.+\/payments/.test(path)) { const id = path.split('/')[2]; return { status: 200, json: { data: payments.filter((p) => p.subscription === id) } }; }
    if (method === 'DELETE' && path.startsWith('/subscriptions/')) return { status: 200, json: { deleted: true } };
    return { status: 404, json: { errors: [{ description: `rota simulada ausente ${method} ${path}` }] } };
  });
  return { calls, customers, payments, subs };
}

const TOKEN = 'token-do-webhook-de-teste-com-tamanho-ok';
let app: FastifyInstance;
const saved = { ...config };
beforeEach(async () => {
  app = await setup();
  Object.assign(config, { paymentProvider: 'ASAAS', asaasApiKey: '$aact_hmlg_chave_ficticia', asaasWebhookToken: TOKEN });
});
afterEach(() => { Object.assign(config, { paymentProvider: saved.paymentProvider, asaasApiKey: saved.asaasApiKey, asaasWebhookToken: saved.asaasWebhookToken }); setAsaasTransport(null); });

const CPF = '529.982.247-25';
const NEED_OF = Object.fromEntries(PRICING_V1.map((d) => [d.code, d.need]));
const form = (itemCode: string) => ({
  need: NEED_OF[itemCode], itemCode, infoText: '', materials: 'SIM', materialsDetail: '', materialsSupplyRequested: false,
  patientName: 'Paciente Fictício', phone: '(11) 99999-0000', location: 'Vila Mariana', whenPref: 'PROXIMOS_DIAS', whenDate: null, notes: '', forSelf: true, responsibleAuthorized: false,
});
const hook = (body: unknown, token = TOKEN) => app.inject({ method: 'POST', url: '/api/payments/asaas/webhook', payload: body as any, headers: { 'asaas-access-token': token } });
const ev = (id: string, event: string, payment: Record<string, unknown>) => ({ id, event, payment });

describe('Asaas — pedidos de cuidado', () => {
  it('CPF exigido só para criar o cliente; cobrança hospedada única; webhook autenticado, idempotente e com conferência de valor', async () => {
    const fake = fakeAsaas();
    const c = new Client(app); await c.login(emailOf('paciente'));
    const req = (await c.post('/api/care/requests', form('CAT-01'), true)).body.request;
    await c.post(`/api/care/requests/${req.id}/accept`, { quoteVersion: req.quoteVersion });
    const body = { quoteVersion: req.quoteVersion, paymentMethod: 'ASAAS', expectedTotalCents: req.quote.totalCents };
    expect((await c.post(`/api/care/requests/${req.id}/checkout`, body, true)).body.error.code).toBe('CPF_REQUIRED');
    expect((await c.post(`/api/care/requests/${req.id}/checkout`, { ...body, payerCpf: '111.111.111-11' }, true)).status).toBe(400);
    const r = await c.post(`/api/care/requests/${req.id}/checkout`, { ...body, payerCpf: CPF }, true);
    expect(r.body).toMatchObject({ paid: false, pending: true, paymentUrl: expect.stringContaining('asaas.com') });
    expect(fake.customers[0]).toMatchObject({ cpfCnpj: '52998224725', externalReference: expect.any(String) });
    expect(fake.payments[0]).toMatchObject({ billingType: 'UNDEFINED', value: req.quote.totalCents / 100, externalReference: `care:${r.body.order.id}` });
    // CPF não fica guardado na ONEMA; só o id do cliente no Asaas
    const u = await one<any>('SELECT * FROM users WHERE email = ?', emailOf('paciente'));
    expect(u.asaas_customer_id).toBe('cus_1');
    expect(JSON.stringify(u)).not.toContain('52998224725');
    // repetir o checkout devolve o mesmo link (sem segunda cobrança) e editar fica bloqueado
    const again = await c.post(`/api/care/requests/${req.id}/checkout`, body, true);
    expect(again.body.paymentUrl).toBe(r.body.paymentUrl);
    expect(fake.payments).toHaveLength(1);
    expect((await c.put(`/api/care/requests/${req.id}`, form('CAT-01'))).body.error.code).toBe('PAYMENT_PENDING');
    // detalhe do pedido mostra o link enquanto pendente
    expect((await c.get(`/api/care/requests/${req.id}`)).body.attempts[0].paymentUrl).toBe(r.body.paymentUrl);

    const pay = fake.payments[0];
    expect((await hook(ev('evt_x', 'PAYMENT_CONFIRMED', pay), 'token-errado')).statusCode).toBe(403);
    expect((await hook(ev('evt_1', 'PAYMENT_CONFIRMED', { ...pay, value: 1 }))).json().outcome).toBe('VALOR_DIVERGENTE');
    expect((await one<any>('SELECT status FROM service_orders')).status).toBe('PENDING_PAYMENT');
    expect((await hook(ev('evt_2', 'PAYMENT_CONFIRMED', pay))).json().outcome).toBe('PEDIDO_CONFIRMED');
    expect((await hook(ev('evt_2', 'PAYMENT_CONFIRMED', pay))).json().outcome).toBe('DUPLICADO');
    expect((await hook(ev('evt_3', 'PAYMENT_RECEIVED', pay))).json().outcome).toBe('PEDIDO_SEM_MUDANCA');
    expect((await one<any>('SELECT status FROM service_orders')).status).toBe('PAID');
    expect((await all<any>(`SELECT 1 FROM care_events WHERE status = 'DISPONIVEL'`)).length).toBeGreaterThan(0);
    expect((await c.get(`/api/care/requests/${req.id}`)).body.request.status).toBe('PEDIDO_GERADO');
    // pagamento de outra cobrança com referência forjada não altera nada
    expect((await hook(ev('evt_4', 'PAYMENT_REFUNDED', { ...pay, id: 'pay_forjado' }))).json().outcome).toBe('PEDIDO_NAO_ENCONTRADO');

    // estorno pelo Financeiro devolve pelo Asaas
    const fin = await loginAs(app, 'financeiro');
    const orderId = (await one<any>('SELECT id FROM service_orders')).id;
    expect((await fin.post(`/api/admin/care/orders/${orderId}/refund`, { reason: 'Teste de estorno real' })).status).toBe(200);
    expect(fake.calls.some((x) => x.method === 'POST' && x.path === `/payments/${pay.id}/refund`)).toBe(true);
    expect((await one<any>('SELECT status FROM service_orders')).status).toBe('REFUNDED');
  });

  it('desistir com cobrança em aberto cancela a cobrança no Asaas; cobrança vencida não cancela o pedido', async () => {
    const fake = fakeAsaas();
    const c = new Client(app); await c.login(emailOf('paciente'));
    const req = (await c.post('/api/care/requests', form('CAT-01'), true)).body.request;
    await c.post(`/api/care/requests/${req.id}/accept`, { quoteVersion: req.quoteVersion });
    await c.post(`/api/care/requests/${req.id}/checkout`, { quoteVersion: req.quoteVersion, paymentMethod: 'ASAAS', expectedTotalCents: req.quote.totalCents, payerCpf: CPF }, true);
    expect((await hook(ev('evt_o', 'PAYMENT_OVERDUE', { ...fake.payments[0], status: 'OVERDUE' }))).json().outcome).toBe('PEDIDO_VENCIDO_AGUARDANDO');
    expect((await one<any>('SELECT status FROM service_orders')).status).toBe('PENDING_PAYMENT');
    expect((await c.post(`/api/care/requests/${req.id}/cancel`)).status).toBe(200);
    expect(fake.calls.some((x) => x.method === 'DELETE' && x.path === `/payments/${fake.payments[0].id}`)).toBe(true);
    expect((await one<any>('SELECT status FROM service_orders')).status).toBe('FAILED');
    // se ainda assim chegar um pagamento, nada é liberado sozinho e fica registrado para a Central
    expect((await hook(ev('evt_late', 'PAYMENT_RECEIVED', fake.payments[0]))).json().outcome).toBe('PAGO_APOS_CANCELAMENTO');
    expect((await one<any>(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'PAYMENT_AFTER_CANCEL'`)).n).toBe(1);
  });
});

describe('Asaas — ONEMA Academy e PRIME', () => {
  it('taxa da Jornada: link do Asaas e liberação pelo webhook', async () => {
    const fake = fakeAsaas();
    const c = new Client(app); await c.login(emailOf('especialista'));
    const o = await c.post('/api/academy/payment-orders', { payerCpf: CPF }, true);
    expect(o.body.order).toMatchObject({ status: 'PENDENTE', provider: 'ASAAS', payment_url: expect.stringContaining('asaas.com') });
    expect((await c.post(`/api/academy/payment-orders/${o.body.order.id}/sandbox-pay`, { outcome: 'APROVADO' })).status).toBe(403);
    expect((await hook(ev('evt_a', 'PAYMENT_RECEIVED', fake.payments[0]))).json().outcome).toBe('ACADEMY_CONFIRMED');
    expect((await one<any>('SELECT status FROM academy_payment_orders')).status).toBe('PAGO');
  });

  it('PRIME: assinatura no Asaas (cartão), ativação e renovação pelo webhook, cancelamento interrompe cobranças', async () => {
    const fake = fakeAsaas();
    const c = new Client(app); await c.login(emailOf('paciente'));
    const offer = await c.get('/api/prime/offer');
    const OFF = { enabled: false, channels: { app: false, email: false, whatsapp: false } };
    const r = await c.post('/api/prime/subscriptions', { acceptTerms: true, termsTextId: offer.body.terms.id, privacyTextId: offer.body.privacy.id, paymentMethod: 'ASAAS_CARTAO', payerCpf: CPF, preferences: { LEMBRETES: OFF, RESUMO_MENSAL: OFF, OFERTAS: OFF } }, true);
    expect(r.body).toMatchObject({ paid: false, pending: true, paymentUrl: expect.stringContaining('asaas.com') });
    expect(fake.subs[0]).toMatchObject({ billingType: 'CREDIT_CARD', cycle: 'MONTHLY', value: offer.body.monthlyPriceCents / 100 });
    const first = fake.payments[0];
    expect((await hook(ev('evt_p1', 'PAYMENT_CONFIRMED', first))).json().outcome).toBe('PRIME_PAGO');
    expect((await one<any>('SELECT status FROM subscriptions')).status).toBe('ACTIVE');
    // renovação: o Asaas debita o mês seguinte; o webhook abre e paga o novo ciclo
    const next = { id: 'pay_renov', subscription: first.subscription, status: 'CONFIRMED', value: first.value };
    expect((await hook(ev('evt_p2', 'PAYMENT_CONFIRMED', next))).json().outcome).toBe('PRIME_PAGO');
    expect((await all('SELECT 1 FROM subscription_cycles WHERE status = ?', 'PAID'))).toHaveLength(2);
    expect((await hook(ev('evt_p3', 'PAYMENT_RECEIVED', next))).json().outcome).toBe('PRIME_SEM_MUDANCA');
    // cancelamento interrompe as cobranças futuras no Asaas
    expect((await c.post('/api/prime/subscriptions/current/cancel', {}, true)).status).toBe(200);
    expect(fake.calls.some((x) => x.method === 'DELETE' && x.path === `/subscriptions/${first.subscription}`)).toBe(true);
  });

  it('chave inválida não cobra nada e mostra mensagem segura', async () => {
    fakeAsaas();
    Object.assign(config, { asaasApiKey: '$aact_hmlg_outra' });
    const c = new Client(app); await c.login(emailOf('especialista'));
    const o = await c.post('/api/academy/payment-orders', { payerCpf: CPF }, true);
    expect(o.status).toBe(502);
    expect(o.body.error.code).toBe('PAYMENT_PROVIDER_AUTH');
    expect(await all('SELECT 1 FROM academy_payment_orders')).toHaveLength(0);
  });
});
