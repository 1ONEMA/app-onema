/**
 * PAC-03 · Pós-Alta 30 dias — motor de ofertas (proposta v1.0 do RT, 17/11/2026), critérios da p. 7:
 * pedido pago cria 6 eventos e abre só a avaliação inicial; os outros 5 "A programar"; reprocessamento não duplica;
 * plano validado pela Central abre a oferta com dependência; referência primeiro, ampliação por prazo/recusa;
 * dois aceites simultâneos = uma atribuição; janela vencida pausa e aciona a Central.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, all, emailOf, idOf, loginAs, one, run, setup } from './helpers.ts';
import { PRICING_V1 } from '../src/db/content/pricing-v1.ts';
import { applyPaymentEvent } from '../src/modules/care/core.ts';
import { requestWindow, runOfferSweep } from '../src/modules/care/offer-engine.ts';
import { tx } from '../src/db/db.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });
async function patient(key: 'paciente' | 'responsavel' = 'paciente') { const c = new Client(app); await c.login(emailOf(key)); return c; }
const EVO = { relato: 'Paciente refere melhora.', sinaisVitais: 'PA 120x80 mmHg.', avaliacao: 'Estável.', procedimentos: 'Avaliação.', orientacoes: 'Manter cuidados.', plano: 'Reavaliar.', observacoes: '', pendencias: [] };
async function finishVisit(sp: Client, eventId: string, pt: Client) {
  const ev = await one<any>('SELECT visit_code, modality FROM care_events WHERE id = ?', eventId);
  if (ev.modality === 'PRESENCIAL') expect((await sp.post(`/api/care/specialist/events/${eventId}/start`, { code: ev.visit_code })).status).toBe(200);
  expect((await sp.post(`/api/care/specialist/events/${eventId}/evolution/sign`, { content: EVO, confirm: true })).status).toBe(200);
  expect((await pt.post(`/api/care/events/${eventId}/sign`, { name: 'Paciente Fictício', confirm: true })).status).toBe(200);
  expect((await sp.post(`/api/care/specialist/events/${eventId}/complete`)).status).toBe(200);
}
async function secondSpecialist() {
  const id = await idOf('especialista'); const now = new Date().toISOString();
  await run(`INSERT INTO partner_training_status (partner_id, journey_state, credentialing_decision, decision_note, decided_at, updated_at) VALUES (?, 'NAO_INICIADA', 'APTO', 'teste', ?, ?)
    ON CONFLICT (partner_id) DO UPDATE SET credentialing_decision = 'APTO'`, id, now, now);
  const c = new Client(app); await c.login(emailOf('especialista')); return c;
}
const NEED_OF = Object.fromEntries(PRICING_V1.map((d) => [d.code, d.need]));
function form(itemCode: string, extra: Record<string, unknown> = {}) {
  return {
    need: NEED_OF[itemCode], itemCode, infoText: 'Teste de homologação (fictício)', materials: 'SIM', materialsDetail: '', materialsSupplyRequested: false,
    patientName: 'Paciente Fictício', phone: '(11) 99999-0000', location: 'Vila Mariana', whenPref: 'PROXIMOS_DIAS', whenDate: null, notes: '',
    forSelf: true, responsibleAuthorized: false, address: { cep: '04101-000', street: 'Rua Fictícia', number: '100', complement: '', district: 'Vila Mariana', city: 'São Paulo', reference: '' }, timeWindow: 'MANHA', ...extra,
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

describe('PAC-03 · motor de ofertas', () => {
  it('janela "Hoje à noite" convertida no fuso de São Paulo, gravada na solicitação', () => {
    const w = requestWindow({ whenPref: 'HOJE', timeWindow: 'NOITE' }, undefined, '2026-11-17T15:00:00.000Z');
    expect(w).toMatchObject({ start: '2026-11-17T21:00:00.000Z', end: '2026-11-18T01:00:00.000Z', label: 'à noite, 18h–22h' });
    // faixa de hoje já encerrada: vale até o fim do dia (a Central confirma)
    const late = requestWindow({ whenPref: 'HOJE', timeWindow: 'MANHA' }, undefined, '2026-11-17T20:00:00.000Z');
    expect(late.label).toBe('até o fim do dia');
    expect(requestWindow({ whenPref: 'AGENDAR', whenDate: '2026-11-20', timeWindow: 'TARDE' }).start).toBe('2026-11-20T15:00:00.000Z');
  });

  it('pago: só a avaliação inicial em oferta; 5 "A programar"; reprocessar o pagamento não duplica nem muda a janela', async () => {
    const c = await patient();
    const { req, pay } = await contract(c, 'PAC-03');
    expect(pay.body.paid).toBe(true);
    const evs = await all<any>('SELECT seq, label, status, window_start, depends_on_seq FROM care_events WHERE order_id = ? ORDER BY seq', pay.body.order.id);
    expect(evs).toHaveLength(6);
    expect(evs[0]).toMatchObject({ label: 'Avaliação inicial', status: 'DISPONIVEL' });
    expect(evs[0].window_start).toBeTruthy();
    expect(evs.slice(1).every((e) => e.status === 'A_PROGRAMAR' && e.depends_on_seq === 1 && !e.window_start)).toBe(true);
    await tx(async () => applyPaymentEvent({ eventId: 'reprocess-1', orderId: pay.body.order.id, type: 'PAYMENT_CONFIRMED' }, null));
    const again = await all<any>('SELECT status, window_start FROM care_events WHERE order_id = ? ORDER BY seq', pay.body.order.id);
    expect(again.map((e) => e.status)).toEqual(evs.map((e) => e.status));
    expect(again[0].window_start).toBe(evs[0].window_start);
    // tela do paciente: inicial "Buscando especialista" com a janela pedida; demais "A programar"
    const d = (await c.get(`/api/care/requests/${req.id}`)).body;
    expect(d.events[0].state).toMatchObject({ code: 'BUSCANDO', label: 'Buscando especialista' });
    expect(d.events[0].state.detail).toMatch(/^Solicitado para /);
    expect(d.events.slice(1).map((e: any) => e.state.label)).toEqual(Array(5).fill('A programar'));
    // especialista vê uma única oferta, com a janela (data completa)
    const sp = new Client(app); await sp.login(emailOf('especialistaOne'));
    const offers = (await sp.get('/api/care/specialist/offers')).body.offers;
    expect(offers).toHaveLength(1);
    expect(offers[0].windowText).toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });

  it('dois aceites simultâneos: uma atribuição; o segundo recebe "já foi preenchida"', async () => {
    const c = await patient();
    await contract(c, 'PAC-03');
    const a = new Client(app); await a.login(emailOf('especialistaOne'));
    const b = await secondSpecialist();
    const id = (await a.get('/api/care/specialist/offers')).body.offers[0].id;
    expect((await b.get('/api/care/specialist/offers')).body.offers.map((o: any) => o.id)).toContain(id);
    const [r1, r2] = await Promise.all([a.post(`/api/care/specialist/events/${id}/accept`), b.post(`/api/care/specialist/events/${id}/accept`)]);
    const codes = [r1.status, r2.status].sort();
    expect(codes).toEqual([200, 409]);
    expect([r1, r2].find((r) => r.status === 409)!.body.error.message).toBe('Esta oferta já foi preenchida.');
    expect((await one<any>(`SELECT COUNT(*)::int AS n FROM care_offer_log WHERE event_id = ? AND kind = 'ACEITE'`, id)).n).toBe(1);
    expect((await b.get('/api/care/specialist/offers')).body.offers).toHaveLength(0);
  });

  it('Central programa o próximo evento: abre após a inicial realizada; referência primeiro, ampliação por recusa; vencimento aciona a Central', async () => {
    const c = await patient();
    const { req, pay } = await contract(c, 'PAC-03');
    const one1 = new Client(app); await one1.login(emailOf('especialistaOne'));
    const other = await secondSpecialist();
    const first = (await one1.get('/api/care/specialist/offers')).body.offers[0];
    expect((await one1.post(`/api/care/specialist/events/${first.id}/accept`)).status).toBe(200);
    const central = await loginAs(app, 'operador');
    const ag = (await central.get('/api/admin/care/agenda')).body.orders.find((o: any) => o.id === pay.body.order.id);
    expect(ag.events).toHaveLength(6);
    const remote = ag.events.find((e: any) => e.modality === 'REMOTO');
    const start = new Date(Date.now() + 2 * 86400_000), end = new Date(start.getTime() + 4 * 3600_000);
    expect((await central.post(`/api/admin/care/events/${remote.id}/plan`, { windowStart: start.toISOString(), windowEnd: end.toISOString(), opensAt: new Date(Date.now() - 1000).toISOString() })).status).toBe(200);
    // dependência: a avaliação inicial ainda não foi realizada → não abre
    await runOfferSweep(true);
    expect((await one<any>('SELECT status FROM care_events WHERE id = ?', remote.id)).status).toBe('A_PROGRAMAR');
    expect((await c.get(`/api/care/requests/${req.id}`)).body.events.find((e: any) => e.id === remote.id).state.label).toMatch(/^Previsto para /);
    await finishVisit(one1, first.id, c);
    await runOfferSweep(true);
    expect((await one<any>('SELECT status, reference_specialist_id, offer_wave FROM care_events WHERE id = ?', remote.id))).toMatchObject({ status: 'DISPONIVEL', reference_specialist_id: await idOf('especialistaOne'), offer_wave: 1 });
    // primeira onda: só a referência vê
    expect((await other.get('/api/care/specialist/offers')).body.offers.map((o: any) => o.id)).not.toContain(remote.id);
    const mine = (await one1.get('/api/care/specialist/offers')).body.offers.find((o: any) => o.id === remote.id);
    expect(mine.reserved).toBe(true);
    expect((await other.post(`/api/care/specialist/events/${remote.id}/accept`)).body.error.code).toBe('OFFER_RESERVED');
    // recusa da referência amplia para a rede
    expect((await one1.post(`/api/care/specialist/events/${remote.id}/decline`, {})).status).toBe(200);
    expect((await other.get('/api/care/specialist/offers')).body.offers.map((o: any) => o.id)).toContain(remote.id);
    expect((await all<any>('SELECT kind FROM care_offer_log WHERE event_id = ? ORDER BY created_at', remote.id)).map((l) => l.kind)).toEqual(expect.arrayContaining(['PROGRAMADA', 'PUBLICADA', 'RECUSA', 'ONDA_AMPLIADA']));
    // janela vence sem aceite: pausa, pendência na Central e aviso ao paciente
    await run('UPDATE care_events SET window_end = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), remote.id);
    await runOfferSweep(true);
    expect((await one<any>('SELECT status, attention FROM care_events WHERE id = ?', remote.id))).toMatchObject({ status: 'A_PROGRAMAR', attention: 'JANELA_VENCIDA' });
    expect((await c.get(`/api/care/requests/${req.id}`)).body.events.find((e: any) => e.id === remote.id).state.label).toBe('Verificando disponibilidade');
    // Central reprograma: pendência resolvida
    expect((await central.post(`/api/admin/care/events/${remote.id}/plan`, { windowStart: start.toISOString(), windowEnd: end.toISOString() })).status).toBe(200);
    expect((await one<any>('SELECT attention FROM care_events WHERE id = ?', remote.id)).attention).toBeNull();
    // paciente comum não acessa a Gestão
    expect((await c.get('/api/admin/care/agenda')).status).toBe(403);
  });
});
