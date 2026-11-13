/**
 * Telenfermagem — API do episódio remoto (POP-ONEMA-TELE-001 v1.0). HOMOLOGAÇÃO: PROIBIDO USO CLÍNICO REAL.
 *
 * SOLICITADO → TRIAGEM → OFERTADO → ACEITO → AGENDADO → EM_ATENDIMENTO → AGUARDANDO_REGISTRO → ASSINADO → CONCLUIDO
 * Desvios: INELEGIVEL, RECUSADO, EXPIRADO, CANCELADO, NAO_COMPARECEU, FALHA_TECNICA, ENCAMINHADO_PRESENCIAL, URGENCIA_ENCAMINHADA.
 *
 * - Acesso negado por padrão: paciente titular, profissional designada (ou a quem a oferta foi feita, com dados mínimos)
 *   e Central/RT. Qualquer outro acesso recebe 404 e fica auditado.
 * - Sala temporária: token de 10 minutos (só o hash é guardado), sem gravação, sem expor telefone pessoal.
 * - Encerrar a chamada NÃO gera cobrança nem repasse; assinatura e fechamento são passos diferentes.
 * - Kary só sugere rascunho; a enfermeira revisa e assina.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { all, one, run, tx } from '../../db/db.ts';
import { config } from '../../config.ts';
import { audit } from '../../lib/audit.ts';
import { hasRole, parse, requireRoles, requireUser } from '../../lib/context.ts';
import { AppError, badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.ts';
import { hmac, rateLimit } from '../../lib/security.ts';
import { addHours, nowIso, protocol, randomToken, sha256, stableJson, uid } from '../../lib/util.ts';
import { notify } from '../prime/core.ts';
import { partnerActive } from '../specialist/validation.ts';
import { evolutionAiEnabled, FAILURE_TEXT, organizeDictation } from '../care/evolution-ai.ts';
import {
  EMPTY_TELE_NOTE, JOIN_EARLY_MS, MODALITIES, MODALITY_LABEL, NO_SHOW_POLICY, OFFER_HOURS, RETURN_WINDOW_DAYS, STATUS_LABEL, TELE_CONSENT_PURPOSE,
  TELE_CONSENT_VERSION, TELE_PROTOCOL_VERSION, TeleNoteSchema, TOKEN_TTL_MS, URGENCY_GUIDANCE, pricingDecision,
} from './core.ts';

const idParam = z.object({ id: z.string().uuid() });
const STAFF = ['OPERADOR_CENTRAL', 'AVALIADOR_RT'] as const;
const isStaff = (a: { roles: string[] }) => a.roles.some((r) => (STAFF as readonly string[]).includes(r));
const synthetic = (email: string) => /@exemplo\.test$/i.test(email);

async function credentialed(userId: string) {
  return await partnerActive(userId);
}

/** Homologação: sem aprovação formal, só pacientes sintéticos. */
async function assertSyntheticPatient(patientId: string) {
  if (config.teleRealUseApproved) return;
  const u = await one<any>('SELECT email FROM users WHERE id = ?', patientId);
  if (!u || !synthetic(u.email)) {
    throw forbidden('Telenfermagem em homologação: uso clínico real proibido. Use apenas contas de teste (@exemplo.test).', 'TELE_HOMOLOGATION_ONLY');
  }
}

type Access = 'PACIENTE' | 'PROFISSIONAL' | 'OFERTA' | 'CENTRAL';
/** Autorização por episódio e papel. Sem vínculo: 404 (não revela o episódio) + auditoria. */
async function load(req: FastifyRequest, id: string, allowed: Access[], forUpdate = false) {
  const a = requireUser(req);
  const e = await one<any>(`SELECT * FROM tele_episodes WHERE id = ?${forUpdate ? ' FOR UPDATE' : ''}`, id);
  let access: Access | null = null;
  if (e) {
    if (allowed.includes('CENTRAL') && isStaff(a)) access = 'CENTRAL';
    else if (allowed.includes('PROFISSIONAL') && e.professional_id === a.userId) access = 'PROFISSIONAL';
    else if (allowed.includes('PACIENTE') && e.patient_id === a.userId) access = 'PACIENTE';
    else if (allowed.includes('OFERTA') && e.status === 'OFERTADO' && hasRole(a, 'ESPECIALISTA') && (e.offered_to === a.userId || !e.offered_to)) access = 'OFERTA';
  }
  if (access === 'CENTRAL') requireRoles(req, [...STAFF]); // MFA dos perfis administrativos
  if (!e || !access) {
    await audit({ actorId: a.userId, action: 'TELE_ACCESS_DENIED', subjectType: 'tele_episode', subjectId: id, correlationId: req.correlationId });
    throw notFound('Teleatendimento não encontrado.');
  }
  return { a, e, access };
}

async function setStatus(e: any, to: string, extra: Record<string, unknown>, actorId: string | null, correlationId: string | null, from?: string[]) {
  const cols = Object.keys(extra);
  const now = nowIso();
  const states = from ?? [e.status];
  const r = await run(`UPDATE tele_episodes SET status = ?, ${cols.map((c) => `${c} = ?, `).join('')}updated_at = ? WHERE id = ? AND status IN (${states.map(() => '?').join(',')})`,
    to, ...cols.map((c) => extra[c] as any), now, e.id, ...states);
  if (!r.changes) throw conflict('TELE_STATE_CONFLICT', 'O teleatendimento mudou de situação. Atualize a tela.');
  await audit({ actorId, action: 'TELE_STATUS', subjectType: 'tele_episode', subjectId: e.id, correlationId, meta: { from: e.status, to } });
}

async function consentState(episodeId: string) {
  const c = await one<any>('SELECT decision, created_at, version FROM tele_consents WHERE episode_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', episodeId);
  return c ? { decision: c.decision as string, at: c.created_at as string, version: c.version as string } : null;
}

