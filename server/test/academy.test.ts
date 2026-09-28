import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, emailOf, idOf, loginAs, one, run, setup } from './helpers.ts';
import { all } from '../src/db/db.ts';
import { hmac } from '../src/lib/security.ts';
import { config } from '../src/config.ts';
import { nowIso, uid } from '../src/lib/util.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });

async function partner() {
  const c = new Client(app);
  await c.login(emailOf('especialista'));
  return c;
}
async function payAndEnroll(c: Client) {
  const o = await c.post('/api/academy/payment-orders', {}, true);
  await c.post(`/api/academy/payment-orders/${o.body.order.id}/sandbox-pay`, { outcome: 'APROVADO' });
  const e = await c.post('/api/academy/enrollments', {}, true);
  expect([200, 201]).toContain(e.status);
  return e.body.enrollment;
}
async function completeLessons(c: Client, course: string) {
  const d = await c.get(`/api/academy/courses/${course}`);
  for (const l of d.body.lessons) {
    const lesson = await c.get(`/api/academy/lessons/${l.code}`);
    const r = await c.put(`/api/academy/progress/${l.code}`, { percent: 100, position: 0, complete: true, rowVersion: lesson.body.progress.rowVersion }, true);
    expect(r.status).toBe(200);
  }
}
async function completeActivity(c: Client, course: string) {
  const a = await c.get(`/api/academy/courses/${course}/activity`);
  const started = await c.post(`/api/academy/activities/${a.body.activity.id}/attempts`, {}, true);
  let last: any;
  for (const s of started.body.activity.steps) {
    const wrong = await c.post(`/api/academy/activity-attempts/${started.body.activity.attempt.id}/decisions`, { stepId: s.id, optionId: 'o1' }, true);
    expect(wrong.body.correct).toBe(false);
    last = await c.post(`/api/academy/activity-attempts/${started.body.activity.attempt.id}/decisions`, { stepId: s.id, optionId: 'o2' }, true);
    expect(last.body.correct).toBe(true);
  }
  return last;
}
function keyMap(assessmentId: string) {
  return new Map(all<any>('SELECT id, correct_option_id FROM academy_questions WHERE assessment_id = ?', assessmentId).map((q) => [q.id, q.correct_option_id]));
}
function answers(attempt: any, keys: Map<string, string>, wrongPositions: number[] = []) {
  const pos = new Map(all<any>('SELECT id, position FROM academy_questions WHERE assessment_id = ?', attempt.assessment.id).map((q) => [q.id, q.position]));
  return attempt.questions.map((q: any) => {
    const wrong = wrongPositions.includes(pos.get(q.questionId)!);
    const key = keys.get(q.questionId)!;
    return { questionId: q.questionId, optionId: wrong ? q.options.find((o: any) => o.id !== key).id : key };
  });
}

