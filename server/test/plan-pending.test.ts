/** Pendências do plano (ONEMA-AJT-PEND-001): tarefa sem confirmação → "Enviar lembrete" e "Encaminhar à ONEMA". */
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
const TEXT = 'Olá! Há um cuidado do seu plano aguardando sua confirmação. Acesse o aplicativo para informar se realizou ou se precisa de ajuda.';
const stripLink = (b: string) => b.replace(/\s*\[\[\/[^\]\s]*\]\]\s*$/, '');

async function pendingAlert() {
  const patient = new Client(app); await patient.login(emailOf('paciente'));
  const req = (await patient.post('/api/care/requests', { need: NEED_OF['CAT-03'], itemCode: 'CAT-03', infoText: '', materials: 'NAO', materialsDetail: '', materialsSupplyRequested: false,
    patientName: 'Paciente Fictício', phone: '(11) 99999-0000', location: 'Vila Mariana', whenPref: 'HOJE', whenDate: null, notes: '', forSelf: true, responsibleAuthorized: false,
    timeWindow: 'TARDE', patientBirthDate: '1950-05-10', address: ADDR }, true)).body.request;
  await patient.post(`/api/care/requests/${req.id}/accept`, { quoteVersion: 1 });
  await patient.post(`/api/care/requests/${req.id}/checkout`, { quoteVersion: 1, paymentMethod: 'SANDBOX_APROVADO', expectedTotalCents: req.quote.totalCents }, true);
  const sp = new Client(app); await sp.login(emailOf('especialistaOne'));
  const ev = (await sp.get('/api/care/specialist/offers')).body.offers[0];
  await sp.post(`/api/care/specialist/events/${ev.id}/accept`);
  const e = await one<any>('SELECT e.order_id, e.specialist_id, o.patient_id FROM care_events e JOIN service_orders o ON o.id = e.order_id WHERE e.id = ?', ev.id);
  const now = new Date().toISOString();
  await run(`INSERT INTO care_evolutions (id, event_id, order_id, patient_id, specialist_id, dictation, content_json, status, signed_at, created_at, updated_at)
    VALUES (gen_random_uuid()::text, ?, ?, ?, ?, '', '{}', 'ASSINADA', ?, ?, ?)`, ev.id, e.order_id, e.patient_id, e.specialist_id, now, now, now);
  const due = new Date(Date.now() - 30 * H).toISOString();
  await sp.post(`/api/carteira/events/${ev.id}/plan`, { items: [{ title: 'Agendar consulta com o cardiologista', instructions: 'Ligar para a clínica e marcar o retorno.', kind: 'AGENDAR',
    dueAt: due, remindersUntil: new Date(Date.now() + 30 * 24 * H).toISOString() }] });
  expect((await runCarteiraAlerts()).overdue).toBe(1);
  const alert = (await sp.get('/api/carteira/specialist/alerts')).body.alerts[0];
  return { patient, sp, alert, due };
}