async function view(e: any, access: Access) {
  const ids = [e.patient_id, e.professional_id, e.origin_specialist_id].filter(Boolean);
  const names = await all<any>(`SELECT id, name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
  const nameOf = (id: string | null) => (id ? names.find((n) => n.id === id)?.name ?? null : null);
  const base = {
    id: e.id, protocol: e.protocol, modality: e.modality, modalityLabel: MODALITY_LABEL[e.modality as keyof typeof MODALITY_LABEL], status: e.status, statusLabel: STATUS_LABEL[e.status],
    windowUntil: e.window_until, scheduledAt: e.scheduled_at, timezone: e.timezone, homologation: !config.teleRealUseApproved,
  };
  // Oferta: dados mínimos para decidir o aceite (sem nome, contato ou conteúdo clínico).
  if (access === 'OFERTA') return { ...base, offerExpiresAt: e.offer_expires_at, preferred: e.offered_to === e.origin_specialist_id && !!e.offered_to };
  const notes = await all<any>('SELECT * FROM tele_notes WHERE episode_id = ? ORDER BY version', e.id);
  return {
    ...base, reason: e.reason, protocolVersion: e.protocol_version, patientName: nameOf(e.patient_id), professionalName: nameOf(e.professional_id),
    originSpecialistName: nameOf(e.origin_specialist_id), originEventId: e.origin_event_id,
    pricing: e.pricing_rule ? { rule: e.pricing_rule, priceCents: e.price_cents, reason: e.pricing_reason, acceptedAt: e.price_accepted_at } : null,
    eligibilityNote: access === 'PACIENTE' ? null : e.eligibility_note,
    consent: await consentState(e.id), consentText: { version: TELE_CONSENT_VERSION, purpose: TELE_CONSENT_PURPOSE },
    offeredTo: access === 'CENTRAL' ? nameOf(e.offered_to) ?? (e.status === 'OFERTADO' ? 'Rede credenciada' : null) : undefined, offerExpiresAt: e.offer_expires_at,
    callStartedAt: e.call_started_at, callEndedAt: e.call_ended_at, failures: e.failures, outcomeReason: e.outcome_reason, outcomePlan: e.outcome_plan, closedAt: e.closed_at,
    notes: notes.filter((n) => n.status === 'ASSINADA' || access !== 'PACIENTE').map((n) => ({
      id: n.id, kind: n.kind, version: n.version, status: n.status, aiSuggested: !!n.ai_suggested, signedAt: n.signed_at, contentHash: n.content_hash,
      content: JSON.parse(n.content_json), dictation: access === 'PACIENTE' ? undefined : n.dictation, parentNoteId: n.parent_note_id,
    })),
    urgencyGuidance: URGENCY_GUIDANCE,
  };
}

/** Oferta vencida: sai da profissional de preferência para a rede; janela vencida sem aceite: EXPIRADO. */
async function sweep(e: any) {
  if (e.status === 'OFERTADO' && Date.now() > new Date(e.window_until).getTime()) {
    await setStatus(e, 'EXPIRADO', { offered_to: null, closed_at: nowIso() }, null, null);
    return { ...e, status: 'EXPIRADO', offered_to: null };
  }
  if (e.status === 'OFERTADO' && e.offered_to && e.offer_expires_at && Date.now() > new Date(e.offer_expires_at).getTime()) {
    const exp = addHours(nowIso(), OFFER_HOURS);
    const r = await run(`UPDATE tele_episodes SET offered_to = NULL, offer_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'OFERTADO' AND offered_to = ?`, exp, nowIso(), e.id, e.offered_to);
    if (r.changes) await audit({ actorId: null, action: 'TELE_OFFER_REDISTRIBUTED', subjectType: 'tele_episode', subjectId: e.id, meta: { reason: 'PRAZO_VENCIDO' } });
    return { ...e, offered_to: null, offer_expires_at: exp };
  }
  return e;
}

export async function teleRoutes(app: FastifyInstance) {
  /** Indicação: enfermeira (a partir do atendimento presencial que concluiu) ou Central/RT. */
  app.post('/api/tele/episodes', async (req) => {
    const a = requireUser(req);
    const b = parse(z.object({
      modality: z.enum(MODALITIES),
      reason: z.string().trim().min(10, 'Descreva a justificativa clínica da indicação.').max(2000),
      windowDays: z.number().int().min(1).max(90).default(15),
      originEventId: z.string().uuid().optional(),
      patientEmail: z.string().trim().email().optional(),
    }), req.body);
    let patientId: string; let origin: any = null;
    if (b.originEventId) {
      origin = await one<any>(`SELECT e.id, e.specialist_id, e.status, e.completed_at, o.patient_id FROM care_events e JOIN service_orders o ON o.id = e.order_id WHERE e.id = ?`, b.originEventId);
      const mine = origin && origin.specialist_id === a.userId;
      if (!origin || (!mine && !isStaff(a))) throw notFound('Atendimento de origem não encontrado.');
      if (isStaff(a) && !mine) requireRoles(req, [...STAFF]);
      if (origin.status !== 'CONCLUIDO') throw unprocessable('ORIGIN_NOT_COMPLETED', 'A indicação de retorno parte de um atendimento presencial concluído.');
      patientId = origin.patient_id;
    } else {
      requireRoles(req, [...STAFF]);
      if (!b.patientEmail) throw badRequest('VALIDATION', 'Informe o atendimento de origem ou o e-mail do paciente.');
      const p = await one<any>(`SELECT u.id FROM users u WHERE lower(u.email) = lower(?)`, b.patientEmail);
      if (!p) throw notFound('Paciente não encontrado.');
      patientId = p.id;
    }
    if (hasRole(a, 'ESPECIALISTA') && !isStaff(a) && !await credentialed(a.userId)) throw forbidden('Seu perfil ainda não foi credenciado pela Central ONEMA.', 'NOT_CREDENTIALED');
    await assertSyntheticPatient(patientId);
    const id = uid(); const now = nowIso();
    await run(`INSERT INTO tele_episodes (id, protocol, patient_id, created_by, origin_event_id, origin_specialist_id, modality, protocol_version, reason, window_until, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, protocol('TELE'), patientId, a.userId, origin?.id ?? null, origin?.specialist_id ?? null, b.modality, TELE_PROTOCOL_VERSION,
      b.reason, new Date(Date.now() + b.windowDays * 86400000).toISOString(), 'SOLICITADO', now, now);
    await audit({ actorId: a.userId, action: 'TELE_REQUESTED', subjectType: 'tele_episode', subjectId: id, correlationId: req.correlationId, meta: { modality: b.modality } });
    const e = (await one<any>('SELECT * FROM tele_episodes WHERE id = ?', id))!;
    return { episode: await view(e, isStaff(a) ? 'CENTRAL' : 'PROFISSIONAL') };
  });

  /** Lista conforme o papel: paciente (os seus), especialista (designados + ofertas), Central/RT (todos). */
  app.get('/api/tele/episodes', async (req) => {
    const a = requireUser(req);
    const q = parse(z.object({ scope: z.enum(['paciente', 'profissional', 'central']).default('paciente') }), req.query);
    let rows: any[] = [];
    if (q.scope === 'central') { requireRoles(req, [...STAFF]); rows = await all<any>('SELECT * FROM tele_episodes ORDER BY updated_at DESC LIMIT 300'); }
    else if (q.scope === 'profissional') {
      requireRoles(req, ['ESPECIALISTA']);
      rows = await all<any>(`SELECT * FROM tele_episodes WHERE professional_id = ? OR origin_specialist_id = ? OR (status = 'OFERTADO' AND (offered_to = ? OR offered_to IS NULL OR offer_expires_at < ?))
        ORDER BY updated_at DESC LIMIT 200`, a.userId, a.userId, a.userId, nowIso());
      if (!await credentialed(a.userId)) rows = rows.filter((r) => r.professional_id === a.userId);
    } else rows = await all<any>('SELECT * FROM tele_episodes WHERE patient_id = ? ORDER BY created_at DESC LIMIT 100', a.userId);
    const out = [];
    for (let e of rows) {
      e = await sweep(e);
      const access: Access = q.scope === 'central' ? 'CENTRAL' : q.scope === 'paciente' ? 'PACIENTE'
        : e.professional_id === a.userId ? 'PROFISSIONAL' : e.status === 'OFERTADO' && (e.offered_to === a.userId || !e.offered_to) ? 'OFERTA' : null as any;
      if (!access) continue; // indicação feita por ela, mas já com outra profissional: não vê o conteúdo
      out.push(await view(e, access));
    }
    return { episodes: out, homologation: !config.teleRealUseApproved };
  });

  app.get('/api/tele/episodes/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const { a, e, access } = await load(req, id, ['PACIENTE', 'PROFISSIONAL', 'OFERTA', 'CENTRAL']);
    if (access !== 'OFERTA') await audit({ actorId: a.userId, action: 'TELE_VIEWED', subjectType: 'tele_episode', subjectId: id, correlationId: req.correlationId, meta: { access } });
    return { episode: await view(await sweep(e), access) };
  });

  /** Elegibilidade por protocolo e categoria profissional (Central/RT). Define a regra comercial versionada. */
  app.post('/api/tele/episodes/:id/eligibility', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ eligible: z.boolean(), note: z.string().trim().min(5, 'Registre o motivo da decisão.').max(1000) }), req.body);
    return await tx(async () => {
      const { a, e } = await load(req, id, ['CENTRAL'], true);
      if (e.status !== 'SOLICITADO') throw conflict('TELE_STATE_CONFLICT', 'A elegibilidade é decidida uma vez, na solicitação.');
      if (!b.eligible) {
        await setStatus(e, 'INELEGIVEL', { eligibility_note: b.note, eligibility_by: a.userId, closed_at: nowIso() }, a.userId, req.correlationId);
      } else {
        const origin = e.origin_event_id ? await one<any>('SELECT completed_at FROM care_events WHERE id = ?', e.origin_event_id) : null;
        const p = pricingDecision(e.modality, origin ? { completedAt: origin.completed_at } : null);
        await setStatus(e, 'TRIAGEM', { eligibility_note: b.note, eligibility_by: a.userId, pricing_rule: p.rule, price_cents: p.priceCents, pricing_reason: p.reason }, a.userId, req.correlationId);
        await audit({ actorId: a.userId, action: 'TELE_PRICING_DECIDED', subjectType: 'tele_episode', subjectId: id, correlationId: req.correlationId, meta: { rule: p.rule, priceCents: p.priceCents, version: TELE_PROTOCOL_VERSION } });
        await notify(e.patient_id, 'ESSENCIAL', 'Teleatendimento: confirme no app', 'Há um teleatendimento aguardando sua confirmação. Abra o app ONEMA para ver os detalhes.');
      }
      return { episode: await view((await one<any>('SELECT * FROM tele_episodes WHERE id = ?', id))!, 'CENTRAL') };
    });
  });

  /**
   * Consentimento (paciente) antes de qualquer ato: aceite com ciência do preço (quando cobrado) ou recusa/revogação documentada.
   * Aceite libera a oferta — primeiro à enfermeira de origem, depois à rede.
   */
  app.post('/api/tele/episodes/:id/consent', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ decision: z.enum(['ACEITO', 'RECUSADO', 'REVOGADO']), acceptedPriceCents: z.number().int().min(0).optional() }), req.body);
    return await tx(async () => {
      const { a, e } = await load(req, id, ['PACIENTE'], true);
      const now = nowIso();
      if (b.decision === 'ACEITO') {
        if (e.status !== 'TRIAGEM') throw conflict('TELE_STATE_CONFLICT', 'Este teleatendimento não está aguardando consentimento.');
        if (e.pricing_rule === 'COBRADO' && b.acceptedPriceCents !== e.price_cents) {
          throw unprocessable('PRICE_NOT_ACCEPTED', 'Confirme o valor informado antes de prosseguir.', { priceCents: e.price_cents });
        }
      } else if (b.decision === 'RECUSADO' && e.status !== 'TRIAGEM') throw conflict('TELE_STATE_CONFLICT', 'Não há consentimento pendente.');
      else if (b.decision === 'REVOGADO' && !['OFERTADO', 'ACEITO', 'AGENDADO', 'FALHA_TECNICA'].includes(e.status)) {
        throw conflict('TELE_STATE_CONFLICT', 'O consentimento só pode ser revogado antes do início do atendimento.');
      }
      await run('INSERT INTO tele_consents (id, episode_id, actor_id, version, purpose, decision, created_at) VALUES (?,?,?,?,?,?,?)',
        uid(), id, a.userId, TELE_CONSENT_VERSION, TELE_CONSENT_PURPOSE, b.decision, now);
      await audit({ actorId: a.userId, action: `TELE_CONSENT_${b.decision}`, subjectType: 'tele_episode', subjectId: id, correlationId: req.correlationId });
      if (b.decision === 'ACEITO') {
        const pref = e.origin_specialist_id && await credentialed(e.origin_specialist_id) ? e.origin_specialist_id : null;
        await setStatus(e, 'OFERTADO', { price_accepted_at: e.pricing_rule === 'COBRADO' ? now : null, offered_to: pref, offer_expires_at: addHours(now, OFFER_HOURS) }, a.userId, req.correlationId);
        if (pref) await notify(pref, 'ESSENCIAL', 'Nova oferta de teleatendimento', 'Há um teleatendimento disponível para você na ONEMA ONE. Abra o app para aceitar.');
      } else {
        await setStatus(e, b.decision === 'RECUSADO' ? 'RECUSADO' : 'CANCELADO', { outcome_reason: b.decision === 'RECUSADO' ? 'Consentimento recusado pelo paciente.' : 'Consentimento revogado pelo paciente.', closed_at: now }, a.userId, req.correlationId);
        if (e.professional_id) await notify(e.professional_id, 'ESSENCIAL', 'Teleatendimento cancelado', 'Um teleatendimento seu foi cancelado pelo paciente.');
      }
      return { episode: await view((await one<any>('SELECT * FROM tele_episodes WHERE id = ?', id))!, 'PACIENTE') };
    });
  });

  /** Central/RT designa uma profissional (redistribuição manual). */
  app.post('/api/tele/episodes/:id/assign', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ professionalEmail: z.string().trim().email().nullable() }), req.body);
    return await tx(async () => {
      const { a, e } = await load(req, id, ['CENTRAL'], true);
      if (e.status !== 'OFERTADO') throw conflict('TELE_STATE_CONFLICT', 'Só é possível redistribuir um teleatendimento em oferta.');
      let to: string | null = null;
      if (b.professionalEmail) {
        const p = await one<any>(`SELECT u.id FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'ESPECIALISTA' WHERE lower(u.email) = lower(?)`, b.professionalEmail);
        if (!p || !await credentialed(p.id)) throw unprocessable('PROFESSIONAL_NOT_ELIGIBLE', 'Profissional não encontrada ou não credenciada.');
        to = p.id;
      }
      await run('UPDATE tele_episodes SET offered_to = ?, offer_expires_at = ?, updated_at = ? WHERE id = ?', to, addHours(nowIso(), OFFER_HOURS), nowIso(), id);
      await audit({ actorId: a.userId, action: 'TELE_OFFER_ASSIGNED', subjectType: 'tele_episode', subjectId: id, correlationId: req.correlationId, meta: { pool: !to } });
      if (to) await notify(to, 'ESSENCIAL', 'Nova oferta de teleatendimento', 'Há um teleatendimento disponível para você na ONEMA ONE. Abra o app para aceitar.');
      return { episode: await view((await one<any>('SELECT * FROM tele_episodes WHERE id = ?', id))!, 'CENTRAL') };
    });
  });

  app.post('/api/tele/episodes/:id/accept', async (req) => {
    const { id } = parse(idParam, req.params);
    const a = requireRoles(req, ['ESPECIALISTA']);
    if (!await credentialed(a.userId)) throw forbidden('Seu perfil ainda não foi credenciado pela Central ONEMA.', 'NOT_CREDENTIALED');
    const cur = await one<any>('SELECT * FROM tele_episodes WHERE id = ?', id);
    if (cur) await sweep(cur);
    return await tx(async () => {
      const { e } = await load(req, id, ['OFERTA'], true);
      if (e.patient_id === a.userId) throw forbidden();
      const now = nowIso();
      const r = await run(`UPDATE tele_episodes SET status = 'ACEITO', professional_id = ?, accepted_at = ?, offered_to = NULL, updated_at = ?
        WHERE id = ? AND status = 'OFERTADO' AND (offered_to = ? OR offered_to IS NULL)`, a.userId, now, now, id, a.userId);
      if (!r.changes) throw conflict('TELE_OFFER_TAKEN', 'Esta oferta não está mais disponível.');
      await audit({ actorId: a.userId, action: 'TELE_STATUS', subjectType: 'tele_episode', subjectId: id, correlationId: req.correlationId, meta: { from: 'OFERTADO', to: 'ACEITO' } });
      await notify(e.patient_id, 'ESSENCIAL', 'Teleatendimento: enfermeira confirmada', 'Uma enfermeira ONEMA confirmou seu teleatendimento. Abra o app para ver o horário.');
      return { episode: await view((await one<any>('SELECT * FROM tele_episodes WHERE id = ?', id))!, 'PROFISSIONAL') };
    });
  });

  /** Agenda (UTC + fuso). Também reagenda após falha técnica. Lembrete sem conteúdo clínico. */
  app.post('/api/tele/episodes/:id/schedule', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ startAt: z.string().datetime({ offset: true }) }), req.body);
    return await tx(async () => {
      const { a, e } = await load(req, id, ['PROFISSIONAL', 'CENTRAL'], true);
      if (!['ACEITO', 'AGENDADO', 'FALHA_TECNICA'].includes(e.status) || !e.professional_id) throw conflict('TELE_STATE_CONFLICT', 'Só é possível agendar um teleatendimento aceito.');
      const at = new Date(b.startAt);
      if (at.getTime() < Date.now() - 5 * 60_000) throw unprocessable('INVALID_TIME', 'Escolha um horário futuro.');
      if (at.getTime() > new Date(e.window_until).getTime()) throw unprocessable('OUTSIDE_WINDOW', 'O horário precisa estar dentro da janela indicada.');
      await setStatus(e, 'AGENDADO', { scheduled_at: at.toISOString() }, a.userId, req.correlationId, ['ACEITO', 'AGENDADO', 'FALHA_TECNICA']);
      const when = at.toLocaleString('pt-BR', { timeZone: e.timezone, dateStyle: 'short', timeStyle: 'short' });
      await notify(e.patient_id, 'LEMBRETE', 'Teleatendimento agendado', `Seu teleatendimento ONEMA está marcado para ${when}. Entre pelo app no horário.`);
      return { episode: await view((await one<any>('SELECT * FROM tele_episodes WHERE id = ?', id))!, 'PROFISSIONAL') };
    });
  });

  /** Token de sala de curta duração (paciente ou profissional designada), apenas com consentimento vigente. */
  app.post('/api/tele/episodes/:id/video-token', async (req) => {
    const { id } = parse(idParam, req.params);
    const { a, e, access } = await load(req, id, ['PACIENTE', 'PROFISSIONAL']);
    const consent = await consentState(id);
    if (consent?.decision !== 'ACEITO') {
      await audit({ actorId: a.userId, action: 'TELE_BLOCKED_NO_CONSENT', subjectType: 'tele_episode', subjectId: id, correlationId: req.correlationId });
      throw unprocessable('CONSENT_REQUIRED', 'O atendimento só abre com o consentimento do paciente registrado.');
    }
    if (!['AGENDADO', 'EM_ATENDIMENTO'].includes(e.status)) throw conflict('TELE_STATE_CONFLICT', 'A sala abre só para atendimentos agendados.');
    if (e.scheduled_at && Date.now() < new Date(e.scheduled_at).getTime() - JOIN_EARLY_MS) throw unprocessable('TOO_EARLY', 'A sala abre 30 minutos antes do horário marcado.');
    if (!await rateLimit(`tele-token:${a.userId}`, 30, 3600_000)) throw new AppError(429, 'RATE_LIMIT', 'Muitas tentativas. Aguarde alguns minutos.');
    const token = randomToken(24); const now = nowIso();
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
    await run('INSERT INTO tele_room_tokens (id, episode_id, user_id, token_hash, expires_at, created_at) VALUES (?,?,?,?,?,?)', uid(), id, a.userId, hmac(`tele-room:${token}`), expiresAt, now);
    await audit({ actorId: a.userId, action: 'TELE_TOKEN_ISSUED', subjectType: 'tele_episode', subjectId: id, correlationId: req.correlationId, meta: { access } });
    // Provedor audiovisual ainda não definido: sala SIMULADA de homologação (sem mídia, sem gravação).
    return { token, expiresAt, provider: 'SIMULADO', recording: false, room: `onema-${sha256(id).slice(0, 12)}` };
  });

  /** Entrada na sala: token válido, não expirado, do próprio usuário e do episódio. A entrada da profissional inicia o atendimento. */
  app.post('/api/tele/episodes/:id/join', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ token: z.string().min(10).max(200) }), req.body);
    const { a, e, access } = await load(req, id, ['PACIENTE', 'PROFISSIONAL']);
    const t = await one<any>('SELECT * FROM tele_room_tokens WHERE token_hash = ?', hmac(`tele-room:${b.token}`));
    if (!t || t.episode_id !== id || t.user_id !== a.userId || new Date(t.expires_at).getTime() < Date.now()) {
      await audit({ actorId: a.userId, action: 'TELE_TOKEN_REJECTED', subjectType: 'tele_episode', subjectId: id, correlationId: req.correlationId });
      throw new AppError(401, 'ROOM_TOKEN_EXPIRED', 'Acesso à sala expirado. Solicite um novo acesso.');
    }
    await run('UPDATE tele_room_tokens SET used_at = COALESCE(used_at, ?) WHERE id = ?', nowIso(), t.id);
    if (access === 'PROFISSIONAL' && e.status === 'AGENDADO') {
      await setStatus(e, 'EM_ATENDIMENTO', { call_started_at: nowIso() }, a.userId, req.correlationId);
    }
    await audit({ actorId: a.userId, action: 'TELE_ROOM_JOINED', subjectType: 'tele_episode', subjectId: id, correlationId: req.correlationId, meta: { access } });
    return { ok: true, status: access === 'PROFISSIONAL' && e.status === 'AGENDADO' ? 'EM_ATENDIMENTO' : e.status };
  });

  /**
   * Fim da chamada (profissional): ENCERRADO → aguarda registro; FALHA_TECNICA não conclui (permite reagendar);
   * NAO_COMPARECEU registra a ausência e a política. Nenhuma cobrança ou repasse é disparado aqui.
   */
  app.post('/api/tele/episodes/:id/end', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ outcome: z.enum(['ENCERRADO', 'FALHA_TECNICA', 'NAO_COMPARECEU']), note: z.string().trim().max(1000).optional() }), req.body);
    return await tx(async () => {
      const { a, e } = await load(req, id, ['PROFISSIONAL'], true);
      const now = nowIso();
      if (b.outcome === 'ENCERRADO') {
        if (e.status !== 'EM_ATENDIMENTO') throw conflict('TELE_STATE_CONFLICT', 'Só é possível encerrar um atendimento em andamento.');
        await setStatus(e, 'AGUARDANDO_REGISTRO', { call_ended_at: now }, a.userId, req.correlationId);
      } else if (b.outcome === 'FALHA_TECNICA') {
        if (!['EM_ATENDIMENTO', 'AGENDADO'].includes(e.status)) throw conflict('TELE_STATE_CONFLICT', 'Situação inválida para registrar falha.');
        await setStatus(e, 'FALHA_TECNICA', { call_ended_at: now, failures: Number(e.failures) + 1, outcome_reason: b.note || 'Queda de conexão.' }, a.userId, req.correlationId);
        await notify(e.patient_id, 'ESSENCIAL', 'Teleatendimento interrompido', 'A conexão caiu. A enfermeira vai remarcar o atendimento pelo app.');
      } else {
        if (e.status !== 'AGENDADO' && e.status !== 'EM_ATENDIMENTO') throw conflict('TELE_STATE_CONFLICT', 'Situação inválida para registrar ausência.');
        if (e.scheduled_at && Date.now() < new Date(e.scheduled_at).getTime()) throw unprocessable('TOO_EARLY', 'A ausência só pode ser registrada depois do horário marcado.');
        await setStatus(e, 'NAO_COMPARECEU', { call_ended_at: now, outcome_reason: b.note || NO_SHOW_POLICY, closed_at: now }, a.userId, req.correlationId);
        await notify(e.patient_id, 'ESSENCIAL', 'Teleatendimento: ausência registrada', 'Registramos sua ausência no teleatendimento. Fale com a Central ONEMA para remarcar.');
      }
      return { episode: await view((await one<any>('SELECT * FROM tele_episodes WHERE id = ?', id))!, 'PROFISSIONAL') };
    });
  });

  /** Encaminhamento presencial ou urgência: motivo, plano e orientação documentados. */
  app.post('/api/tele/episodes/:id/referral', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ kind: z.enum(['PRESENCIAL', 'URGENCIA']), reason: z.string().trim().min(5, 'Registre o motivo.').max(2000), plan: z.string().trim().min(5, 'Registre o plano/orientação.').max(2000) }), req.body);
    return await tx(async () => {
      const { a, e } = await load(req, id, ['PROFISSIONAL'], true);
      const from = ['AGENDADO', 'EM_ATENDIMENTO', 'AGUARDANDO_REGISTRO'];
      if (!from.includes(e.status)) throw conflict('TELE_STATE_CONFLICT', 'Situação inválida para encaminhamento.');
      const to = b.kind === 'URGENCIA' ? 'URGENCIA_ENCAMINHADA' : 'ENCAMINHADO_PRESENCIAL';
      const plan = b.kind === 'URGENCIA' ? `${b.plan}\n${URGENCY_GUIDANCE}` : b.plan;
      await setStatus(e, to, { outcome_reason: b.reason, outcome_plan: plan, call_ended_at: e.call_ended_at ?? nowIso() }, a.userId, req.correlationId, from);
      await notify(e.patient_id, 'ESSENCIAL', b.kind === 'URGENCIA' ? 'Procure atendimento de urgência' : 'Encaminhamento para atendimento presencial',
        b.kind === 'URGENCIA' ? URGENCY_GUIDANCE : 'A enfermeira indicou um atendimento presencial. Veja a orientação no app.');
      return { episode: await view((await one<any>('SELECT * FROM tele_episodes WHERE id = ?', id))!, 'PROFISSIONAL'), guidance: b.kind === 'URGENCIA' ? URGENCY_GUIDANCE : null };
    });
  });

  // ---- Registro (nota) do teleatendimento ----
  const NOTE_STATES = ['EM_ATENDIMENTO', 'AGUARDANDO_REGISTRO', 'ENCAMINHADO_PRESENCIAL', 'URGENCIA_ENCAMINHADA'];
  async function mainNote(episodeId: string) { return await one<any>(`SELECT * FROM tele_notes WHERE episode_id = ? AND kind = 'REGISTRO'`, episodeId); }
  async function saveNote(e: any, authorId: string, dictation: string, content: unknown, aiSuggested: boolean) {
    const json = JSON.stringify(TeleNoteSchema.parse(content));
    const cur = await mainNote(e.id); const now = nowIso();
    if (cur) {
      if (cur.status === 'ASSINADA') throw conflict('NOTE_SIGNED', 'O registro já foi assinado. Use um adendo para complementar.');
      await run('UPDATE tele_notes SET dictation = ?, content_json = ?, ai_suggested = ?, updated_at = ? WHERE id = ?', dictation, json, aiSuggested ? 1 : 0, now, cur.id);
      return cur.id as string;
    }
    const id = uid();
    await run(`INSERT INTO tele_notes (id, episode_id, patient_id, author_id, kind, version, dictation, content_json, ai_suggested, status, created_at, updated_at)
      VALUES (?,?,?,?,'REGISTRO',1,?,?,?,'RASCUNHO',?,?)`, id, e.id, e.patient_id, authorId, dictation, json, aiSuggested ? 1 : 0, now, now);
    return id;
  }

  app.put('/api/tele/episodes/:id/notes', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ dictation: z.string().max(8000).default(''), content: TeleNoteSchema }), req.body);
    const { a, e } = await load(req, id, ['PROFISSIONAL']);
    if (!NOTE_STATES.includes(e.status)) throw conflict('TELE_STATE_CONFLICT', 'O registro é feito durante ou após o atendimento.');
    const cur = await mainNote(id);
    await saveNote(e, a.userId, b.dictation, b.content, !!cur?.ai_suggested);
    return { episode: await view((await one<any>('SELECT * FROM tele_episodes WHERE id = ?', id))!, 'PROFISSIONAL') };
  });

  /** Kary sugere o rascunho a partir do ditado — sugestão identificada; nunca conclui nem assina. */
  app.post('/api/tele/episodes/:id/notes/organize', async (req) => {
    const { id } = parse(idParam, req.params);
    const { dictation } = parse(z.object({ dictation: z.string().trim().min(20, 'Dite ou escreva o registro (pelo menos uma frase completa).').max(8000) }), req.body);
    const { a, e } = await load(req, id, ['PROFISSIONAL']);
    if (!NOTE_STATES.includes(e.status)) throw conflict('TELE_STATE_CONFLICT', 'O registro é feito durante ou após o atendimento.');
    const cur = await mainNote(id);
    if (cur?.status === 'ASSINADA') throw conflict('NOTE_SIGNED', 'O registro já foi assinado. Use um adendo para complementar.');
    const base = cur ? JSON.parse(cur.content_json) : { ...EMPTY_TELE_NOTE };
    if (!evolutionAiEnabled()) {
      await saveNote(e, a.userId, dictation, { ...base, observacoes: base.observacoes || dictation }, !!cur?.ai_suggested);
      return { aiMessage: FAILURE_TEXT.NAO_CONFIGURADA, episode: await view(e, 'PROFISSIONAL') };
    }
    if (!await rateLimit(`evolution-ai:${a.userId}`, 40, 3600_000)) throw new AppError(429, 'RATE_LIMIT', 'Muitas organizações em pouco tempo. Aguarde alguns minutos.');
    const r = await organizeDictation(dictation, { act: `Teleatendimento · ${MODALITY_LABEL[e.modality as keyof typeof MODALITY_LABEL]}`, modality: 'REMOTO' });
    if ('evolution' in r) {
      await saveNote(e, a.userId, dictation, { ...base, ...r.evolution }, true);
      await audit({ actorId: a.userId, action: 'TELE_NOTE_AI_SUGGESTED', subjectType: 'tele_episode', subjectId: id, correlationId: req.correlationId });
      return { aiMessage: 'Sugestão da Kary: revise cada seção, corrija o que for preciso e assine.', episode: await view(e, 'PROFISSIONAL') };
    }
    await saveNote(e, a.userId, dictation, { ...base, observacoes: base.observacoes || dictation }, !!cur?.ai_suggested);
    return { aiMessage: FAILURE_TEXT[r.failure], episode: await view(e, 'PROFISSIONAL') };
  });

  /** Assinatura: revisão humana obrigatória; um único registro assinado por episódio (concorrência protegida). */
  app.post('/api/tele/episodes/:id/sign', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ content: TeleNoteSchema, confirm: z.literal(true, { message: 'Confirme que revisou o registro antes de assinar.' }) }), req.body);
    return await tx(async () => {
      const { a, e } = await load(req, id, ['PROFISSIONAL'], true);
      if (!NOTE_STATES.includes(e.status) || e.status === 'EM_ATENDIMENTO') {
        throw conflict(e.status === 'ASSINADO' || e.status === 'CONCLUIDO' ? 'NOTE_SIGNED' : 'TELE_STATE_CONFLICT', e.status === 'EM_ATENDIMENTO' ? 'Encerre a chamada antes de assinar.' : 'O registro deste teleatendimento já foi assinado ou não está disponível.');
      }
      const filled = [b.content.relato, b.content.avaliacao, b.content.orientacoes].some((x) => x.trim().length >= 5 && !/^não informado/i.test(x.trim()));
      if (!filled) throw unprocessable('NOTE_EMPTY', 'Preencha ao menos o relato, a avaliação ou as orientações.');
      if (b.content.limitacoes.trim().length < 5) throw unprocessable('LIMITATIONS_REQUIRED', 'Registre as limitações da avaliação remota.');
      const cur = await mainNote(id);
      if (cur?.status === 'ASSINADA') throw conflict('NOTE_SIGNED', 'O registro já foi assinado. Use um adendo para complementar.');
      const noteId = await saveNote(e, a.userId, cur?.dictation ?? '', b.content, !!cur?.ai_suggested);
      const now = nowIso();
      const hash = sha256(stableJson({ episode: id, author: a.userId, content: TeleNoteSchema.parse(b.content), at: now }));
      await run(`UPDATE tele_notes SET status = 'ASSINADA', signed_at = ?, content_hash = ?, updated_at = ? WHERE id = ? AND status = 'RASCUNHO'`, now, hash, now, noteId);
      // Encaminhamentos já são finais: o registro é anexado sem mudar a situação.
      if (e.status === 'AGUARDANDO_REGISTRO') await setStatus(e, 'ASSINADO', {}, a.userId, req.correlationId);
      await audit({ actorId: a.userId, action: 'TELE_NOTE_SIGNED', subjectType: 'tele_episode', subjectId: id, correlationId: req.correlationId, meta: { aiSuggested: !!cur?.ai_suggested, hash } });
      await notify(e.patient_id, 'ESSENCIAL', 'Novo registro na sua Carteira Digital', 'O registro do seu teleatendimento foi assinado pela enfermeira. Veja em Carteira Digital.');
      return { episode: await view((await one<any>('SELECT * FROM tele_episodes WHERE id = ?', id))!, 'PROFISSIONAL') };
    });
  });

  /** Retificação: adendo versionado e assinado; o original é preservado. */
  app.post('/api/tele/episodes/:id/addenda', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ text: z.string().trim().min(5, 'Escreva o adendo.').max(4000), confirm: z.literal(true, { message: 'Confirme a assinatura do adendo.' }) }), req.body);
    return await tx(async () => {
      const { a, e } = await load(req, id, ['PROFISSIONAL'], true);
      const main = await mainNote(id);
      if (main?.status !== 'ASSINADA') throw conflict('NOTE_NOT_SIGNED', 'O adendo complementa um registro já assinado.');
      const v = (await one<any>('SELECT MAX(version) AS v FROM tele_notes WHERE episode_id = ?', id))!.v;
      const now = nowIso();
      const content = { ...EMPTY_TELE_NOTE, limitacoes: '', observacoes: b.text };
      const hash = sha256(stableJson({ episode: id, author: a.userId, addendumOf: main.id, text: b.text, at: now }));
      await run(`INSERT INTO tele_notes (id, episode_id, patient_id, author_id, kind, parent_note_id, version, content_json, status, content_hash, signed_at, created_at, updated_at)
        VALUES (?,?,?,?,'ADENDO',?,?,?,'ASSINADA',?,?,?,?)`, uid(), id, e.patient_id, a.userId, main.id, Number(v) + 1, JSON.stringify(content), hash, now, now, now);
      await audit({ actorId: a.userId, action: 'TELE_NOTE_ADDENDUM', subjectType: 'tele_episode', subjectId: id, correlationId: req.correlationId, meta: { version: Number(v) + 1 } });
      return { episode: await view((await one<any>('SELECT * FROM tele_episodes WHERE id = ?', id))!, 'PROFISSIONAL') };
    });
  });

  /** Fechamento: só depois da assinatura. Não gera cobrança nem repasse (integração financeira depende de validação contábil). */
  app.post('/api/tele/episodes/:id/close', async (req) => {
    const { id } = parse(idParam, req.params);
    return await tx(async () => {
      const { a, e } = await load(req, id, ['PROFISSIONAL', 'CENTRAL'], true);
      if (e.status !== 'ASSINADO') throw unprocessable('SIGNATURE_REQUIRED', 'Assine o registro antes de concluir o teleatendimento.');
      await setStatus(e, 'CONCLUIDO', { closed_at: nowIso() }, a.userId, req.correlationId);
      return { episode: await view((await one<any>('SELECT * FROM tele_episodes WHERE id = ?', id))!, isStaff(a) && e.professional_id !== a.userId ? 'CENTRAL' : 'PROFISSIONAL') };
    });
  });

  /** Cancelamento: paciente (antes do início) ou Central/RT, com motivo. */
  app.post('/api/tele/episodes/:id/cancel', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ reason: z.string().trim().min(3, 'Informe o motivo.').max(500) }), req.body);
    return await tx(async () => {
      const { a, e, access } = await load(req, id, ['PACIENTE', 'CENTRAL'], true);
      const from = ['SOLICITADO', 'TRIAGEM', 'OFERTADO', 'ACEITO', 'AGENDADO', 'FALHA_TECNICA'];
      if (!from.includes(e.status)) throw conflict('TELE_STATE_CONFLICT', 'Este teleatendimento não pode mais ser cancelado.');
      await setStatus(e, 'CANCELADO', { outcome_reason: `${access === 'PACIENTE' ? 'Paciente' : 'Central'}: ${b.reason}`, closed_at: nowIso() }, a.userId, req.correlationId, from);
      if (e.professional_id) await notify(e.professional_id, 'ESSENCIAL', 'Teleatendimento cancelado', 'Um teleatendimento seu foi cancelado.');
      return { episode: await view((await one<any>('SELECT * FROM tele_episodes WHERE id = ?', id))!, access) };
    });
  });

  /** Trilha de auditoria do episódio (Central/RT/Auditor). Sem conteúdo clínico. */
  app.get('/api/tele/episodes/:id/audit', async (req) => {
    const { id } = parse(idParam, req.params);
    const a = requireRoles(req, ['AVALIADOR_RT', 'OPERADOR_CENTRAL', 'AUDITOR']);
    if (!await one('SELECT id FROM tele_episodes WHERE id = ?', id)) throw notFound('Teleatendimento não encontrado.');
    const rows = await all<any>(`SELECT ae.action, ae.occurred_at, ae.meta_json, u.name AS actor FROM audit_events ae LEFT JOIN users u ON u.id = ae.actor_id
      WHERE ae.subject_type = 'tele_episode' AND ae.subject_id = ? ORDER BY ae.occurred_at, ae.id`, id);
    await audit({ actorId: a.userId, action: 'TELE_AUDIT_VIEWED', subjectType: 'tele_episode', subjectId: id, correlationId: req.correlationId });
    return { events: rows.map((r) => ({ action: r.action, at: r.occurred_at, actor: r.actor ?? 'Sistema', meta: r.meta_json ? JSON.parse(r.meta_json) : null })) };
  });

  /** Painel de pendências do RT/Central: indicadores sem conteúdo clínico. */
  app.get('/api/admin/tele/pending', async (req) => {
    requireRoles(req, [...STAFF]);
    const counts = await all<any>('SELECT status, COUNT(*) AS n FROM tele_episodes GROUP BY status');
    const now = nowIso();
    const overdueOffers = (await one<any>(`SELECT COUNT(*) AS n FROM tele_episodes WHERE status = 'OFERTADO' AND offer_expires_at < ?`, now))!.n;
    const unsigned = (await one<any>(`SELECT COUNT(*) AS n FROM tele_episodes WHERE status = 'AGUARDANDO_REGISTRO' AND call_ended_at < ?`, addHours(now, -24)))!.n;
    return {
      counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
      pending: { triage: Number(counts.find((c) => c.status === 'SOLICITADO')?.n ?? 0), overdueOffers: Number(overdueOffers), unsignedOver24h: Number(unsigned),
        technicalFailures: Number(counts.find((c) => c.status === 'FALHA_TECNICA')?.n ?? 0) },
      returnWindowDays: RETURN_WINDOW_DAYS, protocolVersion: TELE_PROTOCOL_VERSION, homologation: !config.teleRealUseApproved,
    };
  });
}

/** Registros de telenfermagem assinados para a Carteira Digital (prontuário único do paciente). */
export async function teleWalletNotes(patientId: string) {
  const rows = await all<any>(`SELECT n.id, n.kind, n.version, n.signed_at, n.content_json, n.parent_note_id, e.id AS episode_id, e.protocol, e.modality, e.origin_event_id, u.name AS author
    FROM tele_notes n JOIN tele_episodes e ON e.id = n.episode_id JOIN users u ON u.id = n.author_id
    WHERE n.patient_id = ? AND n.status = 'ASSINADA' ORDER BY n.signed_at DESC LIMIT 100`, patientId);
  return rows.map((r) => ({ id: r.id, kind: r.kind, version: r.version, signedAt: r.signed_at, episodeId: r.episode_id, protocol: r.protocol,
    modalityLabel: MODALITY_LABEL[r.modality as keyof typeof MODALITY_LABEL], originEventId: r.origin_event_id, author: r.author, parentNoteId: r.parent_note_id, content: JSON.parse(r.content_json) }));
}
