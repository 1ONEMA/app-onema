/**
 * Motor de estados da ONEMA Academy.
 * Fonte: Documento Mestre de Transferência Técnica ONEMA Academy v1.0 (25/09/2026), seções 4-9.
 * O cliente nunca promove estados críticos: tudo é calculado/confirmado aqui.
 */
import { config } from '../../config.ts';
import { all, one, run } from '../../db/db.ts';
import { audit } from '../../lib/audit.ts';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors.ts';
import { nowIso } from '../../lib/util.ts';

export type CourseState = 'BLOQUEADO' | 'DISPONIVEL' | 'EM_ANDAMENTO' | 'AGUARDANDO_AVALIACAO' | 'APROVADO' | 'REPROVADO';

export interface Enrollment {
  id: string; partner_id: string; journey_version: string; state: string; started_at: string; completed_at: string | null;
}

export async function activeEnrollment(partnerId: string) {
  return await one<Enrollment>(`SELECT * FROM academy_enrollments WHERE partner_id = ? AND state <> 'CANCELADA'`, partnerId);
}

export async function requireEnrollment(partnerId: string) {
  const e = await activeEnrollment(partnerId);
  if (!e) throw forbidden('Você ainda não possui matrícula ativa na Jornada de Integração.', 'NOT_ENROLLED');
  if (e.state === 'SUSPENSA') throw forbidden('Sua matrícula está suspensa. Procure o suporte da Academy.', 'ENROLLMENT_SUSPENDED');
  return e;
}

export const listCourses = () =>
  all<any>('SELECT * FROM academy_courses ORDER BY sort_order');

export async function latestApproved(table: 'academy_activities' | 'academy_assessments', courseVersionId: string) {
  return await one<any>(`SELECT * FROM ${table} WHERE course_version_id = ? AND state = 'APPROVED' ORDER BY version DESC LIMIT 1`, courseVersionId);
}

/** Vinculação congelada da matrícula a uma versão publicada (ACA-T007). */
export async function boundVersion(enrollmentId: string, courseId: string) {
  return await one<any>(`SELECT ec.*, cv.title, cv.version, cv.activity_required, cv.objectives, cv.workload_text
                   FROM academy_enrollment_courses ec JOIN academy_course_versions cv ON cv.id = ec.course_version_id
                   WHERE ec.enrollment_id = ? AND ec.course_id = ?`, enrollmentId, courseId);
}

export async function bindIfPossible(enrollmentId: string, course: any) {
  const b = await boundVersion(enrollmentId, course.id);
  if (b) return b;
  if (course.status !== 'ACTIVE' || !course.current_version_id) return undefined;
  await run(`INSERT INTO academy_enrollment_courses (enrollment_id, course_id, course_version_id, bound_at) VALUES (?,?,?,?)`,
    enrollmentId, course.id, course.current_version_id, nowIso());
  return await boundVersion(enrollmentId, course.id);
}

export async function lessonsOf(courseVersionId: string) {
  return await all<any>('SELECT * FROM academy_lessons WHERE course_version_id = ? ORDER BY sort_order', courseVersionId);
}

export async function lessonProgress(enrollmentId: string, lessonIds: string[]) {
  if (!lessonIds.length) return new Map<string, any>();
  const rows = await all<any>(`SELECT * FROM academy_lesson_progress WHERE enrollment_id = ? AND lesson_id IN (${lessonIds.map(() => '?').join(',')})`,
    enrollmentId, ...lessonIds);
  return new Map(rows.map((r) => [r.lesson_id, r]));
}

export async function activityCompleted(enrollmentId: string, courseVersionId: string) {
  return !!await one(`SELECT 1 FROM academy_activity_attempts aa JOIN academy_activities a ON a.id = aa.activity_id
                WHERE aa.enrollment_id = ? AND a.course_version_id = ? AND aa.state = 'CONCLUIDA'`, enrollmentId, courseVersionId);
}

/** Situação da avaliação: pronta para uso somente com regra + banco aprovados. */
export async function assessmentReadiness(courseVersionId: string) {
  const a = await latestApproved('academy_assessments', courseVersionId);
  if (!a) {
    const draft = await one<any>(`SELECT * FROM academy_assessments WHERE course_version_id = ? ORDER BY version DESC LIMIT 1`, courseVersionId);
    const missing: string[] = [];
    if (!draft || draft.question_count == null) missing.push('número de questões');
    if (!draft || draft.pass_min_correct == null) missing.push('nota mínima');
    if (!draft || draft.max_attempts == null) missing.push('limite de tentativas');
    missing.push('banco de questões aprovado pelo RT');
    return { ready: false as const, assessment: null, draft, missing, sourceNote: draft?.source_note ?? null };
  }
  return { ready: true as const, assessment: a, draft: null, missing: [] as string[], sourceNote: a.source_note };
}

