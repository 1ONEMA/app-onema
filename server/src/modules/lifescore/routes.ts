/**
 * Rotas do Life Score (três perfis). Identidade e permissões sempre pela sessão; nada de professional_id do cliente.
 *  - Especialista: só no atendimento que aceitou (credenciada); vê o histórico publicado do próprio paciente.
 *  - Paciente: só os próprios registros publicados (rascunho e prévia nunca aparecem).
 *  - Central: RT vê conteúdo clínico (auditado); Operação/Admin veem estados, sem respostas nem textos clínicos.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, one, run, tx } from '../../db/db.ts';
import { audit } from '../../lib/audit.ts';
import { hasRole, parse, requireRoles } from '../../lib/context.ts';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.ts';
import { rateLimit } from '../../lib/security.ts';
import { nowIso, uid } from '../../lib/util.ts';
import { notify } from '../prime/core.ts';
import { notifyRole } from '../finance/payouts.ts';
import { primeActive } from '../care/report-share.ts';
import { LIFESCORE_BUILD, model, modelHash } from './core.ts';
import { partnerActive } from '../specialist/validation.ts';
import {
  DISCLAIMER, RESPONSE_CODES, cancelReminders, currentRelease, historyFor, modelView, newDraft, registerRelease, resultView, revokeRelease,
  runEvaluation, scheduleReminders, setPlanStatus, setSuspension, settingsState, syncScheduling,
} from './service.ts';

const idParam = z.object({ id: z.string().uuid() });
const ITEM_IDS = new Set<string>(model.items.map((i: any) => i.item_id));
const responsesSchema = z.record(z.string(), z.object({
  code: z.enum(RESPONSE_CODES), rationale: z.string().trim().max(500).optional(), naReason: z.string().trim().max(300).optional(),
})).refine((r) => Object.keys(r).every((k) => ITEM_IDS.has(k)), { message: 'Item desconhecido.' });
const planSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('RETORNO'), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.') }),
  z.object({ kind: z.literal('SEM_RETORNO') }),
  z.object({ kind: z.literal('DEFINIR_DEPOIS'), justification: z.string().trim().min(10, 'Justifique por que o retorno será definido depois.').max(500) }),
]);
const spToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export async function lifescoreRoutes(app: FastifyInstance) {
  // ---------------- Especialista ----------------
  async function ownEvent(req: any, id: string) {
    const a = requireRoles(req, ['ESPECIALISTA']);
    if (!await partnerActive(a.userId)) throw forbidden('Disponível para especialistas credenciadas.', 'NOT_CREDENTIALED');
    // Só atendimentos vigentes da própria profissional (cancelado/estornado não dá acesso ao histórico do paciente).
    const e = await one<any>(`SELECT e.id, e.status, e.modality, e.order_id, o.patient_id FROM care_events e JOIN service_orders o ON o.id = e.order_id
      WHERE e.id = ? AND e.specialist_id = ? AND e.status IN ('ACEITO','CONCLUIDO')`, id, a.userId);
    if (!e) throw notFound('Atendimento não encontrado.');
    return { a, e };
  }

  app.get('/api/lifescore/model', async (req) => {
    requireRoles(req, ['ESPECIALISTA', 'AVALIADOR_RT']);
    return modelView();
  });

  app.get('/api/care/specialist/events/:id/lifescore', async (req) => {
    const { id } = parse(idParam, req.params);
    const { e } = await ownEvent(req, id);
    const draft = await one<any>(`SELECT * FROM lifescore_assessments WHERE event_id = ? AND status = 'RASCUNHO'`, id);
    const publishedHere = await one<any>(`SELECT id, score_display, published_at, status FROM lifescore_assessments WHERE event_id = ? AND status IN ('PUBLICADA','ENCERRADA_SEM_SCORE') ORDER BY published_at DESC LIMIT 1`, id);
    const safety = await all<any>('SELECT id, level, reason, occurred_at FROM lifescore_safety_events WHERE event_id = ? ORDER BY occurred_at DESC', id);
    const evo = await one<any>('SELECT content_json, status FROM care_evolutions WHERE event_id = ?', id);
    const st = await settingsState();
    const release = await currentRelease();
    const synthetic = /@exemplo\.test$/i.test((await one<any>('SELECT email FROM users WHERE id = ?', e.patient_id))?.email ?? '');
    return {
      eventStatus: e.status, draft: draft ? { id: draft.id, revision: draft.revision, responses: JSON.parse(draft.responses_json), interpretation: draft.interpretation,
        patientSummary: draft.patient_summary, plan: { kind: draft.plan_kind, date: draft.plan_date, justification: draft.plan_justification }, supersedesId: draft.supersedes_id } : null,
      published: publishedHere, safetyEvents: safety, history: await historyFor(e.patient_id, { audience: 'PROFISSIONAL' }),
      evolution: evo ? { status: evo.status, content: JSON.parse(evo.content_json) } : null,
      calcSuspended: st.calcSuspended, environment: synthetic ? 'HOMOLOGACAO' : 'PRODUCAO', releaseActive: !!release, disclaimer: DISCLAIMER,
    };
  });

  /** Rascunho com controle de concorrência (revision). Salvar rascunho não publica nada. */
  app.put('/api/care/specialist/events/:id/lifescore', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ revision: z.number().int().min(0), responses: responsesSchema,
      interpretation: z.string().trim().max(2000).optional(), patientSummary: z.string().trim().max(1500).optional(),
      plan: z.object({ kind: z.enum(['RETORNO', 'SEM_RETORNO', 'DEFINIR_DEPOIS']).nullable().optional(), date: z.string().max(10).nullable().optional(), justification: z.string().max(500).nullable().optional() }).optional(),
    }), req.body);
    const { a, e } = await ownEvent(req, id);
    if (!['ACEITO', 'CONCLUIDO'].includes(e.status)) throw conflict('EVENT_NOT_ACTIVE', 'O Life Score é registrado em atendimentos aceitos por você.');
    if ((await settingsState()).calcSuspended) throw conflict('LIFESCORE_SUSPENDED', 'O Life Score está suspenso pelo RT. O atendimento e a evolução seguem normalmente.');
    return await tx(async () => {
      let d = await one<any>(`SELECT * FROM lifescore_assessments WHERE event_id = ? AND status = 'RASCUNHO' FOR UPDATE`, id);
      if (!d) { await newDraft(e, a.userId); d = (await one<any>(`SELECT * FROM lifescore_assessments WHERE event_id = ? AND status = 'RASCUNHO'`, id))!; }
      if (d.specialist_id !== a.userId) throw forbidden('Rascunho de outra profissional.');
      if (b.revision !== 0 && b.revision !== d.revision) throw conflict('STALE_REVISION', 'Este rascunho foi alterado em outra tela. Recarregue para continuar.');
      await run(`UPDATE lifescore_assessments SET responses_json = ?, interpretation = ?, patient_summary = ?, plan_kind = ?, plan_date = ?, plan_justification = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
        JSON.stringify(b.responses), b.interpretation ?? null, b.patientSummary ?? null, b.plan?.kind ?? null, b.plan?.date ?? null, b.plan?.justification ?? null, nowIso(), d.id);
      return { id: d.id, revision: d.revision + 1, saved: true };
    });
  });

  /** Prévia: número e domínios só para a profissional (não é publicação nem histórico). */
  app.post('/api/care/specialist/events/:id/lifescore/preview', async (req) => {
    const { id } = parse(idParam, req.params);
    await ownEvent(req, id);
    const d = await one<any>(`SELECT * FROM lifescore_assessments WHERE event_id = ? AND status = 'RASCUNHO'`, id);
    if (!d) throw notFound('Salve o rascunho antes da prévia.');
    return { preview: resultView(await runEvaluation(d)) };
  });

  /** Preocupação de segurança: salva na hora, sem depender do formulário ou do score. */
  app.post('/api/care/specialist/events/:id/safety-events', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ level: z.enum(['IMMEDIATE', 'PRIORITY']), reason: z.string().trim().min(5, 'Descreva a preocupação.').max(1000) }), req.body);
    const { a, e } = await ownEvent(req, id);
    if (!await rateLimit(`ls-safety:${a.userId}`, 10, 3600_000)) throw new AppError(429, 'RATE_LIMIT', 'Muitos registros em pouco tempo. Se for urgente, ligue para a Central ONEMA.');
    const sid = uid(); const now = nowIso();
    await run('INSERT INTO lifescore_safety_events (id, patient_id, event_id, specialist_id, level, reason, occurred_at, created_at) VALUES (?,?,?,?,?,?,?,?)',
      sid, e.patient_id, id, a.userId, b.level, b.reason, now, now);
    await audit({ actorId: a.userId, action: 'LIFESCORE_SAFETY_EVENT', subjectType: 'care_event', subjectId: id, correlationId: req.correlationId, meta: { level: b.level } });
    await notifyRole(['AVALIADOR_RT', 'OPERADOR_CENTRAL'], b.level === 'IMMEDIATE' ? 'Preocupação de segurança: ação imediata' : 'Preocupação de segurança: prioridade',
      'Uma especialista registrou uma preocupação de segurança em atendimento. Veja em Central › Life Score.');
    return { id: sid, saved: true };
  });

  /**
   * Finalizar e publicar. Idempotente: repetir o clique devolve a mesma publicação.
   * Sem cálculo possível: devolve os motivos (nunca zero); a enfermeira pode encerrar sem score com justificativa.
   */
  app.post('/api/care/specialist/events/:id/lifescore/finalize', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({
      confirm: z.literal(true, { message: 'Confirme que revisou as respostas, a interpretação e o resumo.' }),
      revision: z.number().int().min(1),
      interpretation: z.string().trim().min(10, 'Registre a sua interpretação profissional.').max(2000).optional(),
      patientSummary: z.string().trim().min(20, 'Revise o resumo que o paciente vai ler (mínimo 20 caracteres).').max(1500).optional(),
      plan: planSchema.optional(),
      closeWithoutScore: z.string().trim().min(10, 'Justifique o encerramento sem score.').max(500).optional(),
    }), req.body);
    const { a, e } = await ownEvent(req, id);
    if ((await settingsState()).calcSuspended) throw conflict('LIFESCORE_SUSPENDED', 'O Life Score está suspenso pelo RT.');
    const out = await tx(async () => {
      const d = await one<any>(`SELECT * FROM lifescore_assessments WHERE event_id = ? AND status = 'RASCUNHO' FOR UPDATE`, id);
      if (!d) {
        const last = await one<any>(`SELECT id, status, score_display FROM lifescore_assessments WHERE event_id = ? AND specialist_id = ? AND status IN ('PUBLICADA','ENCERRADA_SEM_SCORE') ORDER BY published_at DESC LIMIT 1`, id, a.userId);
        if (last) return { already: true, id: last.id, status: last.status, score: last.score_display };
        throw notFound('Nenhum rascunho para finalizar.');
      }
      if (d.specialist_id !== a.userId) throw forbidden('Rascunho de outra profissional.');
      if (b.revision !== d.revision) throw conflict('STALE_REVISION', 'O rascunho mudou desde a prévia. Revise antes de publicar.');
      const now = nowIso();
      const result = await runEvaluation(d, now);
      if (b.closeWithoutScore) {
        await run(`UPDATE lifescore_assessments SET status = 'ENCERRADA_SEM_SCORE', result_json = ?, calculation_status = ?, safety_level = ?, close_reason = ?, published_at = ?, updated_at = ? WHERE id = ?`,
          JSON.stringify(result), result.calculation_status, result.safety.level, b.closeWithoutScore, now, now, d.id);
        await audit({ actorId: a.userId, action: 'LIFESCORE_CLOSED_WITHOUT_SCORE', subjectType: 'lifescore_assessment', subjectId: d.id, correlationId: req.correlationId });
        return { id: d.id, status: 'ENCERRADA_SEM_SCORE', result: resultView(result) };
      }
      if (result.calculation_status !== 'CALCULABLE_DESCRIPTIVE') {
        throw unprocessable('NOT_CALCULABLE', 'Não calculável: revise os itens indicados ou encerre sem score com justificativa.', resultView(result).issues);
      }
      if (!b.interpretation || !b.patientSummary || !b.plan) throw unprocessable('FINALIZE_FIELDS_REQUIRED', 'Preencha a interpretação, o resumo ao paciente e o plano.');
      if (b.plan.kind === 'RETORNO' && b.plan.date < spToday()) throw unprocessable('INVALID_PLAN_DATE', 'A data de retorno não pode ser anterior a hoje.');
      if (b.plan.kind === 'RETORNO' && b.plan.date > new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10)) throw unprocessable('INVALID_PLAN_DATE', 'Data de retorno muito distante.');
      await run(`UPDATE lifescore_assessments SET status = 'PUBLICADA', result_json = ?, calculation_status = ?, score_raw = ?, score_display = ?, safety_level = ?, interpretation = ?, patient_summary = ?,
          plan_kind = ?, plan_date = ?, plan_justification = ?, plan_status = ?, plan_status_at = ?, published_at = ?, updated_at = ? WHERE id = ?`,
        JSON.stringify(result), result.calculation_status, result.raw_score, result.score_display.toFixed(2), result.safety.level, b.interpretation, b.patientSummary,
        b.plan.kind, b.plan.kind === 'RETORNO' ? b.plan.date : null, b.plan.kind === 'DEFINIR_DEPOIS' ? b.plan.justification : null,
        b.plan.kind === 'SEM_RETORNO' ? 'ENCERRADO_SEM_RESPOSTA' : 'VIGENTE', now, now, now, d.id);
      // Nova avaliação substitui o plano anterior (lembretes antigos cancelados); retificação marca a original.
      for (const old of await all<any>(`SELECT * FROM lifescore_assessments WHERE patient_id = ? AND status = 'PUBLICADA' AND id <> ? AND plan_status = 'VIGENTE'`, e.patient_id, d.id)) {
        await setPlanStatus(old, 'SUBSTITUIDO', 'Nova avaliação publicada.');
      }
      if (d.supersedes_id) {
        await run(`UPDATE lifescore_assessments SET status = 'RETIFICADA', superseded_by = ?, updated_at = ? WHERE id = ? AND status = 'PUBLICADA'`, d.id, now, d.supersedes_id);
        await cancelReminders(d.supersedes_id, 'Avaliação retificada.');
      }
      if (b.plan.kind === 'RETORNO') await scheduleReminders(d.id, e.patient_id, b.plan.date);
      await audit({ actorId: a.userId, action: d.supersedes_id ? 'LIFESCORE_RECTIFIED' : 'LIFESCORE_PUBLISHED', subjectType: 'lifescore_assessment', subjectId: d.id, correlationId: req.correlationId,
        meta: { model: model.model_id, build: LIFESCORE_BUILD, environment: d.environment, plan: b.plan.kind } });
      await notify(e.patient_id, 'ESSENCIAL', 'Avaliação de enfermagem disponível', 'Uma nova avaliação de enfermagem foi publicada em Meu acompanhamento.');
      return { id: d.id, status: 'PUBLICADA', result: resultView(result) };
    });
    return out;
  });

  /** Retificação (autora ou RT): nova versão com motivo; a original continua no histórico. */
  app.post('/api/lifescore/assessments/:id/rectify', async (req) => {
    const a = requireRoles(req, ['ESPECIALISTA', 'AVALIADOR_RT']);
    const { id } = parse(idParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(10, 'Explique o motivo da retificação.').max(500) }), req.body);
    return await tx(async () => {
      const o = await one<any>(`SELECT * FROM lifescore_assessments WHERE id = ? AND status = 'PUBLICADA'`, id);
      if (!o) throw notFound('Avaliação publicada não encontrada.');
      const latest = await one<any>(`SELECT id FROM lifescore_assessments WHERE patient_id = ? AND status = 'PUBLICADA' ORDER BY published_at DESC LIMIT 1`, o.patient_id);
      if (latest?.id !== o.id) throw conflict('NOT_LATEST', 'Só a avaliação publicada mais recente pode ser retificada. Para corrigir outra, registre uma nova avaliação.');
      if (o.specialist_id !== a.userId && !hasRole(a, 'AVALIADOR_RT')) throw notFound('Avaliação publicada não encontrada.');
      if (o.specialist_id !== a.userId) throw forbidden('A retificação é feita pela autora; o RT registra a solicitação.', 'AUTHOR_ONLY');
      if (await one(`SELECT 1 AS ok FROM lifescore_assessments WHERE event_id = ? AND status = 'RASCUNHO'`, o.event_id)) throw conflict('DRAFT_EXISTS', 'Já existe um rascunho neste atendimento.');
      const e = (await one<any>(`SELECT e.id, e.modality, e.order_id, o.patient_id FROM care_events e JOIN service_orders o ON o.id = e.order_id WHERE e.id = ?`, o.event_id))!;
      const nid = await newDraft(e, a.userId, { id: o.id, responses_json: o.responses_json, reason });
      await audit({ actorId: a.userId, action: 'LIFESCORE_RECTIFICATION_STARTED', subjectType: 'lifescore_assessment', subjectId: o.id, correlationId: req.correlationId, meta: { reason } });
      return { draftId: nid };
    });
  });

  // ---------------- Paciente ----------------
  app.get('/api/lifescore/me', async (req) => {
    const a = requireRoles(req, ['PACIENTE']);
    await syncScheduling(a.userId);
    const history = await historyFor(a.userId, { includeRetified: true });
    const latest = history.find((h) => h.status === 'PUBLICADA') ?? null;
    const prime = await primeActive(a.userId);
    const reminders = latest && prime ? await all<any>(`SELECT wave, scheduled_at, status FROM lifescore_reminders WHERE assessment_id = ? ORDER BY wave`, latest.id) : [];
    return {
      latest, history, primeActive: prime, reminders, disclaimer: DISCLAIMER,
      emptyText: 'Seu acompanhamento estará disponível após uma avaliação de enfermagem finalizada.',
      primeNote: prime ? 'Como membro PRIME, você recebe lembretes perto da data prevista (se os lembretes estiverem ativos nas suas preferências).'
        : 'Membros PRIME recebem lembretes e convites para o retorno. A data prevista e a solicitação de atendimento continuam disponíveis para você.',
    };
  });

  app.post('/api/lifescore/me/:id/plan', async (req) => {
    const a = requireRoles(req, ['PACIENTE']);
    const { id } = parse(idParam, req.params);
    const { action } = parse(z.object({ action: z.enum(['RECUSAR_LEMBRETES', 'RECUSAR_ACOMPANHAMENTO']) }), req.body);
    const p = await one<any>(`SELECT * FROM lifescore_assessments WHERE id = ? AND patient_id = ? AND status = 'PUBLICADA'`, id, a.userId);
    if (!p) throw notFound('Avaliação não encontrada.');
    if (action === 'RECUSAR_LEMBRETES') {
      await run('UPDATE lifescore_assessments SET reminders_opt_out = 1, updated_at = ? WHERE id = ?', nowIso(), id);
      await cancelReminders(id, 'Paciente recusou os lembretes.');
    } else if (p.plan_status === 'VIGENTE') await setPlanStatus(p, 'RECUSADO', 'Paciente recusou o acompanhamento.');
    await audit({ actorId: a.userId, action: `LIFESCORE_${action}`, subjectType: 'lifescore_assessment', subjectId: id, correlationId: req.correlationId });
    return { ok: true };
  });

  // ---------------- Central / RT ----------------
  const CENTRAL = ['AVALIADOR_RT', 'OPERADOR_CENTRAL', 'ADMIN_PRIME', 'AUDITOR'] as const;
  app.get('/api/admin/lifescore', async (req) => {
    const a = requireRoles(req, [...CENTRAL]);
    const f = parse(z.object({ status: z.string().max(30).optional(), from: z.string().max(10).optional(), to: z.string().max(10).optional(), q: z.string().max(80).optional() }), req.query);
    const clinical = hasRole(a, 'AVALIADOR_RT');
    const where: string[] = [], args: any[] = [];
    if (f.status) { where.push('a.status = ?'); args.push(f.status); }
    if (f.from) { where.push('a.updated_at >= ?'); args.push(f.from); }
    if (f.to) { where.push('a.updated_at <= ?'); args.push(`${f.to}T23:59:59`); }
    if (f.q) { where.push('(lower(p.name) LIKE ? OR lower(s.name) LIKE ?)'); args.push(`%${f.q.toLowerCase()}%`, `%${f.q.toLowerCase()}%`); }
    const rows = await all<any>(`SELECT a.id, a.status, a.environment, a.score_display, a.safety_level, a.plan_kind, a.plan_date, a.plan_status, a.created_at, a.updated_at, a.published_at,
        a.supersedes_id, p.name AS patient, s.name AS specialist
      FROM lifescore_assessments a JOIN users p ON p.id = a.patient_id JOIN users s ON s.id = a.specialist_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.updated_at DESC LIMIT 300`, ...args);
    const first = (n: string) => (clinical ? n : String(n).split(' ')[0]);
    const safety = (await all<any>(`SELECT x.id, x.level, x.occurred_at, x.handled_at, ${clinical ? 'x.handled_note, x.reason,' : ''} p.name AS patient, s.name AS specialist
      FROM lifescore_safety_events x JOIN users p ON p.id = x.patient_id JOIN users s ON s.id = x.specialist_id ORDER BY (x.handled_at IS NULL) DESC, x.occurred_at DESC LIMIT 100`))
      .map((x) => ({ ...x, patient: first(x.patient) }));
    const reminders = (await all<any>(`SELECT r.id, r.wave, r.plan_date, r.scheduled_at, r.status, r.status_reason, r.attempts, r.last_error, p.name AS patient
      FROM lifescore_reminders r JOIN users p ON p.id = r.patient_id ORDER BY (r.status = 'FALHOU') DESC, r.scheduled_at DESC LIMIT 200`)).map((r) => ({ ...r, patient: first(r.patient) }));
    const st = await settingsState();
    const release = await currentRelease();
    return {
      clinical, suspension: st, release: release ? { approvedBy: release.approved_by, approvedAt: release.approved_at, uat: release.uat_report_ref, rt: release.rt_approval_ref, build: release.app_build } : null,
      build: LIFESCORE_BUILD, modelId: model.model_id, modelHash,
      assessments: rows.map((r) => ({ ...r, patient: clinical ? r.patient : r.patient.split(' ')[0], score_display: clinical ? r.score_display : undefined,
        stale: r.status === 'RASCUNHO' && Date.now() - new Date(r.updated_at).getTime() > 24 * 3600_000 })),
      safety, reminders,
    };
  });

  app.get('/api/admin/lifescore/assessments/:id', async (req) => {
    const a = requireRoles(req, ['AVALIADOR_RT']);
    const { id } = parse(idParam, req.params);
    const r = await one<any>(`SELECT a.*, p.name AS patient, s.name AS specialist FROM lifescore_assessments a JOIN users p ON p.id = a.patient_id JOIN users s ON s.id = a.specialist_id WHERE a.id = ?`, id);
    if (!r) throw notFound('Avaliação não encontrada.');
    await audit({ actorId: a.userId, action: 'LIFESCORE_VIEWED_BY_RT', subjectType: 'lifescore_assessment', subjectId: id, correlationId: req.correlationId });
    const trail = await all<any>(`SELECT action, actor_id, occurred_at FROM audit_events WHERE subject_id = ? ORDER BY seq`, id);
    return { assessment: { ...r, responses: JSON.parse(r.responses_json), result: r.result_json ? resultView(JSON.parse(r.result_json)) : null }, trail };
  });

  app.post('/api/admin/lifescore/safety-events/:id/handled', async (req) => {
    const a = requireRoles(req, ['AVALIADOR_RT', 'OPERADOR_CENTRAL']);
    const { id } = parse(idParam, req.params);
    const { note } = parse(z.object({ note: z.string().trim().min(5).max(500) }), req.body);
    const r = await run('UPDATE lifescore_safety_events SET handled_by = ?, handled_at = ?, handled_note = ? WHERE id = ? AND handled_at IS NULL', a.userId, nowIso(), note, id);
    if (!r.changes) throw conflict('ALREADY_HANDLED', 'Esta ocorrência já foi tratada.');
    await audit({ actorId: a.userId, action: 'LIFESCORE_SAFETY_HANDLED', subjectType: 'lifescore_safety_event', subjectId: id, correlationId: req.correlationId });
    return { ok: true };
  });

  app.post('/api/admin/lifescore/suspension', async (req) => {
    const a = requireRoles(req, ['AVALIADOR_RT']);
    const b = parse(z.object({ calc: z.boolean(), reminders: z.boolean(), reason: z.string().trim().min(10, 'Justifique (fica na auditoria).').max(500) }), req.body);
    await setSuspension(a.userId, b, req.correlationId);
    return await settingsState();
  });

  app.post('/api/admin/lifescore/release', async (req) => {
    const a = requireRoles(req, ['AVALIADOR_RT']);
    const b = parse(z.object({
      uatReportRef: z.string().trim().min(5, 'Informe a referência do relatório de homologação.').max(200),
      rtApprovalRef: z.string().trim().min(5, 'Informe a referência da aprovação do RT.').max(200),
      confirm: z.literal(true, { message: 'Confirme que a homologação foi concluída.' }),
    }), req.body);
    const id = await registerRelease(a.userId, b, req.correlationId);
    return { id, release: await currentRelease() };
  });

  app.post('/api/admin/lifescore/release/revoke', async (req) => {
    const a = requireRoles(req, ['AVALIADOR_RT']);
    const { reason } = parse(z.object({ reason: z.string().trim().min(10).max(500) }), req.body);
    return { revoked: await revokeRelease(a.userId, reason, req.correlationId) };
  });
}
