/** Carteira Digital — plano de cuidados e motor de alertas (critérios de aceite da especificação v1.0). */
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, all, emailOf, idOf, loginAs, one, run, setup } from './helpers.ts';
import { PRICING_V1 } from '../src/db/content/pricing-v1.ts';
import { runCarteiraAlerts } from '../src/modules/carteira/engine.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });
const NEED_OF = Object.fromEntries(PRICING_V1.map((d) => [d.code, d.need]));
const ADDR = { cep: '04101-000', street: 'Rua Fictícia', number: '100', complement: '', district: 'Vila Mariana', city: 'São Paulo', reference: '' };
const H = 3600_000;

/** Atendimento aceito pela especialista com evolução assinada (instrução profissional validada). */
async function signedVisit() {
  const c = new Client(app); await c.login(emailOf('paciente'));
  const req = (await c.post('/api/care/requests', { need: NEED_OF['CAT-03'], itemCode: 'CAT-03', infoText: '', materials: 'NAO', materialsDetail: '', materialsSupplyRequested: false,
    patientName: 'Paciente Fictício', phone: '(11) 99999-0000', location: 'Vila Mariana', whenPref: 'HOJE', whenDate: null, notes: '', forSelf: true, responsibleAuthorized: false,
    timeWindow: 'TARDE', patientBirthDate: '1950-05-10', address: ADDR }, true)).body.request;
  await c.post(`/api/care/requests/${req.id}/accept`, { quoteVersion: 1 });
  await c.post(`/api/care/requests/${req.id}/checkout`, { quoteVersion: 1, paymentMethod: 'SANDBOX_APROVADO', expectedTotalCents: req.quote.totalCents }, true);
  const sp = new Client(app); await sp.login(emailOf('especialistaOne'));
  const ev = (await sp.get('/api/care/specialist/offers')).body.offers[0];
  await sp.post(`/api/care/specialist/events/${ev.id}/accept`);
  return { patient: c, sp, eventId: ev.id as string };
}
async function signEvolution(eventId: string) {
  const e = await one<any>('SELECT e.order_id, e.specialist_id, o.patient_id FROM care_events e JOIN service_orders o ON o.id = e.order_id WHERE e.id = ?', eventId);
  const now = new Date().toISOString();
  await run(`INSERT INTO care_evolutions (id, event_id, order_id, patient_id, specialist_id, dictation, content_json, status, signed_at, created_at, updated_at)
    VALUES (gen_random_uuid()::text, ?, ?, ?, ?, '', '{}', 'ASSINADA', ?, ?, ?)`, eventId, e.order_id, e.patient_id, e.specialist_id, now, now, now);
}

const UNTIL = () => new Date(Date.now() + 30 * 24 * H).toISOString();