export async function attemptsOf(enrollmentId: string, assessmentId: string) {
  return await all<any>(`SELECT * FROM academy_assessment_attempts WHERE enrollment_id = ? AND assessment_id = ? ORDER BY attempt_no`, enrollmentId, assessmentId);
}

export interface CourseSummary {
  id: string; code: string; status: string; state: CourseState;
  version: number | null; courseVersionId: string | null; title: string;
  lessonsTotal: number; lessonsDone: number;
  activityRequired: number | null; activityDone: boolean;
  assessment: { ready: boolean; missing: string[]; attemptsUsed: number; maxAttempts: number | null; id: string | null };
  pending: string[];
  workloadText: string | null;
}

/** Calcula o estado de cada curso na ordem da jornada. */
export async function computeJourney(enrollment: Enrollment | undefined, opts: { bind: boolean }) {
  const courses = await listCourses();
  const out: CourseSummary[] = [];
  let prevApproved = true;
  for (const c of courses) {
    const published = c.current_version_id
      ? await one<any>('SELECT * FROM academy_course_versions WHERE id = ?', c.current_version_id) : undefined;
    let bound = enrollment ? await boundVersion(enrollment.id, c.id) : undefined;
    if (!bound && enrollment && prevApproved && opts.bind) bound = await bindIfPossible(enrollment.id, c);
    const cv = bound ? await one<any>('SELECT * FROM academy_course_versions WHERE id = ?', bound.course_version_id) : published;
    const pending: string[] = [];
    let state: CourseState = 'BLOQUEADO';
    let lessonsTotal = 0, lessonsDone = 0, activityDone = false;
    let asm: CourseSummary['assessment'] = { ready: false, missing: [], attemptsUsed: 0, maxAttempts: null, id: null };

    if (!cv) {
      pending.push('Nenhuma versão publicada deste curso.');
    } else {
      const lessons = (await lessonsOf(cv.id)).filter((l) => l.required);
      lessonsTotal = lessons.length;
      const readiness = await assessmentReadiness(cv.id);
      asm = { ready: readiness.ready, missing: readiness.missing, attemptsUsed: 0, maxAttempts: readiness.assessment?.max_attempts ?? null, id: readiness.assessment?.id ?? null };
      if (!readiness.ready) pending.push(`Avaliação pendente de definição institucional: ${readiness.missing.join(', ')}.`);
      if (cv.activity_required == null) pending.push('Obrigatoriedade da atividade integradora pendente de definição.');
      else if (cv.activity_required === 1 && !await latestApproved('academy_activities', cv.id)) pending.push('Roteiro da atividade integradora pendente de aprovação.');

      if (enrollment && bound) {
        const prog = await lessonProgress(enrollment.id, lessons.map((l) => l.id));
        lessonsDone = lessons.filter((l) => prog.get(l.id)?.state === 'CONCLUIDA').length;
        activityDone = await activityCompleted(enrollment.id, cv.id);
        const attempts = readiness.assessment ? await attemptsOf(enrollment.id, readiness.assessment.id) : [];
        asm.attemptsUsed = attempts.filter((t) => t.state !== 'INVALIDADA').length;
        const started = prog.size > 0 || activityDone || attempts.length > 0;
        const lessonsOk = lessonsTotal > 0 && lessonsDone === lessonsTotal;
        const activityOk = cv.activity_required === 0 || (cv.activity_required === 1 && activityDone);
        if (!prevApproved) state = 'BLOQUEADO';
        else if (bound.result === 'APROVADO') state = 'APROVADO';
        else if (bound.result === 'REPROVADO') state = 'REPROVADO';
        else if (lessonsOk && activityOk) state = 'AGUARDANDO_AVALIACAO';
        else if (started) state = 'EM_ANDAMENTO';
        else state = 'DISPONIVEL';
      } else if (enrollment && prevApproved) {
        pending.push(c.status !== 'ACTIVE' ? 'Curso desativado para novas vinculações.' : 'Curso ainda não publicado.');
      }
    }
    if (c.status !== 'ACTIVE' && !bound) state = 'BLOQUEADO';
    out.push({
      id: c.id, code: c.code, status: c.status, state,
      version: cv?.version ?? null, courseVersionId: cv?.id ?? null, title: cv?.title ?? c.code,
      lessonsTotal, lessonsDone, activityRequired: cv?.activity_required ?? null, activityDone, assessment: asm, pending,
      workloadText: cv?.workload_text ?? null,
    });
    prevApproved = state === 'APROVADO';
  }
  return out;
}

