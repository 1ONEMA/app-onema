/**
 * Atendimento online do catálogo (RT, 13/11/2026): todo atendimento remoto segue para a Telenfermagem — mesma sala de vídeo
 * (Daily, sem gravação, até 30 minutos), com horário combinado pela enfermeira e link por e-mail para os dois lados.
 * A evolução continua sendo registrada e assinada na tela do atendimento; o paciente confirma como nos demais.
 * Homologação: enquanto TELE_REAL_USE_APPROVED não for ativado, só pacientes de teste (@exemplo.test).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, run, tx } from '../../db/db.ts';
import { config } from '../../config.ts';
import { audit } from '../../lib/audit.ts';
import { parse, requireRoles, requireUser } from '../../lib/context.ts';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.ts';
import { nowIso, uid } from '../../lib/util.ts';
import { emailUser } from '../../lib/user-email.ts';
import { notify } from '../prime/core.ts';
import { closeVideo, extendVideo, maxCallMinutes, openVideo, videoPresence } from '../tele/video.ts';
import { SCHEDULE_LABEL } from './offer-engine.ts';
import { partnerActive } from '../specialist/validation.ts';

const idParam = z.object({ id: z.string().uuid() });
const key = (eventId: string) => `care-event:${eventId}`;
const fmt = (iso: string) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });

async function anyEvent(id: string) {
  const e = await one<any>(`SELECT e.*, o.patient_id, o.request_id, o.item_name, pu.email AS patient_email FROM care_events e JOIN service_orders o ON o.id = e.order_id
    JOIN users pu ON pu.id = o.patient_id WHERE e.id = ?`, id);
  if (!e) throw notFound('Atendimento não encontrado.');
  return e;
}
async function scheduleLog(eventId: string, rev: number, action: string, proposedTime: string | null, actorId: string) {
  await run('INSERT INTO care_schedule_log (id, event_id, rev, action, proposed_time, actor_id, created_at) VALUES (?,?,?,?,?,?,?)', uid(), eventId, rev, action, proposedTime, actorId, nowIso());
}
/** Estado do agendamento, igual nas duas telas: quem precisa responder e a versão vigente. */
export function scheduleView(e: any) {
  if (!e.call_scheduled_at) return null;
  return {
    rev: e.schedule_rev, status: e.schedule_status ?? 'AGUARDANDO_PACIENTE', label: SCHEDULE_LABEL[e.schedule_status ?? 'AGUARDANDO_PACIENTE'],
    proposedAt: e.call_scheduled_at, changeRequestedAt: e.schedule_change_at, respondedAt: e.schedule_responded_at,
    pendingFrom: e.schedule_status === 'CONFIRMADO' ? null : e.schedule_status === 'ALTERACAO_SOLICITADA' ? 'ESPECIALISTA' : 'PACIENTE',
  };
}
const outdated = (e: any) => conflict('SCHEDULE_OUTDATED', 'O horário foi atualizado em outra tela. Confira a proposta vigente.', { schedule: scheduleView(e) });
const PRESENT_MS = 20_000;
const presenceCache = new Map<string, { at: number; ids: string[] | null }>();

async function remoteEvent(id: string) {
  const e = await one<any>(`SELECT e.*, o.patient_id, o.request_id, o.item_name, pu.email AS patient_email FROM care_events e JOIN service_orders o ON o.id = e.order_id
    JOIN users pu ON pu.id = o.patient_id WHERE e.id = ?`, id);
  if (!e || e.modality !== 'REMOTO') throw notFound('Atendimento não encontrado.');
  return e;
}
function homologationGuard(e: any) {
  if (!config.teleRealUseApproved && !/@exemplo\.test$/i.test(e.patient_email)) {
    throw forbidden('Atendimento online por vídeo em homologação: uso clínico real proibido até a aprovação do RT. Use contas de teste (@exemplo.test).', 'TELE_HOMOLOGATION_ONLY');
  }
}

