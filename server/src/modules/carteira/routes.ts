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
import { ITEM_KINDS, SPACING_OPTIONS, ensureNext, fmt, fmtDay, prefOf, reminderEvent, requestReview, runPlanReminders, seriesState } from './reminders.ts';

const idParam = z.object({ id: z.string().uuid() });
const STAFF = ['AVALIADOR_RT', 'OPERADOR_CENTRAL'] as const;
const isStaff = (a: { roles: string[] }) => a.roles.some((r) => (STAFF as readonly string[]).includes(r));
const STATUS_LABEL: Record<string, string> = { PENDENTE: 'Pendente', RECONHECIDO: 'Reconhecido', EM_TRATAMENTO: 'Em tratamento', RESOLVIDO: 'Resolvido', ENCERRADO: 'Encerrado' };
const NEXT: Record<string, string[]> = { PENDENTE: ['RECONHECIDO', 'EM_TRATAMENTO', 'RESOLVIDO', 'ENCERRADO'], RECONHECIDO: ['EM_TRATAMENTO', 'RESOLVIDO', 'ENCERRADO'],
  EM_TRATAMENTO: ['RESOLVIDO', 'ENCERRADO'], RESOLVIDO: [], ENCERRADO: [] };
const PRIORITY_ORDER = `CASE a.priority WHEN 'ALTA' THEN 0 WHEN 'MEDIA' THEN 1 ELSE 2 END`;

const itemView = (i: any) => ({ id: i.id, seriesId: i.series_id ?? i.id, title: i.title, instructions: i.instructions, dueAt: i.due_at, recurrenceDays: i.recurrence_days, askFollowup: !!i.ask_followup,
  status: i.status, completedAt: i.completed_at, followupAnswer: i.followup_answer, sourceEventId: i.source_event_id, author: i.author ?? null, label: i.label ?? null,
  kind: i.item_kind ?? 'GERAL', careFrequency: i.care_frequency ?? null, remindersUntil: i.reminders_until ?? null, untilKind: i.until_kind ?? null,
  releasedAt: i.released_at ?? null, ackedAt: i.acked_at ?? null, scheduleReport: i.schedule_report ?? null });

