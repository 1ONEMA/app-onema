import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, emailOf, loginAs, one, run, setup } from './helpers.ts';
import { PRICING_V1 } from '../src/db/content/pricing-v1.ts';
import { loadPops } from '../src/modules/pops/routes.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });
const NEED_OF = Object.fromEntries(PRICING_V1.map((d) => [d.code, d.need]));

async function acceptedCurativo() {
  const c = new Client(app); await c.login(emailOf('paciente'));
  const form = { need: NEED_OF['CAT-02A'], itemCode: 'CAT-02A', infoText: '', materials: 'SIM', materialsDetail: '', materialsSupplyRequested: false,
    patientName: 'Paciente Fictício', phone: '(11) 99999-0000', location: 'Vila Mariana', whenPref: 'PROXIMOS_DIAS', whenDate: null, notes: '', forSelf: true, responsibleAuthorized: false, address: { cep: '04101-000', street: 'Rua Fictícia', number: '100', complement: '', district: 'Vila Mariana', city: 'São Paulo', reference: '' }, timeWindow: 'MANHA' };
  const req = (await c.post('/api/care/requests', form, true)).body.request;
  await c.post(`/api/care/requests/${req.id}/accept`, { quoteVersion: req.quoteVersion });
  await c.post(`/api/care/requests/${req.id}/checkout`, { quoteVersion: req.quoteVersion, paymentMethod: 'SANDBOX_APROVADO', expectedTotalCents: req.quote.totalCents }, true);
  const sp = new Client(app); await sp.login(emailOf('especialistaOne'));
  const ev = (await sp.get('/api/care/specialist/offers')).body.offers[0];
  await sp.post(`/api/care/specialist/events/${ev.id}/accept`);
  return { c, sp, eventId: ev.id as string };
}