describe('Pendências do plano: tarefa sem confirmação', () => {
  it('card mostra paciente, tarefa exata e data prevista; aviso da enfermeira abre o card exato', async () => {
    const { alert, due } = await pendingAlert();
    const dueDate = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(due));
    expect(alert).toMatchObject({ ruleCode: 'ADM-PLANO-ATRASO-001', patientName: 'Paciente Demonstração',
      task: { title: 'Agendar consulta com o cardiologista', instructions: 'Ligar para a clínica e marcar o retorno.', dueDate },
      flag: { code: 'SEM_CONFIRMACAO', text: 'Sem confirmação' } });
    expect(dueDate).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    const n = await one<any>(`SELECT body FROM notifications WHERE user_id = ? AND title = 'Nova pendência na Carteira'`, await idOf('especialistaOne'));
    expect(n.body).toContain('Paciente Demonstração');
    expect(n.body).toMatch(new RegExp(`\\[\\[/especialista#pendencia-${alert.id}\\]\\]$`));
  });

  it('enviar lembrete: mensagem exata ao paciente, trilha e flag; clique duplo = um envio; não confirma o cuidado', async () => {
    const { sp, alert } = await pendingAlert();
    const pid = await idOf('paciente');
    const [r1, r2] = await Promise.all([sp.post(`/api/carteira/alerts/${alert.id}/remind`), sp.post(`/api/carteira/alerts/${alert.id}/remind`)]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect([r1.body.already, r2.body.already].sort()).toEqual([false, true]);
    expect(r1.body.flag).toMatchObject({ code: 'LEMBRETE_ENVIADO', text: 'Lembrete enviado · Aguardando resposta' });
    expect((await sp.post(`/api/carteira/alerts/${alert.id}/remind`)).body.already).toBe(true);
    const notes = await all<any>(`SELECT body, purpose FROM notifications WHERE user_id = ? AND body LIKE 'Olá! Há um cuidado%'`, pid);
    expect(notes).toHaveLength(1);
    expect(notes[0].purpose).toBe('LEMBRETE');
    expect(stripLink(notes[0].body)).toBe(TEXT);
    expect(notes[0].body).toMatch(/\[\[\/carteira#tarefa-[0-9a-f-]+\]\]$/);
    const ev = await all<any>(`SELECT actor_id, action, channel FROM care_alert_events WHERE alert_id = ? AND action LIKE 'LEMBRETE%'`, alert.id);
    expect(ev).toEqual([{ actor_id: await idOf('especialistaOne'), action: 'LEMBRETE_ENVIADO', channel: 'APP' }]);
    expect((await all<any>(`SELECT 1 FROM audit_events WHERE action = 'CARE_ALERT_REMINDER_SENT' AND subject_id = ?`, alert.id))).toHaveLength(1);
    const after = (await sp.get('/api/carteira/specialist/alerts')).body.alerts[0];
    expect(after).toMatchObject({ id: alert.id, status: 'PENDENTE', flag: { code: 'LEMBRETE_ENVIADO' } });
    expect((await one<any>('SELECT status FROM care_plan_items WHERE id = ?', alert.subjectId)).status).toBe('ATIVO');
  });

  it('sem canal autorizado: "Não enviado", sem registro de sucesso; encaminhar continua possível', async () => {
    const { sp, alert } = await pendingAlert();
    const it0 = await one<any>('SELECT series_id, patient_id FROM care_plan_items WHERE id = ?', alert.subjectId);
    await run(`INSERT INTO care_plan_reminder_prefs (series_id, patient_id, mode, updated_by, updated_at) VALUES (?,?,'DESATIVADO',?,?)`, it0.series_id, it0.patient_id, it0.patient_id, new Date().toISOString());
    const r = (await sp.post(`/api/carteira/alerts/${alert.id}/remind`)).body;
    expect(r).toMatchObject({ sent: false, flag: { code: 'NAO_ENVIADO', text: 'Não enviado' } });
    expect((await all<any>(`SELECT 1 FROM notifications WHERE body LIKE 'Olá! Há um cuidado%'`))).toHaveLength(0);
    expect((await all<any>(`SELECT 1 FROM care_alert_events WHERE alert_id = ? AND action = 'LEMBRETE_ENVIADO'`, alert.id))).toHaveLength(0);
    expect((await sp.post(`/api/carteira/alerts/${alert.id}/forward`)).status).toBe(200);
  });

  it('encaminhar à ONEMA: sai das ações da enfermeira, fica no histórico e chega à coordenação; idempotente', async () => {
    const { sp, alert } = await pendingAlert();
    const [f1, f2] = await Promise.all([sp.post(`/api/carteira/alerts/${alert.id}/forward`), sp.post(`/api/carteira/alerts/${alert.id}/forward`)]);
    expect([f1.status, f2.status]).toEqual([200, 200]);
    expect(f1.body.flag).toMatchObject({ code: 'ENCAMINHADO', text: 'Encaminhado à ONEMA' });
    expect((await sp.post(`/api/carteira/alerts/${alert.id}/forward`)).body.already).toBe(true);
    const mine = (await sp.get('/api/carteira/specialist/alerts')).body;
    expect(mine.alerts).toHaveLength(0);
    expect(mine.forwarded[0]).toMatchObject({ id: alert.id, flag: { code: 'ENCAMINHADO' }, task: { title: 'Agendar consulta com o cardiologista' } });
    const op = await loginAs(app, 'operador');
    const q = (await op.get('/api/admin/carteira/alerts')).body.alerts.find((x: any) => x.id === alert.id);
    expect(q).toMatchObject({ recipient: 'CENTRAL', ownerRole: 'OPERADOR_CENTRAL', assignedTo: null, patientName: 'Paciente Demonstração', subjectType: 'care_plan_item' });
    expect((await all<any>(`SELECT 1 FROM care_alert_events WHERE alert_id = ? AND action = 'ENCAMINHADO_ONEMA'`, alert.id))).toHaveLength(1);
    expect((await all<any>(`SELECT 1 FROM audit_events WHERE action = 'CARE_ALERT_FORWARDED' AND subject_id = ?`, alert.id))).toHaveLength(1);
    expect((await all<any>(`SELECT 1 FROM notifications WHERE user_id = ? AND title = 'Pendência do plano encaminhada'`, await idOf('operador')))).toHaveLength(1);
    // não volta a escalar para o RT pelo prazo de ciência
    await run('UPDATE care_alerts SET ack_due_at = ? WHERE id = ?', new Date(Date.now() - H).toISOString(), alert.id);
    expect((await runCarteiraAlerts()).escalated).toBe(0);
    // encaminhada: a enfermeira não envia mais lembrete
    expect((await sp.post(`/api/carteira/alerts/${alert.id}/remind`)).status).toBe(404);
    // a coordenação pode enviar o lembrete
    expect((await op.post(`/api/carteira/alerts/${alert.id}/remind`)).body).toMatchObject({ sent: true, flag: { code: 'ENCAMINHADO' } });
  });

  it('outra enfermeira e o paciente não agem sobre a pendência', async () => {
    const { patient, alert } = await pendingAlert();
    const outra = new Client(app); await outra.login(emailOf('especialista'));
    for (const c of [outra, patient]) {
      expect((await c.post(`/api/carteira/alerts/${alert.id}/remind`)).status).toBe(404);
      expect((await c.post(`/api/carteira/alerts/${alert.id}/forward`)).status).toBe(404);
    }
    expect((await all<any>(`SELECT 1 FROM care_alert_events WHERE alert_id = ? AND action IN ('LEMBRETE_ENVIADO','ENCAMINHADO_ONEMA')`, alert.id))).toHaveLength(0);
  });
});
