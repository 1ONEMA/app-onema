/**
 * Carteira Digital — plano de cuidados e central de alertas (homologação, dados fictícios).
 * - Plano: criado pela enfermeira a partir de atendimento com evolução ASSINADA (instrução profissional validada).
 * - Paciente: vê o plano liberado, confirma tarefas e responde o acompanhamento; reconhece lembretes.
 * - Enfermeiro: pendências atribuídas; RT/Central: fila priorizada, atribuição, regras e auditoria.
 * - Concorrência: toda transição exige a revisão (rev) atual do alerta; dois operadores não encerram/atribuem o mesmo alerta.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, one, run, tx } from '../../db/db.ts';
import { audit } from '../../lib/audit.ts';
import { hasRole, parse, requireRoles, requireUser } from '../../lib/context.ts';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors.ts';
import { nowIso, uid } from '../../lib/util.ts';
import { activeRule, alertEvent, ensureAlertRules, raiseAlert, ruleGaps, runCarteiraAlerts } from './engine.ts';

const idParam = z.object({ id: z.string().uuid() });
const STAFF = ['AVALIADOR_RT', 'OPERADOR_CENTRAL'] as const;
const isStaff = (a: { roles: string[] }) => a.roles.some((r) => (STAFF as readonly string[]).includes(r));
const STATUS_LABEL: Record<string, string> = { PENDENTE: 'Pendente', RECONHECIDO: 'Reconhecido', EM_TRATAMENTO: 'Em tratamento', RESOLVIDO: 'Resolvido', ENCERRADO: 'Encerrado' };
const NEXT: Record<string, string[]> = { PENDENTE: ['RECONHECIDO', 'EM_TRATAMENTO', 'RESOLVIDO', 'ENCERRADO'], RECONHECIDO: ['EM_TRATAMENTO', 'RESOLVIDO', 'ENCERRADO'],
  EM_TRATAMENTO: ['RESOLVIDO', 'ENCERRADO'], RESOLVIDO: [], ENCERRADO: [] };
const PRIORITY_ORDER = `CASE a.priority WHEN 'ALTA' THEN 0 WHEN 'MEDIA' THEN 1 ELSE 2 END`;

const itemView = (i: any) => ({ id: i.id, title: i.title, instructions: i.instructions, dueAt: i.due_at, recurrenceDays: i.recurrence_days, askFollowup: !!i.ask_followup,
  status: i.status, completedAt: i.completed_at, followupAnswer: i.followup_answer, sourceEventId: i.source_event_id, author: i.author ?? null, label: i.label ?? null });
const alertView = (a: any, internal: boolean) => ({
  id: a.id, rule: `${a.rule_code} v${a.rule_version}`, category: a.category, priority: a.priority, status: a.status, statusLabel: STATUS_LABEL[a.status], title: a.title, message: a.message,
  createdAt: a.created_at, ackDueAt: a.ack_due_at, actionDueAt: a.action_due_at, rev: a.rev,
  ...(internal ? { recipient: a.recipient, ownerRole: a.owner_role, assignedTo: a.assigned_name ?? null, patientName: a.patient_name ?? null, escalationLevel: a.escalation_level,
    resolutionNote: a.resolution_note, subjectType: a.subject_type, subjectId: a.subject_id } : {}),
});

export async function carteiraRoutes(app: FastifyInstance) {
  // ---------------- Enfermeira: plano a partir do atendimento assinado ----------------
  app.post('/api/carteira/events/:id/plan', async (req) => {
    const a = requireRoles(req, ['ESPECIALISTA']);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ items: z.array(z.object({
      title: z.string().trim().min(3, 'Informe o título da tarefa.').max(120),
      instructions: z.string().trim().min(5, 'Escreva a orientação ao paciente.').max(2000),
      dueAt: z.string().datetime({ offset: true }),
      recurrenceDays: z.number().int().min(1).max(90).nullable().optional(),
      askFollowup: z.boolean().optional().default(false),
    })).min(1).max(20) }), req.body);
    const e = await one<any>(`SELECT e.*, o.patient_id, (SELECT status FROM care_evolutions v WHERE v.event_id = e.id) AS evolution FROM care_events e JOIN service_orders o ON o.id = e.order_id WHERE e.id = ?`, id);
    if (!e || e.specialist_id !== a.userId) throw notFound('Atendimento não encontrado.');
    if (e.evolution !== 'ASSINADA') throw unprocessable('EVOLUTION_REQUIRED', 'O plano de cuidados é criado a partir da evolução assinada do atendimento.');
    const now = nowIso();
    const ids: string[] = [];
    for (const it of b.items) {
      const iid = uid(); ids.push(iid);
      await run(`INSERT INTO care_plan_items (id, patient_id, created_by, source_event_id, title, instructions, due_at, recurrence_days, ask_followup, status, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,'ATIVO',?,?)`, iid, e.patient_id, a.userId, id, it.title, it.instructions, new Date(it.dueAt).toISOString(), it.recurrenceDays ?? null, it.askFollowup ? 1 : 0, now, now);
    }
    await audit({ actorId: a.userId, action: 'CARE_PLAN_CREATED', subjectType: 'care_event', subjectId: id, correlationId: req.correlationId, meta: { items: ids.length } });
    return { items: (await all<any>('SELECT * FROM care_plan_items WHERE source_event_id = ? ORDER BY due_at', id)).map(itemView) };
  });

  app.get('/api/carteira/events/:id/plan', async (req) => {
    const a = requireRoles(req, ['ESPECIALISTA']);
    const { id } = parse(idParam, req.params);
    const e = await one<any>('SELECT specialist_id FROM care_events WHERE id = ?', id);
    if (!e || e.specialist_id !== a.userId) throw notFound('Atendimento não encontrado.');
    return { items: (await all<any>('SELECT * FROM care_plan_items WHERE source_event_id = ? ORDER BY due_at', id)).map(itemView) };
  });

  app.post('/api/carteira/plan/:id/cancel', async (req) => {
    const a = requireRoles(req, ['ESPECIALISTA', ...STAFF]);
    const { id } = parse(idParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(5, 'Informe o motivo.').max(500) }), req.body);
    const it = await one<any>('SELECT * FROM care_plan_items WHERE id = ?', id);
    if (!it || (it.created_by !== a.userId && !isStaff(a))) throw notFound('Tarefa não encontrada.');
    const r = await run(`UPDATE care_plan_items SET status = 'CANCELADO', cancel_reason = ?, updated_at = ? WHERE id = ? AND status = 'ATIVO'`, reason, nowIso(), id);
    if (!r.changes) throw conflict('PLAN_ITEM_CLOSED', 'Esta tarefa já foi concluída ou cancelada.');
    await audit({ actorId: a.userId, action: 'CARE_PLAN_ITEM_CANCELLED', subjectType: 'care_plan_item', subjectId: id, correlationId: req.correlationId });
    return { ok: true };
  });

  // ---------------- Paciente ----------------
  app.get('/api/carteira/plan', async (req) => {
    const a = requireRoles(req, ['PACIENTE']);
    const items = await all<any>(`SELECT i.*, u.name AS author, e.label FROM care_plan_items i JOIN users u ON u.id = i.created_by JOIN care_events e ON e.id = i.source_event_id
      WHERE i.patient_id = ? ORDER BY CASE i.status WHEN 'ATIVO' THEN 0 ELSE 1 END, i.due_at LIMIT 200`, a.userId);
    const alerts = await all<any>(`SELECT * FROM care_alerts a WHERE a.patient_id = ? AND a.recipient = 'PACIENTE' ORDER BY a.created_at DESC LIMIT 50`, a.userId);
    return { items: items.map(itemView), alerts: alerts.map((x) => alertView(x, false)),
      notice: 'Os avisos da Carteira não substituem atendimento de urgência. Em emergência ligue 192 (SAMU).' };
  });

  /** Paciente confirma a tarefa (e responde o acompanhamento, quando pedido). Recorrência gera a próxima. */
  app.post('/api/carteira/plan/:id/done', async (req) => {
    const a = requireRoles(req, ['PACIENTE']);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ answer: z.enum(['MELHOROU', 'IGUAL', 'PIOROU']).optional(), note: z.string().trim().max(1000).optional() }), req.body ?? {});
    return await tx(async () => {
      const it = await one<any>('SELECT * FROM care_plan_items WHERE id = ? AND patient_id = ? FOR UPDATE', id, a.userId);
      if (!it) throw notFound('Tarefa não encontrada.');
      if (it.status !== 'ATIVO') throw conflict('PLAN_ITEM_CLOSED', 'Esta tarefa já foi concluída ou cancelada.');
      if (it.ask_followup && !b.answer) throw unprocessable('FOLLOWUP_REQUIRED', 'Conte como você está para concluir.');
      const now = nowIso();
      await run(`UPDATE care_plan_items SET status = 'CONCLUIDO', completed_at = ?, followup_answer = ?, followup_note = ?, updated_at = ? WHERE id = ?`, now, b.answer ?? null, b.note ?? null, now, id);
      if (it.recurrence_days) {
        const next = new Date(new Date(it.due_at).getTime() + it.recurrence_days * 86400000).toISOString();
        await run(`INSERT INTO care_plan_items (id, patient_id, created_by, source_event_id, previous_item_id, title, instructions, due_at, recurrence_days, ask_followup, status, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,'ATIVO',?,?)`, uid(), it.patient_id, it.created_by, it.source_event_id, id, it.title, it.instructions, next, it.recurrence_days, it.ask_followup, now, now);
      }
      // Lembretes e atrasos daquela tarefa se resolvem com a confirmação do paciente.
      for (const al of await all<any>(`SELECT id FROM care_alerts WHERE subject_type = 'care_plan_item' AND subject_id = ? AND status IN ('PENDENTE','RECONHECIDO','EM_TRATAMENTO')`, id)) {
        await run(`UPDATE care_alerts SET status = 'RESOLVIDO', resolution_note = 'Tarefa confirmada pelo paciente.', closed_at = ?, rev = rev + 1, updated_at = ? WHERE id = ?`, now, now, al.id);
        await alertEvent(al.id, a.userId, 'RESOLVIDO', null, 'Tarefa confirmada pelo paciente.');
      }
      // Regra clínica FICTÍCIA: só dispara se aprovada pelo RT (matriz completa).
      if (b.answer === 'PIOROU') {
        const rule = await activeRule('CLI-FICT-001');
        if (rule) await raiseAlert(rule, { patientId: a.userId, subjectType: 'care_plan_item', subjectId: id, dedupeKey: `CLI-FICT-001:${id}`, assignedTo: it.created_by });
        else await audit({ actorId: a.userId, action: 'CARE_ALERT_RULE_INACTIVE', subjectType: 'care_plan_item', subjectId: id, meta: { rule: 'CLI-FICT-001' } });
      }
      await audit({ actorId: a.userId, action: 'CARE_PLAN_ITEM_DONE', subjectType: 'care_plan_item', subjectId: id, correlationId: req.correlationId });
      return { ok: true };
    });
  });

  // ---------------- Fila de alertas (paciente, enfermeiro, RT/Central) ----------------
  async function loadAlert(req: any, id: string) {
    const a = requireUser(req);
    const al = await one<any>('SELECT * FROM care_alerts WHERE id = ?', id);
    if (!al) throw notFound('Alerta não encontrado.');
    const patient = al.recipient === 'PACIENTE' && al.patient_id === a.userId;
    const nurse = hasRole(a, 'ESPECIALISTA') && al.assigned_to === a.userId;
    const staff = isStaff(a);
    if (!patient && !nurse && !staff) {
      await audit({ actorId: a.userId, action: 'CARE_ALERT_ACCESS_DENIED', subjectType: 'care_alert', subjectId: id });
      throw notFound('Alerta não encontrado.');
    }
    if (staff && !patient && !nurse) requireRoles(req, [...STAFF]);
    return { a, al, patient, nurse, staff };
  }

  app.post('/api/carteira/alerts/:id/transition', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ to: z.enum(['RECONHECIDO', 'EM_TRATAMENTO', 'RESOLVIDO', 'ENCERRADO']), rev: z.number().int().min(1), note: z.string().trim().max(2000).optional() }), req.body);
    const { a, al, patient } = await loadAlert(req, id);
    if (patient && b.to !== 'RECONHECIDO') throw forbidden('O paciente só confirma a leitura do aviso.');
    if (!NEXT[al.status].includes(b.to)) throw conflict('ALERT_STATE', `Não é possível passar de ${STATUS_LABEL[al.status]} para ${STATUS_LABEL[b.to]}.`);
    if ((b.to === 'RESOLVIDO' || b.to === 'ENCERRADO') && (b.note ?? '').length < 5) throw unprocessable('NOTE_REQUIRED', 'Registre a providência ou a justificativa do encerramento.');
    const now = nowIso();
    const r = await run(`UPDATE care_alerts SET status = ?, rev = rev + 1, resolution_note = COALESCE(?, resolution_note), closed_at = ?, assigned_to = COALESCE(assigned_to, ?), updated_at = ?
      WHERE id = ? AND rev = ?`, b.to, b.to === 'RESOLVIDO' || b.to === 'ENCERRADO' ? b.note : null, b.to === 'RESOLVIDO' || b.to === 'ENCERRADO' ? now : null,
      patient ? null : a.userId, now, id, b.rev);
    if (!r.changes) throw conflict('ALERT_CHANGED', 'Este alerta foi atualizado por outra pessoa. Recarregue antes de continuar.');
    await alertEvent(id, a.userId, b.to, null, b.note ?? null);
    await audit({ actorId: a.userId, action: `CARE_ALERT_${b.to}`, subjectType: 'care_alert', subjectId: id, correlationId: req.correlationId });
    return { alert: alertView((await one<any>('SELECT * FROM care_alerts WHERE id = ?', id))!, !patient) };
  });

  app.get('/api/carteira/specialist/alerts', async (req) => {
    const a = requireRoles(req, ['ESPECIALISTA']);
    const rows = await all<any>(`SELECT a.*, p.name AS patient_name FROM care_alerts a LEFT JOIN users p ON p.id = a.patient_id
      WHERE a.assigned_to = ? AND a.status IN ('PENDENTE','RECONHECIDO','EM_TRATAMENTO') ORDER BY ${PRIORITY_ORDER}, a.created_at LIMIT 100`, a.userId);
    return { alerts: rows.map((x) => alertView(x, true)) };
  });

  app.get('/api/carteira/alerts/:id/events', async (req) => {
    const { id } = parse(idParam, req.params);
    const { patient } = await loadAlert(req, id);
    if (patient) throw forbidden();
    return { events: await all<any>(`SELECT ev.action, ev.channel, ev.note, ev.created_at, u.name AS actor FROM care_alert_events ev LEFT JOIN users u ON u.id = ev.actor_id
      WHERE ev.alert_id = ? ORDER BY ev.created_at, ev.id`, id) };
  });

  // ---------------- RT / Central ----------------
  app.get('/api/admin/carteira/alerts', async (req) => {
    requireRoles(req, [...STAFF]);
    const q = parse(z.object({ status: z.enum(['ABERTOS', 'TODOS']).default('ABERTOS'), category: z.enum(['LEMBRETE', 'CLINICO', 'ADMINISTRATIVO', 'TECNICO']).optional() }), req.query);
    const rows = await all<any>(`SELECT a.*, p.name AS patient_name, u.name AS assigned_name FROM care_alerts a LEFT JOIN users p ON p.id = a.patient_id LEFT JOIN users u ON u.id = a.assigned_to
      WHERE ${q.status === 'ABERTOS' ? `a.status IN ('PENDENTE','RECONHECIDO','EM_TRATAMENTO')` : '1=1'} ${q.category ? 'AND a.category = ?' : ''}
      ORDER BY ${PRIORITY_ORDER}, a.created_at LIMIT 300`, ...(q.category ? [q.category] : []));
    const counts = await all<any>(`SELECT category, status, COUNT(*) AS n FROM care_alerts GROUP BY category, status`);
    const overdue = (await one<any>(`SELECT COUNT(*) AS n FROM care_alerts WHERE status IN ('PENDENTE','RECONHECIDO','EM_TRATAMENTO') AND action_due_at < ?`, nowIso()))!.n;
    return { alerts: rows.map((x) => alertView(x, true)), counts: counts.map((c) => ({ ...c, n: Number(c.n) })), overdue: Number(overdue) };
  });

  app.post('/api/admin/carteira/alerts/:id/assign', async (req) => {
    const a = requireRoles(req, [...STAFF]);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ email: z.string().trim().email().nullable(), rev: z.number().int().min(1) }), req.body);
    let to: string | null = null;
    if (b.email) {
      const u = await one<any>('SELECT id FROM users WHERE lower(email) = lower(?)', b.email);
      if (!u) throw notFound('Usuário não encontrado.');
      to = u.id;
    }
    const r = await run(`UPDATE care_alerts SET assigned_to = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ? AND status IN ('PENDENTE','RECONHECIDO','EM_TRATAMENTO')`, to, nowIso(), id, b.rev);
    if (!r.changes) throw conflict('ALERT_CHANGED', 'Este alerta foi atualizado por outra pessoa ou já foi encerrado. Recarregue antes de continuar.');
    await alertEvent(id, a.userId, 'ATRIBUIDO', null, b.email ?? 'fila');
    await audit({ actorId: a.userId, action: 'CARE_ALERT_ASSIGNED', subjectType: 'care_alert', subjectId: id, correlationId: req.correlationId });
    return { ok: true };
  });

  app.get('/api/admin/carteira/rules', async (req) => {
    requireRoles(req, [...STAFF, 'AUDITOR']);
    await ensureAlertRules();
    const rows = await all<any>('SELECT r.*, u.name AS approver FROM alert_rules r LEFT JOIN users u ON u.id = r.approved_by ORDER BY r.category, r.code, r.version');
    return { rules: rows.map((r) => ({ code: r.code, version: r.version, category: r.category, title: r.title, trigger: r.trigger_desc, recipient: r.recipient, message: r.message,
      priority: r.priority, ownerRole: r.owner_role, substituteRole: r.substitute_role, coverage: r.coverage, ackHours: r.ack_hours, actionHours: r.action_hours, escalateTo: r.escalate_to,
      channels: JSON.parse(r.channels_json), dedupe: r.dedupe_desc, testEvidence: r.test_evidence, sourceProtocol: r.source_protocol, fictitious: !!r.fictitious, status: r.status,
      approvedAt: r.approved_at, approver: r.approver, gaps: ruleGaps(r) })) };
  });

  /** Ativação de regra pelo RT: bloqueada sem matriz completa (dono, mensagem, prazos, escalonamento, deduplicação, teste). */
  app.post('/api/admin/carteira/rules/:code/:version/status', async (req) => {
    const a = requireRoles(req, ['AVALIADOR_RT']);
    const p = parse(z.object({ code: z.string().max(60), version: z.coerce.number().int() }), req.params);
    const b = parse(z.object({ status: z.enum(['APROVADA', 'SUSPENSA']), note: z.string().trim().min(5, 'Registre a justificativa.').max(1000) }), req.body);
    const r = await one<any>('SELECT * FROM alert_rules WHERE code = ? AND version = ?', p.code, p.version);
    if (!r) throw notFound('Regra não encontrada.');
    if (b.status === 'APROVADA') {
      const gaps = ruleGaps(r);
      if (gaps.length) throw unprocessable('RULE_INCOMPLETE', `A regra não pode ser ativada: falta ${gaps.join(', ')}.`, { gaps });
    }
    await run('UPDATE alert_rules SET status = ?, approved_by = ?, approved_at = ? WHERE code = ? AND version = ?', b.status, a.userId, nowIso(), p.code, p.version);
    await audit({ actorId: a.userId, action: `ALERT_RULE_${b.status}`, subjectType: 'alert_rule', subjectId: `${p.code}@${p.version}`, correlationId: req.correlationId, meta: { note: b.note } });
    return { ok: true };
  });

  /** Homologação: executa o motor agora (o job horário faz o mesmo). */
  app.post('/api/admin/carteira/run', async (req) => {
    const a = requireRoles(req, [...STAFF]);
    const r = await runCarteiraAlerts();
    await audit({ actorId: a.userId, action: 'CARE_ALERTS_RUN', subjectType: 'system', correlationId: req.correlationId, meta: r });
    return r;
  });
}