describe('Biblioteca de POPs v1.0', () => {
  it('65 PDFs íntegros, bloqueados até a liberação do RT; RT com acesso integral; vínculo ao atendimento na Carteira', async () => {
    expect((await loadPops({ force: true })).inserted).toBe(65);
    expect((await loadPops({ force: true })).inserted).toBe(0);
    const { c, sp, eventId } = await acceptedCurativo();
    expect((await c.get('/api/pops')).status).toBe(403);
    const naoCred = new Client(app); await naoCred.login(emailOf('especialista2'));
    expect((await naoCred.get('/api/pops')).body.error.code).toBe('NOT_CREDENTIALED');
    const rt = await loginAs(app, 'rt');
    expect((await rt.get('/api/pops')).body.pops).toHaveLength(65);
    const pdf = await app.inject({ method: 'GET', url: '/api/pops/ONEMA-POP-001/pdf', headers: { cookie: rt.cookie } });
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['cache-control']).toContain('no-store');
    expect(crypto.createHash('sha256').update(pdf.rawPayload).digest('hex')).toBe('6a82106c759caf7ebc893956118950ceaf19c81a8aefb95a0a00c28371416d4a');
    // só o RT libera, com justificativa
    const fin = await loginAs(app, 'financeiro');
    expect((await fin.post('/api/admin/pops/status', { all: true, status: 'PUBLICADO', note: 'Homologação concluída.' })).status).toBe(403);
    expect((await rt.post('/api/admin/pops/status', { all: true, status: 'PUBLICADO', note: 'curta' })).status).toBe(400);
    expect((await rt.post('/api/admin/pops/status', { all: true, status: 'PUBLICADO', note: 'Homologação técnica concluída pelo RT.' })).body.updated).toBe(65);

    // Comando do RT 21/11: especialista sem acesso permanente — aceito mas não iniciado: nada liberado (inclusive abertura direta)
    expect((await sp.get('/api/pops')).body.pops).toHaveLength(0);
    expect((await sp.get('/api/pops/ONEMA-POP-018/pdf')).body.error.code).toBe('POP_OUT_OF_SCOPE');
    expect((await sp.get(`/api/care/specialist/events/${eventId}/pops`)).body).toMatchObject({ active: false, candidates: [] });
    // check-in (código do paciente): POPs sugeridos do serviço liberados só para este atendimento
    const ev = await one<any>('SELECT visit_code FROM care_events WHERE id = ?', eventId);
    expect((await sp.post(`/api/care/specialist/events/${eventId}/start`, { code: ev.visit_code })).status).toBe(200);
    const cand = (await sp.get(`/api/care/specialist/events/${eventId}/pops`)).body.candidates.map((p: any) => p.code);
    expect(cand).toEqual(expect.arrayContaining(['ONEMA-POP-017', 'ONEMA-POP-018']));
    expect((await sp.get('/api/pops')).body.pops.map((p: any) => p.code).sort()).toEqual([...cand].sort());
    expect((await sp.get(`/api/pops/ONEMA-POP-018/pdf?eventId=${eventId}`)).status).toBe(200);
    expect((await sp.get('/api/pops/ONEMA-POP-001/pdf')).status).toBe(403); // fora do serviço
    const viewed = await one<any>(`SELECT meta_json FROM audit_events WHERE action = 'POP_VIEWED' ORDER BY seq DESC LIMIT 1`);
    expect(JSON.parse(viewed.meta_json)).toMatchObject({ code: 'ONEMA-POP-018', version: '1.0', eventId });
    // escolha exige justificativa
    expect((await sp.post(`/api/care/specialist/events/${eventId}/pops`, { code: 'ONEMA-POP-018', reason: 'curto' })).status).toBe(400);
    expect((await sp.post(`/api/care/specialist/events/${eventId}/pops`, { code: 'ONEMA-POP-018', reason: 'Ferida em calcâneo avaliada; POP de curativo como referência.' })).status).toBe(200);
    expect((await sp.post(`/api/care/specialist/events/${eventId}/pops`, { code: 'ONEMA-POP-018', reason: 'Repetido por engano no atendimento.' })).status).toBe(409);
    expect((await naoCred.post(`/api/care/specialist/events/${eventId}/pops`, { code: 'ONEMA-POP-018', reason: 'Tentativa indevida de vínculo.' })).status).toBe(404);
    const wallet = (await c.get('/api/care/wallet')).body;
    expect(wallet.pops[0]).toMatchObject({ code: 'ONEMA-POP-018', version: '1.0' });
    // versões e vínculos imutáveis
    await expect(run(`UPDATE pop_documents SET title = 'x' WHERE code = 'ONEMA-POP-018'`)).rejects.toThrow(/immutable/);
    await expect(run('DELETE FROM care_event_pops')).rejects.toThrow(/append-only/);
    // conclusão/cancelamento: acesso revogado; registro da consulta preservado
    await run(`UPDATE care_events SET status = 'CONCLUIDO' WHERE id = ?`, eventId);
    expect((await sp.get('/api/pops')).body.pops).toHaveLength(0);
    expect((await sp.get(`/api/pops/ONEMA-POP-018/pdf?eventId=${eventId}`)).status).toBe(403);
    expect((await sp.get(`/api/care/specialist/events/${eventId}/pops`)).body).toMatchObject({ active: false });
    expect((await one<any>(`SELECT COUNT(*)::int AS n FROM audit_events WHERE action = 'POP_VIEWED'`)).n).toBeGreaterThan(0);
    expect((await rt.get('/api/pops')).body.pops).toHaveLength(65);
  });

  it('serviço sem POP associado: sinaliza e encaminha ao RT uma vez, sem escolher documento', async () => {
    await loadPops({ force: true });
    const rt = await loginAs(app, 'rt');
    await rt.post('/api/admin/pops/status', { all: true, status: 'PUBLICADO', note: 'Homologação técnica concluída pelo RT.' });
    const c = new Client(app); await c.login(emailOf('paciente'));
    const form = { need: NEED_OF['CAT-03'], itemCode: 'CAT-03', infoText: '', materials: 'SIM', materialsDetail: '', materialsSupplyRequested: false,
      patientName: 'Paciente Fictício', phone: '(11) 99999-0000', location: 'Vila Mariana', whenPref: 'PROXIMOS_DIAS', whenDate: null, notes: '', forSelf: true, responsibleAuthorized: false,
      address: { cep: '04101-000', street: 'Rua Fictícia', number: '100', complement: '', district: 'Vila Mariana', city: 'São Paulo', reference: '' }, timeWindow: 'MANHA' };
    const req = (await c.post('/api/care/requests', form, true)).body.request;
    await c.post(`/api/care/requests/${req.id}/accept`, { quoteVersion: req.quoteVersion });
    await c.post(`/api/care/requests/${req.id}/checkout`, { quoteVersion: req.quoteVersion, paymentMethod: 'SANDBOX_APROVADO', expectedTotalCents: req.quote.totalCents }, true);
    const sp = new Client(app); await sp.login(emailOf('especialistaOne'));
    const id = (await sp.get('/api/care/specialist/offers')).body.offers[0].id;
    await sp.post(`/api/care/specialist/events/${id}/accept`);
    const ev = await one<any>('SELECT visit_code FROM care_events WHERE id = ?', id);
    await sp.post(`/api/care/specialist/events/${id}/start`, { code: ev.visit_code });
    const r = (await sp.get(`/api/care/specialist/events/${id}/pops`)).body;
    expect(r).toMatchObject({ active: true, noMapping: true, candidates: [] });
    await sp.get(`/api/care/specialist/events/${id}/pops`);
    expect((await one<any>(`SELECT COUNT(*)::int AS n FROM audit_events WHERE action = 'POP_MAPPING_MISSING'`)).n).toBe(1);
    expect((await one<any>(`SELECT COUNT(*)::int AS n FROM notifications n JOIN user_roles r ON r.user_id = n.user_id WHERE r.role = 'AVALIADOR_RT' AND n.title = 'Serviço sem POP vinculado'`)).n).toBeGreaterThan(0);
  });
});
