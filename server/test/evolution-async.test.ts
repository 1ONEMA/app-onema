import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, emailOf, one, setup } from './helpers.ts';
import { PRICING_V1 } from '../src/db/content/pricing-v1.ts';

// IA simulada: responde a evolução organizada ou um motivo de falha, conforme o ditado.
vi.mock('../src/modules/care/evolution-ai.ts', async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    evolutionAiEnabled: () => true,
    organizeDictation: vi.fn(async (dictation: string) => (dictation.includes('SEMCREDITO')
      ? { failure: 'SEM_CREDITO' }
      : { evolution: { ...real.EMPTY_EVOLUTION, relato: 'Paciente refere melhora da dor.', procedimentos: 'Realizado curativo simples.', pendencias: ['Sinais vitais'] } })),
  };
});

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });

async function startedVisit() {
  const NEED_OF = Object.fromEntries(PRICING_V1.map((d) => [d.code, d.need]));
  const c = new Client(app); await c.login(emailOf('paciente'));
  const form = { need: NEED_OF['CAT-02A'], itemCode: 'CAT-02A', infoText: '', materials: 'SIM', materialsDetail: '', materialsSupplyRequested: false,
    patientName: 'Paciente Fictício', phone: '(11) 99999-0000', location: 'Vila Mariana', whenPref: 'PROXIMOS_DIAS', whenDate: null, notes: '', forSelf: true, responsibleAuthorized: false };
  const req = (await c.post('/api/care/requests', form, true)).body.request;
  await c.post(`/api/care/requests/${req.id}/accept`, { quoteVersion: req.quoteVersion });
  await c.post(`/api/care/requests/${req.id}/checkout`, { quoteVersion: req.quoteVersion, paymentMethod: 'SANDBOX_APROVADO', expectedTotalCents: req.quote.totalCents }, true);
  const sp = new Client(app); await sp.login(emailOf('especialistaOne'));
  const ev = (await sp.get('/api/care/specialist/offers')).body.offers.find((o: any) => o.modality === 'PRESENCIAL');
  await sp.post(`/api/care/specialist/events/${ev.id}/accept`);
  const code = (await one<any>('SELECT visit_code FROM care_events WHERE id = ?', ev.id)).visit_code;
  await sp.post(`/api/care/specialist/events/${ev.id}/start`, { code });
  return { sp, eventId: ev.id as string };
}
async function waitAi(sp: Client, id: string) {
  for (let i = 0; i < 50; i++) {
    const e = (await sp.get(`/api/care/specialist/events/${id}/evolution`)).body.evolution;
    if (e.aiStatus !== 'PROCESSANDO') return e;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('IA não terminou');
}

describe('Kary organiza a evolução em segundo plano', () => {
  it('responde 202, organiza e a tela recebe o resultado; falha mostra o motivo e preserva o ditado', async () => {
    const { sp, eventId } = await startedVisit();
    const r = await sp.post(`/api/care/specialist/events/${eventId}/evolution/organize`, { dictation: 'Paciente refere melhora da dor. Realizado curativo simples.' });
    expect(r.status).toBe(202);
    const ok = await waitAi(sp, eventId);
    expect(ok).toMatchObject({ aiStatus: 'OK', aiUsed: true, content: { relato: 'Paciente refere melhora da dor.', pendencias: ['Sinais vitais'] } });
    const r2 = await sp.post(`/api/care/specialist/events/${eventId}/evolution/organize`, { dictation: 'SEMCREDITO ditado de teste com tamanho suficiente.' });
    expect(r2.status).toBe(202);
    const fail = await waitAi(sp, eventId);
    expect(fail.aiStatus).toBe('FALHOU');
    expect(fail.aiMessage).toMatch(/sem créditos/);
    expect(fail.content.relato).toBe('Paciente refere melhora da dor.'); // não apaga o que já estava organizado
  });
});
