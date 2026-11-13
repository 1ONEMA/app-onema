import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, emailOf, one, run, setup } from './helpers.ts';
import { PRICING_V1 } from '../src/db/content/pricing-v1.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });
const NEED_OF = Object.fromEntries(PRICING_V1.map((d) => [d.code, d.need]));
const ADDR = { cep: '04101-000', street: 'Rua Fictícia', number: '100', complement: 'ap 1', district: 'Vila Mariana', city: 'São Paulo', reference: '' };
const form = (extra: any = {}) => ({ need: NEED_OF['CAT-03'], itemCode: 'CAT-03', infoText: '', materials: 'NAO', materialsDetail: '', materialsSupplyRequested: false,
  patientName: 'Paciente Fictício', phone: '(11) 99999-0000', location: 'Vila Mariana', whenPref: 'HOJE', whenDate: null, notes: '', forSelf: true, responsibleAuthorized: false,
  timeWindow: 'TARDE', patientBirthDate: '1950-05-10', ...extra });
const PDF = Buffer.from('%PDF-1.4\n% pedido medico ficticio\n');

function upload(c: Client, url: string, buf: Buffer, kind = 'PEDIDO_MEDICO', name = 'pedido.pdf') {
  const b = '----x' + Date.now();
  const payload = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}\r\n--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`),
    buf, Buffer.from(`\r\n--${b}--\r\n`)]);
  return app.inject({ method: 'POST', url, payload, headers: { cookie: c.cookie, 'x-csrf-token': c.csrf, 'content-type': `multipart/form-data; boundary=${b}` } });
}

describe('Solicitação: endereço, anexos, orientação de materiais e validade do orçamento', () => {
  it('endereço completo exigido no aceite; anexo visível à especialista só depois do aceite; orientação sem bloquear pagamento', async () => {
    const c = new Client(app); await c.login(emailOf('paciente'));
    const req = (await c.post('/api/care/requests', form(), true)).body.request;
    expect(req.guidance.status).toBe('SOLICITADA');
    expect(req.status).toBe('ORCADO'); // orientação não deixa o orçamento pendente
    expect((await c.post(`/api/care/requests/${req.id}/accept`, { quoteVersion: 1 })).body.error.code).toBe('ADDRESS_REQUIRED');
    // área de atendimento: somente a cidade de São Paulo (Campinas recusado)
    expect((await c.put(`/api/care/requests/${req.id}`, form({ address: { ...ADDR, cep: '13010-000', city: 'Campinas' } }))).status).toBe(400);
    const upd = (await c.put(`/api/care/requests/${req.id}`, form({ address: ADDR }))).body.request;
    expect(upd.address).toMatchObject({ street: 'Rua Fictícia', district: 'Vila Mariana' });
    expect(JSON.stringify(await one('SELECT address_sealed FROM care_requests WHERE id = ?', req.id))).not.toContain('Rua Fictícia');
    // anexo (pedido médico)
    expect((await upload(c, `/api/care/requests/${req.id}/documents`, PDF)).statusCode).toBe(200);
    expect((await upload(c, `/api/care/requests/${req.id}/documents`, Buffer.from('nao e pdf'))).statusCode).toBe(400);
    const docs = (await c.get(`/api/care/requests/${req.id}/documents`)).body.documents;
    expect(docs).toHaveLength(1);
    const other = new Client(app); await other.login(emailOf('responsavel'));
    expect((await other.get(`/api/care/requests/${req.id}/documents`)).status).toBe(404);
    expect((await c.post(`/api/care/requests/${req.id}/accept`, { quoteVersion: upd.quoteVersion })).status).toBe(200);
    await c.post(`/api/care/requests/${req.id}/checkout`, { quoteVersion: upd.quoteVersion, paymentMethod: 'SANDBOX_APROVADO', expectedTotalCents: upd.quote.totalCents }, true);
    const sp = new Client(app); await sp.login(emailOf('especialistaOne'));
    const ev = (await sp.get('/api/care/specialist/offers')).body.offers[0];
    // antes do aceite: nada
    expect((await sp.get(`/api/care/specialist/events/${ev.id}/documents`)).status).toBe(404);
    await sp.post(`/api/care/specialist/events/${ev.id}/accept`);
    const view = (await sp.get(`/api/care/specialist/events/${ev.id}/documents`)).body;
    expect(view.documents).toHaveLength(1);
    const file = await app.inject({ method: 'GET', url: `/api/care/specialist/events/${ev.id}/documents/${view.documents[0].id}`, headers: { cookie: sp.cookie } });
    expect(file.statusCode).toBe(200);
    expect(file.headers['cache-control']).toContain('no-store');
    // orientação: especialista designada envia; paciente confirma
    expect((await sp.post(`/api/care/requests/${req.id}/guidance`, { text: 'Gaze estéril, soro 0,9%, luvas. Links: farmácia do bairro.' })).status).toBe(200);
    expect((await one<any>('SELECT guidance_status FROM care_requests WHERE id = ?', req.id)).guidance_status).toBe('ENVIADA');
    const naoDesignada = new Client(app); await naoDesignada.login(emailOf('especialista'));
    expect((await naoDesignada.post(`/api/care/requests/${req.id}/guidance`, { text: 'Tentativa de quem não foi designada.' })).status).toBe(403);
    expect((await c.post(`/api/care/requests/${req.id}/materials-confirmed`)).status).toBe(200);
    // depois do pedido gerado o anexo não é removido
    expect((await c.req('DELETE', `/api/care/requests/${req.id}/documents/${docs[0].id}`)).body.error.code).toBe('REQUEST_LOCKED');
  });

  it('orçamento vence em 3 dias: nova versão com o preço atual e novo aceite', async () => {
    const c = new Client(app); await c.login(emailOf('paciente'));
    const req = (await c.post('/api/care/requests', form({ address: ADDR }), true)).body.request;
    expect(new Date(req.quoteExpiresAt).getTime() - new Date(req.quoteIssuedAt).getTime()).toBe(3 * 86400000);
    await run(`UPDATE care_requests SET quote_issued_at = ? WHERE id = ?`, new Date(Date.now() - 4 * 86400000).toISOString(), req.id);
    expect((await c.post(`/api/care/requests/${req.id}/accept`, { quoteVersion: 1 })).body.error.code).toBe('QUOTE_EXPIRED');
    const r2 = (await c.get(`/api/care/requests/${req.id}`)).body.request;
    expect(r2.quoteVersion).toBe(2);
    expect((await c.post(`/api/care/requests/${req.id}/accept`, { quoteVersion: 2 })).status).toBe(200);
  });

  it('painel: indisponível pausa ofertas e bloqueia aceite; preferências independentes', async () => {
    const c = new Client(app); await c.login(emailOf('paciente'));
    const req = (await c.post('/api/care/requests', form({ address: ADDR }), true)).body.request;
    await c.post(`/api/care/requests/${req.id}/accept`, { quoteVersion: 1 });
    await c.post(`/api/care/requests/${req.id}/checkout`, { quoteVersion: 1, paymentMethod: 'SANDBOX_APROVADO', expectedTotalCents: req.quote.totalCents }, true);
    const sp = new Client(app); await sp.login(emailOf('especialistaOne'));
    const panel = (await sp.get('/api/care/specialist/panel')).body;
    expect(panel).toMatchObject({ status: 'ATIVO_APTO', preferences: { available: true, soundAlerts: true, whatsappAlerts: false } });
    const ev = (await sp.get('/api/care/specialist/offers')).body.offers[0];
    expect((await sp.put('/api/care/specialist/preferences', { available: false })).body.preferences).toMatchObject({ available: false, soundAlerts: true });
    expect((await sp.get('/api/care/specialist/offers')).body).toMatchObject({ offers: [], available: false });
    expect((await sp.post(`/api/care/specialist/events/${ev.id}/accept`)).body.error.code).toBe('SPECIALIST_UNAVAILABLE');
    expect((await sp.put('/api/care/specialist/preferences', { soundAlerts: false })).body.preferences).toMatchObject({ available: false, soundAlerts: false });
    await sp.put('/api/care/specialist/preferences', { available: true });
    expect((await sp.post(`/api/care/specialist/events/${ev.id}/accept`)).status).toBe(200);
  });
});
