import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { config } from '../../config.ts';
import { all, one, run, tx } from '../../db/db.ts';
import { audit } from '../../lib/audit.ts';
import { idempotent, parse, requireRoles } from '../../lib/context.ts';
import { AppError, badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.ts';
import { hmac, rateLimit, safeEqual } from '../../lib/security.ts';
import { chunkKey, getObject } from '../../lib/storage.ts';
import { hashObj, nowIso, randomToken, sha256, shuffle, uid } from '../../lib/util.ts';
import {
  activeEnrollment, assertPartner, assessmentReadiness, attemptsOf, certificateState, computeJourney,
  courseContext, ensureCanEnroll, latestApproved, lessonProgress, lessonsOf, paymentState,
  refreshJourneyCompletion, requireEnrollment,
} from './core.ts';

const partner = (req: any) => {
  const a = requireRoles(req, ['ESPECIALISTA']);
  assertPartner(a);
  return a;
};

/** URL temporária assinada para mídia privada (ACA-T042). */
export function signedMediaUrl(assetId: string, ttlSec = 600, preview = false) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const p = preview ? '1' : '0';
  const sig = hmac(`${assetId}.${exp}.${p}`);
  return `/api/academy/media/${assetId}?exp=${exp}&p=${p}&sig=${sig}`;
}

export async function fileChecksum(storageKey: string) {
  const buf = await getObject(storageKey);
  return buf ? sha256(buf) : null;
}

/** Integridade: arquivo único pelo SHA-256 completo; mídia em partes pela presença e hash de cada parte. */
export async function verifyMedia(m: any, deep = true) {
  if (!m.chunk_count) return (await fileChecksum(m.storage_key)) === m.checksum_sha256;
  const chunks = await all<any>('SELECT n, sha256 FROM academy_media_chunks WHERE asset_id = ? ORDER BY n', m.id);
  if (chunks.length !== m.chunk_count) return false;
  // Verificação por amostragem na aprovação (primeira e última parte); cada parte é verificada novamente ao ser servida.
  if (deep) for (const c of [chunks[0], chunks[chunks.length - 1]]) {
    const buf = await getObject(chunkKey(m.storage_key, c.n));
    if (!buf || sha256(buf) !== c.sha256) return false;
  }
  return true;
}

function publicStep(s: any) {
  const options = JSON.parse(s.options_json).map((o: any) => ({ id: o.id, text: o.text }));
  return { id: s.id, order: s.sort_order, prompt: s.prompt, options };
}

async function activityView(enrollmentId: string, activity: any) {
  const steps = await all<any>('SELECT * FROM academy_activity_steps WHERE activity_id = ? ORDER BY sort_order', activity.id);
  const attempt = await one<any>(`SELECT * FROM academy_activity_attempts WHERE activity_id = ? AND enrollment_id = ? ORDER BY attempt_no DESC LIMIT 1`,
    activity.id, enrollmentId);
  const decisions = attempt ? await all<any>('SELECT * FROM academy_activity_decisions WHERE attempt_id = ? ORDER BY decided_at', attempt.id) : [];
  const stepStatus = steps.map((s) => {
    const mine = decisions.filter((d) => d.step_id === s.id);
    const last = mine[mine.length - 1];
    const opt = last ? JSON.parse(s.options_json).find((o: any) => o.id === last.option_id) : null;
    return {
      ...publicStep(s),
      solved: mine.some((d) => d.correct),
      tries: mine.length,
      lastDecision: last ? { optionId: last.option_id, correct: !!last.correct, feedback: opt?.feedback ?? null } : null,
    };
  });
  return {
    id: activity.id, version: activity.version, title: activity.title, intro: activity.intro,
    requiredCorrect: activity.required_correct, sourceNote: activity.source_note,
    attempt: attempt ? { id: attempt.id, attemptNo: attempt.attempt_no, state: attempt.state, startedAt: attempt.started_at, completedAt: attempt.completed_at } : null,
    steps: stepStatus,
  };
}

async function attemptPublic(attempt: any, withQuestions: boolean) {
  const asm = await one<any>('SELECT * FROM academy_assessments WHERE id = ?', attempt.assessment_id)!;
  const base: any = {
    id: attempt.id, attemptNo: attempt.attempt_no, state: attempt.state, startedAt: attempt.started_at, submittedAt: attempt.submitted_at,
    assessment: { id: asm.id, version: asm.version, questionCount: asm.question_count, passMinCorrect: asm.pass_min_correct, maxAttempts: asm.max_attempts, criticalGate: !!asm.critical_gate },
  };
  if (['APROVADA', 'REPROVADA'].includes(attempt.state)) {
    base.result = {
      correct: attempt.correct_count, total: asm.question_count, criticalOk: !!attempt.critical_ok,
      rules: [
        { rule: `Mínimo de ${asm.pass_min_correct}/${asm.question_count} acertos`, met: attempt.correct_count >= asm.pass_min_correct },
        ...(asm.critical_gate ? [{ rule: 'Todas as questões críticas corretas (gate independente da nota)', met: !!attempt.critical_ok }] : []),
      ],
    };
  }
  if (withQuestions && ['CRIADA', 'EM_ANDAMENTO'].includes(attempt.state)) {
    const order: string[] = JSON.parse(attempt.question_order_json);
    const qs = await all<any>(`SELECT id, stem, options_json FROM academy_questions WHERE assessment_id = ?`, asm.id);
    const byId = new Map(qs.map((q) => [q.id, q]));
    // Gabarito nunca é enviado ao cliente (ACA-T020).
    base.questions = order.map((id, i) => {
      const q = byId.get(id)!;
      return { questionId: q.id, number: i + 1, stem: q.stem, options: JSON.parse(q.options_json).map((o: any) => ({ id: o.id, text: o.text })) };
    });
  }
  return base;
}

