import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, emailOf, idOf, loginAs, one, run, setup } from './helpers.ts';
import { config } from '../src/config.ts';
import { setAsaasTransport, transfersMode } from '../src/lib/asaas.ts';
import { sealField } from '../src/lib/security.ts';
import { uid } from '../src/lib/util.ts';
import { DEMO_PASSWORD } from '../src/db/seed.ts';
import { PRICING_V1 } from '../src/db/content/pricing-v1.ts';
import { payoutAlerts, reconcileTransfers } from '../src/modules/finance/payouts.ts';

let app: FastifyInstance;
const saved = { ...config };
beforeEach(async () => { app = await setup(); });
afterEach(() => { Object.assign(config, saved); setAsaasTransport(null); });

const CPF = '52998224725';
const NEED_OF = Object.fromEntries(PRICING_V1.map((d) => [d.code, d.need]));
const EVO = { relato: 'Paciente refere melhora.', sinaisVitais: '', avaliacao: 'Ferida limpa.', procedimentos: 'Curativo simples.', orientacoes: '', plano: '', observacoes: '', pendencias: [] };
const TOKEN = 'token-do-webhook-de-teste-com-tamanho-ok';
const hook = (body: unknown) => app.inject({ method: 'POST', url: '/api/payments/asaas/webhook', payload: body as any, headers: { 'asaas-access-token': TOKEN } });

