import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.ts';
import { all, one, run, tx } from '../../db/db.ts';
import { audit } from '../../lib/audit.ts';
import { parse, requireRoles, type AuthCtx } from '../../lib/context.ts';
import { AppError, badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.ts';
import { hashObj, nowIso, sha256, uid } from '../../lib/util.ts';
import { computeJourney, refreshJourneyCompletion } from './core.ts';
import { fileChecksum, signedMediaUrl } from './routes.ts';

const READERS = ['GESTOR_CONTEUDO', 'AVALIADOR_RT', 'ADMIN_ACADEMY', 'AUDITOR'] as const;
const idParam = z.object({ id: z.string().uuid() });

function cvOrThrow(id: string) {
  const cv = one<any>('SELECT cv.*, c.code FROM academy_course_versions cv JOIN academy_courses c ON c.id = cv.course_id WHERE cv.id = ?', id);
  if (!cv) throw notFound('Versão de curso não encontrada.');
  return cv;
}
function requireDraft(cv: any) {
  if (cv.state !== 'DRAFT') {
    throw conflict('VERSION_IMMUTABLE', 'Versões em revisão, aprovadas ou publicadas são imutáveis. Crie um novo rascunho (ACA-T040).');
  }
}
/** Segregação: quem criou não aprova (Documento Mestre 11 - GESTOR não aprova sozinho). */
function segregate(a: AuthCtx, createdBy: string | null) {
  if (createdBy && createdBy === a.userId) {
    throw forbidden('Segregação de funções: quem elaborou o rascunho não pode aprová-lo.', 'SEGREGATION_OF_DUTIES');
  }
}

/** Validações de liberação da versão (ACA-T032: vídeo sem legenda/transcrição não libera). */
export function versionIssues(cvId: string): string[] {
  const issues: string[] = [];
  const cv = one<any>('SELECT * FROM academy_course_versions WHERE id = ?', cvId)!;
  if (cv.activity_required == null) issues.push('Defina se a atividade integradora é obrigatória.');
  const lessons = all<any>('SELECT * FROM academy_lessons WHERE course_version_id = ? ORDER BY sort_order', cvId);
  if (!lessons.length) issues.push('A versão não possui aulas.');
  const approved = (id: string | null) => !!id && one<any>('SELECT state FROM academy_media_assets WHERE id = ?', id)?.state === 'APPROVED';
  for (const l of lessons) {
    if (!l.body && !l.video_asset_id) issues.push(`${l.code}: conteúdo pendente (texto ou vídeo).`);
    if (l.completion_min_percent == null) issues.push(`${l.code}: critério mínimo de conclusão não definido.`);
    if (l.video_asset_id) {
      if (!approved(l.video_asset_id)) issues.push(`${l.code}: vídeo não aprovado.`);
      if (!approved(l.caption_asset_id)) issues.push(`${l.code}: vídeo sem legenda aprovada.`);
      if (!approved(l.transcript_asset_id)) issues.push(`${l.code}: vídeo sem transcrição aprovada.`);
    }
  }
  return issues;
}

function versionSnapshot(cvId: string) {
  const cv = one<any>('SELECT id, version, title, objectives, activity_required, workload_text FROM academy_course_versions WHERE id = ?', cvId);
  const lessons = all<any>('SELECT code, sort_order, required, title, body, video_asset_id, caption_asset_id, transcript_asset_id, completion_min_percent FROM academy_lessons WHERE course_version_id = ? ORDER BY sort_order', cvId);
  return { cv, lessons };
}

function assessmentIssues(asmId: string): string[] {
  const s = one<any>('SELECT * FROM academy_assessments WHERE id = ?', asmId)!;
  const issues: string[] = [];
  if (s.question_count == null) issues.push('Número de questões não definido.');
  if (s.pass_min_correct == null) issues.push('Nota mínima não definida.');
  if (s.max_attempts == null) issues.push('Limite de tentativas não definido.');
  if (s.question_count != null && s.pass_min_correct != null && s.pass_min_correct > s.question_count) issues.push('Nota mínima maior que o número de questões.');
  const qs = all<any>('SELECT position, critical FROM academy_questions WHERE assessment_id = ? ORDER BY position', asmId);
  if (s.question_count != null && qs.length !== s.question_count) issues.push(`Banco com ${qs.length} questões; a regra exige ${s.question_count}.`);
  if (s.critical_gate && !qs.some((q) => q.critical)) issues.push('Gate de questões críticas ativo, mas nenhuma questão está marcada como crítica.');
  qs.forEach((q, i) => { if (q.position !== i + 1) issues.push(`Numeração das questões deve ser sequencial (falta a ${i + 1}).`); });
  return [...new Set(issues)];
}

function activityIssues(actId: string): string[] {
  const act = one<any>('SELECT * FROM academy_activities WHERE id = ?', actId)!;
  const steps = all<any>('SELECT * FROM academy_activity_steps WHERE activity_id = ? ORDER BY sort_order', actId);
  const issues: string[] = [];
  if (!steps.length) issues.push('A atividade não possui decisões.');
  if (act.required_correct == null) issues.push('Regra de conclusão (decisões corretas exigidas) não definida.');
  else if (steps.length !== act.required_correct) issues.push(`A regra exige ${act.required_correct} decisões corretas; o roteiro tem ${steps.length}.`);
  steps.forEach((s, i) => {
    const opts = JSON.parse(s.options_json);
    if (opts.filter((o: any) => o.correct).length !== 1) issues.push(`Decisão ${i + 1}: deve haver exatamente uma opção correta.`);
    if (opts.some((o: any) => !o.feedback)) issues.push(`Decisão ${i + 1}: todas as opções precisam de feedback aprovado.`);
  });
  return issues;
}

function questionView(q: any, withKey: boolean) {
  return {
    id: q.id, position: q.position, critical: !!q.critical, stem: q.stem,
    options: JSON.parse(q.options_json), ...(withKey ? { correctOptionId: q.correct_option_id } : {}),
  };
}

function denyKeyAccess(req: FastifyRequest) {
  // ACA-T020: tentativa de obter gabarito é negada e auditada
  audit({ actorId: req.auth?.userId ?? null, action: 'ANSWER_KEY_ACCESS_DENIED', subjectType: 'assessment', subjectId: (req.params as any)?.id ?? null, correlationId: req.correlationId });
  return forbidden('Acesso ao banco de questões restrito.');
}

export async function academyAdminRoutes(app: FastifyInstance) {
  // ---- Catálogo e versões (ACA-012) ----
  app.get('/api/admin/academy/courses', async (req) => {
    requireRoles(req, [...READERS]);
    const courses = all<any>('SELECT * FROM academy_courses ORDER BY sort_order');
    return {
      courses: courses.map((c) => ({
        ...c,
        versions: all<any>(`SELECT id, version, title, state, created_at, approved_at, published_at, activity_required, workload_text, source_note
                            FROM academy_course_versions WHERE course_id = ? ORDER BY version DESC`, c.id),
      })),
    };
  });

  app.get('/api/admin/academy/course-versions/:id', async (req) => {
    const a = requireRoles(req, [...READERS]);
    const { id } = parse(idParam, req.params);
    const cv = cvOrThrow(id);
    const lessons = all<any>('SELECT * FROM academy_lessons WHERE course_version_id = ? ORDER BY sort_order', id);
    const activities = all<any>('SELECT * FROM academy_activities WHERE course_version_id = ? ORDER BY version DESC', id);
    const assessments = all<any>('SELECT * FROM academy_assessments WHERE course_version_id = ? ORDER BY version DESC', id);
    const canKeys = a.roles.includes('AVALIADOR_RT') || a.roles.includes('GESTOR_CONTEUDO');
    return {
      version: cv,
      issues: versionIssues(id),
      lessons,
      activities: activities.map((act) => ({
        ...act,
        issues: activityIssues(act.id),
        steps: all<any>('SELECT * FROM academy_activity_steps WHERE activity_id = ? ORDER BY sort_order', act.id).map((s) => ({
          id: s.id, order: s.sort_order, prompt: s.prompt,
          options: JSON.parse(s.options_json).map((o: any) => canKeys ? o : { id: o.id, text: o.text }),
        })),
      })),
      assessments: assessments.map((s) => ({
        ...s,
        issues: assessmentIssues(s.id),
        questionTotal: one<any>('SELECT COUNT(*) AS n FROM academy_questions WHERE assessment_id = ?', s.id)!.n,
      })),
    };
  });

  app.post('/api/admin/academy/course-versions', async (req) => {
    const a = requireRoles(req, ['GESTOR_CONTEUDO', 'ADMIN_ACADEMY']);
    const { courseCode } = parse(z.object({ courseCode: z.string().regex(/^C\d{2}$/) }), req.body);
    return tx(() => {
      const course = one<any>('SELECT * FROM academy_courses WHERE code = ?', courseCode);
      if (!course) throw notFound('Curso não encontrado.');
      if (one(`SELECT 1 FROM academy_course_versions WHERE course_id = ? AND state IN ('DRAFT','IN_REVIEW')`, course.id)) {
        throw conflict('DRAFT_EXISTS', 'Já existe um rascunho ou versão em revisão para este curso.');
      }
      const base = one<any>('SELECT * FROM academy_course_versions WHERE course_id = ? ORDER BY version DESC LIMIT 1', course.id);
      const id = uid(), now = nowIso();
      const version = (base?.version ?? 0) + 1;
      run(`INSERT INTO academy_course_versions (id, course_id, version, title, objectives, activity_required, workload_text, source_note, state, created_by, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, course.id, version, base?.title ?? courseCode, base?.objectives ?? null, base?.activity_required ?? null,
        base?.workload_text ?? null, base?.source_note ?? null, 'DRAFT', a.userId, now);
      if (base) {
        for (const l of all<any>('SELECT * FROM academy_lessons WHERE course_version_id = ?', base.id)) {
          run(`INSERT INTO academy_lessons (id, course_version_id, code, sort_order, required, title, body, video_asset_id, caption_asset_id, transcript_asset_id, completion_min_percent)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)`, uid(), id, l.code, l.sort_order, l.required, l.title, l.body, l.video_asset_id, l.caption_asset_id, l.transcript_asset_id, l.completion_min_percent);
        }
        cloneLatest('academy_assessments', base.id, id, a.userId);
        cloneLatest('academy_activities', base.id, id, a.userId);
      }
      audit({ actorId: a.userId, action: 'COURSE_VERSION_DRAFT_CREATED', subjectType: 'course_version', subjectId: id, correlationId: req.correlationId, meta: { courseCode, version } });
      return { id, version };
    });
  });

  app.put('/api/admin/academy/course-versions/:id', async (req) => {
    const a = requireRoles(req, ['GESTOR_CONTEUDO', 'ADMIN_ACADEMY']);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({
      title: z.string().trim().min(3).max(200),
      objectives: z.string().max(4000).nullable(),
      activityRequired: z.union([z.literal(0), z.literal(1)]).nullable(),
      workloadText: z.string().trim().max(60).nullable(),
    }), req.body);
    return tx(() => {
      const cv = cvOrThrow(id); requireDraft(cv);
      const before = versionSnapshot(id);
      run('UPDATE academy_course_versions SET title = ?, objectives = ?, activity_required = ?, workload_text = ? WHERE id = ?',
        body.title, body.objectives, body.activityRequired, body.workloadText || null, id);
      audit({ actorId: a.userId, action: 'COURSE_VERSION_EDITED', subjectType: 'course_version', subjectId: id, before, after: versionSnapshot(id), correlationId: req.correlationId });
      return { ok: true };
    });
  });

  app.put('/api/admin/academy/lessons/:id', async (req) => {
    const a = requireRoles(req, ['GESTOR_CONTEUDO', 'ADMIN_ACADEMY']);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({
      title: z.string().trim().min(3).max(200),
      body: z.string().max(50000).nullable(),
      videoAssetId: z.string().uuid().nullable(),
      captionAssetId: z.string().uuid().nullable(),
      transcriptAssetId: z.string().uuid().nullable(),
      completionMinPercent: z.number().int().min(1).max(100).nullable(),
    }), req.body);
    return tx(() => {
      const l = one<any>('SELECT * FROM academy_lessons WHERE id = ?', id);
      if (!l) throw notFound('Aula não encontrada.');
      requireDraft(cvOrThrow(l.course_version_id));
      for (const [field, kind] of [['videoAssetId', 'VIDEO'], ['captionAssetId', 'CAPTION'], ['transcriptAssetId', 'TRANSCRIPT']] as const) {
        const v = (body as any)[field];
        if (v && one<any>('SELECT kind FROM academy_media_assets WHERE id = ?', v)?.kind !== kind) throw badRequest('INVALID_MEDIA', `Mídia inválida para ${kind}.`);
      }
      const before = versionSnapshot(l.course_version_id);
      run(`UPDATE academy_lessons SET title = ?, body = ?, video_asset_id = ?, caption_asset_id = ?, transcript_asset_id = ?, completion_min_percent = ? WHERE id = ?`,
        body.title, body.body || null, body.videoAssetId, body.captionAssetId, body.transcriptAssetId, body.completionMinPercent, id);
      audit({ actorId: a.userId, action: 'LESSON_EDITED', subjectType: 'course_version', subjectId: l.course_version_id, before, after: versionSnapshot(l.course_version_id), correlationId: req.correlationId, meta: { lesson: l.code } });
      return { ok: true };
    });
  });

  app.post('/api/admin/academy/course-versions/:id/submit', async (req) => {
    const a = requireRoles(req, ['GESTOR_CONTEUDO', 'ADMIN_ACADEMY']);
    const { id } = parse(idParam, req.params);
    return tx(() => {
      const cv = cvOrThrow(id); requireDraft(cv);
      const issues = versionIssues(id);
      if (issues.length) throw unprocessable('VERSION_INCOMPLETE', 'A versão possui pendências que impedem o envio para revisão.', issues);
      run(`UPDATE academy_course_versions SET state = 'IN_REVIEW', submitted_at = ? WHERE id = ?`, nowIso(), id);
      audit({ actorId: a.userId, action: 'COURSE_VERSION_SUBMITTED', subjectType: 'course_version', subjectId: id, correlationId: req.correlationId });
      return { ok: true };
    });
  });

  app.post('/api/admin/academy/course-versions/:id/approve', async (req) => {
    const a = requireRoles(req, ['AVALIADOR_RT']);
    const { id } = parse(idParam, req.params);
    return tx(() => {
      const cv = cvOrThrow(id);
      if (cv.state !== 'IN_REVIEW') throw conflict('INVALID_STATE', 'Somente versões em revisão podem ser aprovadas.');
      segregate(a, cv.created_by);
      const issues = versionIssues(id);
      if (issues.length) throw unprocessable('VERSION_INCOMPLETE', 'A versão possui pendências.', issues);
      const snap = versionSnapshot(id);
      run(`UPDATE academy_course_versions SET state = 'APPROVED', approved_by = ?, approved_at = ?, content_hash = ? WHERE id = ?`, a.userId, nowIso(), hashObj(snap), id);
      audit({ actorId: a.userId, action: 'COURSE_VERSION_APPROVED', subjectType: 'course_version', subjectId: id, after: snap, correlationId: req.correlationId });
      return { ok: true };
    });
  });

  app.post('/api/admin/academy/course-versions/:id/reject', async (req) => {
    const a = requireRoles(req, ['AVALIADOR_RT']);
    const { id } = parse(idParam, req.params);
    const { note } = parse(z.object({ note: z.string().trim().min(5).max(2000) }), req.body);
    return tx(() => {
      const cv = cvOrThrow(id);
      if (cv.state !== 'IN_REVIEW') throw conflict('INVALID_STATE', 'Somente versões em revisão podem ser devolvidas.');
      run(`UPDATE academy_course_versions SET state = 'DRAFT', submitted_at = NULL WHERE id = ?`, id);
      audit({ actorId: a.userId, action: 'COURSE_VERSION_RETURNED', subjectType: 'course_version', subjectId: id, correlationId: req.correlationId, meta: { noteLength: note.length } });
      return { ok: true };
    });
  });

  // ACA-T039: publicação só após aprovação RT
  app.post('/api/admin/academy/course-versions/:id/publish', async (req) => {
    const a = requireRoles(req, ['ADMIN_ACADEMY']);
    const { id } = parse(idParam, req.params);
    return tx(() => {
      const cv = cvOrThrow(id);
      if (cv.state !== 'APPROVED') throw conflict('RT_APPROVAL_REQUIRED', 'A publicação exige aprovação prévia do Avaliador/RT.');
      if (hashObj(versionSnapshot(id)) !== cv.content_hash) throw conflict('CONTENT_CHANGED', 'O conteúdo diverge do aprovado. Publicação bloqueada.');
      const now = nowIso();
      run(`UPDATE academy_course_versions SET state = 'ARCHIVED' WHERE course_id = ? AND state = 'PUBLISHED'`, cv.course_id);
      run(`UPDATE academy_course_versions SET state = 'PUBLISHED', published_at = ? WHERE id = ?`, now, id);
      run('UPDATE academy_courses SET current_version_id = ? WHERE id = ?', id, cv.course_id);
      audit({ actorId: a.userId, action: 'COURSE_VERSION_PUBLISHED', subjectType: 'course_version', subjectId: id, correlationId: req.correlationId, meta: { course: cv.code, version: cv.version } });
      return { ok: true };
    });
  });

  // ACA-T048: desativação bloqueia novas matrículas e preserva histórico
  app.put('/api/admin/academy/courses/:code/status', async (req) => {
    const a = requireRoles(req, ['ADMIN_ACADEMY']);
    const { code } = parse(z.object({ code: z.string().regex(/^C\d{2}$/) }), req.params);
    const { status } = parse(z.object({ status: z.enum(['ACTIVE', 'INACTIVE']) }), req.body);
    const c = one<any>('SELECT * FROM academy_courses WHERE code = ?', code);
    if (!c) throw notFound();
    run('UPDATE academy_courses SET status = ? WHERE id = ?', status, c.id);
    audit({ actorId: a.userId, action: 'COURSE_STATUS_CHANGED', subjectType: 'course', subjectId: c.id, correlationId: req.correlationId, meta: { from: c.status, to: status } });
    return { ok: true };
  });

  // ---- Mídia (ACA-013) ----
  app.get('/api/admin/academy/media', async (req) => {
    requireRoles(req, [...READERS]);
    return { assets: all('SELECT id, kind, title, filename, mime, size_bytes, checksum_sha256, state, created_at FROM academy_media_assets ORDER BY created_at DESC') };
  });

  app.post('/api/admin/academy/media', async (req) => {
    const a = requireRoles(req, ['GESTOR_CONTEUDO', 'ADMIN_ACADEMY']);
    const parts = req.parts();
    const fields: Record<string, string> = {};
    let file: { filename: string; mime: string; buf: Buffer } | null = null;
    for await (const p of parts) {
      if (p.type === 'file') {
        const buf = await p.toBuffer();
        file = { filename: p.filename, mime: p.mimetype, buf };
      } else fields[p.fieldname] = String(p.value);
    }
    const meta = parse(z.object({
      kind: z.enum(['VIDEO', 'AUDIO', 'CAPTION', 'TRANSCRIPT', 'IMAGE']),
      title: z.string().trim().min(3).max(200),
      expectedChecksum: z.string().regex(/^[a-f0-9]{64}$/).optional().or(z.literal('')),
    }), fields);
    if (!file || !file.buf.length) throw badRequest('FILE_REQUIRED', 'Selecione um arquivo.');
    const allowed: Record<string, RegExp> = {
      VIDEO: /^video\/(mp4|webm)$/, AUDIO: /^audio\/(mpeg|mp4|webm|ogg)$/, CAPTION: /^(text\/vtt|application\/octet-stream)$/,
      TRANSCRIPT: /^(text\/plain|text\/markdown|application\/pdf)$/, IMAGE: /^image\/(png|jpeg|webp)$/,
    };
    if (!allowed[meta.kind].test(file.mime)) throw badRequest('INVALID_MIME', `Tipo de arquivo não permitido para ${meta.kind}: ${file.mime}.`);
    const id = uid();
    const checksum = sha256(file.buf);
    fs.mkdirSync(config.mediaDir, { recursive: true });
    fs.writeFileSync(path.join(config.mediaDir, id), file.buf, { mode: 0o600 });
    const mismatch = !!meta.expectedChecksum && meta.expectedChecksum !== checksum;
    run(`INSERT INTO academy_media_assets (id, kind, title, filename, storage_key, mime, size_bytes, checksum_sha256, state, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, meta.kind, meta.title, path.basename(file.filename).slice(0, 200), id, file.mime === 'application/octet-stream' ? 'text/vtt' : file.mime,
      file.buf.length, checksum, mismatch ? 'BLOCKED' : 'PENDING', a.userId, nowIso());
    audit({ actorId: a.userId, action: mismatch ? 'MEDIA_UPLOADED_CHECKSUM_MISMATCH' : 'MEDIA_UPLOADED', subjectType: 'media', subjectId: id, correlationId: req.correlationId, meta: { kind: meta.kind, checksum } });
    if (mismatch) throw new AppError(409, 'MEDIA_INTEGRITY', 'O checksum informado não confere com o arquivo. A mídia foi registrada como BLOQUEADA.', { checksum });
    return { id, checksum, state: 'PENDING' };
  });

  app.post('/api/admin/academy/media/:id/approve', async (req) => {
    const a = requireRoles(req, ['AVALIADOR_RT']);
    const { id } = parse(idParam, req.params);
    const m = one<any>('SELECT * FROM academy_media_assets WHERE id = ?', id);
    if (!m) throw notFound();
    segregate(a, m.created_by);
    if (m.state === 'BLOCKED') throw conflict('MEDIA_BLOCKED', 'Mídia bloqueada não pode ser aprovada. Envie um novo arquivo.');
    if (fileChecksum(m.storage_key) !== m.checksum_sha256) {
      run(`UPDATE academy_media_assets SET state = 'BLOCKED' WHERE id = ?`, id);
      throw new AppError(409, 'MEDIA_INTEGRITY', 'Checksum divergente: mídia bloqueada.');
    }
    run(`UPDATE academy_media_assets SET state = 'APPROVED' WHERE id = ?`, id);
    audit({ actorId: a.userId, action: 'MEDIA_APPROVED', subjectType: 'media', subjectId: id, correlationId: req.correlationId });
    return { ok: true };
  });

  app.get('/api/admin/academy/media/:id/preview', async (req) => {
    requireRoles(req, ['GESTOR_CONTEUDO', 'AVALIADOR_RT', 'ADMIN_ACADEMY']);
    const { id } = parse(idParam, req.params);
    if (!one('SELECT 1 FROM academy_media_assets WHERE id = ?', id)) throw notFound();
    return { url: signedMediaUrl(id, 300, true) };
  });

  // ---- Atividades integradoras ----
  app.post('/api/admin/academy/course-versions/:id/activities', async (req) => {
    const a = requireRoles(req, ['GESTOR_CONTEUDO', 'AVALIADOR_RT']);
    const { id } = parse(idParam, req.params);
    return tx(() => {
      cvOrThrow(id);
      if (one(`SELECT 1 FROM academy_activities WHERE course_version_id = ? AND state = 'DRAFT'`, id)) throw conflict('DRAFT_EXISTS', 'Já existe um rascunho de atividade.');
      const newId = cloneLatest('academy_activities', id, id, a.userId, true);
      audit({ actorId: a.userId, action: 'ACTIVITY_DRAFT_CREATED', subjectType: 'activity', subjectId: newId, correlationId: req.correlationId });
      return { id: newId };
    });
  });

  app.put('/api/admin/academy/activities/:id', async (req) => {
    const a = requireRoles(req, ['GESTOR_CONTEUDO', 'AVALIADOR_RT']);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({
      title: z.string().trim().min(3).max(200),
      intro: z.string().max(10000).nullable(),
      requiredCorrect: z.number().int().min(1).max(50).nullable(),
      steps: z.array(z.object({
        prompt: z.string().trim().min(5).max(5000),
        options: z.array(z.object({ text: z.string().trim().min(1).max(1000), correct: z.boolean(), feedback: z.string().trim().max(3000) })).min(2).max(6),
      })).max(50),
    }), req.body);
    return tx(() => {
      const act = one<any>('SELECT * FROM academy_activities WHERE id = ?', id);
      if (!act) throw notFound();
      if (act.state !== 'DRAFT') throw conflict('VERSION_IMMUTABLE', 'Atividade aprovada é imutável. Crie um novo rascunho.');
      run('UPDATE academy_activities SET title = ?, intro = ?, required_correct = ? WHERE id = ?', body.title, body.intro, body.requiredCorrect, id);
      run('DELETE FROM academy_activity_steps WHERE activity_id = ?', id);
      body.steps.forEach((s, i) => {
        run('INSERT INTO academy_activity_steps (id, activity_id, sort_order, prompt, options_json) VALUES (?,?,?,?,?)', uid(), id, i + 1, s.prompt,
          JSON.stringify(s.options.map((o, j) => ({ id: `o${j + 1}`, text: o.text, correct: o.correct, feedback: o.feedback }))));
      });
      audit({ actorId: a.userId, action: 'ACTIVITY_EDITED', subjectType: 'activity', subjectId: id, correlationId: req.correlationId, meta: { steps: body.steps.length } });
      return { ok: true, issues: activityIssues(id) };
    });
  });

  app.post('/api/admin/academy/activities/:id/approve', async (req) => {
    const a = requireRoles(req, ['AVALIADOR_RT']);
    const { id } = parse(idParam, req.params);
    return tx(() => {
      const act = one<any>('SELECT * FROM academy_activities WHERE id = ?', id);
      if (!act) throw notFound();
      if (act.state !== 'DRAFT') throw conflict('INVALID_STATE', 'Somente rascunhos podem ser aprovados.');
      segregate(a, act.created_by);
      const issues = activityIssues(id);
      if (issues.length) throw unprocessable('ACTIVITY_INCOMPLETE', 'A atividade possui pendências.', issues);
      run(`UPDATE academy_activities SET state = 'RETIRED' WHERE course_version_id = ? AND state = 'APPROVED'`, act.course_version_id);
      run(`UPDATE academy_activities SET state = 'APPROVED', approved_by = ?, approved_at = ? WHERE id = ?`, a.userId, nowIso(), id);
      audit({ actorId: a.userId, action: 'ACTIVITY_APPROVED', subjectType: 'activity', subjectId: id, correlationId: req.correlationId });
      return { ok: true };
    });
  });

  // ---- Avaliações e banco de questões (ACA-014) ----
  app.post('/api/admin/academy/course-versions/:id/assessments', async (req) => {
    const a = requireRoles(req, ['AVALIADOR_RT', 'GESTOR_CONTEUDO']);
    const { id } = parse(idParam, req.params);
    return tx(() => {
      cvOrThrow(id);
      if (one(`SELECT 1 FROM academy_assessments WHERE course_version_id = ? AND state = 'DRAFT'`, id)) throw conflict('DRAFT_EXISTS', 'Já existe um rascunho de avaliação.');
      const newId = cloneLatest('academy_assessments', id, id, a.userId, true);
      audit({ actorId: a.userId, action: 'ASSESSMENT_DRAFT_CREATED', subjectType: 'assessment', subjectId: newId, correlationId: req.correlationId });
      return { id: newId };
    });
  });

  // Regras de aprovação: decisão institucional -> somente AVALIADOR_RT
  app.put('/api/admin/academy/assessments/:id/rules', async (req) => {
    const a = requireRoles(req, ['AVALIADOR_RT']);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({
      questionCount: z.number().int().min(1).max(200).nullable(),
      passMinCorrect: z.number().int().min(1).max(200).nullable(),
      maxAttempts: z.number().int().min(1).max(20).nullable(),
      criticalGate: z.boolean(),
      sourceNote: z.string().max(1000).nullable(),
    }), req.body);
    return tx(() => {
      const s = one<any>('SELECT * FROM academy_assessments WHERE id = ?', id);
      if (!s) throw notFound();
      if (s.state !== 'DRAFT') throw conflict('VERSION_IMMUTABLE', 'Avaliação aprovada é imutável. Crie um novo rascunho.');
      const before = { q: s.question_count, p: s.pass_min_correct, m: s.max_attempts, c: s.critical_gate };
      run('UPDATE academy_assessments SET question_count = ?, pass_min_correct = ?, max_attempts = ?, critical_gate = ?, source_note = ? WHERE id = ?',
        body.questionCount, body.passMinCorrect, body.maxAttempts, body.criticalGate ? 1 : 0, body.sourceNote, id);
      audit({ actorId: a.userId, action: 'ASSESSMENT_RULES_EDITED', subjectType: 'assessment', subjectId: id, before,
        after: { q: body.questionCount, p: body.passMinCorrect, m: body.maxAttempts, c: body.criticalGate ? 1 : 0 }, correlationId: req.correlationId });
      return { ok: true, issues: assessmentIssues(id) };
    });
  });

  app.get('/api/admin/academy/assessments/:id/questions', async (req) => {
    if (!req.auth || !req.auth.roles.some((r) => r === 'AVALIADOR_RT' || r === 'GESTOR_CONTEUDO')) throw denyKeyAccess(req);
    const a = requireRoles(req, ['AVALIADOR_RT', 'GESTOR_CONTEUDO']);
    const { id } = parse(idParam, req.params);
    const s = one<any>('SELECT * FROM academy_assessments WHERE id = ?', id);
    if (!s) throw notFound();
    // GESTOR vê gabarito somente enquanto elabora o rascunho (menor privilégio).
    const withKey = a.roles.includes('AVALIADOR_RT') || s.state === 'DRAFT';
    return {
      assessment: { ...s, issues: assessmentIssues(id) },
      questions: all<any>('SELECT * FROM academy_questions WHERE assessment_id = ? ORDER BY position', id).map((q) => questionView(q, withKey)),
      keyVisible: withKey,
    };
  });

  const questionBody = z.object({
    position: z.number().int().min(1).max(200),
    critical: z.boolean(),
    stem: z.string().trim().min(5).max(5000),
    options: z.array(z.string().trim().min(1).max(1000)).min(2).max(6),
    correctIndex: z.number().int().min(0).max(5),
  });
  app.post('/api/admin/academy/assessments/:id/questions', async (req) => {
    const a = requireRoles(req, ['AVALIADOR_RT', 'GESTOR_CONTEUDO']);
    const { id } = parse(idParam, req.params);
    const body = parse(questionBody, req.body);
    if (body.correctIndex >= body.options.length) throw badRequest('INVALID_KEY', 'Alternativa correta inválida.');
    return tx(() => {
      const s = one<any>('SELECT * FROM academy_assessments WHERE id = ?', id);
      if (!s) throw notFound();
      if (s.state !== 'DRAFT') throw conflict('VERSION_IMMUTABLE', 'Avaliação aprovada é imutável.');
      if (one('SELECT 1 FROM academy_questions WHERE assessment_id = ? AND position = ?', id, body.position)) throw conflict('POSITION_TAKEN', `Já existe a questão ${body.position}.`);
      const qid = uid();
      const options = body.options.map((t, i) => ({ id: `o${i + 1}`, text: t }));
      run(`INSERT INTO academy_questions (id, assessment_id, position, critical, stem, options_json, correct_option_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        qid, id, body.position, body.critical ? 1 : 0, body.stem, JSON.stringify(options), options[body.correctIndex].id, a.userId, nowIso());
      audit({ actorId: a.userId, action: 'QUESTION_CREATED', subjectType: 'assessment', subjectId: id, correlationId: req.correlationId, meta: { position: body.position } });
      return { id: qid };
    });
  });

  app.delete('/api/admin/academy/questions/:id', async (req) => {
    const a = requireRoles(req, ['AVALIADOR_RT', 'GESTOR_CONTEUDO']);
    const { id } = parse(idParam, req.params);
    return tx(() => {
      const q = one<any>('SELECT q.*, s.state FROM academy_questions q JOIN academy_assessments s ON s.id = q.assessment_id WHERE q.id = ?', id);
      if (!q) throw notFound();
      if (q.state !== 'DRAFT') throw conflict('VERSION_IMMUTABLE', 'Avaliação aprovada é imutável.');
      run('DELETE FROM academy_questions WHERE id = ?', id);
      audit({ actorId: a.userId, action: 'QUESTION_DELETED', subjectType: 'assessment', subjectId: q.assessment_id, correlationId: req.correlationId, meta: { position: q.position } });
      return { ok: true };
    });
  });

  app.post('/api/admin/academy/assessments/:id/approve', async (req) => {
    const a = requireRoles(req, ['AVALIADOR_RT']);
    const { id } = parse(idParam, req.params);
    return tx(() => {
      const s = one<any>('SELECT * FROM academy_assessments WHERE id = ?', id);
      if (!s) throw notFound();
      if (s.state !== 'DRAFT') throw conflict('INVALID_STATE', 'Somente rascunhos podem ser aprovados.');
      segregate(a, s.created_by);
      const issues = assessmentIssues(id);
      if (issues.length) throw unprocessable('ASSESSMENT_INCOMPLETE', 'A avaliação possui pendências.', issues);
      run(`UPDATE academy_assessments SET state = 'RETIRED' WHERE course_version_id = ? AND state = 'APPROVED'`, s.course_version_id);
      run(`UPDATE academy_assessments SET state = 'APPROVED', approved_by = ?, approved_at = ? WHERE id = ?`, a.userId, nowIso(), id);
      audit({ actorId: a.userId, action: 'ASSESSMENT_APPROVED', subjectType: 'assessment', subjectId: id, correlationId: req.correlationId });
      return { ok: true };
    });
  });

  // ---- Modelo do certificado (P-008) ----
  app.get('/api/admin/academy/certificate-templates', async (req) => {
    requireRoles(req, [...READERS]);
    return { templates: all<any>('SELECT * FROM academy_certificate_templates ORDER BY version DESC').map((t) => ({ ...t, signatories: JSON.parse(t.signatories_json) })) };
  });
  app.post('/api/admin/academy/certificate-templates', async (req) => {
    const a = requireRoles(req, ['ADMIN_ACADEMY', 'GESTOR_CONTEUDO']);
    const body = parse(z.object({
      heading: z.string().trim().min(5).max(200),
      declaration: z.string().trim().min(10).max(3000),
      signatories: z.array(z.object({ name: z.string().trim().min(3).max(120), role: z.string().trim().min(2).max(120) })).min(1).max(4),
    }), req.body);
    if (!/não autoriza atendimento/i.test(body.declaration)) {
      throw unprocessable('DECLARATION_REQUIRED', 'A declaração deve informar expressamente que a conclusão não autoriza atendimento nem credenciamento automático.');
    }
    const v = one<any>('SELECT COALESCE(MAX(version),0)+1 AS v FROM academy_certificate_templates')!.v;
    const id = uid();
    run(`INSERT INTO academy_certificate_templates (id, version, heading, declaration, signatories_json, state, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      id, v, body.heading, body.declaration, JSON.stringify(body.signatories), 'DRAFT', a.userId, nowIso());
    audit({ actorId: a.userId, action: 'CERT_TEMPLATE_DRAFTED', subjectType: 'certificate_template', subjectId: id, correlationId: req.correlationId });
    return { id, version: v };
  });
  app.post('/api/admin/academy/certificate-templates/:id/approve', async (req) => {
    const a = requireRoles(req, ['AVALIADOR_RT']);
    const { id } = parse(idParam, req.params);
    return tx(() => {
      const t = one<any>('SELECT * FROM academy_certificate_templates WHERE id = ?', id);
      if (!t) throw notFound();
      if (t.state !== 'DRAFT') throw conflict('INVALID_STATE', 'Somente rascunhos podem ser aprovados.');
      segregate(a, t.created_by);
      run(`UPDATE academy_certificate_templates SET state = 'RETIRED' WHERE state = 'APPROVED'`);
      run(`UPDATE academy_certificate_templates SET state = 'APPROVED', approved_by = ?, approved_at = ? WHERE id = ?`, a.userId, nowIso(), id);
      audit({ actorId: a.userId, action: 'CERT_TEMPLATE_APPROVED', subjectType: 'certificate_template', subjectId: id, correlationId: req.correlationId });
      return { ok: true };
    });
  });
  app.get('/api/admin/academy/certificates', async (req) => {
    requireRoles(req, ['AVALIADOR_RT', 'ADMIN_ACADEMY', 'AUDITOR', 'CREDENCIAMENTO']);
    return {
      certificates: all(`SELECT c.id, c.public_code, c.issued_at, c.revoked_at, c.revoke_reason, c.content_hash, u.name AS holder
                         FROM academy_certificates c JOIN academy_enrollments e ON e.id = c.enrollment_id JOIN users u ON u.id = e.partner_id ORDER BY c.issued_at DESC`),
    };
  });
  // Revogação por evento próprio, sem apagar o original
  app.post('/api/admin/academy/certificates/:id/revoke', async (req) => {
    const a = requireRoles(req, ['AVALIADOR_RT', 'ADMIN_ACADEMY']);
    const { id } = parse(idParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(10).max(1000) }), req.body);
    return tx(() => {
      const c = one<any>('SELECT * FROM academy_certificates WHERE id = ?', id);
      if (!c) throw notFound();
      if (c.revoked_at) throw conflict('ALREADY_REVOKED', 'Certificado já revogado.');
      run('UPDATE academy_certificates SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE id = ?', nowIso(), a.userId, reason, id);
      audit({ actorId: a.userId, action: 'CERTIFICATE_REVOKED', subjectType: 'certificate', subjectId: id, correlationId: req.correlationId });
      return { ok: true };
    });
  });

  // ---- Credenciamento: projeção + decisão humana (ACA-T043/T044) ----
  app.get('/api/admin/academy/training-status', async (req) => {
    requireRoles(req, ['CREDENCIAMENTO', 'ADMIN_ACADEMY', 'AUDITOR']);
    return {
      partners: all(`SELECT u.id, u.name, u.email, u.academy_eligible, p.journey_state, p.completed_at, p.credentialing_decision, p.decided_at, p.decision_note
                     FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'ESPECIALISTA'
                     LEFT JOIN partner_training_status p ON p.partner_id = u.id ORDER BY u.name`),
    };
  });
  app.post('/api/admin/academy/training-status/:id/decision', async (req) => {
    const a = requireRoles(req, ['CREDENCIAMENTO']);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({
      decision: z.enum(['PENDENTE', 'APTO', 'NAO_APTO']),
      note: z.string().trim().min(10, 'Registre a justificativa da decisão.').max(2000),
      otherGatesConfirmed: z.boolean(),
    }), req.body);
    return tx(() => {
      const p = one<any>('SELECT * FROM partner_training_status WHERE partner_id = ?', id);
      if (!p) throw notFound('Parceiro sem registro de capacitação.');
      if (body.decision === 'APTO') {
        if (p.journey_state !== 'CONCLUIDA') throw conflict('ACADEMY_INCOMPLETE', 'Jornada Academy não concluída: o credenciamento permanece pendente.');
        if (!body.otherGatesConfirmed) throw unprocessable('OTHER_GATES_REQUIRED', 'Confirme que os demais requisitos de credenciamento foram verificados (P-010).');
      }
      run('UPDATE partner_training_status SET credentialing_decision = ?, decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ? WHERE partner_id = ?',
        body.decision, a.userId, nowIso(), body.note, nowIso(), id);
      audit({ actorId: a.userId, action: 'CREDENTIALING_DECISION', subjectType: 'partner', subjectId: id, before: { d: p.credentialing_decision }, after: { d: body.decision },
        correlationId: req.correlationId, meta: { decision: body.decision } });
      return { ok: true };
    });
  });

  // ---- Suporte: estado técnico (sem notas/respostas) ----
  app.get('/api/admin/academy/partners', async (req) => {
    requireRoles(req, ['SUPORTE_ACADEMY', 'ADMIN_ACADEMY']);
    const { q } = parse(z.object({ q: z.string().max(100).optional() }), req.query);
    const like = `%${(q ?? '').trim()}%`;
    const partners = all<any>(`SELECT u.id, u.name, u.email, u.status, u.academy_eligible FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'ESPECIALISTA'
                               WHERE u.name LIKE ? OR u.email LIKE ? ORDER BY u.name LIMIT 50`, like, like);
    return {
      partners: partners.map((p) => {
        const e = one<any>(`SELECT * FROM academy_enrollments WHERE partner_id = ? AND state <> 'CANCELADA'`, p.id);
        const pay = one<any>('SELECT status, updated_at FROM academy_payment_orders WHERE partner_id = ? ORDER BY created_at DESC LIMIT 1', p.id);
        return {
          ...p,
          enrollment: e ? { state: e.state, startedAt: e.started_at } : null,
          payment: pay ?? null,
          courses: e ? computeJourney(e, { bind: false }).map((c) => ({ code: c.code, state: c.state, lessonsDone: c.lessonsDone, lessonsTotal: c.lessonsTotal, attemptsUsed: c.assessment.attemptsUsed })) : [],
          openTickets: one<any>(`SELECT COUNT(*) AS n FROM support_tickets WHERE subject_user_id = ? AND status = 'ABERTO'`, p.id)!.n,
        };
      }),
    };
  });

  app.get('/api/admin/support-tickets', async (req) => {
    requireRoles(req, ['SUPORTE_ACADEMY', 'ADMIN_ACADEMY', 'AUDITOR']);
    return { tickets: all(`SELECT t.*, u.name AS subject_name, o.name AS opened_by_name FROM support_tickets t JOIN users u ON u.id = t.subject_user_id
                          JOIN users o ON o.id = t.opened_by ORDER BY t.created_at DESC LIMIT 200`) };
  });
  app.post('/api/admin/support-tickets', async (req) => {
    const a = requireRoles(req, ['SUPORTE_ACADEMY']);
    const body = parse(z.object({
      userId: z.string().uuid(), category: z.enum(['ACESSO', 'PAGAMENTO', 'PROGRESSO', 'CERTIFICADO', 'OUTRO']),
      description: z.string().trim().min(10).max(4000),
    }), req.body);
    if (!one('SELECT 1 FROM users WHERE id = ?', body.userId)) throw notFound('Usuário não encontrado.');
    const id = uid();
    run(`INSERT INTO support_tickets (id, subject_user_id, opened_by, category, description, created_at) VALUES (?,?,?,?,?,?)`, id, body.userId, a.userId, body.category, body.description, nowIso());
    audit({ actorId: a.userId, action: 'SUPPORT_TICKET_OPENED', subjectType: 'ticket', subjectId: id, correlationId: req.correlationId, meta: { category: body.category } });
    return { id };
  });
  app.post('/api/admin/support-tickets/:id/close', async (req) => {
    const a = requireRoles(req, ['SUPORTE_ACADEMY']);
    const { id } = parse(idParam, req.params);
    const r = run(`UPDATE support_tickets SET status = 'ENCERRADO', closed_at = ? WHERE id = ? AND status = 'ABERTO'`, nowIso(), id);
    if (!r.changes) throw notFound('Chamado aberto não encontrado.');
    audit({ actorId: a.userId, action: 'SUPPORT_TICKET_CLOSED', subjectType: 'ticket', subjectId: id, correlationId: req.correlationId });
    return { ok: true };
  });

  // ---- Financeiro Academy (sem respostas/notas) ----
  app.get('/api/admin/academy/payment-orders', async (req) => {
    requireRoles(req, ['FINANCEIRO', 'ADMIN_ACADEMY', 'AUDITOR']);
    return { orders: all(`SELECT o.id, o.amount_cents, o.currency, o.status, o.provider, o.provider_ref, o.created_at, o.updated_at, u.name AS partner_name
                          FROM academy_payment_orders o JOIN users u ON u.id = o.partner_id ORDER BY o.created_at DESC LIMIT 500`) };
  });

  // ---- Relatórios (ACA-015) - números reais do banco ----
  app.get('/api/admin/academy/reports', async (req) => {
    requireRoles(req, ['ADMIN_ACADEMY', 'AUDITOR']);
    return {
      generatedAt: nowIso(),
      enrollmentsByState: all('SELECT state, COUNT(*) AS total FROM academy_enrollments GROUP BY state'),
      courseResults: all(`SELECT c.code, ec.result, COUNT(*) AS total FROM academy_enrollment_courses ec JOIN academy_courses c ON c.id = ec.course_id GROUP BY c.code, ec.result ORDER BY c.code`),
      attemptsByResult: all(`SELECT c.code, t.state, COUNT(*) AS total FROM academy_assessment_attempts t JOIN academy_assessments s ON s.id = t.assessment_id
                             JOIN academy_course_versions cv ON cv.id = s.course_version_id JOIN academy_courses c ON c.id = cv.course_id GROUP BY c.code, t.state ORDER BY c.code`),
      certificates: one('SELECT COUNT(*) AS issued, SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked FROM academy_certificates'),
      payments: all('SELECT status, COUNT(*) AS total, SUM(amount_cents) AS amount_cents FROM academy_payment_orders GROUP BY status'),
      credentialing: all('SELECT credentialing_decision AS decision, COUNT(*) AS total FROM partner_training_status GROUP BY credentialing_decision'),
    };
  });

  // Recalcula projeções (útil após publicação de versões) - somente ADMIN
  app.post('/api/admin/academy/recompute', async (req) => {
    const a = requireRoles(req, ['ADMIN_ACADEMY']);
    let n = 0;
    tx(() => {
      for (const e of all<any>(`SELECT * FROM academy_enrollments WHERE state = 'EM_ANDAMENTO'`)) { refreshJourneyCompletion(e, req.correlationId); n++; }
      audit({ actorId: a.userId, action: 'PROJECTIONS_RECOMPUTED', subjectType: 'system', correlationId: req.correlationId, meta: { enrollments: n } });
    });
    return { recomputed: n };
  });
}

/** Cria novo rascunho clonando a última versão (atividade/avaliação) de uma versão de curso. */
function cloneLatest(table: 'academy_assessments' | 'academy_activities', fromCv: string, toCv: string, actor: string, sameCourseVersion = false): string {
  const src = one<any>(`SELECT * FROM ${table} WHERE course_version_id = ? AND state <> 'RETIRED' ORDER BY version DESC LIMIT 1`, fromCv)
    ?? (sameCourseVersion ? one<any>(`SELECT * FROM ${table} WHERE course_version_id = ? ORDER BY version DESC LIMIT 1`, fromCv) : undefined);
  const version = sameCourseVersion ? (one<any>(`SELECT COALESCE(MAX(version),0)+1 AS v FROM ${table} WHERE course_version_id = ?`, toCv)!.v) : 1;
  const id = uid(), now = nowIso();
  if (table === 'academy_assessments') {
    if (!src && !sameCourseVersion) return '';
    run(`INSERT INTO academy_assessments (id, course_version_id, version, question_count, pass_min_correct, max_attempts, critical_gate, source_note, state, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, toCv, version, src?.question_count ?? null, src?.pass_min_correct ?? null, src?.max_attempts ?? null,
      src?.critical_gate ?? 0, src?.source_note ?? null, 'DRAFT', actor, now);
    if (src) for (const q of all<any>('SELECT * FROM academy_questions WHERE assessment_id = ?', src.id)) {
      run(`INSERT INTO academy_questions (id, assessment_id, position, critical, stem, options_json, correct_option_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        uid(), id, q.position, q.critical, q.stem, q.options_json, q.correct_option_id, q.created_by, now);
    }
  } else {
    if (!src && !sameCourseVersion) return '';
    run(`INSERT INTO academy_activities (id, course_version_id, version, title, intro, required_correct, source_note, state, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`, id, toCv, version, src?.title ?? 'Atividade integradora', src?.intro ?? null, src?.required_correct ?? null, src?.source_note ?? null, 'DRAFT', actor, now);
    if (src) for (const s of all<any>('SELECT * FROM academy_activity_steps WHERE activity_id = ?', src.id)) {
      run('INSERT INTO academy_activity_steps (id, activity_id, sort_order, prompt, options_json) VALUES (?,?,?,?,?)', uid(), id, s.sort_order, s.prompt, s.options_json);
    }
  }
  return id;
}
