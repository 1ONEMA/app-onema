/**
 * Atendimento online do catálogo (RT, 13/11/2026): todo atendimento remoto segue para a Telenfermagem — mesma sala de vídeo
 * (Daily, sem gravação, até 30 minutos), com horário combinado pela enfermeira e link por e-mail para os dois lados.
 * A evolução continua sendo registrada e assinada na tela do atendimento; o paciente confirma como nos demais.
 * Homologação: enquanto TELE_REAL_USE_APPROVED não for ativado, só pacientes de teste (@exemplo.test).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, run } from '../../db/db.ts';
import { config } from '../../config.ts';
import { audit } from '../../lib/audit.ts';
import { parse, requireRoles, requireUser } from '../../lib/context.ts';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.ts';
import { nowIso } from '../../lib/util.ts';
import { emailUser } from '../../lib/user-email.ts';
import { notify } from '../prime/core.ts';
import { closeVideo, maxCallMinutes, openVideo } from '../tele/video.ts';
import { partnerActive } from '../specialist/validation.ts';

const idParam = z.object({ id: z.string().uuid() });
const key = (eventId: string) => `care-event:${eventId}`;
const fmt = (iso: string) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });

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
  /** A enfermeira combina o horário da chamada; paciente e enfermeira recebem o link por e-mail e aviso no app. */
  app.post('/api/care/specialist/events/:id/call-schedule', async (req) => {
    const a = requireRoles(req, ['ESPECIALISTA']);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ startAt: z.string().datetime({ offset: true }) }), req.body);
    const e = await remoteEvent(id);
    if (e.specialist_id !== a.userId) throw notFound('Atendimento não encontrado.');
    if (!await partnerActive(a.userId)) throw forbidden('Seu perfil não está ativo para atendimento.', 'NOT_CREDENTIALED');
    if (e.status !== 'ACEITO') throw conflict('EVENT_NOT_ACCEPTED', 'Só é possível agendar um atendimento aceito por você.');
    homologationGuard(e);
    const at = new Date(b.startAt);
    if (at.getTime() < Date.now() - 5 * 60_000) throw unprocessable('INVALID_TIME', 'Escolha um horário futuro.');
    await run('UPDATE care_events SET call_scheduled_at = ?, updated_at = ? WHERE id = ?', at.toISOString(), nowIso(), id);
    await audit({ actorId: a.userId, action: 'ONLINE_CALL_SCHEDULED', subjectType: 'care_event', subjectId: id, correlationId: req.correlationId });
    const when = fmt(at.toISOString()); const mins = maxCallMinutes();
    await notify(e.patient_id, 'LEMBRETE', 'Atendimento online agendado', `Seu atendimento online ONEMA está marcado para ${when}. Entre pelo app no horário.`);
    await emailUser(e.patient_id, 'ONLINE_AGENDADO', 'Atendimento online agendado', [`Seu atendimento online ONEMA (${e.label}) está marcado para ${when} (horário de Brasília).`,
      `No horário, entre pelo link abaixo, faça login e toque em "Entrar na sala". A sala abre 30 minutos antes e o atendimento dura até ${mins} minutos. Não é gravado.`],
      { label: 'Abrir meu atendimento', path: `/solicitacoes/${e.request_id}` }).catch((err) => req.log.warn({ err: String(err) }, 'e-mail do atendimento online'));
    await emailUser(a.userId, 'ONLINE_AGENDADO', 'Atendimento online agendado', [`Você tem um atendimento online ONEMA (${e.label}) marcado para ${when} (horário de Brasília).`,
      `Entre pelo link abaixo e toque em "Entrar na sala". O atendimento começa quando você entra e dura até ${mins} minutos.`],
      { label: 'Abrir o atendimento', path: `/especialista/atendimentos/${id}` }).catch((err) => req.log.warn({ err: String(err) }, 'e-mail do atendimento online'));
    return { ok: true, callScheduledAt: at.toISOString() };
  });

  /** Entrar na sala (paciente do pedido ou enfermeira designada). A entrada da enfermeira inicia o atendimento e o relógio. */
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
    let startedAt: string | null = e.call_started_at;
    if (professional && !startedAt) {
      startedAt = nowIso();
      await run('UPDATE care_events SET call_started_at = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND call_started_at IS NULL', startedAt, startedAt, startedAt, id);
    }
    let video: Awaited<ReturnType<typeof openVideo>>;
    try {
      video = await openVideo({ key: key(id), userName: a.name || (professional ? 'Enfermeira ONEMA' : 'Paciente'), owner: professional, startedAt, notBefore: e.call_scheduled_at });
    } catch (err: any) {
      if (err instanceof AppError) throw err;
      req.log.error({ correlationId: req.correlationId, status: err?.status, info: err?.info }, 'Daily: falha ao abrir a sala');
      throw new AppError(502, 'VIDEO_UNAVAILABLE', 'Não foi possível abrir a sala de vídeo agora. Tente de novo em instantes.');
    }
    await audit({ actorId: a.userId, action: 'ONLINE_CALL_JOINED', subjectType: 'care_event', subjectId: id, correlationId: req.correlationId, meta: { professional, provider: video.provider } });
    return { video, startedAt };
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
