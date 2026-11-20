/**
 * Gestão › Agenda de pacotes (PAC-03, p. 7): agenda dos eventos, ondas, motivo de pendência e ações de programação,
 * antecipação, reoferta, reatribuição e contato. Toda ação exige motivo e fica no histórico do motor e na auditoria.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, one, run, tx } from '../../db/db.ts';
import { audit } from '../../lib/audit.ts';
import { parse, requireRoles } from '../../lib/context.ts';
import { conflict, notFound, unprocessable } from '../../lib/errors.ts';
import { nowIso } from '../../lib/util.ts';
import { notify } from '../prime/core.ts';
import { ENGINE_DEFAULTS, engineParams, eventState, offerLog, publishOffer, runOfferSweep, saveEngineParams, windowText } from './offer-engine.ts';

const VIEW = ['OPERADOR_CENTRAL', 'ADMIN_PRIME', 'AVALIADOR_RT', 'AUDITOR'] as const;
const ACT = ['OPERADOR_CENTRAL', 'ADMIN_PRIME', 'AVALIADOR_RT'] as const;
const idParam = z.object({ id: z.string().uuid() });
const note = z.string().trim().min(5, 'Descreva o motivo (mínimo 5 caracteres).').max(500);

async function loadEvent(id: string) {
  const e = await one<any>(`SELECT e.*, o.patient_id, o.status AS order_status FROM care_events e JOIN service_orders o ON o.id = e.order_id WHERE e.id = ? FOR UPDATE OF e`, id);
  if (!e) throw notFound('Evento não encontrado.');
  if (e.order_status !== 'PAID') throw conflict('ORDER_NOT_PAID', 'O pedido deste evento não está pago.');
  return e;
}

export async function offerAdminRoutes(app: FastifyInstance) {
  app.get('/api/admin/care/agenda', async (req) => {
    requireRoles(req, [...VIEW]);
    await runOfferSweep(true);
    const q = parse(z.object({ all: z.enum(['0', '1']).optional() }), req.query ?? {});
    const orders = await all<any>(`SELECT o.id, o.item_code, o.item_name, o.paid_at, o.acts_total, u.name AS patient_name, r.phone, r.protocol, r.location
      FROM service_orders o JOIN users u ON u.id = o.patient_id LEFT JOIN care_requests r ON r.id = o.request_id
      WHERE o.status = 'PAID' AND ${q.all === '1' ? 'TRUE' : `EXISTS (SELECT 1 FROM care_events x WHERE x.order_id = o.id AND x.status IN ('A_PROGRAMAR','DISPONIVEL','ACEITO'))`}
      ORDER BY o.paid_at DESC LIMIT 100`);
    const out = [];
    for (const o of orders) {
      const events = await all<any>(`SELECT e.*, su.name AS specialist_name, ru.name AS reference_name,
          (SELECT COUNT(*) FROM specialist_offer_declines d WHERE d.event_id = e.id) AS declines
        FROM care_events e LEFT JOIN users su ON su.id = e.specialist_id LEFT JOIN users ru ON ru.id = e.reference_specialist_id
        WHERE e.order_id = ? ORDER BY e.seq`, o.id);
      const logs = await all<any>(`SELECT l.event_id, l.kind, l.wave, l.note, l.created_at, su.name AS specialist_name, au.name AS actor_name FROM care_offer_log l
        LEFT JOIN users su ON su.id = l.specialist_id LEFT JOIN users au ON au.id = l.actor_id
        WHERE l.event_id IN (SELECT id FROM care_events WHERE order_id = ?) ORDER BY l.created_at DESC LIMIT 60`, o.id);
      out.push({
        id: o.id, itemCode: o.item_code, itemName: o.item_name, paidAt: o.paid_at, patientName: o.patient_name, phone: o.phone, protocol: o.protocol, location: o.location,
        events: events.map((e) => ({
          id: e.id, seq: e.seq, label: e.label, modality: e.modality, status: e.status, state: eventState(e), attention: e.attention, attentionAt: e.attention_at,
          window: e.window_start && e.window_end ? windowText(e.window_start, e.window_end) : null, windowStart: e.window_start, windowEnd: e.window_end,
          planValidatedAt: e.plan_validated_at, offerOpensAt: e.offer_opens_at, dependsOnSeq: e.depends_on_seq, wave: e.offer_wave, publishedAt: e.offer_published_at,
          reference: e.reference_name, referenceUntil: e.reference_until, declines: Number(e.declines), specialist: e.specialist_name, acceptedAt: e.accepted_at,
          scheduledAt: e.call_scheduled_at, scheduleStatus: e.schedule_status, startedAt: e.started_at, completedAt: e.completed_at,
          log: logs.filter((l) => l.event_id === e.id).slice(0, 12).map(({ event_id, ...l }) => l),
        })),
      });
    }
    return { orders: out, params: await engineParams() };
  });

  /** Programar (validar) a janela de um evento. A oferta abre na antecedência configurada, com a dependência satisfeita. */
  app.post('/api/admin/care/events/:id/plan', async (req) => {
    const a = requireRoles(req, [...ACT]);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ windowStart: z.string().datetime({ offset: true }), windowEnd: z.string().datetime({ offset: true }), opensAt: z.string().datetime({ offset: true }).nullable().optional(), note: note.optional() }), req.body);
    const start = new Date(b.windowStart), end = new Date(b.windowEnd);
    if (end <= start) throw unprocessable('INVALID_WINDOW', 'O fim da janela precisa ser depois do início.');
    if (end.getTime() <= Date.now()) throw unprocessable('INVALID_WINDOW', 'A janela precisa terminar no futuro.');
    return await tx(async () => {
      const e = await loadEvent(id);
      if (!['A_PROGRAMAR', 'DISPONIVEL'].includes(e.status)) throw conflict('EVENT_NOT_PLANNABLE', 'Só é possível programar eventos ainda sem especialista confirmada.');
      const params = await engineParams();
      const lead = (params.leadHours as any)[e.modality] ?? 24;
      const opensAt = b.opensAt ? new Date(b.opensAt).toISOString() : new Date(Math.max(Date.now(), start.getTime() - lead * 3600_000)).toISOString();
      const now = nowIso();
      // Reprogramar evento em oferta: pausa os convites atuais (voltam a abrir na nova data).
      await run(`UPDATE care_events SET status = 'A_PROGRAMAR', window_start = ?, window_end = ?, window_label = NULL, offer_opens_at = ?, plan_validated_at = ?, plan_validated_by = ?,
        attention = NULL, attention_at = NULL, reference_specialist_id = NULL, reference_until = NULL, updated_at = ? WHERE id = ?`,
        start.toISOString(), end.toISOString(), opensAt, now, a.userId, now, id);
      await offerLog(id, 'PROGRAMADA', { actorId: a.userId, note: `${windowText(start.toISOString(), end.toISOString())} · oferta abre ${new Date(opensAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' })}${b.note ? ` · ${b.note}` : ''}` });
      await audit({ actorId: a.userId, action: 'CARE_EVENT_PLANNED', subjectType: 'care_event', subjectId: id, correlationId: req.correlationId, meta: { windowStart: b.windowStart, windowEnd: b.windowEnd, opensAt } });
      await notify(e.patient_id, 'LEMBRETE', 'Atendimento programado', `"${e.label}" está previsto para ${windowText(start.toISOString(), end.toISOString())}. Avisaremos quando a especialista confirmar.`);
      return { ok: true };
    }).then(async (r) => { await runOfferSweep(true); return r; });
  });

  /** Antecipar o convite (ignora antecedência e dependência, conforme o plano). Exige janela futura. */
  app.post('/api/admin/care/events/:id/release', async (req) => {
    const a = requireRoles(req, [...ACT]);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ note }), req.body);
    return await tx(async () => {
      const e = await loadEvent(id);
      if (!['A_PROGRAMAR', 'DISPONIVEL'].includes(e.status)) throw conflict('EVENT_NOT_PLANNABLE', 'Este evento já tem especialista confirmada.');
      if (!e.window_end || new Date(e.window_end).getTime() <= Date.now()) throw unprocessable('WINDOW_REQUIRED', 'Programe uma janela futura antes de liberar a oferta.');
      // Reoferta: novos convites para toda a rede habilitada (recusas anteriores voltam a receber).
      await run('DELETE FROM specialist_offer_declines WHERE event_id = ?', id);
      await publishOffer(e, await engineParams(), a.userId, `Liberada pela Central: ${b.note}`);
      await audit({ actorId: a.userId, action: 'CARE_EVENT_OFFER_RELEASED', subjectType: 'care_event', subjectId: id, correlationId: req.correlationId, meta: { note: b.note } });
      return { ok: true };
    });
  });

  /** Reatribuir: retira a especialista (antes do início) e reabre só este evento. */
  app.post('/api/admin/care/events/:id/reassign', async (req) => {
    const a = requireRoles(req, [...ACT]);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ note }), req.body);
    return await tx(async () => {
      const e = await loadEvent(id);
      if (e.status !== 'ACEITO' || e.started_at) throw conflict('EVENT_NOT_REASSIGNABLE', 'Só é possível reatribuir atendimento confirmado e ainda não iniciado.');
      const now = nowIso();
      const prev = e.specialist_id;
      await run(`UPDATE care_events SET status = 'A_PROGRAMAR', specialist_id = NULL, accepted_at = NULL, visit_code = NULL, call_scheduled_at = NULL, schedule_status = NULL,
        schedule_change_at = NULL, attention = NULL, updated_at = ? WHERE id = ?`, now, id);
      await run('UPDATE payout_entries SET specialist_id = NULL, updated_at = ? WHERE event_id = ?', now, id);
      if (prev) await run('INSERT INTO specialist_offer_declines (event_id, specialist_id, reason, created_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING', id, prev, 'Reatribuído pela Central', now);
      await offerLog(id, 'REATRIBUIDA', { specialistId: prev, actorId: a.userId, note: b.note });
      if (prev) await notify(prev, 'ESSENCIAL', 'Atendimento reatribuído', `A Central ONEMA reatribuiu "${e.label}". Motivo: ${b.note}`);
      if (e.window_end && new Date(e.window_end).getTime() > Date.now()) await publishOffer({ ...e, status: 'A_PROGRAMAR' }, await engineParams(), a.userId, 'Reoferta após reatribuição.');
      else await run(`UPDATE care_events SET attention = 'JANELA_VENCIDA', attention_at = ? WHERE id = ?`, now, id);
      await audit({ actorId: a.userId, action: 'CARE_EVENT_REASSIGNED', subjectType: 'care_event', subjectId: id, correlationId: req.correlationId, meta: { previous: prev, note: b.note } });
      return { ok: true };
    });
  });

  /** Confirmar a agenda de um aceite registrado antes da regra (pendência REVISAR_AGENDA). */
  app.post('/api/admin/care/events/:id/confirm-agenda', async (req) => {
    const a = requireRoles(req, [...ACT]);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ note }), req.body);
    return await tx(async () => {
      const e = await loadEvent(id);
      if (!e.attention) throw conflict('NO_PENDING', 'Este evento não tem pendência.');
      await run('UPDATE care_events SET attention = NULL, attention_at = NULL, updated_at = ? WHERE id = ?', nowIso(), id);
      await offerLog(id, 'PENDENCIA_RESOLVIDA', { actorId: a.userId, note: b.note });
      await audit({ actorId: a.userId, action: 'CARE_EVENT_PENDING_RESOLVED', subjectType: 'care_event', subjectId: id, correlationId: req.correlationId, meta: { was: e.attention, note: b.note } });
      return { ok: true };
    });
  });

  /** Parâmetros do motor (faixas, prazo da referência, antecedência por modalidade). */
  app.put('/api/admin/care/offer-params', async (req) => {
    const a = requireRoles(req, ['ADMIN_PRIME', 'OPERADOR_CENTRAL']);
    const hour = z.number().int().min(0).max(24);
    const b = parse(z.object({
      faixas: z.object({ MANHA: z.tuple([hour, hour]), TARDE: z.tuple([hour, hour]), NOITE: z.tuple([hour, hour]), QUALQUER: z.tuple([hour, hour]) }),
      agoraHours: z.number().int().min(1).max(24), proximosDias: z.number().int().min(1).max(14), referenceMinutes: z.number().int().min(0).max(24 * 60),
      leadHours: z.object({ PRESENCIAL: z.number().int().min(0).max(24 * 14), REMOTO: z.number().int().min(0).max(24 * 14) }),
    }), req.body);
    for (const [k, [h0, h1]] of Object.entries(b.faixas)) if (h1 <= h0) throw unprocessable('INVALID_FAIXA', `Faixa ${k}: o fim precisa ser depois do início.`);
    await saveEngineParams(b);
    await audit({ actorId: a.userId, action: 'OFFER_ENGINE_PARAMS_CHANGED', subjectType: 'system_settings', subjectId: 'offer_engine_params', correlationId: req.correlationId, meta: b });
    return { ok: true, params: b, defaults: ENGINE_DEFAULTS };
  });
}
