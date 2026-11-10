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
    patientName: 'Paciente Fictício', phone: '(11) 99999-0000', location: 'Vila Mariana', whenPref: 'PROXIMOS_DIAS', whenDate: null, notes: '', forSelf: true, responsibleAuthorized: false };
  const req = (await c.post('/api/care/requests', form, true)).body.request;
  await c.post(`/api/care/requests/${req.id}/accept`, { quoteVersion: req.quoteVersion });
  await c.post(`/api/care/requests/${req.id}/checkout`, { quoteVersion: req.quoteVersion, paymentMethod: 'SANDBOX_APROVADO', expectedTotalCents: req.quote.totalCents }, true);
  const sp = new Client(app); await sp.login(emailOf('especialistaOne'));
  const ev = (await sp.get('/api/care/specialist/offers')).body.offers[0];
  await sp.post(`/api/care/specialist/events/${ev.id}/accept`);
  return { c, sp, eventId: ev.id as string };
}

describe('Biblioteca de POPs v1.0', () => {
  it('65 PDFs íntegros, bloqueados até a liberação do RT; acesso só RT e ONEMA ONE credenciada; vínculo ao atendimento na Carteira', async () => {
    expect((await loadPops({ force: true })).inserted).toBe(65);
    expect((await loadPops({ force: true })).inserted).toBe(0);
    const { c, sp, eventId } = await acceptedCurativo();
    // antes da liberação: especialista não vê nada; paciente e outros perfis não acessam
    expect((await sp.get('/api/pops')).body.pops).toHaveLength(0);
    expect((await sp.get('/api/pops/ONEMA-POP-018/pdf')).status).toBe(404);
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
    expect((await sp.get('/api/pops')).body.pops).toHaveLength(65);
    // candidatos do curativo simples; escolha exige justificativa
    const cand = (await sp.get(`/api/care/specialist/events/${eventId}/pops`)).body.candidates.map((p: any) => p.code);
    expect(cand).toEqual(expect.arrayContaining(['ONEMA-POP-017', 'ONEMA-POP-018']));
    expect((await sp.post(`/api/care/specialist/events/${eventId}/pops`, { code: 'ONEMA-POP-018', reason: 'curto' })).status).toBe(400);
    expect((await sp.post(`/api/care/specialist/events/${eventId}/pops`, { code: 'ONEMA-POP-018', reason: 'Ferida em calcâneo avaliada; POP de curativo como referência.' })).status).toBe(200);
    expect((await sp.post(`/api/care/specialist/events/${eventId}/pops`, { code: 'ONEMA-POP-018', reason: 'Repetido por engano no atendimento.' })).status).toBe(409);
    // outra especialista não vincula ao atendimento alheio
    expect((await naoCred.post(`/api/care/specialist/events/${eventId}/pops`, { code: 'ONEMA-POP-018', reason: 'Tentativa indevida de vínculo.' })).status).toBe(404);
    const wallet = (await c.get('/api/care/wallet')).body;
    expect(wallet.pops[0]).toMatchObject({ code: 'ONEMA-POP-018', version: '1.0' });
    // versões e vínculos imutáveis
    await expect(run(`UPDATE pop_documents SET title = 'x' WHERE code = 'ONEMA-POP-018'`)).rejects.toThrow(/immutable/);
    await expect(run('DELETE FROM care_event_pops')).rejects.toThrow(/append-only/);
    // suspenso: some da lista, mas a versão vinculada continua acessível a quem a usou
    await rt.post('/api/admin/pops/status', { codes: ['ONEMA-POP-018'], status: 'SUSPENSO', note: 'Revisão de conteúdo pelo RT.' });
    expect((await sp.get('/api/pops')).body.pops.map((p: any) => p.code)).not.toContain('ONEMA-POP-018');
    expect((await sp.get('/api/pops/ONEMA-POP-018/pdf')).status).toBe(200);
    expect((await one<any>(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'POP_VIEWED'`)).n).toBeGreaterThan(0);
  });
});