async function approvedApplication(key: 'especialistaOne' | 'especialista', cpf = CPF) {
  const now = new Date().toISOString();
  await run(`INSERT INTO specialist_applications (id, user_id, full_name, cpf, coren_number, coren_uf, phone, regions, needs_json, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, uid(), await idOf(key), 'Enf. Teste', sealField(cpf), '123456', 'SP', '(11) 99999-0000', 'Zona Sul', '[]', 'APROVADA', now, now);
}

/** Pedido pago (sandbox) + especialista aceita; opcionalmente conclui com assinatura do paciente. */
async function visit(opts: { finish?: boolean } = {}) {
  const c = new Client(app); await c.login(emailOf('paciente'));
  const form = { need: NEED_OF['CAT-02A'], itemCode: 'CAT-02A', infoText: '', materials: 'SIM', materialsDetail: '', materialsSupplyRequested: false,
    patientName: 'Paciente Fictício', phone: '(11) 99999-0000', location: 'Vila Mariana', whenPref: 'PROXIMOS_DIAS', whenDate: null, notes: '', forSelf: true, responsibleAuthorized: false, address: { cep: '04101-000', street: 'Rua Fictícia', number: '100', complement: '', district: 'Vila Mariana', city: 'São Paulo', reference: '' }, timeWindow: 'MANHA' };
  const req = (await c.post('/api/care/requests', form, true)).body.request;
  await c.post(`/api/care/requests/${req.id}/accept`, { quoteVersion: req.quoteVersion });
  const co = await c.post(`/api/care/requests/${req.id}/checkout`, { quoteVersion: req.quoteVersion, paymentMethod: 'SANDBOX_APROVADO', expectedTotalCents: req.quote.totalCents }, true);
  const sp = new Client(app); await sp.login(emailOf('especialistaOne'));
  const ev = (await sp.get('/api/care/specialist/offers')).body.offers.find((o: any) => o.modality === 'PRESENCIAL');
  expect((await sp.post(`/api/care/specialist/events/${ev.id}/accept`)).status).toBe(200);
  if (opts.finish) {
    const code = (await one<any>('SELECT visit_code FROM care_events WHERE id = ?', ev.id)).visit_code;
    await sp.post(`/api/care/specialist/events/${ev.id}/start`, { code });
    await sp.post(`/api/care/specialist/events/${ev.id}/evolution/sign`, { content: EVO, confirm: true });
    await c.post(`/api/care/events/${ev.id}/sign`, { name: 'Paciente Fictício', confirm: true });
    expect((await sp.post(`/api/care/specialist/events/${ev.id}/complete`)).status).toBe(200);
  }
  const payout = await one<any>('SELECT * FROM payout_entries WHERE event_id = ?', ev.id);
  return { c, sp, eventId: ev.id as string, orderId: co.body.order.id as string, payout };
}

/** Asaas simulado só com o que o repasse usa. */
function fakeTransfers(mode: 'ok' | 'timeout' | 'saldo' = 'ok') {
  const transfers: any[] = [];
  setAsaasTransport(async (method, url, _h, raw) => {
    const path = url.replace(/^https:\/\/api(-sandbox)?\.asaas\.com\/v3/, '');
    const body = raw ? JSON.parse(raw) : undefined;
    if (method === 'POST' && path === '/transfers') {
      if (mode === 'saldo') return { status: 400, json: { errors: [{ description: 'Saldo insuficiente para realizar a transferência.' }] } };
      const t = { id: `tra_${transfers.length + 1}`, status: 'PENDING', transferFee: 0, ...body };
      transfers.push(t);
      if (mode === 'timeout') throw new Error('timeout');
      return { status: 200, json: t };
    }
    if (method === 'GET' && path.startsWith('/transfers?')) return { status: 200, json: { data: transfers } };
    if (method === 'GET' && path.startsWith('/transfers/')) {
      const t = transfers.find((x) => x.id === path.split('/')[2]);
      return t ? { status: 200, json: { ...t, status: 'DONE', transactionReceiptUrl: 'https://sandbox.asaas.com/comprovantes/1' } } : { status: 404, json: {} };
    }
    return { status: 404, json: { errors: [{ description: `rota simulada ausente ${method} ${path}` }] } };
  });
  return transfers;
}
const asaasOn = () => Object.assign(config, { paymentProvider: 'ASAAS', asaasApiKey: '$aact_hmlg_chave_ficticia', asaasWebhookToken: TOKEN, asaasTransfersEnabled: true });

describe('Repasse — validação, autorização e segregação (T04, T05, T14)', () => {
  it('sem conclusão não há validação; validado gera obrigação única com prazo de 48 h; quem valida não autoriza; modo manual', async () => {
    await approvedApplication('especialistaOne');
    const { sp, payout, eventId } = await visit();
    const op = await loginAs(app, 'operador');
    const fin = await loginAs(app, 'financeiro');
    // T04: atendimento não concluído — não aparece para validar e não valida
    expect((await op.post(`/api/admin/finance/payouts/${payout.id}/validate`, { approve: true })).body.error.code).toBe('PAYOUT_NOT_PENDING_VALIDATION');
    // conclui (com assinatura do paciente)
    const c = new Client(app); await c.login(emailOf('paciente'));
    const code = (await one<any>('SELECT visit_code FROM care_events WHERE id = ?', eventId)).visit_code;
    await sp.post(`/api/care/specialist/events/${eventId}/start`, { code });
    await sp.post(`/api/care/specialist/events/${eventId}/evolution/sign`, { content: EVO, confirm: true });
    await c.post(`/api/care/events/${eventId}/sign`, { name: 'Paciente Fictício', confirm: true });
    await sp.post(`/api/care/specialist/events/${eventId}/complete`);
    expect((await one<any>(`SELECT COUNT(*) AS n FROM notifications WHERE title = 'Atendimento para validar'`)).n).toBeGreaterThan(0);
    // Financeiro não valida; operação não autoriza
    expect((await fin.post(`/api/admin/finance/payouts/${payout.id}/validate`, { approve: true })).status).toBe(403);
    expect((await op.post(`/api/admin/finance/payouts/${payout.id}/validate`, { approve: false })).body.error.code).toBe('NOTE_REQUIRED');
    expect((await op.post(`/api/admin/finance/payouts/${payout.id}/validate`, { approve: true })).status).toBe(200);
    const v = await one<any>('SELECT * FROM payout_entries WHERE id = ?', payout.id);
    expect(v.status).toBe('VALIDADO');
    expect(new Date(v.due_at).getTime() - new Date(v.validated_at).getTime()).toBe(48 * 3600_000);
    expect((await op.post(`/api/admin/finance/payouts/${payout.id}/authorize`)).status).toBe(403);
    // sem chave Pix verificada não autoriza
    expect((await fin.post(`/api/admin/finance/payouts/${payout.id}/authorize`)).body.error.code).toBe('PAYOUT_BLOCKED');
    // chave Pix: senha obrigatória; CPF precisa ser o da especialista; mascarada na resposta
    expect((await sp.put('/api/specialist/bank-destination', { pixKeyType: 'CPF', pixKey: CPF, holderName: 'Enf. Teste', password: 'errada' })).body.error.code).toBe('WRONG_PASSWORD');
    expect((await sp.put('/api/specialist/bank-destination', { pixKeyType: 'CPF', pixKey: '111.444.777-35', holderName: 'Enf. Teste', password: DEMO_PASSWORD })).body.error.code).toBe('PIX_KEY_NOT_OWNER');
    const dest = await sp.put('/api/specialist/bank-destination', { pixKeyType: 'CPF', pixKey: CPF, holderName: 'Enf. Teste', password: DEMO_PASSWORD });
    expect(dest.status, JSON.stringify(dest.body)).toBe(200);
    expect(dest.body.destination).toMatchObject({ status: 'VERIFICADA', maskedKey: '***.982.247-**' });
    expect(JSON.stringify(await one('SELECT * FROM bank_destinations'))).not.toContain(CPF);
    // modo manual (transferências desligadas): autorizado → programado → pago com comprovante
    expect(transfersMode()).toBe('MANUAL');
    expect((await fin.post(`/api/admin/finance/payouts/${payout.id}/authorize`)).body).toMatchObject({ status: 'PROGRAMADO', manual: true });
    expect((await fin.post(`/api/admin/finance/payouts/${payout.id}/manual-paid`, { reference: 'E2E123456789' })).status).toBe(200);
    expect((await fin.post(`/api/admin/finance/payouts/${payout.id}/manual-paid`, { reference: 'E2E123456789' })).status).toBe(409);
    // T14: a especialista vê só os próprios repasses, sem preço do paciente
    const mine = (await sp.get('/api/specialist/payouts')).body;
    expect(mine.payouts[0]).toMatchObject({ status: 'CONFIRMADO', netCents: payout.amount_cents });
    expect(JSON.stringify(mine)).not.toMatch(/final_price|finalPrice|price_cents/);
    await approvedApplication('especialista', '11144477735');
    const other = new Client(app); await other.login(emailOf('especialista'));
    expect((await other.get('/api/specialist/payouts')).body.payouts).toHaveLength(0);
    expect((await other.get('/api/admin/finance/overview')).status).toBe(403);
    expect((await c.get('/api/admin/finance/overview')).status).toBe(403);
    const auditor = await loginAs(app, 'auditor');
    expect((await auditor.get('/api/admin/finance/overview')).status).toBe(200);
    expect((await auditor.post(`/api/admin/finance/payouts/${payout.id}/authorize`)).status).toBe(403);
  });
});

async function readyPayout() {
  await approvedApplication('especialistaOne');
  const v = await visit({ finish: true });
  expect((await v.sp.put('/api/specialist/bank-destination', { pixKeyType: 'CPF', pixKey: CPF, holderName: 'Enf. Teste', password: DEMO_PASSWORD })).status).toBe(200);
  const op = await loginAs(app, 'operador');
  expect((await op.post(`/api/admin/finance/payouts/${v.payout.id}/validate`, { approve: true })).status).toBe(200);
  return { ...v, op, fin: await loginAs(app, 'financeiro'), DEMO_PASSWORD };
}

describe('Repasse por Pix no Asaas (T06–T09, T12)', () => {
  it('T06: transferência enviada, confirmada pelo webhook com tarifa e comprovante; duplicado não repete', async () => {
    const { payout, fin } = await readyPayout();
    asaasOn(); const transfers = fakeTransfers();
    expect((await fin.post(`/api/admin/finance/payouts/${payout.id}/authorize`)).body.status).toBe('ENVIADO');
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({ pixAddressKey: CPF, pixAddressKeyType: 'CPF', externalReference: `payout:${payout.id}` });
    expect((await fin.post(`/api/admin/finance/payouts/${payout.id}/authorize`)).status).toBe(409);
    const done = { id: 'evt_t1', event: 'TRANSFER_DONE', transfer: { id: transfers[0].id, status: 'DONE', value: transfers[0].value, transferFee: 0, transactionReceiptUrl: 'https://sandbox.asaas.com/comprovantes/x' } };
    expect((await hook(done)).json().outcome).toBe('REPASSE_CONFIRMADO');
    expect((await hook(done)).json().outcome).toBe('DUPLICADO');
    const p = await one<any>('SELECT * FROM payout_entries WHERE id = ?', payout.id);
    expect(p).toMatchObject({ status: 'CONFIRMADO', transfer_fee_cents: 0, transfer_receipt_url: 'https://sandbox.asaas.com/comprovantes/x' });
  });

  it('T07: timeout após envio fica "em verificação" e a conciliação consulta antes de qualquer nova tentativa', async () => {
    const { payout, fin } = await readyPayout();
    asaasOn(); const transfers = fakeTransfers('timeout');
    expect((await fin.post(`/api/admin/finance/payouts/${payout.id}/authorize`)).body.status).toBe('ENVIO_INCERTO');
    expect((await one<any>('SELECT status FROM payout_entries WHERE id = ?', payout.id)).status).toBe('ENVIO_INCERTO');
    fakeTransfers('ok'); // o Asaas voltou; a transferência criada antes do timeout existe
    const sim = transfers[0];
    setAsaasTransport(async (method, url) => {
      if (method === 'GET' && url.includes('/transfers?')) return { status: 200, json: { data: [sim] } };
      if (method === 'GET' && url.includes('/transfers/')) return { status: 200, json: { ...sim, status: 'DONE' } };
      if (method === 'POST') throw new Error('não deveria criar outra transferência');
      return { status: 404, json: {} };
    });
    const r = await reconcileTransfers();
    expect(r.updated).toBe(1);
    expect((await one<any>('SELECT status, transfer_id FROM payout_entries WHERE id = ?', payout.id))).toMatchObject({ status: 'ENVIADO', transfer_id: sim.id });
    await reconcileTransfers();
    expect((await one<any>('SELECT status FROM payout_entries WHERE id = ?', payout.id)).status).toBe('CONFIRMADO');
  });

  it('T08: saldo insuficiente bloqueia, alerta e permite reenvio pelo Financeiro', async () => {
    const { payout, fin } = await readyPayout();
    asaasOn(); fakeTransfers('saldo');
    expect((await fin.post(`/api/admin/finance/payouts/${payout.id}/authorize`)).body.status).toBe('SALDO_INSUFICIENTE');
    expect((await one<any>(`SELECT COUNT(*) AS n FROM notifications WHERE title LIKE 'Repasse bloqueado%'`)).n).toBeGreaterThan(0);
    fakeTransfers('ok');
    expect((await fin.post(`/api/admin/finance/payouts/${payout.id}/retry`)).body.status).toBe('ENVIADO');
  });

  it('T09: troca de chave Pix exige senha, bloqueia por 24 h e precisa de duas aprovações de pessoas diferentes', async () => {
    const { payout, fin, sp, DEMO_PASSWORD } = await readyPayout();
    const ch = await sp.put('/api/specialist/bank-destination', { pixKeyType: 'EMAIL', pixKey: 'enf.teste@exemplo.test', holderName: 'Enf. Teste', password: DEMO_PASSWORD });
    expect(ch.body.destination).toMatchObject({ status: 'PENDENTE_VERIFICACAO', isChange: true, maskedKey: 'en***@exemplo.test' });
    expect((await fin.post(`/api/admin/finance/payouts/${payout.id}/authorize`)).body.error.code).toBe('PAYOUT_BLOCKED');
    const d = ch.body.destination.id;
    expect((await fin.post(`/api/admin/finance/bank-destinations/${d}/verify`, { approve: true, note: 'Titular conferido.' })).body.pending).toBe('SEGUNDA_APROVACAO');
    expect((await fin.post(`/api/admin/finance/bank-destinations/${d}/verify`, { approve: true, note: 'De novo.' })).status).toBe(403);
    const adm = await loginAs(app, 'adminPrime');
    expect((await adm.post(`/api/admin/finance/bank-destinations/${d}/verify`, { approve: true, note: 'Segunda aprovação.' })).body.status).toBe('VERIFICADA');
    // ainda dentro do bloqueio de 24 h
    expect((await fin.post(`/api/admin/finance/payouts/${payout.id}/authorize`)).body.error.message).toMatch(/alterada recentemente/);
    await run(`UPDATE bank_destinations SET available_from = '2020-01-01T00:00:00.000Z' WHERE id = ?`, d);
    expect((await fin.post(`/api/admin/finance/payouts/${payout.id}/authorize`)).body.status).toBe('PROGRAMADO');
    expect((await one<any>(`SELECT COUNT(*) AS n FROM notifications WHERE title = 'Chave Pix alterada'`)).n).toBe(1);
  });

  it('acima do limite: segunda aprovação de outra pessoa', async () => {
    const { payout, fin } = await readyPayout();
    config.payoutDualApprovalCents = 1000;
    expect((await fin.post(`/api/admin/finance/payouts/${payout.id}/authorize`)).body.pending).toBe('SEGUNDA_APROVACAO');
    expect((await fin.post(`/api/admin/finance/payouts/${payout.id}/authorize`)).status).toBe(403);
    const adm = await loginAs(app, 'adminPrime');
    expect((await adm.post(`/api/admin/finance/payouts/${payout.id}/authorize`)).body.status).toBe('PROGRAMADO');
  });

  it('T12: chargeback bloqueia repasse pendente; revertido devolve ao estado anterior', async () => {
    const { payout, orderId, fin } = await readyPayout();
    asaasOn();
    await run(`UPDATE service_orders SET provider = 'ASAAS', provider_ref = ? WHERE id = ?`, 'pay_cb', orderId);
    const cb = { id: 'evt_cb', event: 'PAYMENT_CHARGEBACK_REQUESTED', payment: { id: 'pay_cb', externalReference: `care:${orderId}`, value: 1 } };
    expect((await hook(cb)).json().outcome).toBe('CHARGEBACK_REGISTRADO');
    expect((await one<any>('SELECT status, blocked_from FROM payout_entries WHERE id = ?', payout.id))).toMatchObject({ status: 'BLOQUEADO', blocked_from: 'VALIDADO' });
    expect((await fin.post(`/api/admin/finance/payouts/${payout.id}/authorize`)).status).toBe(409);
    const occ = await one<any>('SELECT * FROM financial_occurrences');
    expect(occ).toMatchObject({ kind: 'CHARGEBACK', status: 'ABERTA' });
    // revertida só com o Asaas confirmando o pagamento
    let payStatus = 'CHARGEBACK_REQUESTED';
    setAsaasTransport(async (method, url) => (method === 'GET' && url.endsWith('/payments/pay_cb') ? { status: 200, json: { id: 'pay_cb', status: payStatus } } : { status: 404, json: {} }));
    const bad = await fin.post(`/api/admin/finance/occurrences/${occ.id}/resolve`, { outcome: 'REVERTIDA', note: 'Contestação ganha.' });
    expect(bad.body.error?.code, JSON.stringify(bad.body)).toBe('CHARGEBACK_NOT_REVERSED');
    payStatus = 'RECEIVED';
    expect((await fin.post(`/api/admin/finance/occurrences/${occ.id}/resolve`, { outcome: 'REVERTIDA', note: 'Contestação ganha.' })).status).toBe(200);
    expect((await one<any>('SELECT status FROM payout_entries WHERE id = ?', payout.id)).status).toBe('VALIDADO');
  });

  it('chave de produção sem aprovação formal (Portão D) não transfere pelo Asaas', async () => {
    Object.assign(config, { paymentProvider: 'ASAAS', asaasApiKey: '$aact_prod_ficticia', asaasTransfersEnabled: true, asaasProductionApproved: false });
    expect(transfersMode()).toBe('MANUAL');
    config.asaasProductionApproved = true;
    expect(transfersMode()).toBe('ASAAS');
  });

  it('alertas D+1 e perto de 48 h são enviados uma única vez', async () => {
    const { payout } = await readyPayout();
    const past = new Date(Date.now() - 41 * 3600_000).toISOString();
    await run('UPDATE payout_entries SET validated_at = ? WHERE id = ?', past, payout.id);
    expect(await payoutAlerts()).toBe(1);
    expect(await payoutAlerts()).toBe(0);
  });
});

describe('Revisão de segurança', () => {
  it('quem concedeu o perfil ao primeiro aprovador não pode ser o segundo', async () => {
    const { payout, fin } = await readyPayout();
    config.payoutDualApprovalCents = 1000;
    await run(`UPDATE user_roles SET granted_by = ? WHERE user_id = ? AND role = 'FINANCEIRO'`, await idOf('adminPrime'), await idOf('financeiro'));
    expect((await fin.post(`/api/admin/finance/payouts/${payout.id}/authorize`)).body.pending).toBe('SEGUNDA_APROVACAO');
    const adm = await loginAs(app, 'adminPrime');
    expect((await adm.post(`/api/admin/finance/payouts/${payout.id}/authorize`)).body.error.code).toBe('SEGREGATION_OF_DUTIES');
  });

  it('ato remoto aceito ou com evolução registrada não gera estorno integral automático', async () => {
    const { c, orderId, eventId } = await visit();
    await run(`UPDATE care_events SET modality = 'REMOTO' WHERE id = ?`, eventId);
    const r = await c.post(`/api/care/orders/${orderId}/refund-request`, { reason: 'Quero cancelar' });
    expect(r.body.refund.status).toBe('EM_ANALISE');
    expect((await one<any>('SELECT status FROM care_events WHERE id = ?', eventId)).status).toBe('ACEITO');
  });
});

describe('Reembolso (política ONEMA)', () => {
  it('antes do início: integral e automático, cancela o atendimento aceito e o repasse; só o titular pede', async () => {
    const { c, orderId, eventId, payout } = await visit();
    const intruso = new Client(app); await intruso.login(emailOf('responsavel'));
    expect((await intruso.post(`/api/care/orders/${orderId}/refund-request`, { reason: 'Não fui eu que contratei' })).status).toBe(404);
    const r = await c.post(`/api/care/orders/${orderId}/refund-request`, { reason: 'Mudança de planos' });
    expect(r.body.refund).toMatchObject({ status: 'DEVOLVIDO', actsDone: 0 });
    expect(r.body.refund.amountCents).toBe(r.body.refund.paidCents);
    expect(r.body.refund.receipt).toMatch(/devolvido/);
    expect((await one<any>('SELECT status FROM service_orders WHERE id = ?', orderId)).status).toBe('REFUNDED');
    expect((await one<any>('SELECT status FROM care_events WHERE id = ?', eventId)).status).toBe('CANCELADO');
    expect((await one<any>('SELECT status FROM payout_entries WHERE id = ?', payout.id)).status).toBe('CANCELADO');
    expect((await c.get(`/api/care/orders/${orderId}/refunds`)).body.refunds).toHaveLength(1);
    expect((await intruso.get(`/api/care/orders/${orderId}/refunds`)).status).toBe(404);
  });
});
