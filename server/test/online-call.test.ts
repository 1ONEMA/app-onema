/** Atendimento online do catálogo pela sala da Telenfermagem: horário, link por e-mail, 30 minutos, acesso restrito. */
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, all, emailOf, idOf, one, run, setup } from './helpers.ts';
import { PRICING_V1 } from '../src/db/content/pricing-v1.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });
const NEED_OF = Object.fromEntries(PRICING_V1.map((d) => [d.code, d.need]));

async function onlineEvent() {
  const c = new Client(app); await c.login(emailOf('paciente'));
  const req = (await c.post('/api/care/requests', { need: NEED_OF['CONT-01'], itemCode: 'CONT-01', infoText: '', materials: 'NAO', materialsDetail: '', materialsSupplyRequested: false,
    patientName: 'Paciente Fictício', phone: '(11) 99999-0000', location: 'Vila Mariana', whenPref: 'HOJE', whenDate: null, notes: '', forSelf: true, responsibleAuthorized: false,
    timeWindow: 'TARDE', patientBirthDate: '1950-05-10' }, true)).body.request;
  expect((await c.post(`/api/care/requests/${req.id}/accept`, { quoteVersion: 1 })).status).toBe(200); // remoto: sem endereço
  await c.post(`/api/care/requests/${req.id}/checkout`, { quoteVersion: 1, paymentMethod: 'SANDBOX_APROVADO', expectedTotalCents: req.quote.totalCents }, true);
  const sp = new Client(app); await sp.login(emailOf('especialistaOne'));
  const ev = (await sp.get('/api/care/specialist/offers')).body.offers.find((o: any) => o.modality === 'REMOTO');
  await sp.post(`/api/care/specialist/events/${ev.id}/accept`);
  return { patient: c, sp, eventId: ev.id as string, requestId: req.id as string };
}

describe('Atendimento online (catálogo) na sala da Telenfermagem', () => {
  it('horário combinado com link por e-mail; sala só para paciente e enfermeira; 30 minutos a partir da entrada da enfermeira', async () => {
    const { patient, sp, eventId, requestId } = await onlineEvent();
    expect((await patient.post(`/api/care/events/${eventId}/call`)).body.error.code).toBe('CALL_NOT_SCHEDULED');
    const start = new Date(Date.now() + 10 * 60_000).toISOString();
    expect((await sp.post(`/api/care/specialist/events/${eventId}/call-schedule`, { startAt: start })).status).toBe(200);
    // e-mail com link para os dois lados (sem provedor no teste: registrado, sem conteúdo clínico)
    const out = await all<any>(`SELECT recipient_user_id, template, payload_json FROM outbox_messages WHERE template = 'ONLINE_AGENDADO'`);
    expect(out.map((o) => o.recipient_user_id).sort()).toEqual([await idOf('paciente'), await idOf('especialistaOne')].sort());
    expect(out.map((o) => JSON.parse(o.payload_json).path).sort()).toEqual([`/especialista/atendimentos/${eventId}`, `/solicitacoes/${requestId}`].sort());
    // outra pessoa não entra
    const outro = new Client(app); await outro.login(emailOf('responsavel'));
    expect((await outro.post(`/api/care/events/${eventId}/call`)).status).toBe(404);
    // paciente entra antes: sala aguarda; fim = horário + 30 min
    const p1 = (await patient.post(`/api/care/events/${eventId}/call`)).body;
    expect(p1.video).toMatchObject({ provider: 'SIMULADO', maxMinutes: 30 });
    expect(Math.round((new Date(p1.video.endsAt).getTime() - new Date(start).getTime()) / 60000)).toBe(30);
    // enfermeira entra: começa o atendimento e o relógio de 30 minutos
    const s1 = (await sp.post(`/api/care/events/${eventId}/call`)).body;
    expect(s1.startedAt).toBeTruthy();
    expect(Math.round((new Date(s1.video.endsAt).getTime() - Date.now()) / 60000)).toBe(30);
    // passou de 30 minutos: sala não reabre
    await run(`UPDATE care_events SET call_started_at = ? WHERE id = ?`, new Date(Date.now() - 31 * 60_000).toISOString(), eventId);
    expect((await patient.post(`/api/care/events/${eventId}/call`)).body.error.code).toBe('CALL_TIME_OVER');
    expect((await sp.post(`/api/care/specialist/events/${eventId}/call-end`)).status).toBe(200);
    expect((await one<any>('SELECT call_ended_at, started_at FROM care_events WHERE id = ?', eventId))).toMatchObject({ call_ended_at: expect.any(String), started_at: expect.any(String) });
    expect((await patient.post(`/api/care/events/${eventId}/call`)).body.error.code).toBe('CALL_ENDED');
  });

  it('homologação: paciente real (fora de @exemplo.test) não usa a sala de vídeo', async () => {
    const { sp, eventId } = await onlineEvent();
    await run(`UPDATE users SET email = 'pessoa.real@gmail.com' WHERE email = ?`, emailOf('paciente'));
    expect((await sp.post(`/api/care/specialist/events/${eventId}/call-schedule`, { startAt: new Date(Date.now() + 600_000).toISOString() })).body.error.code).toBe('TELE_HOMOLOGATION_ONLY');
  });
});
