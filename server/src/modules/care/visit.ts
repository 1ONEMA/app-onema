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
import { parse, requireRoles } from '../../lib/context.ts';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.ts';
import { rateLimit, safeEqual } from '../../lib/security.ts';
import { nowIso, uid } from '../../lib/util.ts';
import { notify } from '../prime/core.ts';
import { EMPTY_EVOLUTION, EVOLUTION_MODEL, EvolutionSchema, evolutionAiEnabled, organizeDictation } from './evolution-ai.ts';

const idParam = z.object({ id: z.string().uuid() });

async function credentialedSpecialist(req: any) {
  const a = requireRoles(req, ['ESPECIALISTA']);
  const t = await one<any>('SELECT credentialing_decision FROM partner_training_status WHERE partner_id = ?', a.userId);
  if (t?.credentialing_decision !== 'APTO') throw forbidden('Seu perfil ainda não foi credenciado pela Central ONEMA.', 'NOT_CREDENTIALED');
  return a;
}

/** Evento aceito por esta especialista (senão 404: não revela eventos de outras pessoas). */
async function myEvent(eventId: string, userId: string) {
  const e = await one<any>(`SELECT e.*, o.patient_id, o.item_name FROM care_events e JOIN service_orders o ON o.id = e.order_id WHERE e.id = ?`, eventId);
  if (!e || e.specialist_id !== userId) throw notFound('Atendimento não encontrado.');
  return e;
}

const evolutionView = (v: any) => v && ({
  id: v.id, status: v.status, dictation: v.dictation, content: JSON.parse(v.content_json), aiUsed: !!v.ai_used, signedAt: v.signed_at, updatedAt: v.updated_at,
});

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
    return { event: { id: e.id, label: e.label, itemName: e.item_name, modality: e.modality, status: e.status, startedAt: e.started_at },
      evolution: evolutionView(v), aiEnabled: evolutionAiEnabled() };
  });

  /** Kary organiza o ditado em seções (rascunho salvo). Sem IA configurada, o rascunho fica com o ditado para preenchimento manual. */
  app.post('/api/care/specialist/events/:id/evolution/organize', async (req) => {
    const a = await credentialedSpecialist(req);
    const { id } = parse(idParam, req.params);
    const { dictation } = parse(z.object({ dictation: z.string().trim().min(20, 'Dite ou escreva a evolução (pelo menos uma frase completa).').max(8000) }), req.body);
    const e = await myEvent(id, a.userId);
    if (e.status !== 'ACEITO') throw conflict('EVENT_NOT_ACCEPTED', 'A evolução é registrada durante o atendimento aceito por você.');
    const cur = await one<any>('SELECT status FROM care_evolutions WHERE event_id = ?', id);
    if (cur?.status === 'ASSINADA') throw conflict('EVOLUTION_SIGNED', 'A evolução deste atendimento já foi assinada.');
    if (!await rateLimit(`evolution-ai:${a.userId}`, 40, 3600_000)) throw new AppError(429, 'RATE_LIMIT', 'Muitas organizações em pouco tempo. Aguarde alguns minutos.');
    const organized = await organizeDictation(dictation, { act: e.label, modality: e.modality });
    const content = organized ?? { ...EMPTY_EVOLUTION, observacoes: dictation };
    const v = await saveDraft(e, a.userId, dictation, content, !!organized);
    await audit({ actorId: a.userId, action: organized ? 'EVOLUTION_ORGANIZED_AI' : 'EVOLUTION_DRAFT_MANUAL', subjectType: 'care_event', subjectId: id, correlationId: req.correlationId });
    return { evolution: evolutionView(v), ai: !!organized,
      message: organized ? 'A Kary organizou o ditado. Revise cada seção, corrija o que for preciso e assine.'
        : evolutionAiEnabled() ? 'A Kary não conseguiu organizar agora. O ditado foi guardado em "Observações": preencha as seções e assine.'
        : 'Organização por IA não configurada. O ditado foi guardado em "Observações": preencha as seções e assine.' };
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