export async function academyRoutes(app: FastifyInstance) {
  // ACA-001/002 - Entrada e Minha Jornada
  app.get('/api/academy/journey', async (req) => {
    const a = partner(req);
    return await tx(async () => {
      const enrollment = await activeEnrollment(a.userId);
      const courses = await computeJourney(enrollment, { bind: true });
      const pay = await paymentState(a.userId);
      const cert = await certificateState(enrollment);
      const training = await one<any>('SELECT journey_state, completed_at, credentialing_decision FROM partner_training_status WHERE partner_id = ?', a.userId);
      return {
        eligible: a.academyEligible,
        requirePayment: config.academyRequirePayment,
        fee: { amountCents: config.academyFeeCents, currency: 'BRL' },
        payment: pay ? { id: pay.id, status: pay.status, amountCents: pay.amount_cents, provider: pay.provider, updatedAt: pay.updated_at } : null,
        enrollment: enrollment ? { id: enrollment.id, state: enrollment.state, journeyVersion: enrollment.journey_version, startedAt: enrollment.started_at, completedAt: enrollment.completed_at } : null,
        courses,
        certificate: cert,
        training: training ?? null,
        notice: 'A conclusão da jornada não autoriza atendimento nem credenciamento automático. A decisão de credenciamento é humana.',
      };
    });
  });

  // Catálogo: apenas versões publicadas (sem rascunhos)
  app.get('/api/academy/catalog', async (req) => {
    partner(req);
    return {
      courses: await all<any>(`SELECT c.code, c.status, cv.version, cv.title, cv.objectives FROM academy_courses c
                         LEFT JOIN academy_course_versions cv ON cv.id = c.current_version_id ORDER BY c.sort_order`),
    };
  });

  app.post('/api/academy/enrollments', async (req, reply) => {
    const a = partner(req);
    return await idempotent(req, reply, 'enroll', async () => {
      const existing = await activeEnrollment(a.userId);
      if (existing) return { status: 200, body: { enrollment: existing } };
      await ensureCanEnroll(a.userId, a.academyEligible);
      const id = uid();
      const now = nowIso();
      await run(`INSERT INTO academy_enrollments (id, partner_id, journey_version, state, started_at) VALUES (?,?,?,?,?)`,
        id, a.userId, config.journeyVersion, 'EM_ANDAMENTO', now);
      await run(`INSERT INTO partner_training_status (partner_id, journey_state, updated_at) VALUES (?,?,?)
           ON CONFLICT(partner_id) DO UPDATE SET journey_state = excluded.journey_state, updated_at = excluded.updated_at`, a.userId, 'EM_ANDAMENTO', now);
      await audit({ actorId: a.userId, action: 'ENROLLMENT_CREATED', subjectType: 'enrollment', subjectId: id, correlationId: req.correlationId });
      return { status: 201, body: { enrollment: await one('SELECT * FROM academy_enrollments WHERE id = ?', id) } };
    });
  });

  // ACA-003 - Detalhe do curso
  app.get('/api/academy/courses/:code', async (req) => {
    const a = partner(req);
    const { code } = parse(z.object({ code: z.string().regex(/^C\d{2}$/) }), req.params);
    return await tx(async () => {
      const { enrollment, summary, bound } = await courseContext(a.userId, code);
      const lessons = await lessonsOf(bound.course_version_id);
      const prog = await lessonProgress(enrollment.id, lessons.map((l) => l.id));
      const activity = await latestApproved('academy_activities', bound.course_version_id);
      const readiness = await assessmentReadiness(bound.course_version_id);
      const attempts = readiness.assessment ? await attemptsOf(enrollment.id, readiness.assessment.id) : [];
      return {
        course: summary,
        objectives: bound.objectives,
        lessons: lessons.map((l) => ({
          code: l.code, order: l.sort_order, title: l.title, required: !!l.required,
          contentAvailable: !!(l.body || l.video_asset_id),
          state: prog.get(l.id)?.state ?? 'NAO_INICIADA', percent: prog.get(l.id)?.percent ?? 0,
        })),
        activity: activity ? { id: activity.id, title: activity.title, required: bound.activity_required === 1 } : null,
        activityRequired: bound.activity_required,
        assessment: {
          ready: readiness.ready, missing: readiness.missing, id: readiness.assessment?.id ?? null,
          questionCount: readiness.assessment?.question_count ?? readiness.draft?.question_count ?? null,
          passMinCorrect: readiness.assessment?.pass_min_correct ?? readiness.draft?.pass_min_correct ?? null,
          maxAttempts: readiness.assessment?.max_attempts ?? readiness.draft?.max_attempts ?? null,
          sourceNote: readiness.sourceNote,
          attempts: attempts.map((t) => ({ id: t.id, attemptNo: t.attempt_no, state: t.state, submittedAt: t.submitted_at, correct: t.correct_count })),
        },
      };
    });
  });

  // ACA-004 - Player da aula
  app.get('/api/academy/lessons/:code', async (req) => {
    const a = partner(req);
    const { code } = parse(z.object({ code: z.string().regex(/^C\d{2}-A\d{2}$/) }), req.params);
    return await tx(async () => {
      const { enrollment, bound } = await courseContext(a.userId, code.slice(0, 3));
      const lesson = await one<any>('SELECT * FROM academy_lessons WHERE course_version_id = ? AND code = ?', bound.course_version_id, code);
      if (!lesson) throw notFound('Aula não encontrada.');
      const prog = await one<any>('SELECT * FROM academy_lesson_progress WHERE enrollment_id = ? AND lesson_id = ?', enrollment.id, lesson.id);
      const media = async (id: string | null) => {
        if (!id) return null;
        const m = await one<any>('SELECT id, kind, title, mime, state FROM academy_media_assets WHERE id = ?', id);
        if (!m || m.state !== 'APPROVED') return null;
        return { id: m.id, kind: m.kind, title: m.title, mime: m.mime, url: signedMediaUrl(m.id, 4 * 3600) };
      };
      const all_ = await lessonsOf(bound.course_version_id);
      const idx = all_.findIndex((l) => l.id === lesson.id);
      return {
        lesson: {
          code: lesson.code, title: lesson.title, body: lesson.body, courseCode: code.slice(0, 3),
          completionMinPercent: lesson.completion_min_percent,
          video: await media(lesson.video_asset_id), caption: await media(lesson.caption_asset_id), transcript: await media(lesson.transcript_asset_id),
          prev: idx > 0 ? all_[idx - 1].code : null, next: idx < all_.length - 1 ? all_[idx + 1].code : null,
        },
        progress: prog ? { state: prog.state, percent: prog.percent, lastPosition: prog.last_position, rowVersion: prog.row_version } :
          { state: 'NAO_INICIADA', percent: 0, lastPosition: 0, rowVersion: 0 },
      };
    });
  });

  // Registro de progresso: versão + controle otimista + idempotência (ACA-T008/T009/T010)
  app.put('/api/academy/progress/:code', async (req, reply) => {
    const a = partner(req);
    const { code } = parse(z.object({ code: z.string().regex(/^C\d{2}-A\d{2}$/) }), req.params);
    const body = parse(z.object({
      percent: z.number().int().min(0).max(100),
      position: z.number().int().min(0).max(24 * 3600),
      complete: z.boolean().default(false),
      rowVersion: z.number().int().min(0),
    }), req.body);
    return await idempotent(req, reply, `progress:${code}`, async () => {
      const { enrollment, bound } = await courseContext(a.userId, code.slice(0, 3));
      const lesson = await one<any>('SELECT * FROM academy_lessons WHERE course_version_id = ? AND code = ?', bound.course_version_id, code);
      if (!lesson) throw notFound('Aula não encontrada.');
      const cur = await one<any>('SELECT * FROM academy_lesson_progress WHERE enrollment_id = ? AND lesson_id = ?', enrollment.id, lesson.id);
      const curVersion = cur?.row_version ?? 0;
      if (body.rowVersion !== curVersion) {
        throw conflict('PROGRESS_CONFLICT', 'O progresso desta aula foi atualizado em outra sessão. Recarregamos o estado mais recente.',
          { state: cur?.state ?? 'NAO_INICIADA', percent: cur?.percent ?? 0, lastPosition: cur?.last_position ?? 0, rowVersion: curVersion });
      }
      const percent = Math.max(cur?.percent ?? 0, body.percent);
      let state = cur?.state === 'CONCLUIDA' ? 'CONCLUIDA' : 'EM_ANDAMENTO';
      const now = nowIso();
      let completedAt = cur?.completed_at ?? null;
      if (body.complete && state !== 'CONCLUIDA') {
        if (!lesson.body && !lesson.video_asset_id) throw unprocessable('CONTENT_PENDING', 'O conteúdo desta aula ainda não foi disponibilizado.');
        if (lesson.completion_min_percent == null) throw unprocessable('COMPLETION_RULE_PENDING', 'O critério de conclusão desta aula ainda não foi definido.');
        if (percent < lesson.completion_min_percent) {
          throw unprocessable('COMPLETION_REQUIREMENT_NOT_MET', `Para concluir, é necessário percorrer ao menos ${lesson.completion_min_percent}% da aula.`);
        }
        state = 'CONCLUIDA';
        completedAt = now;
      }
      if (cur) {
        await run(`UPDATE academy_lesson_progress SET state = ?, percent = ?, last_position = ?, row_version = row_version + 1, updated_at = ?, completed_at = ?
             WHERE id = ? AND row_version = ?`, state, percent, body.position, now, completedAt, cur.id, curVersion);
      } else {
        await run(`INSERT INTO academy_lesson_progress (id, enrollment_id, lesson_id, state, percent, last_position, row_version, updated_at, completed_at)
             VALUES (?,?,?,?,?,?,1,?,?)`, uid(), enrollment.id, lesson.id, state, percent, body.position, now, completedAt);
      }
      if (state === 'CONCLUIDA' && cur?.state !== 'CONCLUIDA') {
        await audit({ actorId: a.userId, action: 'LESSON_COMPLETED', subjectType: 'lesson', subjectId: lesson.id, correlationId: req.correlationId, meta: { code } });
      }
      const saved = await one<any>('SELECT * FROM academy_lesson_progress WHERE enrollment_id = ? AND lesson_id = ?', enrollment.id, lesson.id)!;
      return { status: 200, body: { state: saved.state, percent: saved.percent, lastPosition: saved.last_position, rowVersion: saved.row_version } };
    });
  });

  // Mídia privada com URL assinada e verificação de integridade (ACA-T041/T042)
  app.get('/api/academy/media/:id', { config: { public: true } }, async (req, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const q = parse(z.object({ exp: z.coerce.number(), p: z.enum(['0', '1']), sig: z.string() }), req.query);
    if (q.exp < Math.floor(Date.now() / 1000)) throw forbidden('Link de mídia expirado. Recarregue a aula.', 'MEDIA_URL_EXPIRED');
    if (!safeEqual(hmac(`${id}.${q.exp}.${q.p}`), q.sig)) throw forbidden('Assinatura de mídia inválida.', 'MEDIA_SIGNATURE_INVALID');
    const m = await one<any>('SELECT * FROM academy_media_assets WHERE id = ?', id);
    if (!m) throw notFound();
    if (m.state === 'BLOCKED' || (m.state !== 'APPROVED' && q.p !== '1')) throw forbidden('Mídia indisponível.', 'MEDIA_BLOCKED');
    const block = async () => {
      await run(`UPDATE academy_media_assets SET state = 'BLOCKED' WHERE id = ?`, id);
      await audit({ actorId: null, action: 'MEDIA_CHECKSUM_MISMATCH', subjectType: 'media', subjectId: id, correlationId: req.correlationId });
      return new AppError(409, 'MEDIA_INTEGRITY', 'A mídia falhou na verificação de integridade e foi bloqueada.');
    };
    reply.header('Cache-Control', 'private, no-store');
    reply.header('Content-Type', m.mime);
    reply.header('Accept-Ranges', 'bytes');
    const total = Number(m.size_bytes);
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (!m.chunk_count) {
      const buf = await getObject(m.storage_key);
      if (!buf || sha256(buf) !== m.checksum_sha256) throw await block();
      if (!range) return reply.send(buf);
      const start = range[1] ? Number(range[1]) : Math.max(0, total - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
      if (start >= total || start > end) return reply.code(416).header('Content-Range', `bytes */${total}`).send();
      return reply.code(206).header('Content-Range', `bytes ${start}-${end}/${total}`).send(buf.subarray(start, end + 1));
    }
    // Mídia em partes: cada resposta entrega no máximo uma parte (limite de resposta da Function);
    // o player do navegador pede as faixas seguintes automaticamente.
    const start = range?.[1] ? Number(range[1]) : range?.[2] ? Math.max(0, total - Number(range[2])) : 0;
    if (start >= total) return reply.code(416).header('Content-Range', `bytes */${total}`).send();
    const n = Math.floor(start / m.chunk_size);
    const c = await one<any>('SELECT sha256 FROM academy_media_chunks WHERE asset_id = ? AND n = ?', id, n);
    const buf = c ? await getObject(chunkKey(m.storage_key, n)) : null;
    if (!buf || sha256(buf) !== c.sha256) throw await block();
    const chunkStart = n * m.chunk_size;
    const reqEnd = range?.[1] && range?.[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
    const end = Math.min(reqEnd, chunkStart + buf.length - 1);
    if (!range && m.chunk_count === 1) return reply.send(buf);
    return reply.code(206).header('Content-Range', `bytes ${start}-${end}/${total}`).send(buf.subarray(start - chunkStart, end - chunkStart + 1));
  });

  // ACA-005 - Atividade integradora
  app.get('/api/academy/courses/:code/activity', async (req) => {
    const a = partner(req);
    const { code } = parse(z.object({ code: z.string().regex(/^C\d{2}$/) }), req.params);
    return await tx(async () => {
      const { enrollment, bound } = await courseContext(a.userId, code);
      const activity = await latestApproved('academy_activities', bound.course_version_id);
      if (!activity) throw unprocessable('ACTIVITY_PENDING', 'O roteiro desta atividade ainda não foi aprovado.');
      return { activity: await activityView(enrollment.id, activity), required: bound.activity_required };
    });
  });

  app.post('/api/academy/activities/:id/attempts', async (req, reply) => {
    const a = partner(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    return await idempotent(req, reply, `activity-attempt:${id}`, async () => {
      const activity = await one<any>(`SELECT * FROM academy_activities WHERE id = ? AND state = 'APPROVED'`, id);
      if (!activity) throw notFound('Atividade não encontrada.');
      const cv = await one<any>('SELECT c.code FROM academy_course_versions cv JOIN academy_courses c ON c.id = cv.course_id WHERE cv.id = ?', activity.course_version_id)!;
      const { enrollment, bound } = await courseContext(a.userId, cv.code);
      if (bound.course_version_id !== activity.course_version_id) throw forbidden('Atividade não pertence à versão do seu curso.');
      const open = await one<any>(`SELECT * FROM academy_activity_attempts WHERE activity_id = ? AND enrollment_id = ? AND state = 'EM_ANDAMENTO'`, id, enrollment.id);
      if (!open) {
        const n = (await one<any>('SELECT COALESCE(MAX(attempt_no),0)+1 AS n FROM academy_activity_attempts WHERE activity_id = ? AND enrollment_id = ?', id, enrollment.id))!.n;
        const attemptId = uid();
        await run(`INSERT INTO academy_activity_attempts (id, activity_id, enrollment_id, attempt_no, state, started_at) VALUES (?,?,?,?,?,?)`,
          attemptId, id, enrollment.id, n, 'EM_ANDAMENTO', nowIso());
        await audit({ actorId: a.userId, action: 'ACTIVITY_ATTEMPT_STARTED', subjectType: 'activity_attempt', subjectId: attemptId, correlationId: req.correlationId });
      }
      return { status: open ? 200 : 201, body: { activity: await activityView(enrollment.id, activity) } };
    });
  });

  app.post('/api/academy/activity-attempts/:id/decisions', async (req, reply) => {
    const a = partner(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(z.object({ stepId: z.string().uuid(), optionId: z.string().min(1).max(40) }), req.body);
    return await idempotent(req, reply, `activity-decision:${id}`, async () => {
      const attempt = await one<any>(`SELECT aa.*, e.partner_id FROM academy_activity_attempts aa JOIN academy_enrollments e ON e.id = aa.enrollment_id WHERE aa.id = ?`, id);
      if (!attempt || attempt.partner_id !== a.userId) throw notFound('Tentativa não encontrada.'); // IDOR (ACA-T035)
      if (attempt.state !== 'EM_ANDAMENTO') throw conflict('ATTEMPT_CLOSED', 'Esta tentativa já foi encerrada.');
      const step = await one<any>('SELECT * FROM academy_activity_steps WHERE id = ? AND activity_id = ?', body.stepId, attempt.activity_id);
      if (!step) throw notFound('Etapa não encontrada.');
      if (await one('SELECT 1 FROM academy_activity_decisions WHERE attempt_id = ? AND step_id = ? AND correct = 1', id, step.id)) {
        throw conflict('STEP_ALREADY_SOLVED', 'Esta decisão já foi concluída corretamente.');
      }
      const opt = JSON.parse(step.options_json).find((o: any) => o.id === body.optionId);
      if (!opt) throw badRequest('INVALID_OPTION', 'Opção inválida.');
      await run(`INSERT INTO academy_activity_decisions (id, attempt_id, step_id, option_id, correct, decided_at) VALUES (?,?,?,?,?,?)`,
        uid(), id, step.id, opt.id, opt.correct ? 1 : 0, nowIso());
      const activity = await one<any>('SELECT * FROM academy_activities WHERE id = ?', attempt.activity_id)!;
      const steps = await all<any>('SELECT id FROM academy_activity_steps WHERE activity_id = ?', activity.id);
      const solved = (await one<any>(`SELECT COUNT(DISTINCT step_id) AS n FROM academy_activity_decisions WHERE attempt_id = ? AND correct = 1`, id))!.n;
      let completed = false;
      if (solved >= steps.length && solved >= (activity.required_correct ?? steps.length)) {
        await run(`UPDATE academy_activity_attempts SET state = 'CONCLUIDA', completed_at = ? WHERE id = ?`, nowIso(), id);
        await audit({ actorId: a.userId, action: 'ACTIVITY_COMPLETED', subjectType: 'activity_attempt', subjectId: id, correlationId: req.correlationId,
          meta: { activityId: activity.id, version: activity.version } });
        completed = true;
      }
      return { status: 200, body: { correct: !!opt.correct, feedback: opt.feedback ?? null, solvedSteps: solved, totalSteps: steps.length, completed } };
    });
  });

  // ACA-006 - Avaliação final
  app.post('/api/academy/assessments/:id/attempts', async (req, reply) => {
    const a = partner(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    return await idempotent(req, reply, `assessment-attempt:${id}`, async () => {
      const asm = await one<any>(`SELECT * FROM academy_assessments WHERE id = ?`, id);
      if (!asm) throw notFound('Avaliação não encontrada.');
      const code = (await one<any>('SELECT c.code FROM academy_course_versions cv JOIN academy_courses c ON c.id = cv.course_id WHERE cv.id = ?', asm.course_version_id))!.code;
      const { enrollment, bound, summary } = await courseContext(a.userId, code);
      if (bound.course_version_id !== asm.course_version_id) throw forbidden('Avaliação não pertence à versão do seu curso.');
      const readiness = await assessmentReadiness(bound.course_version_id);
      if (!readiness.ready || readiness.assessment.id !== id) {
        throw unprocessable('ASSESSMENT_PENDING', `Avaliação indisponível: ${readiness.missing.join(', ') || 'versão não vigente'}.`);
      }
      if (summary.state === 'APROVADO') throw conflict('ALREADY_APPROVED', 'Você já foi aprovado neste curso.');
      if (summary.state !== 'AGUARDANDO_AVALIACAO') {
        throw forbidden('Conclua todas as aulas obrigatórias e a atividade integradora (quando exigida) antes da avaliação.', 'PREREQUISITES_NOT_MET');
      }
      const open = await one<any>(`SELECT * FROM academy_assessment_attempts WHERE assessment_id = ? AND enrollment_id = ? AND state IN ('CRIADA','EM_ANDAMENTO')`, id, enrollment.id);
      if (open) return { status: 200, body: { attempt: await attemptPublic(open, true) } };
      const used = (await attemptsOf(enrollment.id, id)).filter((t) => t.state !== 'INVALIDADA').length;
      if (used >= asm.max_attempts) throw forbidden(`Limite de ${asm.max_attempts} tentativas atingido.`, 'ATTEMPT_LIMIT');
      const qids = (await all<any>('SELECT id FROM academy_questions WHERE assessment_id = ?', id)).map((q) => q.id);
      const attemptId = uid();
      await run(`INSERT INTO academy_assessment_attempts (id, assessment_id, enrollment_id, attempt_no, state, question_order_json, started_at)
           VALUES (?,?,?,?,?,?,?)`, attemptId, id, enrollment.id, used + 1, 'EM_ANDAMENTO', JSON.stringify(shuffle(qids)), nowIso());
      await audit({ actorId: a.userId, action: 'ASSESSMENT_ATTEMPT_STARTED', subjectType: 'assessment_attempt', subjectId: attemptId, correlationId: req.correlationId,
        meta: { assessmentVersion: asm.version, attemptNo: used + 1 } });
      return { status: 201, body: { attempt: await attemptPublic(await one('SELECT * FROM academy_assessment_attempts WHERE id = ?', attemptId), true) } };
    });
  });

  app.get('/api/academy/assessment-attempts/:id', async (req) => {
    const a = partner(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const t = await one<any>(`SELECT t.*, e.partner_id FROM academy_assessment_attempts t JOIN academy_enrollments e ON e.id = t.enrollment_id WHERE t.id = ?`, id);
    if (!t || t.partner_id !== a.userId) throw notFound('Tentativa não encontrada.');
    const code = (await one<any>(`SELECT c.code FROM academy_assessments s JOIN academy_course_versions cv ON cv.id = s.course_version_id JOIN academy_courses c ON c.id = cv.course_id WHERE s.id = ?`, t.assessment_id))!.code;
    return { attempt: await attemptPublic(t, true), courseCode: code };
  });

  // Submissão atômica, idempotente e auditada (ACA-T013..T022)
  app.post('/api/academy/assessment-attempts/:id/submit', async (req, reply) => {
    const a = partner(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(z.object({
      answers: z.array(z.object({ questionId: z.string().uuid(), optionId: z.string().min(1).max(40) })).min(1).max(200),
    }), req.body);
    return await idempotent(req, reply, `assessment-submit:${id}`, async () => {
      const t = await one<any>(`SELECT t.*, e.partner_id FROM academy_assessment_attempts t JOIN academy_enrollments e ON e.id = t.enrollment_id WHERE t.id = ?`, id);
      if (!t || t.partner_id !== a.userId) throw notFound('Tentativa não encontrada.');
      if (!['CRIADA', 'EM_ANDAMENTO'].includes(t.state)) {
        throw conflict('ATTEMPT_ALREADY_SUBMITTED', 'Esta tentativa já foi submetida em outra sessão.', { attempt: await attemptPublic(t, false) });
      }
      const asm = await one<any>('SELECT * FROM academy_assessments WHERE id = ?', t.assessment_id)!;
      const questions = await all<any>('SELECT id, position, critical, correct_option_id, options_json FROM academy_questions WHERE assessment_id = ?', asm.id);
      const answers = new Map(body.answers.map((x) => [x.questionId, x.optionId]));
      const unknown = body.answers.filter((x) => !questions.some((q) => q.id === x.questionId));
      if (unknown.length) throw badRequest('INVALID_QUESTION', 'Resposta para questão que não pertence a esta tentativa.');
      const missing = questions.filter((q) => !answers.has(q.id));
      if (missing.length) throw unprocessable('INCOMPLETE_ANSWERS', `Responda todas as questões antes de enviar (${missing.length} sem resposta).`);
      let correct = 0, criticalOk = true;
      const now = nowIso();
      for (const q of questions) {
        const opt = answers.get(q.id)!;
        if (!JSON.parse(q.options_json).some((o: any) => o.id === opt)) throw badRequest('INVALID_OPTION', 'Alternativa inválida.');
        const ok = opt === q.correct_option_id;
        if (ok) correct++;
        else if (q.critical) criticalOk = false;
        await run(`INSERT INTO academy_assessment_answers (id, attempt_id, question_id, option_id, correct) VALUES (?,?,?,?,?)`, uid(), id, q.id, opt, ok ? 1 : 0);
      }
      const passed = correct >= asm.pass_min_correct && (!asm.critical_gate || criticalOk);
      const state = passed ? 'APROVADA' : 'REPROVADA';
      const upd = await run(`UPDATE academy_assessment_attempts SET state = ?, submitted_at = ?, correct_count = ?, critical_ok = ? WHERE id = ? AND state IN ('CRIADA','EM_ANDAMENTO')`,
        state, now, correct, criticalOk ? 1 : 0, id);
      if (upd.changes !== 1) throw conflict('ATTEMPT_ALREADY_SUBMITTED', 'Esta tentativa já foi submetida.');
      const course = await one<any>(`SELECT cv.course_id FROM academy_course_versions cv WHERE cv.id = ?`, asm.course_version_id)!;
      if (passed) {
        await run(`UPDATE academy_enrollment_courses SET result = 'APROVADO', result_at = ?, result_attempt_id = ? WHERE enrollment_id = ? AND course_id = ?`,
          now, id, t.enrollment_id, course.course_id);
      } else {
        const used = (await attemptsOf(t.enrollment_id, asm.id)).filter((x) => x.state !== 'INVALIDADA').length;
        if (used >= asm.max_attempts) {
          await run(`UPDATE academy_enrollment_courses SET result = 'REPROVADO', result_at = ?, result_attempt_id = ? WHERE enrollment_id = ? AND course_id = ?`,
            now, id, t.enrollment_id, course.course_id);
        }
      }
      await audit({ actorId: a.userId, action: 'ASSESSMENT_SUBMITTED', subjectType: 'assessment_attempt', subjectId: id, correlationId: req.correlationId,
        meta: { result: state, assessmentVersion: asm.version, attemptNo: t.attempt_no } });
      const enrollment = await one<any>('SELECT * FROM academy_enrollments WHERE id = ?', t.enrollment_id);
      await refreshJourneyCompletion(enrollment, req.correlationId);
      return { status: 200, body: { attempt: await attemptPublic(await one('SELECT * FROM academy_assessment_attempts WHERE id = ?', id), false) } };
    });
  });

  // ACA-008 - Histórico educacional (somente dados educacionais)
  const historyData = async (partnerId: string) => {
    const enrollments = await all<any>('SELECT id, journey_version, state, started_at, completed_at FROM academy_enrollments WHERE partner_id = ? ORDER BY started_at', partnerId);
    return Promise.all(enrollments.map(async (e) => ({
      ...e,
      courses: await all<any>(`SELECT c.code, cv.version, cv.title, ec.bound_at, ec.result, ec.result_at FROM academy_enrollment_courses ec
                         JOIN academy_courses c ON c.id = ec.course_id JOIN academy_course_versions cv ON cv.id = ec.course_version_id
                         WHERE ec.enrollment_id = ? ORDER BY c.sort_order`, e.id),
      lessons: await all<any>(`SELECT l.code, l.title, p.state, p.completed_at FROM academy_lesson_progress p JOIN academy_lessons l ON l.id = p.lesson_id
                         WHERE p.enrollment_id = ? ORDER BY l.code`, e.id),
      activityAttempts: await all<any>(`SELECT a.title, a.version, t.attempt_no, t.state, t.started_at, t.completed_at FROM academy_activity_attempts t
                                  JOIN academy_activities a ON a.id = t.activity_id WHERE t.enrollment_id = ? ORDER BY t.started_at`, e.id),
      assessmentAttempts: await all<any>(`SELECT c.code, s.version, t.attempt_no, t.state, t.started_at, t.submitted_at, t.correct_count, s.question_count
                                    FROM academy_assessment_attempts t JOIN academy_assessments s ON s.id = t.assessment_id
                                    JOIN academy_course_versions cv ON cv.id = s.course_version_id JOIN academy_courses c ON c.id = cv.course_id
                                    WHERE t.enrollment_id = ? ORDER BY t.started_at`, e.id),
      certificates: await all<any>('SELECT public_code, issued_at, revoked_at FROM academy_certificates WHERE enrollment_id = ?', e.id),
    })));
  };
  app.get('/api/academy/history', async (req) => {
    const a = partner(req);
    return { enrollments: await historyData(a.userId) };
  });
  app.get('/api/academy/history/export', async (req, reply) => {
    const a = partner(req);
    await audit({ actorId: a.userId, action: 'HISTORY_EXPORTED', subjectType: 'user', subjectId: a.userId, correlationId: req.correlationId });
    reply.header('Content-Disposition', 'attachment; filename="historico-academy.json"');
    reply.header('Cache-Control', 'no-store');
    return { exportedAt: nowIso(), scope: 'Somente dados educacionais da ONEMA Academy', partner: { name: a.name, email: a.email }, enrollments: await historyData(a.userId) };
  });

  // ACA-009 - Certificados
  app.get('/api/academy/certificates', async (req) => {
    const a = partner(req);
    const rows = await all<any>(`SELECT c.* FROM academy_certificates c JOIN academy_enrollments e ON e.id = c.enrollment_id WHERE e.partner_id = ?`, a.userId);
    const tpl = await one<any>(`SELECT id, version FROM academy_certificate_templates WHERE state = 'APPROVED' ORDER BY version DESC LIMIT 1`);
    return {
      templateApproved: !!tpl,
      certificates: await Promise.all(rows.map(async (c) => {
        const verifyUrl = `${config.publicOrigin}/verificar/${c.public_code}`;
        const template = await one<any>('SELECT heading, declaration, signatories_json, version FROM academy_certificate_templates WHERE id = ?', c.template_id)!;
        return {
          id: c.id, publicCode: c.public_code, issuedAt: c.issued_at, contentHash: c.content_hash, revokedAt: c.revoked_at,
          revokeReason: c.revoke_reason, snapshot: JSON.parse(c.snapshot_json), verifyUrl,
          template: { heading: template.heading, declaration: template.declaration, signatories: JSON.parse(template.signatories_json), version: template.version },
          qrDataUrl: await QRCode.toDataURL(verifyUrl, { margin: 1, width: 180 }),
        };
      })),
    };
  });

  app.post('/api/academy/certificates', async (req, reply) => {
    const a = partner(req);
    return await idempotent(req, reply, 'certificate-issue', async () => {
      const enrollment = await requireEnrollment(a.userId);
      const existing = await one<any>('SELECT id, public_code FROM academy_certificates WHERE enrollment_id = ?', enrollment.id);
      if (existing) return { status: 200, body: { certificate: existing, alreadyIssued: true } };
      const journey = await refreshJourneyCompletion(enrollment, req.correlationId);
      const fresh = await one<any>('SELECT * FROM academy_enrollments WHERE id = ?', enrollment.id)!;
      if (fresh.state !== 'CONCLUIDA') throw forbidden('A emissão exige a conclusão de todos os cursos da jornada.', 'JOURNEY_INCOMPLETE');
      const tpl = await one<any>(`SELECT * FROM academy_certificate_templates WHERE state = 'APPROVED' ORDER BY version DESC LIMIT 1`);
      if (!tpl) throw unprocessable('CERTIFICATE_TEMPLATE_PENDING', 'O modelo oficial do certificado ainda não foi aprovado pela ONEMA (P-008). A emissão será liberada após a aprovação.');
      const code = `ONM-${randomToken(6).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 4)}-${randomToken(6).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 4)}`;
      const snapshot = {
        holderName: a.name,
        journeyVersion: fresh.journey_version,
        journeyTitle: 'Jornada de Integração ONEMA Academy',
        completedAt: fresh.completed_at,
        courses: journey.map((c) => ({ code: c.code, title: c.title, version: c.version, workload: c.workloadText ?? '[VALIDAR]' })),
        templateVersion: tpl.version,
        statement: 'A conclusão não autoriza atendimento nem credenciamento automático.',
      };
      const id = uid();
      await run(`INSERT INTO academy_certificates (id, enrollment_id, public_code, template_id, issued_at, snapshot_json, content_hash) VALUES (?,?,?,?,?,?,?)`,
        id, enrollment.id, code, tpl.id, nowIso(), JSON.stringify(snapshot), hashObj(snapshot));
      await audit({ actorId: a.userId, action: 'CERTIFICATE_ISSUED', subjectType: 'certificate', subjectId: id, after: snapshot, correlationId: req.correlationId });
      return { status: 201, body: { certificate: { id, public_code: code }, alreadyIssued: false } };
    });
  });

  // Verificação pública mínima (sem notas, respostas, pagamento ou dados clínicos)
  app.get('/api/public/certificates/:code/verify', { config: { public: true } }, async (req) => {
    const { code } = parse(z.object({ code: z.string().max(40) }), req.params);
    if (!await rateLimit(`verify:${req.ip}`, 60, 60_000)) throw new AppError(429, 'RATE_LIMIT', 'Muitas consultas. Aguarde um minuto.');
    const c = await one<any>('SELECT * FROM academy_certificates WHERE public_code = ?', code.toUpperCase());
    const result = !c ? 'NAO_ENCONTRADO' : c.revoked_at ? 'REVOGADO' : 'VALIDO';
    await run(`INSERT INTO academy_certificate_verifications (id, certificate_id, checked_at, result, request_fingerprint) VALUES (?,?,?,?,?)`,
      uid(), c?.id ?? null, nowIso(), result, sha256(`${req.ip}|${req.headers['user-agent'] ?? ''}`).slice(0, 16));
    if (!c) return { result };
    const snap = JSON.parse(c.snapshot_json);
    const masked = String(snap.holderName).split(/\s+/).filter(Boolean).map((p: string, i: number, arr: string[]) =>
      i === 0 || i === arr.length - 1 ? p : `${p[0]}.`).join(' ');
    return {
      result, publicCode: c.public_code, holder: masked, journeyTitle: snap.journeyTitle, issuedAt: c.issued_at,
      contentHash: c.content_hash, revokedAt: c.revoked_at,
      notice: 'Esta verificação confirma apenas a emissão do certificado educacional. Não equivale a credenciamento ou autorização assistencial.',
    };
  });

  // ACA-010 - Pagamento da jornada (sandbox; gateway real não autorizado - P-009)
  app.post('/api/academy/payment-orders', async (req, reply) => {
    const a = partner(req);
    return await idempotent(req, reply, 'academy-order', async () => {
      const open = await one<any>(`SELECT * FROM academy_payment_orders WHERE partner_id = ? AND status IN ('PENDENTE','PAGO')`, a.userId);
      if (open) return { status: 200, body: { order: open } };
      const id = uid(), now = nowIso();
      await run(`INSERT INTO academy_payment_orders (id, partner_id, amount_cents, currency, status, provider, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
        id, a.userId, config.academyFeeCents, 'BRL', 'PENDENTE', config.paymentProvider, now, now);
      await audit({ actorId: a.userId, action: 'ACADEMY_ORDER_CREATED', subjectType: 'academy_order', subjectId: id, correlationId: req.correlationId });
      return { status: 201, body: { order: await one('SELECT * FROM academy_payment_orders WHERE id = ?', id) } };
    });
  });

  app.post('/api/academy/payment-orders/:id/sandbox-pay', async (req) => {
    const a = partner(req);
    if (config.paymentProvider !== 'SANDBOX') throw forbidden('Simulação indisponível.');
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { outcome } = parse(z.object({ outcome: z.enum(['APROVADO', 'RECUSADO']) }), req.body);
    const o = await one<any>('SELECT * FROM academy_payment_orders WHERE id = ?', id);
    if (!o || o.partner_id !== a.userId) throw notFound('Pedido não encontrado.');
    const event = { eventId: `sbx_${uid()}`, orderId: id, type: outcome === 'APROVADO' ? 'PAYMENT_CONFIRMED' : 'PAYMENT_DECLINED', providerRef: `sbx_ref_${id.slice(0, 8)}` };
    return await tx(async () => await applyPaymentEvent(event, req.correlationId));
  });

  // Webhook: assinatura HMAC + proteção de replay (contrato futuro do provedor real)
  app.post('/api/academy/payment-webhooks', { config: { public: true } }, async (req) => {
    const sig = String(req.headers['x-onema-signature'] ?? '');
    const raw = JSON.stringify(req.body ?? {});
    if (!config.paymentWebhookSecret || !safeEqual(hmac(raw, config.paymentWebhookSecret), sig)) {
      throw forbidden('Assinatura inválida.', 'INVALID_SIGNATURE');
    }
    const ev = parse(z.object({
      eventId: z.string().min(4).max(100), orderId: z.string().uuid(),
      type: z.enum(['PAYMENT_CONFIRMED', 'PAYMENT_DECLINED', 'PAYMENT_REFUNDED', 'PAYMENT_CANCELLED']),
      providerRef: z.string().max(100).optional(),
    }), req.body);
    return await tx(async () => await applyPaymentEvent(ev, req.correlationId));
  });
}

const TRANSITIONS: Record<string, { from: string[]; to: string }> = {
  PAYMENT_CONFIRMED: { from: ['PENDENTE'], to: 'PAGO' },
  PAYMENT_DECLINED: { from: ['PENDENTE'], to: 'RECUSADO' },
  PAYMENT_CANCELLED: { from: ['PENDENTE'], to: 'CANCELADO' },
  PAYMENT_REFUNDED: { from: ['PAGO'], to: 'ESTORNADO' },
};

export async function applyPaymentEvent(ev: { eventId: string; orderId: string; type: string; providerRef?: string }, correlationId: string | null) {
  if (await one('SELECT 1 FROM academy_payment_events WHERE provider_event_id = ?', ev.eventId)) {
    return { duplicate: true, order: await one('SELECT id, status FROM academy_payment_orders WHERE id = ?', ev.orderId) };
  }
  const o = await one<any>('SELECT * FROM academy_payment_orders WHERE id = ?', ev.orderId);
  if (!o) throw notFound('Pedido não encontrado.');
  const t = TRANSITIONS[ev.type];
  await run(`INSERT INTO academy_payment_events (id, provider_event_id, order_id, type, received_at) VALUES (?,?,?,?,?)`, uid(), ev.eventId, o.id, ev.type, nowIso());
  if (!t.from.includes(o.status)) {
    await audit({ actorId: null, action: 'ACADEMY_PAYMENT_EVENT_IGNORED', subjectType: 'academy_order', subjectId: o.id, correlationId, meta: { type: ev.type, status: o.status } });
    return { duplicate: false, ignored: true, order: { id: o.id, status: o.status } };
  }
  await run('UPDATE academy_payment_orders SET status = ?, provider_ref = COALESCE(?, provider_ref), updated_at = ? WHERE id = ?', t.to, ev.providerRef ?? null, nowIso(), o.id);
  await audit({ actorId: null, action: `ACADEMY_PAYMENT_${t.to}`, subjectType: 'academy_order', subjectId: o.id, correlationId, meta: { provider: o.provider } });
  return { duplicate: false, order: { id: o.id, status: t.to } };
}
