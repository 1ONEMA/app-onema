/** Atividades integradoras oficiais (ONEMA-ACA-ATI-INTERATIVA v1.2, RT 26/11/2026). */
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, emailOf, one, setup } from './helpers.ts';
import { all } from '../src/db/db.ts';
import { loadOfficialActivities } from '../src/modules/academy/official-bank.ts';
import ACT from '../src/db/content/academy-atividades.json';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });

async function enrolled() {
  const c = new Client(app); await c.login(emailOf('especialista'));
  const o = await c.post('/api/academy/payment-orders', {}, true);
  await c.post(`/api/academy/payment-orders/${o.body.order.id}/sandbox-pay`, { outcome: 'APROVADO' });
  await c.post('/api/academy/enrollments', {}, true);
  return c;
}

describe('Atividades integradoras oficiais', () => {
  it('carga idempotente: C01 6, C02 5, C04 9 decisões; C03 sem atividade', async () => {
    expect(await loadOfficialActivities()).toBeGreaterThan(0);
    expect(await loadOfficialActivities()).toBe(0);
    const rows = await all<any>(`SELECT c.code, a.required_correct, (SELECT COUNT(*)::int FROM academy_activity_steps s WHERE s.activity_id = a.id) AS steps
      FROM academy_activities a JOIN academy_course_versions cv ON cv.id = a.course_version_id JOIN academy_courses c ON c.id = cv.course_id
      WHERE a.state = 'APPROVED' AND c.current_version_id = cv.id ORDER BY c.code`);
    expect(rows.map((r) => [r.code, r.required_correct, r.steps])).toEqual([['C01', 6, 6], ['C02', 5, 5], ['C04', 9, 9]]);
  });

  it('sem gabarito no cliente; decisões em sequência; retorno da alternativa; conclusão só com a síntese confirmada', async () => {
    await loadOfficialActivities();
    const c = await enrolled();
    const a = (await c.get('/api/academy/courses/C01/activity')).body.activity;
    expect(a.title).toBe('Uma visita, várias decisões');
    expect(a.content).toMatchObject({ image: '/academy/atividades/C01.jpg', openingAudio: 'C01-abertura', closing: null });
    const started = (await c.post(`/api/academy/activities/${a.id}/attempts`, {}, true)).body.activity;
    const json = JSON.stringify(started);
    expect(json).not.toMatch(/"correct"\s*:\s*true|feedback|transition":"[A-Z]/);
    const course = (ACT as any).courses.find((x: any) => x.id === 'C01');
    const attemptId = started.attempt.id;
    // fora de ordem: recusado
    const second = started.steps[1];
    expect((await c.post(`/api/academy/activity-attempts/${attemptId}/decisions`, { stepId: second.id, optionId: 'A' }, true)).body.error.code).toBe('PREVIOUS_STEP_PENDING');
    for (const [i, s] of started.steps.entries()) {
      const src = course.steps[i];
      const wrong = src.options.find((o: any) => o.id !== src.correctOptionId);
      const w = await c.post(`/api/academy/activity-attempts/${attemptId}/decisions`, { stepId: s.id, optionId: wrong.id }, true);
      expect(w.body).toMatchObject({ correct: false, feedback: wrong.feedback, feedbackAudio: wrong.feedbackAudio });
      const r = await c.post(`/api/academy/activity-attempts/${attemptId}/decisions`, { stepId: s.id, optionId: src.correctOptionId }, true);
      expect(r.body.correct).toBe(true);
      expect(r.body.completed).toBe(false);
    }
    const view = (await c.get('/api/academy/courses/C01/activity')).body.activity;
    expect(view.allSolved).toBe(true);
    expect(view.content.closing).toBe(course.closing);
    expect(view.steps[0].transition).toBe(course.steps[0].transition);
    expect((await c.post(`/api/academy/activity-attempts/${attemptId}/complete`, {})).status).toBe(400);
    expect((await c.post(`/api/academy/activity-attempts/${attemptId}/complete`, { acknowledged: true })).body).toMatchObject({ completed: true, already: false });
    expect((await c.post(`/api/academy/activity-attempts/${attemptId}/complete`, { acknowledged: true })).body.already).toBe(true);
    expect((await one<any>('SELECT state FROM academy_activity_attempts WHERE id = ?', attemptId)).state).toBe('CONCLUIDA');
  });
});