/** Contexto do curso para o especialista: vínculo + verificação de bloqueio. */
export async function courseContext(partnerId: string, courseCode: string) {
  const enrollment = await requireEnrollment(partnerId);
  const journey = await computeJourney(enrollment, { bind: true });
  const summary = journey.find((c) => c.code === courseCode);
  if (!summary) throw notFound('Curso não encontrado.');
  if (summary.state === 'BLOQUEADO') throw forbidden('Este curso ainda está bloqueado. Conclua o curso anterior.', 'COURSE_LOCKED');
  const course = await one<any>('SELECT * FROM academy_courses WHERE code = ?', courseCode)!;
  const bound = await boundVersion(enrollment.id, course.id);
  if (!bound) throw unprocessable('COURSE_NOT_PUBLISHED', 'Este curso ainda não possui versão publicada.');
  return { enrollment, summary, course, bound, journey };
}

/** Atualiza a projeção de capacitação no ONEMA ONE (somente projeção - ACA-T043/T044). */
export async function refreshJourneyCompletion(enrollment: Enrollment, correlationId: string | null) {
  const journey = await computeJourney(enrollment, { bind: true });
  const allApproved = journey.length > 0 && journey.every((c) => c.state === 'APROVADO');
  const now = nowIso();
  if (allApproved && enrollment.state !== 'CONCLUIDA') {
    await run(`UPDATE academy_enrollments SET state = 'CONCLUIDA', completed_at = ? WHERE id = ?`, now, enrollment.id);
    await audit({ actorId: enrollment.partner_id, action: 'JOURNEY_COMPLETED', subjectType: 'enrollment', subjectId: enrollment.id, correlationId });
  }
  const state = allApproved ? 'CONCLUIDA' : enrollment.state;
  await run(`INSERT INTO partner_training_status (partner_id, journey_state, completed_at, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(partner_id) DO UPDATE SET journey_state = excluded.journey_state,
         completed_at = COALESCE(partner_training_status.completed_at, excluded.completed_at), updated_at = excluded.updated_at`,
    enrollment.partner_id, state, allApproved ? now : null, now);
  return journey;
}

export async function paymentState(partnerId: string) {
  const o = await one<any>(`SELECT * FROM academy_payment_orders WHERE partner_id = ? ORDER BY created_at DESC LIMIT 1`, partnerId);
  return o ?? null;
}

export async function certificateState(enrollment: Enrollment | undefined) {
  if (!enrollment) return { state: 'NAO_ELEGIVEL' as const, certificate: null };
  const cert = await one<any>('SELECT id, public_code, issued_at, revoked_at, content_hash FROM academy_certificates WHERE enrollment_id = ?', enrollment.id);
  if (cert) return { state: cert.revoked_at ? 'REVOGADO' as const : 'EMITIDO' as const, certificate: cert };
  return { state: enrollment.state === 'CONCLUIDA' ? 'ELEGIVEL' as const : 'NAO_ELEGIVEL' as const, certificate: null };
}

export function assertPartner(a: { roles: string[]; academyEligible: boolean }) {
  if (!a.roles.includes('ESPECIALISTA')) throw forbidden('A ONEMA Academy é exclusiva da Área do Especialista.');
}

export async function ensureCanEnroll(partnerId: string, eligible: boolean) {
  if (!eligible) {
    throw forbidden('Sua elegibilidade ao ONEMA ONE ainda não foi confirmada. Procure o credenciamento.', 'NOT_ELIGIBLE');
  }
  if ((await all(`SELECT 1 FROM academy_courses WHERE status <> 'ACTIVE'`)).length) {
    throw conflict('JOURNEY_UNAVAILABLE', 'A jornada está temporariamente indisponível para novas matrículas.');
  }
  if (config.academyRequirePayment) {
    const p = await paymentState(partnerId);
    if (!p || p.status !== 'PAGO') {
      throw forbidden('A matrícula exige a confirmação do pagamento da taxa de acesso.', 'PAYMENT_REQUIRED');
    }
  }
}
