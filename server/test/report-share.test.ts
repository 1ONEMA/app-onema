import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, emailOf, idOf, one, run, setup } from './helpers.ts';
import { PRICING_V1 } from '../src/db/content/pricing-v1.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });

const NEED_OF = Object.fromEntries(PRICING_V1.map((d) => [d.code, d.need]));
const EVO = {
  relato: 'Paciente refere melhora da dor.\n\nSegundo parágrafo do relato.', sinaisVitais: 'PA 120x80 mmHg', avaliacao: 'Ferida limpa.',
  procedimentos: 'Realizado curativo simples.', orientacoes: 'Manter curativo seco.', plano: 'Retorno em 2 dias.', observacoes: 'Divergência: paciente nega alergia relatada no pedido.',
  pendencias: ['interna'],
};

/** Paciente PRIME com evolução assinada por especialista com COREN aprovado; devolve o token público. */
async function sharedReport() {
  const c = new Client(app); await c.login(emailOf('paciente'));
  const form = { need: NEED_OF['CAT-02A'], itemCode: 'CAT-02A', infoText: '', materials: 'SIM', materialsDetail: '', materialsSupplyRequested: false,
    patientName: 'Paciente Fictício', phone: '(11) 99999-0000', location: 'Vila Mariana', whenPref: 'PROXIMOS_DIAS', whenDate: null, notes: '', forSelf: true, responsibleAuthorized: false,
    address: { cep: '04101-000', street: 'Rua Fictícia', number: '100', complement: '', district: 'Vila Mariana', city: 'São Paulo', reference: '' }, timeWindow: 'MANHA' };
  const req = (await c.post('/api/care/requests', form, true)).body.request;
  await c.post(`/api/care/requests/${req.id}/accept`, { quoteVersion: req.quoteVersion });
  await c.post(`/api/care/requests/${req.id}/checkout`, { quoteVersion: req.quoteVersion, paymentMethod: 'SANDBOX_APROVADO', expectedTotalCents: req.quote.totalCents }, true);
  const sp = new Client(app); await sp.login(emailOf('especialistaOne'));
  const spId = await idOf('especialistaOne');
  await run(`INSERT INTO specialist_applications (id, user_id, full_name, cpf, coren_number, coren_uf, phone, regions, needs_json, status, created_at, updated_at)
    VALUES ('app-rs-1', ?, 'Enf. Especialista ONE', '000.000.000-00', '123456', 'SP', '(11) 90000-0000', 'Vila Mariana', '[]', 'APROVADA', '2026-01-01', '2026-01-01')
    ON CONFLICT (user_id) DO UPDATE SET coren_number = '123456', coren_uf = 'SP', status = 'APROVADA'`, spId);
  const ev = (await sp.get('/api/care/specialist/offers')).body.offers.find((o: any) => o.modality === 'PRESENCIAL');
  expect((await sp.post(`/api/care/specialist/events/${ev.id}/accept`)).status).toBe(200);
  const code = (await one<any>('SELECT visit_code FROM care_events WHERE id = ?', ev.id)).visit_code;
  expect((await sp.post(`/api/care/specialist/events/${ev.id}/start`, { code })).status).toBe(200);
  expect((await sp.post(`/api/care/specialist/events/${ev.id}/evolution/sign`, { content: EVO, confirm: true })).status).toBe(200);
  const offer = await c.get('/api/prime/offer');
  const off = { enabled: false, channels: { app: false, email: false, whatsapp: false } };
  expect((await c.post('/api/prime/subscriptions', { acceptTerms: true, termsTextId: offer.body.terms.id, privacyTextId: offer.body.privacy.id, paymentMethod: 'SANDBOX_APROVADO',
    preferences: { LEMBRETES: off, RESUMO_MENSAL: off, OFERTAS: off } }, true)).status).toBe(201);
  const docId = (await c.get('/api/care/wallet')).body.clinicalDocuments[0].id as string;
  const sh = (await c.post(`/api/care/evolutions/${docId}/share`, { channel: 'LINK' })).body;
  return { c, eventId: ev.id as string, docId, shareId: sh.id as string, token: sh.url.split('/relatorio/')[1] as string, expiresAt: sh.expiresAt as string };
}

describe('Relatório compartilhado (link público)', () => {
  it('traz identificação, autoria e validade sem expor dados sensíveis', async () => {
    const { token, docId, eventId, expiresAt } = await sharedReport();
    const anon = new Client(app);
    const pub = await anon.get(`/api/public/reports/${token}`);
    expect(pub.status).toBe(200);
    const ev = await one<any>('SELECT started_at FROM care_events WHERE id = ?', eventId);
    const evo = await one<any>('SELECT signed_at FROM care_evolutions WHERE id = ?', docId);
    const order = await one<any>('SELECT item_name FROM service_orders o JOIN care_events e ON e.order_id = o.id WHERE e.id = ?', eventId);
    expect(pub.body).toMatchObject({
      patient: 'Paciente', patientName: 'Paciente Demonstração', sharedBy: 'Paciente Demonstração',
      recordId: docId.replace(/-/g, '').slice(0, 8).toUpperCase(),
      careAt: ev.started_at, careAtSource: 'STARTED_AT', serviceName: order.item_name,
      specialist: 'Enf. Especialista ONE (credenciada)', coren: '123456-SP', corenNumber: '123456', corenUf: 'SP',
      signedAt: evo.signed_at, expiresAt,
    });
    // conteúdo clínico preservado como registrado (parágrafos, divergências); pendências internas fora
    const { pendencias: _p, ...expected } = EVO;
    expect(pub.body.content).toEqual(expected);
    // nada de CPF, endereço, telefone ou preço
    const raw = JSON.stringify(pub.body);
    for (const leak of ['000.000.000-00', 'Rua Fictícia', '04101-000', '99999-0000', '90000-0000', 'cents', 'cpf', 'address', 'phone', 'interna']) expect(raw).not.toContain(leak);
  });

  it('link expirado ou revogado continua indisponível', async () => {
    const { c, token, shareId } = await sharedReport();
    const anon = new Client(app);
    await run(`UPDATE report_shares SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`, shareId);
    const exp = await anon.get(`/api/public/reports/${token}`);
    expect(exp.status).toBe(404);
    expect(exp.body.patientName).toBeUndefined();
    expect((await one<any>('SELECT access_count FROM report_shares WHERE id = ?', shareId)).access_count).toBe(0);
    await run(`UPDATE report_shares SET expires_at = '2999-01-01T00:00:00.000Z' WHERE id = ?`, shareId);
    expect((await anon.get(`/api/public/reports/${token}`)).status).toBe(200);
    expect((await c.post(`/api/care/report-shares/${shareId}/revoke`)).status).toBe(200);
    expect((await anon.get(`/api/public/reports/${token}`)).status).toBe(404);
    expect((await one<any>(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'REPORT_SHARE_OPENED'`)).n).toBe(1);
  });
});
