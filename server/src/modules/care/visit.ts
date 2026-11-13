/**
 * Visita e registro clínico do atendimento (especialista ONEMA ONE credenciada):
 * - Início da visita presencial com o código de 6 dígitos que o paciente vê no app (+ localização opcional, com consentimento).
 * - Evolução de enfermagem: ditado → Kary organiza → enfermeira revisa e assina → aparece na Carteira do paciente.
 */
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, run, tx } from '../../db/db.ts';
import { audit } from '../../lib/audit.ts';
import { openField } from '../../lib/security.ts';
import { parse, requireRoles } from '../../lib/context.ts';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.ts';
import { rateLimit, safeEqual } from '../../lib/security.ts';
import { nowIso, uid } from '../../lib/util.ts';
import { notify } from '../prime/core.ts';
import { EMPTY_EVOLUTION, EVOLUTION_MODEL, EvolutionSchema, FAILURE_TEXT, type OrganizeFailure, evolutionAiEnabled, organizeDictation } from './evolution-ai.ts';
import { runInBackground } from '../../lib/background.ts';
import { partnerActive } from '../specialist/validation.ts';

const idParam = z.object({ id: z.string().uuid() });

async function credentialedSpecialist(req: any) {
  const a = requireRoles(req, ['ESPECIALISTA']);
  if (!await partnerActive(a.userId)) throw forbidden('Seu perfil ainda não foi credenciado pela Central ONEMA.', 'NOT_CREDENTIALED');
  return a;
}

/** Evento aceito por esta especialista (senão 404: não revela eventos de outras pessoas). */
async function myEvent(eventId: string, userId: string) {
  const e = await one<any>(`SELECT e.*, o.patient_id, o.item_name FROM care_events e JOIN service_orders o ON o.id = e.order_id WHERE e.id = ?`, eventId);
  if (!e || e.specialist_id !== userId) throw notFound('Atendimento não encontrado.');
  return e;
}

/** Organização parada há mais de 3 minutos é tratada como tempo esgotado (a Function pode ter sido encerrada). */
const stale = (at: string | null) => !at || Date.now() - new Date(at).getTime() > 180_000;
const evolutionView = (v: any) => {
  if (!v) return null;
  const aiStatus = v.ai_status === 'PROCESSANDO' && stale(v.ai_requested_at) ? 'FALHOU' : v.ai_status ?? null;
  const aiError = aiStatus === 'FALHOU' ? (v.ai_status === 'PROCESSANDO' ? 'TEMPO_ESGOTADO' : v.ai_error) : null;
  return {
    id: v.id, status: v.status, dictation: v.dictation, content: JSON.parse(v.content_json), aiUsed: !!v.ai_used, signedAt: v.signed_at, updatedAt: v.updated_at,
    aiStatus, aiMessage: aiError ? FAILURE_TEXT[aiError as OrganizeFailure] ?? FAILURE_TEXT.INDISPONIVEL : aiStatus === 'OK' ? 'A Kary organizou o ditado. Revise cada seção, corrija o que for preciso e assine.' : null,
  };
};

/** Código numérico de 6 dígitos para o início da visita (gerado no aceite). */
export const newVisitCode = () => String(crypto.randomInt(100000, 1000000));