describe('Acesso, pagamento e matrícula', () => {
  it('parceiro não elegível é bloqueado (ACA-T002)', async () => {
    const c = new Client(app); await c.login(emailOf('especialista2'));
    const o = await c.post('/api/academy/payment-orders', {}, true);
    await c.post(`/api/academy/payment-orders/${o.body.order.id}/sandbox-pay`, { outcome: 'APROVADO' });
    const e = await c.post('/api/academy/enrollments', {}, true);
    expect(e.status).toBe(403);
    expect(e.body.error.code).toBe('NOT_ELIGIBLE');
  });

  it('pagamento PENDENTE/RECUSADO não libera matrícula; PAGO libera acesso comercial, não aptidão (ACA-T004/T005)', async () => {
    const c = await partner();
    const o = await c.post('/api/academy/payment-orders', {}, true);
    expect(o.body.order.status).toBe('PENDENTE');
    expect((await c.post('/api/academy/enrollments', {}, true)).body.error.code).toBe('PAYMENT_REQUIRED');
    await c.post(`/api/academy/payment-orders/${o.body.order.id}/sandbox-pay`, { outcome: 'RECUSADO' });
    expect((await c.post('/api/academy/enrollments', {}, true)).status).toBe(403);
    const o2 = await c.post('/api/academy/payment-orders', {}, true);
    expect(o2.body.order.id).not.toBe(o.body.order.id);
    await c.post(`/api/academy/payment-orders/${o2.body.order.id}/sandbox-pay`, { outcome: 'APROVADO' });
    expect((await c.post('/api/academy/enrollments', {}, true)).status).toBe(201);
    const t = one<any>('SELECT * FROM partner_training_status WHERE partner_id = ?', idOf('especialista'));
    expect(t.credentialing_decision).toBe('PENDENTE');
  });

  it('webhook exige assinatura e é idempotente em replay (ACA-T006)', async () => {
    const c = await partner();
    const o = await c.post('/api/academy/payment-orders', {}, true);
    const ev = { eventId: 'evt_123456', orderId: o.body.order.id, type: 'PAYMENT_CONFIRMED', providerRef: 'ref1' };
    const raw = JSON.stringify(ev);
    const anon = new Client(app);
    expect((await anon.req('POST', '/api/academy/payment-webhooks', ev, { 'x-onema-signature': 'invalida' })).status).toBe(403);
    const sig = hmac(raw, config.paymentWebhookSecret);
    const r1 = await anon.req('POST', '/api/academy/payment-webhooks', ev, { 'x-onema-signature': sig });
    const r2 = await anon.req('POST', '/api/academy/payment-webhooks', ev, { 'x-onema-signature': sig });
    expect(r1.body.order.status).toBe('PAGO');
    expect(r2.body.duplicate).toBe(true);
    expect(one<any>('SELECT COUNT(*) AS n FROM academy_payment_events WHERE order_id = ?', o.body.order.id).n).toBe(1);
  });

  it('matrícula é idempotente e a jornada mostra somente os dados do próprio parceiro', async () => {
    const c = await partner();
    await payAndEnroll(c);
    const again = await c.post('/api/academy/enrollments', {}, true);
    expect(again.status).toBe(200);
    expect(one<any>('SELECT COUNT(*) AS n FROM academy_enrollments').n).toBe(1);
    const j = await c.get('/api/academy/journey');
    expect(j.body.courses.map((x: any) => x.code)).toEqual(['C01', 'C02', 'C03', 'C04']);
    expect(j.body.courses[0].state).toBe('DISPONIVEL');
    expect(j.body.courses[1].state).toBe('BLOQUEADO');
    expect(JSON.stringify(j.body)).not.toMatch(/patient|paciente_id|prontu/i);
  });
});

describe('Progresso e aulas', () => {
  it('conclusão sem requisito mínimo é bloqueada no servidor (ACA-T009) e o progresso persiste (ACA-T010)', async () => {
    const c = await partner(); await payAndEnroll(c);
    const l = await c.get('/api/academy/lessons/C01-A01');
    const r = await c.put('/api/academy/progress/C01-A01', { percent: 40, position: 12, complete: true, rowVersion: 0 }, true);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('COMPLETION_REQUIREMENT_NOT_MET');
    const ok = await c.put('/api/academy/progress/C01-A01', { percent: 40, position: 12, complete: false, rowVersion: l.body.progress.rowVersion }, true);
    expect(ok.body).toMatchObject({ state: 'EM_ANDAMENTO', percent: 40, lastPosition: 12, rowVersion: 1 });
    const other = new Client(app); await other.login(emailOf('especialista')); // nova sessão
    const again = await other.get('/api/academy/lessons/C01-A01');
    expect(again.body.progress).toMatchObject({ percent: 40, lastPosition: 12, rowVersion: 1 });
  });

  it('atualização concorrente usa controle otimista (ACA-T008)', async () => {
    const c = await partner(); await payAndEnroll(c);
    await c.put('/api/academy/progress/C01-A01', { percent: 10, position: 1, complete: false, rowVersion: 0 }, true);
    const stale = await c.put('/api/academy/progress/C01-A01', { percent: 20, position: 2, complete: false, rowVersion: 0 }, true);
    expect(stale.status).toBe(409);
    expect(stale.body.error.details.rowVersion).toBe(1);
  });

  it('curso seguinte permanece bloqueado e aula de curso bloqueado é negada', async () => {
    const c = await partner(); await payAndEnroll(c);
    const r = await c.get('/api/academy/lessons/C02-A01');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('COURSE_LOCKED');
  });
});

