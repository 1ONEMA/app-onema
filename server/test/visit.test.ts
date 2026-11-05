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
    expect(await organizeDictation('qualquer ditado de teste suficiente', { act: 'x', modality: 'PRESENCIAL' })).toEqual({ failure: 'NAO_CONFIGURADA' });
    const code = (await one<any>('SELECT visit_code FROM care_events WHERE id = ?', eventId)).visit_code;
    await sp.post(`/api/care/specialist/events/${eventId}/start`, { code });
    expect((await sp.post(`/api/care/specialist/events/${eventId}/evolution/organize`, { dictation: 'curto' })).status).toBe(400);
    const dictation = 'Paciente refere melhora da dor. Realizado curativo simples em calcâneo direito, ferida limpa.';
    const org = await sp.post(`/api/care/specialist/events/${eventId}/evolution/organize`, { dictation });
    expect(org.body.evolution).toMatchObject({ status: 'RASCUNHO', aiStatus: 'FALHOU', content: { observacoes: dictation } });
    expect(org.body.evolution.aiMessage).toMatch(/não configurada/);
    expect((await sp.post(`/api/care/specialist/events/${eventId}/complete`)).body.error.code).toBe('EVOLUTION_REQUIRED');
    expect((await sp.post(`/api/care/specialist/events/${eventId}/evolution/sign`, { content: { ...EVO, relato: '', avaliacao: '', procedimentos: '' }, confirm: true })).body.error.code).toBe('EVOLUTION_EMPTY');
    expect((await sp.post(`/api/care/specialist/events/${eventId}/evolution/sign`, { content: EVO })).status).toBe(400);
    const signed = await sp.post(`/api/care/specialist/events/${eventId}/evolution/sign`, { content: EVO, confirm: true });
    expect(signed.body.evolution.status).toBe('ASSINADA');
    expect((await sp.put(`/api/care/specialist/events/${eventId}/evolution`, { content: EVO })).body.error.code).toBe('EVOLUTION_SIGNED');
    await expect(run(`UPDATE care_evolutions SET content_json = '{}'`)).rejects.toThrow(/immutable/);
    // paciente vê a evolução e a linha do tempo antes de assinar; outra pessoa não assina
    const det = (await c.get(`/api/care/requests/${(await one<any>('SELECT r.id FROM care_requests r')).id}`)).body;
    const evDet = det.events.find((x: any) => x.id === eventId);
    expect(evDet).toMatchObject({ awaiting_signature: true, evolution: { procedimentos: 'Realizado curativo simples.' } });
    expect(det.timeline.map((t: any) => t.kind)).toEqual(expect.arrayContaining(['PAGAMENTO', 'ESPECIALISTA', 'INICIO', 'EVOLUCAO']));
    const intruso = new Client(app); await intruso.login(emailOf('responsavel'));
    expect((await intruso.post(`/api/care/events/${eventId}/sign`, { name: 'Outra Pessoa', confirm: true })).status).toBe(404);
    expect((await c.post(`/api/care/events/${eventId}/sign`, { name: 'Paciente Fictício' })).status).toBe(400);
    expect((await c.post(`/api/care/events/${eventId}/sign`, { name: 'Paciente Fictício', confirm: true })).status).toBe(200);
    expect((await c.post(`/api/care/events/${eventId}/sign`, { name: 'Paciente Fictício', confirm: true })).body.error.code).toBe('ALREADY_SIGNED');
    expect((await sp.post(`/api/care/specialist/events/${eventId}/complete`)).status).toBe(200);
    const after = (await c.get(`/api/care/requests/${(await one<any>('SELECT r.id FROM care_requests r')).id}`)).body.timeline.map((t: any) => t.kind);
    expect(after).toEqual(expect.arrayContaining(['CONFIRMACAO', 'CONCLUSAO']));
    const wallet = (await c.get('/api/care/wallet')).body;
    expect(wallet.clinicalDocuments).toHaveLength(1);
    expect(wallet.clinicalDocuments[0]).toMatchObject({ content: { procedimentos: 'Realizado curativo simples.' }, specialist: expect.any(String) });
    // o ditado bruto não vai para o paciente
    expect(JSON.stringify(wallet)).not.toContain('calcâneo direito');

    // Compartilhar o relatório: só com PRIME ativo; link com token, revogável, sem pendências internas
    const docId = wallet.clinicalDocuments[0].id;
    expect(wallet.primeActive).toBe(false);
    expect((await c.post(`/api/care/evolutions/${docId}/share`, { channel: 'WHATSAPP' })).body.error.code).toBe('PRIME_REQUIRED');
    const offer = await c.get('/api/prime/offer');
    expect((await c.post('/api/prime/subscriptions', { acceptTerms: true, termsTextId: offer.body.terms.id, privacyTextId: offer.body.privacy.id, paymentMethod: 'SANDBOX_APROVADO',
      preferences: { LEMBRETES: { enabled: false, channels: { app: false, email: false, whatsapp: false } }, RESUMO_MENSAL: { enabled: false, channels: { app: false, email: false, whatsapp: false } }, OFERTAS: { enabled: false, channels: { app: false, email: false, whatsapp: false } } } }, true)).status).toBe(201);
    expect((await c.get('/api/care/wallet')).body.primeActive).toBe(true);
    expect((await intruso.post(`/api/care/evolutions/${docId}/share`, { channel: 'LINK' })).status).toBe(404);
    const sh = (await c.post(`/api/care/evolutions/${docId}/share`, { channel: 'EMAIL' })).body;
    const token = sh.url.split('/relatorio/')[1];
    expect(token.length).toBeGreaterThan(30);
    expect((await one<any>('SELECT token_hash FROM report_shares')).token_hash).not.toContain(token);
    const anon = new Client(app);
    const pub = await anon.get(`/api/public/reports/${token}`);
    expect(pub.status).toBe(200);
    expect(pub.headers['x-robots-tag']).toContain('noindex');
    expect(pub.body).toMatchObject({ patient: 'Paciente', content: { procedimentos: 'Realizado curativo simples.' } });
    expect(pub.body.content.pendencias).toBeUndefined();
    expect((await anon.get(`/api/public/reports/${token.slice(0, -2)}xx`)).status).toBe(404);
    expect((await c.get('/api/care/report-shares')).body.shares[0].access_count).toBe(1);
    expect((await intruso.post(`/api/care/report-shares/${sh.id}/revoke`)).status).toBe(404);
    expect((await c.post(`/api/care/report-shares/${sh.id}/revoke`)).status).toBe(200);
    expect((await anon.get(`/api/public/reports/${token}`)).status).toBe(404);
  });
});