/** Texto da ocorrência no histórico (disponibilização, ciência e execução são registros distintos). */
function occurrenceText(i: any) {
  if (i.status === 'CANCELADO') return i.cancel_reason?.startsWith('Preferência') ? 'Não enviado | avisos pausados ou desativados por você' : 'Encerrado pela Enfermagem';
  if (i.schedule_report === 'INFORMADO_PACIENTE') return 'Agendamento informado por você';
  if (i.status === 'CONCLUIDO') return `Realização registrada${i.followup_answer ? ` | resposta: ${({ MELHOROU: 'Melhorou', IGUAL: 'Igual', PIOROU: 'Piorou' } as any)[i.followup_answer]}` : ''}`;
  if (i.status === 'CIENTE') return `Ciente registrado${i.item_kind === 'AGENDAR' ? ' | sem confirmação de agendamento' : ''}`;
  if (i.status === 'EXPIRADO') return 'Disponibilizado | sem resposta registrada';
  return 'Disponibilizado | aguardando ciência';
}
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
      // Comando do RT (20/11): tipo, frequência do cuidado (separada da frequência dos avisos) e término/revisão obrigatório.
      kind: z.enum(ITEM_KINDS).optional().default('GERAL'),
      careFrequency: z.string().trim().max(200).optional(),
      remindersUntil: z.string().datetime({ offset: true }),
      untilKind: z.enum(['ENCERRAMENTO', 'REVISAO']).optional().default('ENCERRAMENTO'),
    })).min(1).max(20) }), req.body);
    for (const it of b.items) {
      if (new Date(it.remindersUntil).getTime() < new Date(it.dueAt).getTime()) throw unprocessable('INVALID_UNTIL', 'A data de término/revisão precisa ser depois do início dos avisos.');
    }
    const e = await one<any>(`SELECT e.*, o.patient_id, (SELECT status FROM care_evolutions v WHERE v.event_id = e.id) AS evolution FROM care_events e JOIN service_orders o ON o.id = e.order_id WHERE e.id = ?`, id);
    if (!e || e.specialist_id !== a.userId) throw notFound('Atendimento não encontrado.');
    if (e.evolution !== 'ASSINADA') throw unprocessable('EVOLUTION_REQUIRED', 'O plano de cuidados é criado a partir da evolução assinada do atendimento.');
    const now = nowIso();
    const ids: string[] = [];
    for (const it of b.items) {
      const iid = uid(); ids.push(iid);
      await run(`INSERT INTO care_plan_items (id, patient_id, created_by, source_event_id, series_id, title, instructions, due_at, recurrence_days, ask_followup, status,
          item_kind, care_frequency, reminders_until, until_kind, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,'ATIVO',?,?,?,?,?,?)`, iid, e.patient_id, a.userId, id, iid, it.title, it.instructions, new Date(it.dueAt).toISOString(), it.recurrenceDays ?? null,
        it.askFollowup && it.kind !== 'AGENDAR' ? 1 : 0, it.kind, it.careFrequency || null, new Date(it.remindersUntil).toISOString(), it.untilKind, now, now);
    }
    await audit({ actorId: a.userId, action: 'CARE_PLAN_CREATED', subjectType: 'care_event', subjectId: id, correlationId: req.correlationId, meta: { items: ids.length } });
    return { items: (await all<any>('SELECT * FROM care_plan_items WHERE source_event_id = ? ORDER BY due_at', id)).map(itemView),
      message: 'Programação salva. Os avisos respeitarão as preferências do paciente e serão interrompidos na data definida.' };
  });

  app.get('/api/carteira/events/:id/plan', async (req) => {
    const a = requireRoles(req, ['ESPECIALISTA']);
    const { id } = parse(idParam, req.params);
    const e = await one<any>('SELECT specialist_id FROM care_events WHERE id = ?', id);
    if (!e || e.specialist_id !== a.userId) throw notFound('Atendimento não encontrado.');
    const items = await all<any>('SELECT * FROM care_plan_items WHERE source_event_id = ? ORDER BY due_at', id);
    const seriesIds = [...new Set(items.map((i) => i.series_id ?? i.id))];
    // Acesso à preferência: ativo/espaçado/pausado/desligado, data da alteração e pedido de revisão.
    return { items: items.map(itemView), series: await Promise.all(seriesIds.map(seriesState)) };
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
    await runPlanReminders({ patientId: a.userId, notify: false });
    const items = await all<any>(`SELECT i.*, u.name AS author, e.label FROM care_plan_items i JOIN users u ON u.id = i.created_by JOIN care_events e ON e.id = i.source_event_id
      WHERE i.patient_id = ? ORDER BY CASE i.status WHEN 'ATIVO' THEN 0 ELSE 1 END, i.due_at LIMIT 200`, a.userId);
    const alerts = await all<any>(`SELECT * FROM care_alerts a WHERE a.patient_id = ? AND a.recipient = 'PACIENTE' ORDER BY a.created_at DESC LIMIT 50`, a.userId);
    // Último lembrete efetivamente disponibilizado (de hoje ou anterior), um só para toda a seção.
    const last = items.filter((i) => i.released_at).sort((x, y) => (x.due_at < y.due_at ? 1 : x.due_at > y.due_at ? -1 : (x.created_at < y.created_at ? 1 : -1)))[0] ?? null;
    const seriesIds = [...new Set(items.map((i) => i.series_id ?? i.id))];
    const series = await Promise.all(seriesIds.map(seriesState));
    const pendingActions = items.filter((i) => i.status === 'ATIVO' && i.released_at).length;
    return {
      items: items.map(itemView), alerts: alerts.map((x) => alertView(x, false)),
      latest: last ? { ...itemView(last), occurrenceText: occurrenceText(last), series: series.find((x) => x.seriesId === (last.series_id ?? last.id)) ?? null } : null,
      series, pendingActions,
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
      // Ajuste 01: reenvio, duplo clique ou outra aba confirmando a mesma ocorrência = um único ato (mesmo resultado).
      if (it.status === 'CONCLUIDO') return { ok: true, already: true, item: itemView(it) };
      if (it.status !== 'ATIVO') throw conflict('PLAN_ITEM_CLOSED', 'Esta tarefa foi cancelada pela enfermeira.');
      if (it.ask_followup && !b.answer) throw unprocessable('FOLLOWUP_REQUIRED', 'Conte como você está para concluir.');
      const now = nowIso();
      await run(`UPDATE care_plan_items SET status = 'CONCLUIDO', completed_at = ?, followup_answer = ?, followup_note = ?, released_at = COALESCE(released_at, ?), updated_at = ? WHERE id = ?`,
        now, b.answer ?? null, b.note ?? null, now, now, id);
      await reminderEvent(it.series_id ?? id, id, a.userId, 'REALIZADO', a.userId, b.answer ?? null);
      if (it.recurrence_days) await ensureNext(it.series_id ?? id);
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
      return { ok: true, item: itemView((await one<any>('SELECT * FROM care_plan_items WHERE id = ?', id))!) };
    });
  });

  // ---------------- Lembretes: ciência, agendamento, preferências, histórico e revisão (RT, 20/11/2026) ----------------
  async function ownOccurrence(patientId: string, id: string) {
    const it = await one<any>('SELECT * FROM care_plan_items WHERE id = ? AND patient_id = ? FOR UPDATE', id, patientId);
    if (!it) throw notFound('Lembrete não encontrado.');
    return it;
  }

  /** "Ciente": ciência daquela ocorrência, uma única vez (duas abas, clique duplo e reconexão = um registro). */
  app.post('/api/carteira/plan/:id/ack', async (req) => {
    const a = requireRoles(req, ['PACIENTE']);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ answer: z.enum(['MELHOROU', 'IGUAL', 'PIOROU']).optional() }), req.body ?? {});
    const out = await tx(async () => {
      const it = await ownOccurrence(a.userId, id);
      if (it.acked_at || it.status === 'CIENTE') return { it, already: true };
      if (it.status !== 'ATIVO' || !it.released_at) throw conflict('REMINDER_CLOSED', 'Este lembrete não está mais disponível para ciência.');
      if (it.ask_followup && !b.answer) throw unprocessable('FOLLOWUP_REQUIRED', 'Conte como você está para registrar a ciência.');
      const now = nowIso();
      await run(`UPDATE care_plan_items SET status = 'CIENTE', acked_at = ?, acked_by = ?, followup_answer = COALESCE(?, followup_answer), updated_at = ? WHERE id = ? AND status = 'ATIVO'`,
        now, a.userId, b.answer ?? null, now, id);
      await reminderEvent(it.series_id ?? id, id, a.userId, 'CIENTE', a.userId, b.answer ?? null);
      for (const al of await all<any>(`SELECT id FROM care_alerts WHERE subject_type = 'care_plan_item' AND subject_id = ? AND status IN ('PENDENTE','RECONHECIDO','EM_TRATAMENTO') AND recipient = 'PACIENTE'`, id)) {
        await run(`UPDATE care_alerts SET status = 'RESOLVIDO', resolution_note = 'Ciência registrada pelo paciente.', closed_at = ?, rev = rev + 1, updated_at = ? WHERE id = ?`, now, now, al.id);
        await alertEvent(al.id, a.userId, 'RESOLVIDO', null, 'Ciência registrada pelo paciente.');
      }
      if (b.answer === 'PIOROU') {
        const rule = await activeRule('CLI-FICT-001');
        if (rule) await raiseAlert(rule, { patientId: a.userId, subjectType: 'care_plan_item', subjectId: id, dedupeKey: `CLI-FICT-001:${id}`, assignedTo: it.created_by });
      }
      return { it, already: false };
    });
    if (!out.already) await audit({ actorId: a.userId, action: 'CARE_PLAN_REMINDER_ACKED', subjectType: 'care_plan_item', subjectId: id, correlationId: req.correlationId });
    const next = await ensureNext(out.it.series_id ?? id);
    return { ok: true, already: out.already, next };
  });

  /** Tarefa de agendar: "Já agendei" (informado pelo paciente) ou "Preciso de ajuda para agendar" (pendência da Central). */
  app.post('/api/carteira/plan/:id/schedule-report', async (req) => {
    const a = requireRoles(req, ['PACIENTE']);
    const { id } = parse(idParam, req.params);
    const { action } = parse(z.object({ action: z.enum(['JA_AGENDEI', 'PRECISO_AJUDA']) }), req.body);
    const it = await one<any>('SELECT * FROM care_plan_items WHERE id = ? AND patient_id = ?', id, a.userId);
    if (!it) throw notFound('Lembrete não encontrado.');
    if (it.item_kind !== 'AGENDAR') throw unprocessable('NOT_SCHEDULING', 'Esta orientação não é uma ação de agendar.');
    const seriesId = it.series_id ?? id;
    if (action === 'PRECISO_AJUDA') {
      await requestReview(seriesId, a.userId, 'AJUDA_AGENDAR', `Paciente pediu ajuda para agendar: ${it.title}`, a.userId);
      return { ok: true, message: 'Pedido registrado. A Central ONEMA vai ajudar você a agendar. Isso não é um canal de urgência.' };
    }
    const r = await tx(async () => {
      const cur = await ownOccurrence(a.userId, id);
      if (cur.schedule_report === 'INFORMADO_PACIENTE') return false;
      const now = nowIso();
      await run(`UPDATE care_plan_items SET schedule_report = 'INFORMADO_PACIENTE', status = CASE WHEN status = 'ATIVO' THEN 'CIENTE' ELSE status END, acked_at = COALESCE(acked_at, ?),
        acked_by = COALESCE(acked_by, ?), updated_at = ? WHERE id = ?`, now, a.userId, now, id);
      // Avisos de agendar encerrados a partir do relato (identificado como informado pelo paciente).
      await run(`UPDATE care_plan_items SET status = 'CANCELADO', cancel_reason = 'Agendamento informado pelo paciente', updated_at = ? WHERE series_id = ? AND status = 'ATIVO' AND released_at IS NULL`, now, seriesId);
      await reminderEvent(seriesId, id, a.userId, 'AGENDAMENTO_INFORMADO', a.userId, 'Informado pelo paciente');
      return true;
    });
    if (r) await audit({ actorId: a.userId, action: 'CARE_PLAN_SCHEDULE_REPORTED', subjectType: 'care_plan_item', subjectId: id, correlationId: req.correlationId });
    return { ok: true, already: !r, message: 'Registramos que você já agendou (informado por você). Os avisos de agendar foram encerrados.' };
  });

  /** Preferências de aviso por orientação: altera os avisos, não a orientação de Enfermagem. */
  app.put('/api/carteira/series/:id/prefs', async (req) => {
    const a = requireRoles(req, ['PACIENTE']);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({
      mode: z.enum(['ATIVO', 'ESPACADO', 'PAUSADO', 'DESATIVADO']),
      intervalDays: z.number().int().optional(),
      pausedUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }), req.body);
    const root = await one<any>('SELECT * FROM care_plan_items WHERE series_id = ? AND patient_id = ? ORDER BY due_at LIMIT 1', id, a.userId);
    if (!root) throw notFound('Orientação não encontrada.');
    let interval: number | null = null, paused: string | null = null;
    if (b.mode === 'ESPACADO') {
      if (root.item_kind === 'HORARIO') throw unprocessable('SPACING_NOT_ALLOWED', 'Este cuidado tem horário específico: não é possível espaçar os avisos. Você pode desativá-los; a orientação continua valendo e a Enfermagem verá sua preferência.');
      if (!root.recurrence_days) throw unprocessable('SPACING_NOT_ALLOWED', 'Esta orientação tem aviso único.');
      if (!b.intervalDays || !SPACING_OPTIONS.includes(b.intervalDays) || b.intervalDays < root.recurrence_days) {
        throw unprocessable('INVALID_INTERVAL', `Escolha um intervalo de ${SPACING_OPTIONS.filter((d) => d >= root.recurrence_days).join(', ')} dias.`);
      }
      interval = b.intervalDays;
      const first = new Date(Math.max(Date.now(), new Date(root.due_at).getTime()) + interval * 86400000);
      if (root.reminders_until && first.getTime() > new Date(root.reminders_until).getTime()) {
        throw unprocessable('NO_ELIGIBLE_DATE', `Com esse intervalo não haveria novo aviso antes do término da programação (${fmtDay(root.reminders_until)}). Escolha um intervalo menor ou desative os avisos.`);
      }
    }
    if (b.mode === 'PAUSADO') {
      if (!b.pausedUntil) throw unprocessable('PAUSE_DATE_REQUIRED', 'Escolha a data de retomada.');
      paused = new Date(`${b.pausedUntil}T00:00:00-03:00`).toISOString();
      if (new Date(paused).getTime() <= Date.now()) throw unprocessable('INVALID_PAUSE', 'A data de retomada precisa ser no futuro.');
      if (root.reminders_until && new Date(paused).getTime() > new Date(root.reminders_until).getTime()) {
        throw unprocessable('NO_ELIGIBLE_DATE', `A programação termina em ${fmtDay(root.reminders_until)}: não haveria aviso depois dessa pausa. Você pode desativar os avisos.`);
      }
    }
    if (b.mode === 'ESPACADO' || b.mode === 'ATIVO') interval = b.mode === 'ESPACADO' ? interval : null;
    const now = nowIso();
    await tx(async () => {
      const prev = await prefOf(id);
      await run(`INSERT INTO care_plan_reminder_prefs (series_id, patient_id, mode, interval_days, paused_until, updated_by, updated_at) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT (series_id) DO UPDATE SET mode = EXCLUDED.mode, interval_days = EXCLUDED.interval_days, paused_until = EXCLUDED.paused_until, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        id, a.userId, b.mode, interval, paused, a.userId, now);
      // Envios futuros incompatíveis são invalidados; a elegibilidade é conferida de novo no disparo.
      await run(`UPDATE care_plan_items SET status = 'CANCELADO', cancel_reason = 'Preferência do paciente: aviso reprogramado.', updated_at = ? WHERE series_id = ? AND status = 'ATIVO' AND released_at IS NULL`, now, id);
      await reminderEvent(id, null, a.userId, 'PREFERENCIA', a.userId, `${prev.mode} → ${b.mode}${interval ? ` (a cada ${interval} dias)` : ''}${paused ? ` até ${fmtDay(paused)}` : ''}`);
    });
    await audit({ actorId: a.userId, action: 'CARE_PLAN_REMINDER_PREFS', subjectType: 'care_plan_series', subjectId: id, correlationId: req.correlationId, meta: { mode: b.mode, interval, paused } });
    const next = await ensureNext(id);
    return { ok: true, state: await seriesState(id), next };
  });

  /** "Acredito que não preciso mais": pedido de revisão pela Enfermagem. Não encerra a orientação nem marca execução. */
  app.post('/api/carteira/series/:id/review-request', async (req) => {
    const a = requireRoles(req, ['PACIENTE']);
    const { id } = parse(idParam, req.params);
    const { note } = parse(z.object({ note: z.string().trim().max(500).optional() }), req.body ?? {});
    const root = await one<any>('SELECT title FROM care_plan_items WHERE series_id = ? AND patient_id = ? LIMIT 1', id, a.userId);
    if (!root) throw notFound('Orientação não encontrada.');
    const created = await requestReview(id, a.userId, 'PEDIDO_PACIENTE', note || `Paciente acredita que não precisa mais: ${root.title}`, a.userId);
    return { ok: true, already: !created, message: 'Seu pedido ficará disponível para revisão da Enfermagem. Isso não encerra automaticamente sua orientação.' };
  });

  /** Histórico de lembretes: abre só quando pedido; do mais recente ao mais antigo, 10 por página, com filtros. */
  app.get('/api/carteira/reminders/history', async (req) => {
    const a = requireRoles(req, ['PACIENTE']);
    const q = parse(z.object({ seriesId: z.string().uuid().optional(), days: z.coerce.number().int().min(1).max(3650).optional().default(30), page: z.coerce.number().int().min(1).max(500).optional().default(1) }), req.query ?? {});
    const since = new Date(Date.now() - q.days * 86400000).toISOString();
    const args: any[] = [a.userId, since];
    if (q.seriesId) args.push(q.seriesId);
    const rows = await all<any>(`SELECT * FROM care_plan_items WHERE patient_id = ? AND released_at IS NOT NULL AND due_at >= ? ${q.seriesId ? 'AND series_id = ?' : ''}
      ORDER BY due_at DESC, created_at DESC LIMIT 11 OFFSET ${(q.page - 1) * 10}`, ...args);
    return { items: rows.slice(0, 10).map((i) => ({ id: i.id, seriesId: i.series_id, title: i.title, at: i.released_at < i.due_at ? i.due_at : i.due_at, atText: fmt(i.due_at),
      ackedAt: i.acked_at, text: occurrenceText(i) })), hasMore: rows.length > 10, page: q.page };
  });

  // ---------------- Enfermagem/RT: programação da série e pendências ----------------
  /** Programação da série (término/revisão, intervalo). Uma edição clínica nunca reativa aviso desativado pelo paciente. */
  app.put('/api/carteira/series/:id/schedule', async (req) => {
    const a = requireRoles(req, ['ESPECIALISTA', ...STAFF]);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ remindersUntil: z.string().datetime({ offset: true }), untilKind: z.enum(['ENCERRAMENTO', 'REVISAO']),
      recurrenceDays: z.number().int().min(1).max(90).nullable().optional(), kind: z.enum(ITEM_KINDS).optional() }), req.body);
    const root = await one<any>('SELECT * FROM care_plan_items WHERE series_id = ? ORDER BY due_at LIMIT 1', id);
    if (!root || (root.created_by !== a.userId && !isStaff(a))) throw notFound('Orientação não encontrada.');
    const now = nowIso();
    await tx(async () => {
      await run(`UPDATE care_plan_items SET reminders_until = ?, until_kind = ?, recurrence_days = COALESCE(?, recurrence_days), item_kind = COALESCE(?, item_kind), updated_at = ? WHERE series_id = ?`,
        new Date(b.remindersUntil).toISOString(), b.untilKind, b.recurrenceDays ?? null, b.kind ?? null, now, id);
      await run(`UPDATE care_plan_reviews SET status = 'RESOLVIDA', resolved_at = ?, resolved_by = ?, resolution = 'Programação definida' WHERE series_id = ? AND kind IN ('PARAMETRIZACAO','REVISAO_PROGRAMADA') AND status = 'ABERTA'`, now, a.userId, id);
      await reminderEvent(id, null, root.patient_id, 'PROGRAMACAO', a.userId, `${b.untilKind === 'REVISAO' ? 'Revisão' : 'Término'} em ${fmtDay(b.remindersUntil)}`);
    });
    await audit({ actorId: a.userId, action: 'CARE_PLAN_SCHEDULE_SET', subjectType: 'care_plan_series', subjectId: id, correlationId: req.correlationId });
    await ensureNext(id);
    return { ok: true, state: await seriesState(id), message: 'Programação salva. Os avisos respeitarão as preferências do paciente e serão interrompidos na data definida.' };
  });

  app.get('/api/admin/carteira/reviews', async (req) => {
    requireRoles(req, [...STAFF, 'AUDITOR']);
    const rows = await all<any>(`SELECT r.*, u.name AS patient_name, (SELECT title FROM care_plan_items i WHERE i.series_id = r.series_id ORDER BY due_at LIMIT 1) AS title,
        (SELECT reminders_until FROM care_plan_items i WHERE i.series_id = r.series_id ORDER BY due_at LIMIT 1) AS reminders_until
      FROM care_plan_reviews r JOIN users u ON u.id = r.patient_id WHERE r.status = 'ABERTA' ORDER BY r.created_at LIMIT 200`);
    return { reviews: await Promise.all(rows.map(async (r) => ({ id: r.id, seriesId: r.series_id, kind: r.kind, note: r.note, createdAt: r.created_at, patientName: r.patient_name, title: r.title,
      state: await seriesState(r.series_id) }))) };
  });

  app.post('/api/admin/carteira/reviews/:id/resolve', async (req) => {
    const a = requireRoles(req, [...STAFF]);
    const { id } = parse(idParam, req.params);
    const { resolution } = parse(z.object({ resolution: z.string().trim().min(5, 'Descreva a providência.').max(500) }), req.body);
    const r = await run(`UPDATE care_plan_reviews SET status = 'RESOLVIDA', resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ? AND status = 'ABERTA'`, nowIso(), a.userId, resolution, id);
    if (!r.changes) throw conflict('REVIEW_CLOSED', 'Esta pendência já foi resolvida.');
    await audit({ actorId: a.userId, action: 'CARE_PLAN_REVIEW_RESOLVED', subjectType: 'care_plan_review', subjectId: id, correlationId: req.correlationId });
    return { ok: true };
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
