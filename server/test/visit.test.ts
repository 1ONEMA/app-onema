import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, emailOf, one, run, setup } from './helpers.ts';
import { PRICING_V1 } from '../src/db/content/pricing-v1.ts';
import { organizeDictation } from '../src/modules/care/evolution-ai.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });

const NEED_OF = Object.fromEntries(PRICING_V1.map((d) => [d.code, d.need]));
const EVO = { relato: 'Paciente refere melhora da dor.', sinaisVitais: 'Não informado no ditado.', avaliacao: 'Ferida limpa.', procedimentos: 'Realizado curativo simples.', orientacoes: '', plano: '', observacoes: '', pendencias: [] };

/** Paciente contrata um curativo presencial e a especialista credenciada aceita. */
async function acceptedVisit() {
  const c = new Client(app); await c.login(emailOf('paciente'));
  const form = { need: NEED_OF['CAT-02A'], itemCode: 'CAT-02A', infoText: '', materials: 'SIM', materialsDetail: '', materialsSupplyRequested: false,
    patientName: 'Paciente Fictício', phone: '(11) 99999-0000', location: 'Vila Mariana', whenPref: 'PROXIMOS_DIAS', whenDate: null, notes: '', forSelf: true, responsibleAuthorized: false };
  const req = (await c.post('/api/care/requests', form, true)).body.request;
  await c.post(`/api/care/requests/${req.id}/accept`, { quoteVersion: req.quoteVersion });
  await c.post(`/api/care/requests/${req.id}/checkout`, { quoteVersion: req.quoteVersion, paymentMethod: 'SANDBOX_APROVADO', expectedTotalCents: req.quote.totalCents }, true);
  const sp = new Client(app); await sp.login(emailOf('especialistaOne'));
  const ev = (await sp.get('/api/care/specialist/offers')).body.offers.find((o: any) => o.modality === 'PRESENCIAL');
  expect((await sp.post(`/api/care/specialist/events/${ev.id}/accept`)).status).toBe(200);
  return { c, sp, eventId: ev.id as string, requestId: req.id as string };
}

describe('Início da visita com código do paciente', () => {
  it('paciente vê o código; especialista só inicia com o código certo; tentativas limitadas; localização arredondada', async () => {
    const { c, sp, eventId, requestId } = await acceptedVisit();
    const seen = (await c.get(`/api/care/requests/${requestId}`)).body.events.find((e: any) => e.id === eventId);
    expect(seen.visit_code).toMatch(/^\d{6}$/);
    // a especialista não recebe o código pela API dela
    expect(JSON.stringify((await sp.get('/api/care/specialist/offers')).body)).not.toContain(seen.visit_code);
    // sem início não assina nem conclui
    expect((await sp.post(`/api/care/specialist/events/${eventId}/evolution/sign`, { content: EVO, confirm: true })).body.error.code).toBe('VISIT_NOT_STARTED');
    expect((await sp.post(`/api/care/specialist/events/${eventId}/complete`)).body.error.code).toBe('VISIT_NOT_STARTED');
    const wrong = seen.visit_code === '111111' ? '222222' : '111111';
    expect((await sp.post(`/api/care/specialist/events/${eventId}/start`, { code: wrong })).body.error.code).toBe('INVALID_VISIT_CODE');
    // outra especialista não acessa o atendimento
    const other = new Client(app); await other.login(emailOf('especialista'));
    await run(`INSERT INTO partner_training_status (partner_id, journey_state, credentialing_decision, updated_at) VALUES ((SELECT id FROM users WHERE email = ?), 'NAO_INICIADA', 'APTO', '2026-01-01') ON CONFLICT (partner_id) DO UPDATE SET credentialing_decision = 'APTO'`, emailOf('especialista'));
    expect((await other.post(`/api/care/specialist/events/${eventId}/start`, { code: seen.visit_code })).status).toBe(404);
    const ok = await sp.post(`/api/care/specialist/events/${eventId}/start`, { code: seen.visit_code, location: { lat: -23.5871234, lng: -46.6345678, accuracy: 12.4 } });
    expect(ok.status).toBe(200);
    const row = await one<any>('SELECT started_at, start_lat, start_lng, start_accuracy_m FROM care_events WHERE id = ?', eventId);
    expect([row.start_lat, row.start_lng, row.start_accuracy_m]).toEqual([-23.587, -46.635, 12]);
    expect((await sp.post(`/api/care/specialist/events/${eventId}/start`, { code: seen.visit_code })).body.error.code).toBe('ALREADY_STARTED');
    // código some da tela do paciente após o início
    expect((await c.get(`/api/care/requests/${requestId}`)).body.events.find((e: any) => e.id === eventId).visit_code).toBeNull();
    expect((await one<any>(`SELECT COUNT(*) AS n FROM notifications WHERE title = 'Atendimento iniciado'`)).n).toBe(1);
  });

  it('código errado repetido é bloqueado', async () => {
    const { sp, eventId } = await acceptedVisit();
    const code = (await one<any>('SELECT visit_code FROM care_events WHERE id = ?', eventId)).visit_code;
    const wrong = code === '111111' ? '222222' : '111111';
    for (let i = 0; i < 5; i++) await sp.post(`/api/care/specialist/events/${eventId}/start`, { code: wrong });
    expect((await sp.post(`/api/care/specialist/events/${eventId}/start`, { code })).status).toBe(429);
  });
});