export async function onlineCallRoutes(app: FastifyInstance) {
  /**
   * A enfermeira propõe (ou remarca) o horário. Vale para atendimento remoto e presencial (PAC-03: "Agendado" depois de
   * profissional e horário confirmados). Cada remarcação é uma nova proposta rastreável; o paciente confirma ou pede alteração.
   */
  app.post('/api/care/specialist/events/:id/call-schedule', async (req) => {
    const a = requireRoles(req, ['ESPECIALISTA']);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ startAt: z.string().datetime({ offset: true }) }), req.body);
    const e0 = await anyEvent(id);
    if (e0.specialist_id !== a.userId) throw notFound('Atendimento não encontrado.');
    if (!await partnerActive(a.userId)) throw forbidden('Seu perfil não está ativo para atendimento.', 'NOT_CREDENTIALED');
    if (e0.status !== 'ACEITO') throw conflict('EVENT_NOT_ACCEPTED', 'Só é possível agendar um atendimento aceito por você.');
    if (e0.modality === 'REMOTO') homologationGuard(e0);
    const at = new Date(b.startAt);
    if (at.getTime() < Date.now() - 5 * 60_000) throw unprocessable('INVALID_TIME', 'Escolha um horário futuro.');
    const result = await tx(async () => {
      const e = (await one<any>('SELECT * FROM care_events WHERE id = ? FOR UPDATE', id))!;
      // Reenvio da mesma proposta: mesmo resultado, sem nova versão.
      if (e.call_scheduled_at === at.toISOString() && e.schedule_status === 'AGUARDANDO_PACIENTE') return { repeated: true, rev: e.schedule_rev };
      const rev = e.schedule_rev + 1, now = nowIso();
      await run(`UPDATE care_events SET call_scheduled_at = ?, schedule_status = 'AGUARDANDO_PACIENTE', schedule_rev = ?, schedule_change_at = NULL, schedule_responded_at = NULL, updated_at = ? WHERE id = ?`,
        at.toISOString(), rev, now, id);
      await scheduleLog(id, rev, 'PROPOSTA', at.toISOString(), a.userId);
      return { repeated: false, rev };
    });
    if (result.repeated) return { ok: true, callScheduledAt: at.toISOString(), already: true };
    await audit({ actorId: a.userId, action: 'ONLINE_CALL_SCHEDULED', subjectType: 'care_event', subjectId: id, correlationId: req.correlationId, meta: { rev: result.rev } });
    const when = fmt(at.toISOString()); const mins = maxCallMinutes();
    const remote = e0.modality === 'REMOTO';
    await notify(e0.patient_id, 'LEMBRETE', 'Confirme o horário do atendimento', `A especialista propôs ${when} para "${e0.label}". Confirme ou solicite alteração no app.`);
    await emailUser(e0.patient_id, 'ONLINE_AGENDADO', 'Confirme o horário do atendimento', [`A especialista ONEMA propôs ${when} (horário de Brasília) para ${e0.label}.`,
      'Abra o atendimento pelo link abaixo, faça login e toque em "Confirmar horário" ou "Solicitar alteração".',
      ...(remote ? [`No horário, entre pelo app e toque em "Entrar na sala". A sala abre 30 minutos antes e o atendimento dura até ${mins} minutos. Não é gravado.`] : [])],
      { label: 'Abrir meu atendimento', path: `/solicitacoes/${e0.request_id}` }).catch((err) => req.log.warn({ err: String(err) }, 'e-mail do agendamento'));
    if (remote) {
      await emailUser(a.userId, 'ONLINE_AGENDADO', 'Atendimento online agendado', [`Você propôs ${when} (horário de Brasília) para o atendimento online ONEMA (${e0.label}).`,
        `Entre pelo link abaixo e toque em "Entrar na sala". O tempo de ${mins} minutos começa quando você e o paciente estiverem na sala.`],
        { label: 'Abrir o atendimento', path: `/especialista/atendimentos/${id}` }).catch((err) => req.log.warn({ err: String(err) }, 'e-mail do atendimento online'));
    }
    return { ok: true, callScheduledAt: at.toISOString() };
  });

  /** Paciente confirma a proposta vigente. Resposta a proposta antiga não sobrescreve a mais recente. */
  app.post('/api/care/events/:id/schedule/confirm', async (req) => {
    const a = requireRoles(req, ['PACIENTE']);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ rev: z.number().int().min(1) }), req.body);
    const out = await tx(async () => {
      const e = await one<any>('SELECT e.*, o.patient_id FROM care_events e JOIN service_orders o ON o.id = e.order_id WHERE e.id = ? FOR UPDATE OF e', id);
      if (!e || e.patient_id !== a.userId) throw notFound('Atendimento não encontrado.');
      if (!e.call_scheduled_at || e.status !== 'ACEITO') throw conflict('NO_PROPOSAL', 'Não há horário proposto para confirmar.');
      if (b.rev !== e.schedule_rev) throw outdated(e);
      if (e.schedule_status === 'CONFIRMADO') return { e, repeated: true };
      if (e.schedule_status !== 'AGUARDANDO_PACIENTE') throw outdated(e);
      const now = nowIso();
      await run(`UPDATE care_events SET schedule_status = 'CONFIRMADO', schedule_responded_at = ?, updated_at = ? WHERE id = ?`, now, now, id);
      await scheduleLog(id, e.schedule_rev, 'CONFIRMADO', e.call_scheduled_at, a.userId);
      return { e: { ...e, schedule_status: 'CONFIRMADO', schedule_responded_at: now }, repeated: false };
    });
    if (!out.repeated) {
      await audit({ actorId: a.userId, action: 'CARE_SCHEDULE_CONFIRMED', subjectType: 'care_event', subjectId: id, correlationId: req.correlationId, meta: { rev: b.rev } });
      if (out.e.specialist_id) await notify(out.e.specialist_id, 'ESSENCIAL', 'Horário confirmado pelo paciente', `"${out.e.label}": ${fmt(out.e.call_scheduled_at)} confirmado.`);
    }
    return { ok: true, already: out.repeated, schedule: scheduleView(out.e) };
  });

  /** Paciente pede alteração com nova data/hora. Vira horário combinado só depois do aceite da especialista. */
  app.post('/api/care/events/:id/schedule/change', async (req) => {
    const a = requireRoles(req, ['PACIENTE']);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ rev: z.number().int().min(1), startAt: z.string().datetime({ offset: true }) }), req.body);
    const at = new Date(b.startAt);
    if (at.getTime() < Date.now() + 15 * 60_000) throw unprocessable('INVALID_TIME', 'Escolha um horário futuro (pelo menos 15 minutos a partir de agora).');
    const out = await tx(async () => {
      const e = await one<any>('SELECT e.*, o.patient_id FROM care_events e JOIN service_orders o ON o.id = e.order_id WHERE e.id = ? FOR UPDATE OF e', id);
      if (!e || e.patient_id !== a.userId) throw notFound('Atendimento não encontrado.');
      if (!e.call_scheduled_at || e.status !== 'ACEITO' || e.call_started_at) throw conflict('NO_PROPOSAL', 'Não há horário que possa ser alterado.');
      if (b.rev !== e.schedule_rev) throw outdated(e);
      if (e.schedule_status === 'ALTERACAO_SOLICITADA' && e.schedule_change_at === at.toISOString()) return { e, repeated: true };
      const rev = e.schedule_rev + 1, now = nowIso();
      await run(`UPDATE care_events SET schedule_status = 'ALTERACAO_SOLICITADA', schedule_change_at = ?, schedule_rev = ?, schedule_responded_at = ?, updated_at = ? WHERE id = ?`,
        at.toISOString(), rev, now, now, id);
      await scheduleLog(id, rev, 'ALTERACAO_SOLICITADA', at.toISOString(), a.userId);
      return { e: { ...e, schedule_status: 'ALTERACAO_SOLICITADA', schedule_change_at: at.toISOString(), schedule_rev: rev, schedule_responded_at: now }, repeated: false };
    });
    if (!out.repeated) {
      await audit({ actorId: a.userId, action: 'CARE_SCHEDULE_CHANGE_REQUESTED', subjectType: 'care_event', subjectId: id, correlationId: req.correlationId, meta: { rev: out.e.schedule_rev } });
      if (out.e.specialist_id) await notify(out.e.specialist_id, 'ESSENCIAL', 'Paciente pediu outro horário', `"${out.e.label}": nova proposta ${fmt(at.toISOString())}. Aceite ou proponha outro horário.`);
    }
    return { ok: true, already: out.repeated, schedule: scheduleView(out.e) };
  });

  /** Especialista aceita a nova data pedida pelo paciente: vira o horário combinado (confirmado pelos dois). */
  app.post('/api/care/specialist/events/:id/schedule/accept-change', async (req) => {
    const a = requireRoles(req, ['ESPECIALISTA']);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ rev: z.number().int().min(1) }), req.body);
    const out = await tx(async () => {
      const e = await one<any>('SELECT e.*, o.patient_id FROM care_events e JOIN service_orders o ON o.id = e.order_id WHERE e.id = ? FOR UPDATE OF e', id);
      if (!e || e.specialist_id !== a.userId) throw notFound('Atendimento não encontrado.');
      if (b.rev !== e.schedule_rev) throw outdated(e);
      if (e.schedule_status === 'CONFIRMADO') return { e, repeated: true };
      if (e.schedule_status !== 'ALTERACAO_SOLICITADA' || !e.schedule_change_at) throw outdated(e);
      const now = nowIso();
      await run(`UPDATE care_events SET call_scheduled_at = schedule_change_at, schedule_status = 'CONFIRMADO', schedule_responded_at = ?, updated_at = ? WHERE id = ?`, now, now, id);
      await scheduleLog(id, e.schedule_rev, 'ALTERACAO_ACEITA', e.schedule_change_at, a.userId);
      return { e: { ...e, call_scheduled_at: e.schedule_change_at, schedule_status: 'CONFIRMADO', schedule_responded_at: now }, repeated: false };
    });
    if (!out.repeated) {
      await audit({ actorId: a.userId, action: 'CARE_SCHEDULE_CHANGE_ACCEPTED', subjectType: 'care_event', subjectId: id, correlationId: req.correlationId, meta: { rev: b.rev } });
      await notify(out.e.patient_id, 'ESSENCIAL', 'Novo horário confirmado', `"${out.e.label}": ${fmt(out.e.call_scheduled_at)} confirmado pela especialista.`);
    }
    return { ok: true, already: out.repeated, schedule: scheduleView(out.e) };
  });

  /** Entrar na sala (paciente do pedido ou enfermeira designada). O tempo de atendimento conta a partir dos dois presentes. */
  app.post('/api/care/events/:id/call', async (req) => {
    const a = requireUser(req);
    const { id } = parse(idParam, req.params);
    const e = await remoteEvent(id);
    const professional = e.specialist_id === a.userId;
    if (!professional && e.patient_id !== a.userId) {
      await audit({ actorId: a.userId, action: 'ONLINE_CALL_ACCESS_DENIED', subjectType: 'care_event', subjectId: id, correlationId: req.correlationId });
      throw notFound('Atendimento não encontrado.');
    }
    if (professional && !await partnerActive(a.userId)) throw forbidden('Seu perfil não está ativo para atendimento.', 'NOT_CREDENTIALED');
    if (e.status !== 'ACEITO') throw conflict('EVENT_NOT_ACCEPTED', 'A sala abre para atendimentos confirmados.');
    if (e.call_ended_at) throw conflict('CALL_ENDED', 'Esta chamada já foi encerrada.');
    homologationGuard(e);
    if (!e.call_scheduled_at) throw unprocessable('CALL_NOT_SCHEDULED', 'A enfermeira ainda vai combinar o horário da chamada.');
    if (Date.now() < new Date(e.call_scheduled_at).getTime() - 30 * 60_000) throw unprocessable('TOO_EARLY', 'A sala abre 30 minutos antes do horário marcado.');
    if (professional && !e.call_started_at) {
      const t = nowIso();
      await run('UPDATE care_events SET call_started_at = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND call_started_at IS NULL', t, t, t, id);
    }
    let video: Awaited<ReturnType<typeof openVideo>>;
    try {
      video = await openVideo({ key: key(id), userName: a.name || (professional ? 'Enfermeira ONEMA' : 'Paciente'), owner: professional, startedAt: e.call_session_started_at,
        notBefore: e.call_scheduled_at, waitMinutes: 30, presenceId: professional ? 'especialista' : 'paciente' });
    } catch (err: any) {
      if (err instanceof AppError) throw err;
      req.log.error({ correlationId: req.correlationId, status: err?.status, info: err?.info }, 'Daily: falha ao abrir a sala');
      throw new AppError(502, 'VIDEO_UNAVAILABLE', 'Não foi possível abrir a sala de vídeo agora. Tente de novo em instantes.');
    }
    await audit({ actorId: a.userId, action: 'ONLINE_CALL_JOINED', subjectType: 'care_event', subjectId: id, correlationId: req.correlationId, meta: { professional, provider: video.provider } });
    return { video, startedAt: e.call_session_started_at };
  });

  /**
   * Presença na sala (ajuste 05): com o Daily, vale quem está de fato dentro da chamada (não o clique no botão);
   * na sala simulada de homologação, o sinal periódico do app enquanto a sala está aberta.
   * Os dois presentes pela primeira vez = início efetivo da sessão (o tempo de espera não consome os 30 minutos).
   */
  app.post('/api/care/events/:id/call/presence', async (req) => {
    const a = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ inRoom: z.boolean().optional() }), req.body ?? {});
    const e = await remoteEvent(id);
    const professional = e.specialist_id === a.userId;
    if (!professional && e.patient_id !== a.userId) throw notFound('Atendimento não encontrado.');
    const now = Date.now(), nowS = nowIso();
    let ids: string[] | null = null;
    const c = presenceCache.get(id);
    if (c && now - c.at < 2000) ids = c.ids;
    else {
      try { ids = await videoPresence(key(id)); } catch (err: any) { req.log.warn({ status: err?.status }, 'Daily: presença indisponível'); ids = c?.ids ?? null; }
      presenceCache.set(id, { at: now, ids });
    }
    const col = professional ? 'call_specialist_seen_at' : 'call_patient_seen_at';
    if (ids) {
      // Daily: atualiza "visto" de quem está na chamada.
      if (ids.includes('paciente')) await run('UPDATE care_events SET call_patient_seen_at = ? WHERE id = ?', nowS, id);
      if (ids.includes('especialista')) await run('UPDATE care_events SET call_specialist_seen_at = ? WHERE id = ?', nowS, id);
    } else if (b.inRoom && !e.call_ended_at) {
      await run(`UPDATE care_events SET ${col} = ? WHERE id = ?`, nowS, id);
    }
    const cur = (await one<any>('SELECT call_patient_seen_at, call_specialist_seen_at, call_session_started_at, call_ended_at, call_scheduled_at FROM care_events WHERE id = ?', id))!;
    const here = (t: string | null) => !!t && now - new Date(t).getTime() < PRESENT_MS;
    const pHere = here(cur.call_patient_seen_at), sHere = here(cur.call_specialist_seen_at);
    let session = cur.call_session_started_at as string | null;
    if (!session && pHere && sHere && !cur.call_ended_at) {
      const r = await run('UPDATE care_events SET call_session_started_at = ?, updated_at = ? WHERE id = ? AND call_session_started_at IS NULL', nowS, nowS, id);
      if (r.changes) {
        session = nowS;
        await audit({ actorId: a.userId, action: 'ONLINE_CALL_SESSION_STARTED', subjectType: 'care_event', subjectId: id });
        await extendVideo(key(id), nowS).catch((err) => req.log.warn({ status: err?.status }, 'Daily: falha ao ajustar a sala'));
      } else session = (await one<any>('SELECT call_session_started_at FROM care_events WHERE id = ?', id))!.call_session_started_at;
    }
    const st = (isHere: boolean, seen: string | null, otherHere: boolean) =>
      cur.call_ended_at ? 'ENCERRADA' : isHere ? (otherHere ? 'CONECTADO' : 'AGUARDANDO') : seen ? 'DESCONECTADO' : 'AUSENTE';
    const mins = maxCallMinutes();
    return {
      provider: ids ? 'DAILY' : 'SIMULADO',
      patient: st(pHere, cur.call_patient_seen_at, sHere), specialist: st(sHere, cur.call_specialist_seen_at, pHere),
      sessionStartedAt: session, endsAt: session ? new Date(new Date(session).getTime() + mins * 60_000).toISOString() : null, maxMinutes: mins,
      ended: !!cur.call_ended_at, serverTime: nowS,
    };
  });

  /** Encerrar a chamada (enfermeira). Não conclui o atendimento: a evolução e a confirmação do paciente seguem o fluxo normal. */
  app.post('/api/care/specialist/events/:id/call-end', async (req) => {
    const a = requireRoles(req, ['ESPECIALISTA']);
    const { id } = parse(idParam, req.params);
    const e = await remoteEvent(id);
    if (e.specialist_id !== a.userId) throw notFound('Atendimento não encontrado.');
    if (!e.call_started_at) throw conflict('CALL_NOT_STARTED', 'A chamada ainda não começou.');
    await run('UPDATE care_events SET call_ended_at = COALESCE(call_ended_at, ?), updated_at = ? WHERE id = ?', nowIso(), nowIso(), id);
    await closeVideo(key(id)).catch((err) => req.log.warn({ status: err?.status }, 'Daily: falha ao encerrar a sala'));
    await audit({ actorId: a.userId, action: 'ONLINE_CALL_ENDED', subjectType: 'care_event', subjectId: id, correlationId: req.correlationId });
    return { ok: true };
  });
}