export async function visitRoutes(app: FastifyInstance) {
  app.post('/api/care/specialist/events/:id/start', async (req) => {
    const a = await credentialedSpecialist(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({
      code: z.string().trim().regex(/^\d{6}$/, 'Digite os 6 números do código mostrado pelo paciente.').optional(),
      location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracy: z.number().min(0).max(100000) }).optional(),
    }), req.body ?? {});
    // Conferência do código FORA da transação: tentativas erradas contam e ficam auditadas mesmo com o erro.
    const e = await myEvent(id, a.userId);
    if (e.status !== 'ACEITO') throw conflict('EVENT_NOT_ACCEPTED', 'Só é possível iniciar um atendimento aceito por você.');
    if (e.started_at) throw conflict('ALREADY_STARTED', 'Este atendimento já foi iniciado.');
    if (e.modality === 'PRESENCIAL') {
      if (!await rateLimit(`visit-code:${id}`, 5, 15 * 60_000)) throw new AppError(429, 'RATE_LIMIT', 'Muitas tentativas. Aguarde 15 minutos ou fale com a Central ONEMA.');
      if (!b.code || !e.visit_code || !safeEqual(b.code, e.visit_code)) {
        await audit({ actorId: a.userId, action: 'VISIT_CODE_INVALID', subjectType: 'care_event', subjectId: id, correlationId: req.correlationId });
        throw unprocessable('INVALID_VISIT_CODE', 'Código incorreto. Peça ao paciente o código que aparece no app dele.');
      }
    }
    return await tx(async () => {
      const now = nowIso();
      // Localização arredondada (~100 m): confirma a presença sem guardar o endereço exato.
      const loc = b.location ? [Math.round(b.location.lat * 1000) / 1000, Math.round(b.location.lng * 1000) / 1000, Math.round(b.location.accuracy)] : [null, null, null];
      const r = await run(`UPDATE care_events SET started_at = ?, start_lat = ?, start_lng = ?, start_accuracy_m = ?, updated_at = ? WHERE id = ? AND status = 'ACEITO' AND started_at IS NULL`, now, ...loc, now, id);
      if (!r.changes) throw conflict('ALREADY_STARTED', 'Este atendimento já foi iniciado.');
      await audit({ actorId: a.userId, action: 'VISIT_STARTED', subjectType: 'care_event', subjectId: id, correlationId: req.correlationId, meta: { located: !!b.location } });
      const sp = await one<any>('SELECT name FROM users WHERE id = ?', a.userId);
      await notify(e.patient_id, 'ESSENCIAL', 'Atendimento iniciado', `${sp?.name ?? 'A especialista ONEMA'} iniciou o atendimento "${e.label}" (${e.item_name}).`);
      return { ok: true, startedAt: now };
    });
  });

  app.get('/api/care/specialist/events/:id/evolution', async (req) => {
    const a = await credentialedSpecialist(req);
    const { id } = parse(idParam, req.params);
    const e = await myEvent(id, a.userId);
    const v = await one<any>('SELECT * FROM care_evolutions WHERE event_id = ?', id);
    // Endereço completo, contato e janela só para a especialista que aceitou (antes do aceite, a oferta mostra apenas a região).
    const r = await one<any>(`SELECT r.patient_name, r.phone, r.location, r.address_sealed, r.when_pref, r.when_date, r.time_window, r.notes FROM care_requests r
      JOIN service_orders o ON o.request_id = r.id WHERE o.id = ?`, e.order_id);
    const visit = r && ['ACEITO', 'CONCLUIDO'].includes(e.status) ? { patientName: r.patient_name, phone: r.phone, location: r.location,
      address: r.address_sealed ? JSON.parse(openField(r.address_sealed)) : null, whenPref: r.when_pref, whenDate: r.when_date, timeWindow: r.time_window, notes: r.notes } : null;
    return { event: { id: e.id, label: e.label, itemName: e.item_name, modality: e.modality, status: e.status, startedAt: e.started_at,
        patientSignedAt: e.patient_signed_at, patientSignatureName: e.patient_signature_name, completedAt: e.completed_at,
        callScheduledAt: e.call_scheduled_at, callStartedAt: e.call_started_at, callEndedAt: e.call_ended_at }, visit,
      evolution: evolutionView(v), aiEnabled: evolutionAiEnabled() };
  });

  /**
   * Kary organiza o ditado em seções, em segundo plano: o rascunho é salvo na hora com o ditado e a tela
   * acompanha (GET .../evolution) até a organização terminar ou informar o motivo da falha.
   */
  app.post('/api/care/specialist/events/:id/evolution/organize', async (req, reply) => {
    const a = await credentialedSpecialist(req);
    const { id } = parse(idParam, req.params);
    const { dictation } = parse(z.object({ dictation: z.string().trim().min(20, 'Dite ou escreva a evolução (pelo menos uma frase completa).').max(8000) }), req.body);
    const e = await myEvent(id, a.userId);
    if (e.status !== 'ACEITO') throw conflict('EVENT_NOT_ACCEPTED', 'A evolução é registrada durante o atendimento aceito por você.');
    const cur = await one<any>('SELECT * FROM care_evolutions WHERE event_id = ?', id);
    if (cur?.status === 'ASSINADA') throw conflict('EVOLUTION_SIGNED', 'A evolução deste atendimento já foi assinada.');
    if (cur?.ai_status === 'PROCESSANDO' && !stale(cur.ai_requested_at)) throw conflict('AI_BUSY', 'A Kary ainda está organizando o ditado anterior. Aguarde alguns segundos.');
    if (!evolutionAiEnabled()) {
      const v = await saveDraft(e, a.userId, dictation, cur ? JSON.parse(cur.content_json) : { ...EMPTY_EVOLUTION, observacoes: dictation }, false);
      await run(`UPDATE care_evolutions SET ai_status = 'FALHOU', ai_error = 'NAO_CONFIGURADA' WHERE id = ?`, v.id);
      return { evolution: evolutionView(await one<any>('SELECT * FROM care_evolutions WHERE id = ?', v.id)) };
    }
    if (!await rateLimit(`evolution-ai:${a.userId}`, 40, 3600_000)) throw new AppError(429, 'RATE_LIMIT', 'Muitas organizações em pouco tempo. Aguarde alguns minutos.');
    const v = await saveDraft(e, a.userId, dictation, cur ? JSON.parse(cur.content_json) : { ...EMPTY_EVOLUTION }, !!cur?.ai_used);
    await run(`UPDATE care_evolutions SET ai_status = 'PROCESSANDO', ai_error = NULL, ai_requested_at = ? WHERE id = ?`, nowIso(), v.id);
    const correlationId = req.correlationId;
    runInBackground(async () => {
      const r = await organizeDictation(dictation, { act: e.label, modality: e.modality });
      if ('evolution' in r) {
        await run(`UPDATE care_evolutions SET content_json = ?, ai_used = 1, ai_model = ?, ai_status = 'OK', ai_error = NULL, updated_at = ? WHERE id = ? AND status = 'RASCUNHO'`,
          JSON.stringify(r.evolution), EVOLUTION_MODEL, nowIso(), v.id);
        await audit({ actorId: a.userId, action: 'EVOLUTION_ORGANIZED_AI', subjectType: 'care_event', subjectId: id, correlationId });
      } else {
        // Sem perder o que foi dito: o ditado vai para "Observações" quando o rascunho ainda está vazio.
        const empty = !JSON.parse(v.content_json).observacoes && !JSON.parse(v.content_json).relato;
        const content = empty ? JSON.stringify({ ...JSON.parse(v.content_json), observacoes: dictation }) : v.content_json;
        await run(`UPDATE care_evolutions SET content_json = ?, ai_status = 'FALHOU', ai_error = ?, updated_at = ? WHERE id = ? AND status = 'RASCUNHO'`, content, r.failure, nowIso(), v.id);
        await audit({ actorId: a.userId, action: 'EVOLUTION_AI_FAILED', subjectType: 'care_event', subjectId: id, correlationId, meta: { failure: r.failure } });
      }
    });
    reply.code(202);
    return { evolution: evolutionView(await one<any>('SELECT * FROM care_evolutions WHERE id = ?', v.id)) };
  });

  app.put('/api/care/specialist/events/:id/evolution', async (req) => {
    const a = await credentialedSpecialist(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ dictation: z.string().max(8000).default(''), content: EvolutionSchema }), req.body);
    const e = await myEvent(id, a.userId);
    if (e.status !== 'ACEITO') throw conflict('EVENT_NOT_ACCEPTED', 'A evolução é registrada durante o atendimento aceito por você.');
    const cur = await one<any>('SELECT * FROM care_evolutions WHERE event_id = ?', id);
    if (cur?.status === 'ASSINADA') throw conflict('EVOLUTION_SIGNED', 'A evolução deste atendimento já foi assinada.');
    const v = await saveDraft(e, a.userId, b.dictation || cur?.dictation || '', b.content, !!cur?.ai_used);
    return { evolution: evolutionView(v) };
  });

  app.post('/api/care/specialist/events/:id/evolution/sign', async (req) => {
    const a = await credentialedSpecialist(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ content: EvolutionSchema, confirm: z.literal(true, { message: 'Confirme que revisou a evolução antes de assinar.' }) }), req.body);
    return await tx(async () => {
      const e = await myEvent(id, a.userId);
      if (e.status !== 'ACEITO') throw conflict('EVENT_NOT_ACCEPTED', 'A evolução é registrada durante o atendimento aceito por você.');
      if (e.modality === 'PRESENCIAL' && !e.started_at) throw unprocessable('VISIT_NOT_STARTED', 'Inicie o atendimento com o código do paciente antes de assinar a evolução.');
      const filled = [b.content.relato, b.content.avaliacao, b.content.procedimentos].some((x) => x.trim().length >= 5 && !/^não informado/i.test(x.trim()));
      if (!filled) throw unprocessable('EVOLUTION_EMPTY', 'Preencha ao menos o relato, a avaliação ou os procedimentos realizados.');
      const cur = await one<any>('SELECT * FROM care_evolutions WHERE event_id = ?', id);
      if (cur?.status === 'ASSINADA') throw conflict('EVOLUTION_SIGNED', 'A evolução deste atendimento já foi assinada.');
      const now = nowIso();
      const v = await saveDraft(e, a.userId, cur?.dictation ?? '', b.content, !!cur?.ai_used);
      await run(`UPDATE care_evolutions SET status = 'ASSINADA', signed_at = ?, updated_at = ? WHERE id = ?`, now, now, v.id);
      await audit({ actorId: a.userId, action: 'EVOLUTION_SIGNED', subjectType: 'care_event', subjectId: id, correlationId: req.correlationId, meta: { aiUsed: !!cur?.ai_used } });
      await notify(e.patient_id, 'ESSENCIAL', 'Nova evolução na sua Carteira Digital', `A evolução do atendimento "${e.label}" foi registrada e assinada pela especialista. Veja em Carteira Digital.`);
      return { evolution: evolutionView(await one<any>('SELECT * FROM care_evolutions WHERE id = ?', v.id)) };
    });
  });
}

async function saveDraft(e: any, specialistId: string, dictation: string, content: unknown, aiUsed: boolean) {
  const now = nowIso();
  const json = JSON.stringify(EvolutionSchema.parse(content));
  const cur = await one<any>('SELECT id FROM care_evolutions WHERE event_id = ?', e.id);
  if (cur) {
    await run('UPDATE care_evolutions SET dictation = ?, content_json = ?, ai_used = ?, ai_model = ?, updated_at = ? WHERE id = ?',
      dictation, json, aiUsed ? 1 : 0, aiUsed ? EVOLUTION_MODEL : null, now, cur.id);
    return (await one<any>('SELECT * FROM care_evolutions WHERE id = ?', cur.id))!;
  }
  const id = uid();
  await run(`INSERT INTO care_evolutions (id, event_id, order_id, patient_id, specialist_id, dictation, content_json, ai_used, ai_model, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, id, e.id, e.order_id, e.patient_id, specialistId, dictation, json, aiUsed ? 1 : 0, aiUsed ? EVOLUTION_MODEL : null, 'RASCUNHO', now, now);
  return (await one<any>('SELECT * FROM care_evolutions WHERE id = ?', id))!;
}