describe('Evolução de enfermagem (Kary)', () => {
  it('sem IA configurada o ditado vira rascunho manual; assinatura obrigatória para concluir; assinada é imutável e vai à Carteira', async () => {
    const { c, sp, eventId } = await acceptedVisit();
    expect(await organizeDictation('qualquer ditado de teste suficiente', { act: 'x', modality: 'PRESENCIAL' })).toBeNull();
    const code = (await one<any>('SELECT visit_code FROM care_events WHERE id = ?', eventId)).visit_code;
    await sp.post(`/api/care/specialist/events/${eventId}/start`, { code });
    expect((await sp.post(`/api/care/specialist/events/${eventId}/evolution/organize`, { dictation: 'curto' })).status).toBe(400);
    const dictation = 'Paciente refere melhora da dor. Realizado curativo simples em calcâneo direito, ferida limpa.';
    const org = await sp.post(`/api/care/specialist/events/${eventId}/evolution/organize`, { dictation });
    expect(org.body).toMatchObject({ ai: false, evolution: { status: 'RASCUNHO', content: { observacoes: dictation } } });
    expect((await sp.post(`/api/care/specialist/events/${eventId}/complete`)).body.error.code).toBe('EVOLUTION_REQUIRED');
    expect((await sp.post(`/api/care/specialist/events/${eventId}/evolution/sign`, { content: { ...EVO, relato: '', avaliacao: '', procedimentos: '' }, confirm: true })).body.error.code).toBe('EVOLUTION_EMPTY');
    expect((await sp.post(`/api/care/specialist/events/${eventId}/evolution/sign`, { content: EVO })).status).toBe(400);
    const signed = await sp.post(`/api/care/specialist/events/${eventId}/evolution/sign`, { content: EVO, confirm: true });
    expect(signed.body.evolution.status).toBe('ASSINADA');
    expect((await sp.put(`/api/care/specialist/events/${eventId}/evolution`, { content: EVO })).body.error.code).toBe('EVOLUTION_SIGNED');
    await expect(run(`UPDATE care_evolutions SET content_json = '{}'`)).rejects.toThrow(/immutable/);
    expect((await sp.post(`/api/care/specialist/events/${eventId}/complete`)).status).toBe(200);
    const wallet = (await c.get('/api/care/wallet')).body;
    expect(wallet.clinicalDocuments).toHaveLength(1);
    expect(wallet.clinicalDocuments[0]).toMatchObject({ content: { procedimentos: 'Realizado curativo simples.' }, specialist: expect.any(String) });
    // o ditado bruto não vai para o paciente
    expect(JSON.stringify(wallet)).not.toContain('calcâneo direito');
  });
});