describe('Carteira Digital: plano e alertas', () => {
  it('plano só a partir de evolução assinada; lembrete disponibilizado; resumo sem dado clínico; Ciente único; próxima pela agenda', async () => {
    const { patient, sp, eventId } = await signedVisit();
    const due = new Date(Date.now() - 60_000).toISOString();
    const item = { title: 'Troca do curativo', instructions: 'Trocar o curativo e manter o local seco.', dueAt: due, recurrenceDays: 2, remindersUntil: UNTIL() };
    expect((await sp.post(`/api/carteira/events/${eventId}/plan`, { items: [item] })).body.error.code).toBe('EVOLUTION_REQUIRED');
    await signEvolution(eventId);
    // término/revisão obrigatório
    expect((await sp.post(`/api/carteira/events/${eventId}/plan`, { items: [{ ...item, remindersUntil: undefined }] })).status).toBe(400);
    const created = (await sp.post(`/api/carteira/events/${eventId}/plan`, { items: [item] })).body;
    expect(created.items).toHaveLength(1);
    expect(created.message).toBe('Programação salva. Os avisos respeitarão as preferências do paciente e serão interrompidos na data definida.');
    const outra = new Client(app); await outra.login(emailOf('especialista'));
    expect((await outra.post(`/api/carteira/events/${eventId}/plan`, { items: [item] })).status).toBe(404);
    const r1 = await runCarteiraAlerts();
    expect(r1).toMatchObject({ reminders: 1, released: 1 });
    expect((await runCarteiraAlerts()).reminders).toBe(0); // deduplicado
    const plan = (await patient.get('/api/carteira/plan')).body;
    expect(plan.latest).toMatchObject({ title: 'Troca do curativo', status: 'ATIVO', occurrenceText: 'Disponibilizado | aguardando ciência' });
    expect(plan.alerts[0]).toMatchObject({ status: 'PENDENTE', category: 'LEMBRETE' });
    // falha do canal push: alerta continua pendente e abre pendência técnica única
    const ev = await all<any>('SELECT action, channel FROM care_alert_events WHERE alert_id = ? ORDER BY created_at', plan.alerts[0].id);
    expect(ev.map((e) => `${e.action}:${e.channel ?? ''}`)).toEqual(['CRIADO:', 'ENTREGUE:CARTEIRA', 'FALHA_CANAL:PUSH']);
    expect((await all<any>(`SELECT * FROM care_alerts WHERE category = 'TECNICO'`))).toHaveLength(1);
    // um resumo por dia, sem dado clínico
    const n = await all<any>(`SELECT body FROM notifications WHERE user_id = ? AND title = 'Lembretes do seu plano de cuidados'`, await idOf('paciente'));
    expect(n).toHaveLength(1);
    expect(n[0].body).not.toMatch(/curativo/i);
    // "Ciente" em duas abas: uma ciência; próxima ocorrência calculada pela agenda (horário original)
    const [a1, a2] = await Promise.all([patient.post(`/api/carteira/plan/${plan.latest.id}/ack`, {}), patient.post(`/api/carteira/plan/${plan.latest.id}/ack`, {})]);
    expect([a1.status, a2.status]).toEqual([200, 200]);
    expect((await one<any>(`SELECT COUNT(*)::int AS n FROM care_plan_reminder_events WHERE kind = 'CIENTE'`)).n).toBe(1);
    expect(new Date(a1.body.next.nextAt).getTime()).toBe(new Date(due).getTime() + 2 * 24 * H);
    const after = (await patient.get('/api/carteira/plan')).body;
    expect(after.latest).toMatchObject({ status: 'CIENTE', occurrenceText: 'Ciente registrado' });
    expect(after.latest.series.nextAt).toBe(a1.body.next.nextAt);
    expect(after.alerts[0].status).toBe('RESOLVIDO');
    // paciente B não vê nada do paciente A
    const b = new Client(app); await b.login(emailOf('responsavel'));
    expect((await b.get('/api/carteira/plan')).body).toMatchObject({ items: [], alerts: [] });
    expect((await b.post(`/api/carteira/plan/${plan.latest.id}/ack`, {})).status).toBe(404);
    expect((await b.put(`/api/carteira/series/${plan.latest.seriesId}/prefs`, { mode: 'DESATIVADO' })).status).toBe(404);
  });

  it('preferências: espaçar (≥ original), pausar, desativar e reativar; histórico com 50 ocorrências e só o último lembrete na Carteira', async () => {
    const { patient, sp, eventId } = await signedVisit();
    await signEvolution(eventId);
    const base = Date.now() - 60 * 24 * H;
    await sp.post(`/api/carteira/events/${eventId}/plan`, { items: [{ title: 'Caminhada e Exercícios', instructions: 'Caminhar 20 minutos.', dueAt: new Date(base).toISOString(), recurrenceDays: 1,
      remindersUntil: new Date(Date.now() + 90 * 24 * H).toISOString() }] });
    const seriesId = (await one<any>('SELECT series_id FROM care_plan_items LIMIT 1')).series_id;
    // 50 ocorrências passadas já disponibilizadas
    for (let k = 1; k <= 50; k++) {
      await run(`INSERT INTO care_plan_items (id, patient_id, created_by, source_event_id, previous_item_id, series_id, title, instructions, due_at, recurrence_days, status, released_at, created_at, updated_at)
        SELECT gen_random_uuid()::text, patient_id, created_by, source_event_id, NULL, series_id, title, instructions, ?, 1, 'EXPIRADO', ?, ?, ? FROM care_plan_items WHERE id = ?`,
        new Date(base + k * 24 * H).toISOString(), new Date(base + k * 24 * H).toISOString(), new Date().toISOString(), new Date().toISOString(), seriesId);
    }
    await runCarteiraAlerts();
    const plan = (await patient.get('/api/carteira/plan')).body;
    expect(plan.latest.title).toBe('Caminhada e Exercícios');
    expect(plan.series).toHaveLength(1);
    const h1 = (await patient.get('/api/carteira/reminders/history?days=365')).body;
    expect(h1.items).toHaveLength(10); expect(h1.hasMore).toBe(true);
    expect(h1.items[0].at >= h1.items[9].at).toBe(true);
    expect((await patient.get(`/api/carteira/reminders/history?days=365&page=6&seriesId=${seriesId}`)).body.items.length).toBeGreaterThan(0);
    // espaçar: menor que o original recusado; 5 dias aceito
    expect((await patient.put(`/api/carteira/series/${seriesId}/prefs`, { mode: 'ESPACADO', intervalDays: 7 })).body.error.code).toBe('INVALID_INTERVAL');
    const sp5 = (await patient.put(`/api/carteira/series/${seriesId}/prefs`, { mode: 'ESPACADO', intervalDays: 5 })).body;
    expect(sp5.state.flag).toMatchObject({ code: 'ESPACADO', text: 'Avisos a cada 5 dias' });
    expect(sp5.next.nextAt).toBeTruthy();
    // pausar até uma data
    const until = new Date(Date.now() + 10 * 24 * H).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const pz = (await patient.put(`/api/carteira/series/${seriesId}/prefs`, { mode: 'PAUSADO', pausedUntil: until })).body;
    expect(pz.state.flag.code).toBe('PAUSADO');
    expect(new Date(pz.next.nextAt).getTime()).toBeGreaterThanOrEqual(new Date(`${until}T00:00:00-03:00`).getTime());
    // desativar: sem próximo aviso; edição clínica não reativa
    const off = (await patient.put(`/api/carteira/series/${seriesId}/prefs`, { mode: 'DESATIVADO' })).body;
    expect(off.next).toMatchObject({ nextAt: null, reason: 'Avisos desativados por você.' });
    expect((await sp.put(`/api/carteira/series/${seriesId}/schedule`, { remindersUntil: new Date(Date.now() + 100 * 24 * H).toISOString(), untilKind: 'REVISAO' })).body.state.flag.code).toBe('DESATIVADO');
    // reativar
    expect((await patient.put(`/api/carteira/series/${seriesId}/prefs`, { mode: 'ATIVO' })).body.next.nextAt).toBeTruthy();
    // pedido de revisão: pendência para a Enfermagem, não encerra a orientação
    const rv = (await patient.post(`/api/carteira/series/${seriesId}/review-request`, {})).body;
    expect(rv.message).toBe('Seu pedido ficará disponível para revisão da Enfermagem. Isso não encerra automaticamente sua orientação.');
    expect((await patient.post(`/api/carteira/series/${seriesId}/review-request`, {})).body.already).toBe(true);
    const rt = await loginAs(app, 'rt');
    const reviews = (await rt.get('/api/admin/carteira/reviews')).body.reviews;
    expect(reviews.map((r: any) => r.kind)).toContain('PEDIDO_PACIENTE');
    expect((await one<any>('SELECT status FROM care_plan_items WHERE series_id = ? ORDER BY due_at DESC LIMIT 1', seriesId)).status).toBe('ATIVO');
  });

  it('ação de agendar: "Já agendei" encerra os avisos de agendar; "Preciso de ajuda" abre pendência; atraso de agendar vira pendência do enfermeiro', async () => {
    const { patient, sp, eventId } = await signedVisit();
    await signEvolution(eventId);
    await sp.post(`/api/carteira/events/${eventId}/plan`, { items: [{ title: 'Agendar visita para medicação', instructions: 'Agendar com antecedência.', kind: 'AGENDAR',
      dueAt: new Date(Date.now() - 30 * H).toISOString(), recurrenceDays: 3, remindersUntil: UNTIL() }] });
    const r = await runCarteiraAlerts();
    expect(r.overdue).toBe(1);
    const mine = (await sp.get('/api/carteira/specialist/alerts')).body.alerts;
    expect(mine[0]).toMatchObject({ category: 'ADMINISTRATIVO', status: 'PENDENTE', recipient: 'ENFERMEIRO' });
    await run(`UPDATE care_alerts SET ack_due_at = ? WHERE id = ?`, new Date(Date.now() - H).toISOString(), mine[0].id);
    expect((await runCarteiraAlerts()).escalated).toBe(1);
    const rt = await loginAs(app, 'rt');
    const op = await loginAs(app, 'operador');
    const q = (await rt.get('/api/admin/carteira/alerts')).body.alerts.find((x: any) => x.id === mine[0].id);
    expect(q).toMatchObject({ recipient: 'RT', escalationLevel: 1, assignedTo: null });
    const [x, y] = await Promise.all([
      rt.post(`/api/carteira/alerts/${q.id}/transition`, { to: 'RESOLVIDO', rev: q.rev, note: 'Contato feito com o paciente.' }),
      op.post(`/api/carteira/alerts/${q.id}/transition`, { to: 'ENCERRADO', rev: q.rev, note: 'Encerrado pela operação.' }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    await expect(run(`DELETE FROM care_alert_events`)).rejects.toThrow();
    const latest = (await patient.get('/api/carteira/plan')).body.latest;
    expect((await patient.post(`/api/carteira/plan/${latest.id}/schedule-report`, { action: 'PRECISO_AJUDA' })).body.message).toMatch(/Central ONEMA vai ajudar/);
    expect((await rt.get('/api/admin/carteira/reviews')).body.reviews.map((x: any) => x.kind)).toContain('AJUDA_AGENDAR');
    expect((await patient.post(`/api/carteira/plan/${latest.id}/schedule-report`, { action: 'JA_AGENDEI' })).status).toBe(200);
    const after = (await patient.get('/api/carteira/plan')).body;
    expect(after.latest.occurrenceText).toBe('Agendamento informado por você');
    expect(after.series[0].nextAt).toBeNull();
    expect((await one<any>(`SELECT COUNT(*)::int AS n FROM care_plan_items WHERE status = 'ATIVO' AND released_at IS NULL`)).n).toBe(0);
  });

  it('regra clínica fictícia só dispara depois de completa e aprovada pelo RT', async () => {
    const { patient, sp, eventId } = await signedVisit();
    await signEvolution(eventId);
    await sp.post(`/api/carteira/events/${eventId}/plan`, { items: [
      { title: 'Como está a ferida?', instructions: 'Responda como está o local do curativo.', dueAt: new Date(Date.now() + H).toISOString(), askFollowup: true, remindersUntil: UNTIL() },
      { title: 'Como está a ferida? (2)', instructions: 'Responda de novo amanhã.', dueAt: new Date(Date.now() + 25 * H).toISOString(), askFollowup: true, remindersUntil: UNTIL() },
    ] });
    const items = (await patient.get('/api/carteira/plan')).body.items;
    expect((await patient.post(`/api/carteira/plan/${items[0].id}/done`, {})).body.error.code).toBe('FOLLOWUP_REQUIRED');
    await patient.post(`/api/carteira/plan/${items[0].id}/done`, { answer: 'PIOROU' });
    expect((await all<any>(`SELECT * FROM care_alerts WHERE category = 'CLINICO'`))).toHaveLength(0);
    const rt = await loginAs(app, 'rt');
    const rule = (await rt.get('/api/admin/carteira/rules')).body.rules.find((r: any) => r.code === 'CLI-FICT-001');
    expect(rule.gaps.length).toBeGreaterThan(0);
    expect((await rt.post('/api/admin/carteira/rules/CLI-FICT-001/1/status', { status: 'APROVADA', note: 'Tentativa sem matriz completa.' })).body.error.code).toBe('RULE_INCOMPLETE');
    const op = await loginAs(app, 'operador');
    expect((await op.post('/api/admin/carteira/rules/LEM-PLANO-001/1/status', { status: 'SUSPENSA', note: 'Operação não pode alterar regra.' })).status).toBe(403);
    await run(`UPDATE alert_rules SET substitute_role = 'OPERADOR_CENTRAL', coverage = 'Homologação', source_protocol = 'POP fictício', test_evidence = 'carteira.test.ts' WHERE code = 'CLI-FICT-001'`);
    expect((await rt.post('/api/admin/carteira/rules/CLI-FICT-001/1/status', { status: 'APROVADA', note: 'Regra fictícia aprovada para homologação.' })).status).toBe(200);
    await patient.post(`/api/carteira/plan/${items[1].id}/done`, { answer: 'PIOROU' });
    const cli = await all<any>(`SELECT * FROM care_alerts WHERE category = 'CLINICO'`);
    expect(cli).toHaveLength(1);
    expect(cli[0]).toMatchObject({ priority: 'ALTA', assigned_to: await idOf('especialistaOne') });
  });
});
