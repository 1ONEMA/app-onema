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

describe('Carteira Digital: plano e alertas', () => {
  it('plano só a partir de evolução assinada; lembrete único; falha de push não encerra; confirmação resolve; recorrência', async () => {
    const { patient, sp, eventId } = await signedVisit();
    const item = { title: 'Troca do curativo', instructions: 'Trocar o curativo e manter o local seco.', dueAt: new Date(Date.now() + 2 * H).toISOString(), recurrenceDays: 2 };
    expect((await sp.post(`/api/carteira/events/${eventId}/plan`, { items: [item] })).body.error.code).toBe('EVOLUTION_REQUIRED');
    await signEvolution(eventId);
    expect((await sp.post(`/api/carteira/events/${eventId}/plan`, { items: [item] })).body.items).toHaveLength(1);
    // outra especialista não cria plano no atendimento
    const outra = new Client(app); await outra.login(emailOf('especialista'));
    expect((await outra.post(`/api/carteira/events/${eventId}/plan`, { items: [item] })).status).toBe(404);
    const r1 = await runCarteiraAlerts();
    expect(r1.reminders).toBe(1);
    expect((await runCarteiraAlerts()).reminders).toBe(0); // deduplicado
    const plan = (await patient.get('/api/carteira/plan')).body;
    expect(plan.items[0]).toMatchObject({ title: 'Troca do curativo', status: 'ATIVO' });
    expect(plan.alerts).toHaveLength(1);
    expect(plan.alerts[0]).toMatchObject({ status: 'PENDENTE', category: 'LEMBRETE' });
    // falha do canal push: alerta continua pendente (entrega ≠ leitura) e abre pendência técnica única
    const ev = await all<any>('SELECT action, channel FROM care_alert_events WHERE alert_id = ? ORDER BY created_at', plan.alerts[0].id);
    expect(ev.map((e) => `${e.action}:${e.channel ?? ''}`)).toEqual(['CRIADO:', 'ENTREGUE:CARTEIRA', 'FALHA_CANAL:PUSH']);
    expect((await all<any>(`SELECT * FROM care_alerts WHERE category = 'TECNICO'`))).toHaveLength(1);
    // notificação sem dado clínico
    const n = await all<any>(`SELECT body FROM notifications WHERE user_id = ? AND title = 'Cuidado programado'`, await idOf('paciente'));
    expect(n[0].body).not.toMatch(/curativo/i);
    // paciente reconhece (leitura humana) com a revisão atual; revisão antiga é recusada
    expect((await patient.post(`/api/carteira/alerts/${plan.alerts[0].id}/transition`, { to: 'RESOLVIDO', rev: 1, note: 'tentativa do paciente' })).status).toBe(403);
    expect((await patient.post(`/api/carteira/alerts/${plan.alerts[0].id}/transition`, { to: 'RECONHECIDO', rev: 1 })).body.alert.status).toBe('RECONHECIDO');
    expect((await patient.post(`/api/carteira/alerts/${plan.alerts[0].id}/transition`, { to: 'RECONHECIDO', rev: 1 })).status).toBe(409);
    // confirmação da tarefa resolve o lembrete e cria a próxima (recorrência)
    expect((await patient.post(`/api/carteira/plan/${plan.items[0].id}/done`, {})).status).toBe(200);
    const after = (await patient.get('/api/carteira/plan')).body;
    expect(after.items.map((i: any) => i.status).sort()).toEqual(['ATIVO', 'CONCLUIDO']);
    expect(after.alerts[0].status).toBe('RESOLVIDO');
    // paciente B não vê nada do paciente A
    const b = new Client(app); await b.login(emailOf('responsavel'));
    expect((await b.get('/api/carteira/plan')).body).toMatchObject({ items: [], alerts: [] });
    expect((await b.post(`/api/carteira/plan/${after.items.find((i: any) => i.status === 'ATIVO').id}/done`, {})).status).toBe(404);
    expect((await b.post(`/api/carteira/alerts/${plan.alerts[0].id}/transition`, { to: 'RECONHECIDO', rev: 3 })).status).toBe(404);
  });

  it('atraso vira pendência do enfermeiro; escalonamento ao RT por prazo; dois operadores não encerram o mesmo alerta', async () => {
    const { sp, eventId } = await signedVisit();
    await signEvolution(eventId);
    await sp.post(`/api/carteira/events/${eventId}/plan`, { items: [{ title: 'Medir glicemia', instructions: 'Anotar o valor medido.', dueAt: new Date(Date.now() + 60_000).toISOString() }] });
    await run(`UPDATE care_plan_items SET due_at = ?`, new Date(Date.now() - 30 * H).toISOString());
    expect((await runCarteiraAlerts()).overdue).toBe(1);
    const mine = (await sp.get('/api/carteira/specialist/alerts')).body.alerts;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ category: 'ADMINISTRATIVO', status: 'PENDENTE', recipient: 'ENFERMEIRO' });
    // prazo de ciência vencido → escalonado para o RT
    await run(`UPDATE care_alerts SET ack_due_at = ? WHERE id = ?`, new Date(Date.now() - H).toISOString(), mine[0].id);
    expect((await runCarteiraAlerts()).escalated).toBe(1);
    const rt = await loginAs(app, 'rt');
    const op = await loginAs(app, 'operador');
    const q = (await rt.get('/api/admin/carteira/alerts')).body.alerts.find((x: any) => x.id === mine[0].id);
    expect(q).toMatchObject({ recipient: 'RT', escalationLevel: 1, assignedTo: null });
    // concorrência: os dois tentam com a mesma revisão
    const [x, y] = await Promise.all([
      rt.post(`/api/carteira/alerts/${q.id}/transition`, { to: 'RESOLVIDO', rev: q.rev, note: 'Contato feito; paciente mediu e registrou.' }),
      op.post(`/api/carteira/alerts/${q.id}/transition`, { to: 'ENCERRADO', rev: q.rev, note: 'Encerrado pela operação.' }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect((await rt.post(`/api/carteira/alerts/${q.id}/transition`, { to: 'EM_TRATAMENTO', rev: q.rev + 1 })).body.error.code).toBe('ALERT_STATE');
    const trail = (await rt.get(`/api/carteira/alerts/${q.id}/events`)).body.events.map((e: any) => e.action);
    expect(trail).toEqual(expect.arrayContaining(['CRIADO', 'ENTREGUE', 'ESCALONADO']));
    await expect(run(`DELETE FROM care_alert_events`)).rejects.toThrow();
  });

  it('regra clínica fictícia só dispara depois de completa e aprovada pelo RT', async () => {
    const { patient, sp, eventId } = await signedVisit();
    await signEvolution(eventId);
    await sp.post(`/api/carteira/events/${eventId}/plan`, { items: [
      { title: 'Como está a ferida?', instructions: 'Responda como está o local do curativo.', dueAt: new Date(Date.now() + H).toISOString(), askFollowup: true },
      { title: 'Como está a ferida? (2)', instructions: 'Responda de novo amanhã.', dueAt: new Date(Date.now() + 25 * H).toISOString(), askFollowup: true },
    ] });
    const items = (await patient.get('/api/carteira/plan')).body.items;
    expect((await patient.post(`/api/carteira/plan/${items[0].id}/done`, {})).body.error.code).toBe('FOLLOWUP_REQUIRED');
    await patient.post(`/api/carteira/plan/${items[0].id}/done`, { answer: 'PIOROU' });
    expect((await all<any>(`SELECT * FROM care_alerts WHERE category = 'CLINICO'`))).toHaveLength(0); // regra em rascunho
    const rt = await loginAs(app, 'rt');
    const rule = (await rt.get('/api/admin/carteira/rules')).body.rules.find((r: any) => r.code === 'CLI-FICT-001');
    expect(rule.gaps.length).toBeGreaterThan(0);
    expect((await rt.post('/api/admin/carteira/rules/CLI-FICT-001/1/status', { status: 'APROVADA', note: 'Tentativa sem matriz completa.' })).body.error.code).toBe('RULE_INCOMPLETE');
    const op = await loginAs(app, 'operador');
    expect((await op.post('/api/admin/carteira/rules/LEM-PLANO-001/1/status', { status: 'SUSPENSA', note: 'Operação não pode alterar regra.' })).status).toBe(403);
    // completa a matriz (homologação) e aprova
    await run(`UPDATE alert_rules SET substitute_role = 'OPERADOR_CENTRAL', coverage = 'Homologação', source_protocol = 'POP fictício', test_evidence = 'carteira.test.ts' WHERE code = 'CLI-FICT-001'`);
    expect((await rt.post('/api/admin/carteira/rules/CLI-FICT-001/1/status', { status: 'APROVADA', note: 'Regra fictícia aprovada para homologação.' })).status).toBe(200);
    await patient.post(`/api/carteira/plan/${items[1].id}/done`, { answer: 'PIOROU' });
    const cli = await all<any>(`SELECT * FROM care_alerts WHERE category = 'CLINICO'`);
    expect(cli).toHaveLength(1);
    expect(cli[0]).toMatchObject({ priority: 'ALTA', assigned_to: await idOf('especialistaOne') });
    expect((await sp.get('/api/carteira/specialist/alerts')).body.alerts.map((a: any) => a.category)).toContain('CLINICO');
  });
});