describe('Atividade e avaliação C01 (regra oficial 10/12, 3 tentativas)', () => {
  it('atividade: seis decisões corretas após revisão concluem a atividade (ACA-T011); incompleta bloqueia avaliação (ACA-T012)', async () => {
    const c = await partner(); await payAndEnroll(c);
    await completeLessons(c, 'C01');
    const course = await c.get('/api/academy/courses/C01');
    const blocked = await c.post(`/api/academy/assessments/${course.body.assessment.id}/attempts`, {}, true);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PREREQUISITES_NOT_MET');
    const last = await completeActivity(c, 'C01');
    expect(last.body.completed).toBe(true);
    expect(one<any>(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'ACTIVITY_COMPLETED'`).n).toBe(1);
    const j = await c.get('/api/academy/journey');
    expect(j.body.courses[0].state).toBe('AGUARDANDO_AVALIACAO');
  });

  it('9/12 reprova, 10/12 aprova, quarta tentativa bloqueada, gabarito nunca vai ao cliente (ACA-T013..T016, T020)', async () => {
    const c = await partner(); await payAndEnroll(c);
    await completeLessons(c, 'C01'); await completeActivity(c, 'C01');
    const asmId = (await c.get('/api/academy/courses/C01')).body.assessment.id;
    const keys = keyMap(asmId);
    const t1 = await c.post(`/api/academy/assessments/${asmId}/attempts`, {}, true);
    expect(t1.status).toBe(201);
    expect(JSON.stringify(t1.body)).not.toMatch(/correctOption|correct_option|"correct":/);
    expect(t1.body.attempt.questions).toHaveLength(12);
    const s1 = await c.post(`/api/academy/assessment-attempts/${t1.body.attempt.id}/submit`, { answers: answers(t1.body.attempt, keys, [1, 2, 3]) }, true);
    expect(s1.body.attempt.state).toBe('REPROVADA');
    expect(s1.body.attempt.result.correct).toBe(9);
    const t2 = await c.post(`/api/academy/assessments/${asmId}/attempts`, {}, true);
    const s2 = await c.post(`/api/academy/assessment-attempts/${t2.body.attempt.id}/submit`, { answers: answers(t2.body.attempt, keys, [4, 5]) }, true);
    expect(s2.body.attempt.state).toBe('APROVADA');
    const j = await c.get('/api/academy/journey');
    expect(j.body.courses[0].state).toBe('APROVADO');
    expect(j.body.courses[1].state).not.toBe('BLOQUEADO');
    // ordem variada: gabarito vinculado ao questionVersionId (ACA-T016)
    const order1 = one<any>('SELECT question_order_json FROM academy_assessment_attempts WHERE id = ?', t1.body.attempt.id).question_order_json;
    expect(JSON.parse(order1).sort()).toEqual([...keys.keys()].sort());
    // especialista tentando obter o gabarito pela API administrativa: negado e auditado (ACA-T020)
    const k = await c.get(`/api/admin/academy/assessments/${asmId}/questions`);
    expect(k.status).toBe(403);
    expect(one<any>(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'ANSWER_KEY_ACCESS_DENIED'`).n).toBe(1);
  });

  it('três reprovações encerram o curso como REPROVADO e bloqueiam a quarta tentativa (ACA-T015)', async () => {
    const c = await partner(); await payAndEnroll(c);
    await completeLessons(c, 'C01'); await completeActivity(c, 'C01');
    const asmId = (await c.get('/api/academy/courses/C01')).body.assessment.id;
    const keys = keyMap(asmId);
    for (let i = 0; i < 3; i++) {
      const t = await c.post(`/api/academy/assessments/${asmId}/attempts`, {}, true);
      await c.post(`/api/academy/assessment-attempts/${t.body.attempt.id}/submit`, { answers: answers(t.body.attempt, keys, [1, 2, 3, 4]) }, true);
    }
    const t4 = await c.post(`/api/academy/assessments/${asmId}/attempts`, {}, true);
    expect(t4.status).toBe(403);
    expect((await c.get('/api/academy/journey')).body.courses[0].state).toBe('REPROVADO');
  });

  it('duplo clique/replay e sessões concorrentes geram uma única submissão (ACA-T021/T022)', async () => {
    const c = await partner(); await payAndEnroll(c);
    await completeLessons(c, 'C01'); await completeActivity(c, 'C01');
    const asmId = (await c.get('/api/academy/courses/C01')).body.assessment.id;
    const t = await c.post(`/api/academy/assessments/${asmId}/attempts`, {}, true);
    const body = { answers: answers(t.body.attempt, keyMap(asmId)) };
    const [a, b] = await Promise.all([
      c.post(`/api/academy/assessment-attempts/${t.body.attempt.id}/submit`, body, 'same-key-123'),
      c.post(`/api/academy/assessment-attempts/${t.body.attempt.id}/submit`, body, 'same-key-123'),
    ]);
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
    const other = new Client(app); await other.login(emailOf('especialista'));
    const conc = await other.post(`/api/academy/assessment-attempts/${t.body.attempt.id}/submit`, body, true);
    expect(conc.status).toBe(409);
    expect(conc.body.error.code).toBe('ATTEMPT_ALREADY_SUBMITTED');
    expect(one<any>('SELECT COUNT(*) AS n FROM academy_assessment_answers WHERE attempt_id = ?', t.body.attempt.id).n).toBe(12);
  });

  it('IDOR: outro parceiro não acessa tentativa alheia (ACA-T035)', async () => {
    const c = await partner(); await payAndEnroll(c);
    await completeLessons(c, 'C01'); await completeActivity(c, 'C01');
    const asmId = (await c.get('/api/academy/courses/C01')).body.assessment.id;
    const t = await c.post(`/api/academy/assessments/${asmId}/attempts`, {}, true);
    run('UPDATE users SET academy_eligible = 1 WHERE email = ?', emailOf('especialista2'));
    const intruder = new Client(app); await intruder.login(emailOf('especialista2'));
    expect((await intruder.get(`/api/academy/assessment-attempts/${t.body.attempt.id}`)).status).toBe(404);
    expect((await intruder.post(`/api/academy/assessment-attempts/${t.body.attempt.id}/submit`, { answers: [{ questionId: uid(), optionId: 'o1' }] }, true)).status).toBe(404);
  });

  it('C02: avaliação sem regra definida permanece indisponível (P-001), sem regra inventada', async () => {
    const c = await partner(); await payAndEnroll(c);
    const j = await c.get('/api/academy/journey');
    const c02 = j.body.courses[1];
    expect(c02.assessment.ready).toBe(false);
    expect(c02.pending.join(' ')).toMatch(/nota mínima/);
  });
});

/** Fixture de TESTE: aprova C02–C04 com regras fictícias apenas neste banco em memória para exercitar gates finais. */
function testOnlyFixture(courseCode: string, rules: { q: number; p: number; m: number; gate: 0 | 1; critical?: number[] }) {
  const cv = one<any>(`SELECT cv.id FROM academy_course_versions cv JOIN academy_courses c ON c.id = cv.course_id WHERE c.code = ? AND cv.state = 'PUBLISHED'`, courseCode)!.id;
  const asm = one<any>('SELECT id FROM academy_assessments WHERE course_version_id = ?', cv)!.id;
  run('UPDATE academy_assessments SET question_count = ?, pass_min_correct = ?, max_attempts = ?, critical_gate = ? WHERE id = ?', rules.q, rules.p, rules.m, rules.gate, asm);
  for (let i = 1; i <= rules.q; i++) {
    run(`INSERT INTO academy_questions (id, assessment_id, position, critical, stem, options_json, correct_option_id, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      uid(), asm, i, rules.critical?.includes(i) ? 1 : 0, `Teste ${i}`, JSON.stringify([{ id: 'o1', text: 'a' }, { id: 'o2', text: 'b' }]), 'o2', nowIso());
  }
  run(`UPDATE academy_assessments SET state = 'APPROVED' WHERE id = ?`, asm);
  const act = one<any>(`SELECT id FROM academy_activities WHERE course_version_id = ?`, cv);
  if (act) {
    run('UPDATE academy_activities SET required_correct = 1 WHERE id = ?', act.id);
    run('INSERT INTO academy_activity_steps (id, activity_id, sort_order, prompt, options_json) VALUES (?,?,?,?,?)', uid(), act.id, 1, 'Teste',
      JSON.stringify([{ id: 'o1', text: 'x', correct: false, feedback: 'f' }, { id: 'o2', text: 'y', correct: true, feedback: 'f' }]));
    run(`UPDATE academy_activities SET state = 'APPROVED' WHERE id = ?`, act.id);
  }
  return asm;
}

async function passCourse(c: Client, code: string, wrong: number[] = []) {
  await completeLessons(c, code);
  const course = await c.get(`/api/academy/courses/${code}`);
  if (course.body.activityRequired === 1) await completeActivity(c, code);
  const asmId = course.body.assessment.id;
  const t = await c.post(`/api/academy/assessments/${asmId}/attempts`, {}, true);
  return c.post(`/api/academy/assessment-attempts/${t.body.attempt.id}/submit`, { answers: answers(t.body.attempt, keyMap(asmId), wrong) }, true);
}

describe('C04: questões críticas como gate independente (ACA-T017..T019)', () => {
  async function toC04() {
    testOnlyFixture('C02', { q: 2, p: 1, m: 3, gate: 0 });
    testOnlyFixture('C03', { q: 2, p: 1, m: 3, gate: 0 });
    testOnlyFixture('C04', { q: 10, p: 8, m: 5, gate: 1, critical: [3, 6, 8, 10] }); // m=5 apenas no teste (P-002)
    const c = await partner(); await payAndEnroll(c);
    for (const code of ['C01', 'C02', 'C03']) expect((await passCourse(c, code)).body.attempt.state).toBe('APROVADA');
    await completeLessons(c, 'C04'); await completeActivity(c, 'C04');
    const asmId = (await c.get('/api/academy/courses/C04')).body.assessment.id;
    return { c, asmId };
  }
  async function attempt(c: Client, asmId: string, wrong: number[]) {
    const t = await c.post(`/api/academy/assessments/${asmId}/attempts`, {}, true);
    return c.post(`/api/academy/assessment-attempts/${t.body.attempt.id}/submit`, { answers: answers(t.body.attempt, keyMap(asmId), wrong) }, true);
  }
  it('9/10 com a questão 06 (crítica) errada reprova; 7/10 com críticas corretas reprova; 8/10 com críticas corretas aprova', async () => {
    const { c, asmId } = await toC04();
    expect((await attempt(c, asmId, [6])).body.attempt.state).toBe('REPROVADA');
    expect((await attempt(c, asmId, [1, 2, 4])).body.attempt.state).toBe('REPROVADA');
    const ok = await attempt(c, asmId, [1, 2]);
    expect(ok.body.attempt.state).toBe('APROVADA');
    expect(ok.body.attempt.result.criticalOk).toBe(true);
  });
});

describe('Certificado, credenciamento e integrações', () => {
  async function completeJourney() {
    testOnlyFixture('C02', { q: 2, p: 1, m: 3, gate: 0 });
    testOnlyFixture('C03', { q: 2, p: 1, m: 3, gate: 0 });
    testOnlyFixture('C04', { q: 10, p: 8, m: 3, gate: 1, critical: [3, 6, 8, 10] });
    const c = await partner(); await payAndEnroll(c);
    return c;
  }
  it('jornada incompleta bloqueia emissão (ACA-T023)', async () => {
    const c = await partner(); await payAndEnroll(c);
    const r = await c.post('/api/academy/certificates', {}, true);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('JOURNEY_INCOMPLETE');
  });

  it('com todos os gates: um único certificado imutável, QR verificável e revogação (ACA-T024..T026, T043, T044)', async () => {
    const c = await completeJourney();
    for (const code of ['C01', 'C02', 'C03', 'C04']) expect((await passCourse(c, code)).body.attempt.state).toBe('APROVADA');
    const j = await c.get('/api/academy/journey');
    expect(j.body.enrollment.state).toBe('CONCLUIDA');
    expect(j.body.certificate.state).toBe('ELEGIVEL');
    // Projeção: conclusão não gera aptidão (ACA-T043/T044)
    expect(one<any>('SELECT * FROM partner_training_status WHERE partner_id = ?', idOf('especialista'))).toMatchObject({ journey_state: 'CONCLUIDA', credentialing_decision: 'PENDENTE' });
    // Modelo pendente (P-008): emissão bloqueada com mensagem clara
    const pending = await c.post('/api/academy/certificates', {}, true);
    expect(pending.body.error.code).toBe('CERTIFICATE_TEMPLATE_PENDING');
    const admin = await loginAs(app, 'adminAcademy');
    const tpl = await admin.post('/api/admin/academy/certificate-templates', { heading: 'Certificado de teste', declaration: 'A conclusão não autoriza atendimento nem credenciamento automático.', signatories: [{ name: 'Signatário Teste', role: 'RT' }] });
    const rt = await loginAs(app, 'rt');
    expect((await rt.post(`/api/admin/academy/certificate-templates/${tpl.body.id}/approve`)).status).toBe(200);
    const [i1, i2] = [await c.post('/api/academy/certificates', {}, true), await c.post('/api/academy/certificates', {}, true)];
    expect(i1.status).toBe(201);
    expect(i2.body.alreadyIssued).toBe(true);
    expect(one<any>('SELECT COUNT(*) AS n FROM academy_certificates').n).toBe(1);
    const code = i1.body.certificate.public_code;
    const v = await new Client(app).get(`/api/public/certificates/${code}/verify`);
    expect(v.body.result).toBe('VALIDO');
    const certRow = one<any>('SELECT * FROM academy_certificates WHERE public_code = ?', code);
    expect(v.body.contentHash).toBe(certRow.content_hash);
    expect(JSON.stringify(v.body)).not.toMatch(/correct|score|nota|pagamento|amount/i);
    expect(() => run('UPDATE academy_certificates SET content_hash = ? WHERE id = ?', 'x', certRow.id)).toThrow(/immutable/);
    expect((await new Client(app).get('/api/public/certificates/ONM-XXXX-0000/verify')).body).toEqual({ result: 'NAO_ENCONTRADO' });
    await rt.post(`/api/admin/academy/certificates/${certRow.id}/revoke`, { reason: 'Revogação de teste automatizado' });
    expect((await new Client(app).get(`/api/public/certificates/${code}/verify`)).body.result).toBe('REVOGADO');
    // Credenciamento humano: APTO exige confirmação dos demais gates (P-010)
    const cred = await loginAs(app, 'credenciamento');
    const noGates = await cred.post(`/api/admin/academy/training-status/${idOf('especialista')}/decision`, { decision: 'APTO', note: 'Decisão de teste registrada', otherGatesConfirmed: false });
    expect(noGates.status).toBe(422);
    expect((await cred.post(`/api/admin/academy/training-status/${idOf('especialista')}/decision`, { decision: 'APTO', note: 'Decisão de teste registrada', otherGatesConfirmed: true })).status).toBe(200);
  });

  it('credenciamento APTO é negado com Academy incompleta (ACA-T044)', async () => {
    const c = await partner(); await payAndEnroll(c);
    const cred = await loginAs(app, 'credenciamento');
    const r = await cred.post(`/api/admin/academy/training-status/${idOf('especialista')}/decision`, { decision: 'APTO', note: 'Tentativa de teste', otherGatesConfirmed: true });
    expect(r.status).toBe(409);
  });

  it('segregação: nenhuma tabela/rota da Academy grava dados de paciente (ACA-T003/T038)', async () => {
    const c = await partner(); await payAndEnroll(c);
    await completeLessons(c, 'C01');
    expect(one<any>('SELECT COUNT(*) AS n FROM prime_receipts').n).toBe(0);
    expect(one<any>('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?', idOf('paciente')).n).toBe(0);
    const exp = await c.get('/api/academy/history/export');
    expect(exp.body.scope).toMatch(/educacionais/);
  });
});

describe('Administração de conteúdo, mídia e auditoria', () => {
  it('publicação exige aprovação RT; versão publicada é imutável; matrícula preserva versão original (ACA-T007, T039, T040)', async () => {
    const c = await partner(); await payAndEnroll(c);
    await c.get('/api/academy/courses/C01'); // vincula v1
    const gestor = await loginAs(app, 'gestor');
    const courses = await gestor.get('/api/admin/academy/courses');
    const v1 = courses.body.courses[0].versions[0];
    const lesson = one<any>('SELECT * FROM academy_lessons WHERE course_version_id = ? LIMIT 1', v1.id);
    const edit = await gestor.put(`/api/admin/academy/lessons/${lesson.id}`, { title: 'x x x', body: 'y', videoAssetId: null, captionAssetId: null, transcriptAssetId: null, completionMinPercent: 100 });
    expect(edit.body.error.code).toBe('VERSION_IMMUTABLE');
    const draft = await gestor.post('/api/admin/academy/course-versions', { courseCode: 'C01' });
    expect(draft.body.version).toBe(2);
    const adminA = await loginAs(app, 'adminAcademy');
    const pub = await adminA.post(`/api/admin/academy/course-versions/${draft.body.id}/publish`);
    expect(pub.body.error.code).toBe('RT_APPROVAL_REQUIRED');
    expect((await gestor.post(`/api/admin/academy/course-versions/${draft.body.id}/submit`)).status).toBe(200);
    // gestor não pode aprovar
    expect((await gestor.post(`/api/admin/academy/course-versions/${draft.body.id}/approve`)).status).toBe(403);
    const rt = await loginAs(app, 'rt');
    expect((await rt.post(`/api/admin/academy/course-versions/${draft.body.id}/approve`)).status).toBe(200);
    expect((await adminA.post(`/api/admin/academy/course-versions/${draft.body.id}/publish`)).status).toBe(200);
    const course = await c.get('/api/academy/courses/C01');
    expect(course.body.course.version).toBe(1); // matrícula antiga preserva versão
    expect(one<any>(`SELECT state FROM academy_course_versions WHERE id = ?`, v1.id).state).toBe('ARCHIVED');
    expect(one<any>(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'COURSE_VERSION_APPROVED' AND after_hash IS NOT NULL`).n).toBe(1);
  });

  it('vídeo sem legenda/transcrição não libera versão; checksum divergente bloqueia; URL assinada expira (ACA-T032, T041, T042)', async () => {
    const gestor = await loginAs(app, 'gestor');
    const draft = await gestor.post('/api/admin/academy/course-versions', { courseCode: 'C02' });
    const upload = async (kind: string, mime: string, content: string, expected?: string) => {
      const boundary = '----t' + uid();
      const parts = [`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nMídia ${kind}\r\n`,
        ...(expected ? [`--${boundary}\r\nContent-Disposition: form-data; name="expectedChecksum"\r\n\r\n${expected}\r\n`] : []),
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="f.bin"\r\nContent-Type: ${mime}\r\n\r\n${content}\r\n--${boundary}--\r\n`];
      return app.inject({ method: 'POST', url: '/api/admin/academy/media', payload: parts.join(''),
        headers: { cookie: gestor.cookie, 'x-csrf-token': gestor.csrf, 'content-type': `multipart/form-data; boundary=${boundary}` } });
    };
    const bad = await upload('VIDEO', 'video/mp4', 'conteudo', 'a'.repeat(64));
    expect(bad.statusCode).toBe(409);
    const vid = (await upload('VIDEO', 'video/mp4', 'video-ficticio')).json();
    const rt = await loginAs(app, 'rt');
    expect((await rt.post(`/api/admin/academy/media/${vid.id}/approve`)).status).toBe(200);
    const lesson = one<any>('SELECT id FROM academy_lessons WHERE course_version_id = ? ORDER BY sort_order LIMIT 1', draft.body.id);
    await gestor.put(`/api/admin/academy/lessons/${lesson.id}`, { title: 'Aula com vídeo', body: null, videoAssetId: vid.id, captionAssetId: null, transcriptAssetId: null, completionMinPercent: 90 });
    const sub = await gestor.post(`/api/admin/academy/course-versions/${draft.body.id}/submit`);
    expect(sub.status).toBe(422);
    expect(sub.body.error.details.join(' ')).toMatch(/sem legenda aprovada.*|sem transcrição/);
    // URL assinada: válida, adulterada, expirada
    const prev = await gestor.get(`/api/admin/academy/media/${vid.id}/preview`);
    expect((await app.inject({ url: prev.body.url })).statusCode).toBe(200);
    expect((await app.inject({ url: prev.body.url.replace(/sig=.*/, 'sig=abc') })).statusCode).toBe(403);
    const exp = Math.floor(Date.now() / 1000) - 10;
    expect((await app.inject({ url: `/api/academy/media/${vid.id}?exp=${exp}&p=1&sig=${hmac(`${vid.id}.${exp}.1`)}` })).json().error.code).toBe('MEDIA_URL_EXPIRED');
    // arquivo adulterado no storage -> bloqueio
    fs.writeFileSync(path.join(config.mediaDir, vid.id), 'adulterado');
    expect((await app.inject({ url: prev.body.url })).statusCode).toBe(409);
    expect(one<any>('SELECT state FROM academy_media_assets WHERE id = ?', vid.id).state).toBe('BLOCKED');
  });

  it('trilha de auditoria é append-only (ACA-T028)', async () => {
    const c = await partner(); await payAndEnroll(c);
    expect(() => run('DELETE FROM audit_events')).toThrow(/append-only/);
    expect(() => run(`UPDATE audit_events SET action = 'X'`)).toThrow(/append-only/);
    const aud = await loginAs(app, 'auditor');
    const r = await aud.get('/api/admin/audit');
    expect(r.body.total).toBeGreaterThan(0);
    expect(JSON.stringify(r.body)).not.toMatch(/password|senha|correct_option/i);
    expect((await aud.post('/api/admin/academy/course-versions', { courseCode: 'C01' })).status).toBe(403);
  });

  it('desativação de curso bloqueia novas matrículas e preserva histórico (ACA-T048)', async () => {
    const admin = await loginAs(app, 'adminAcademy');
    await admin.put('/api/admin/academy/courses/C03/status', { status: 'INACTIVE' });
    const c = await partner();
    const o = await c.post('/api/academy/payment-orders', {}, true);
    await c.post(`/api/academy/payment-orders/${o.body.order.id}/sandbox-pay`, { outcome: 'APROVADO' });
    const e = await c.post('/api/academy/enrollments', {}, true);
    expect(e.body.error.code).toBe('JOURNEY_UNAVAILABLE');
  });
});
