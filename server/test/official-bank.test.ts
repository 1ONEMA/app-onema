import { beforeEach, describe, expect, it } from 'vitest';
import { all, one, setup } from './helpers.ts';
import { loadOfficialAssessments } from '../src/modules/academy/official-bank.ts';

beforeEach(async () => { await setup(); });

describe('Banco oficial das avaliações finais (42 questões aprovadas pelo RT)', () => {
  it('substitui as questões de demonstração na versão vigente, com as regras de cada curso; idempotente', async () => {
    expect(await loadOfficialAssessments({ force: true })).toBeGreaterThanOrEqual(4);
    expect(await loadOfficialAssessments({ force: true })).toBe(0);
    const rows = await all<any>(`SELECT c.code, a.question_count, a.pass_min_correct, a.max_attempts, a.critical_gate,
        (SELECT COUNT(*) FROM academy_questions q WHERE q.assessment_id = a.id) AS n,
        (SELECT COUNT(*) FROM academy_questions q WHERE q.assessment_id = a.id AND q.critical = 1) AS crit,
        (SELECT COUNT(*) FROM academy_questions q WHERE q.assessment_id = a.id AND q.stem LIKE '%DEMONSTRAÇÃO%') AS demo
      FROM academy_courses c JOIN academy_assessments a ON a.course_version_id = c.current_version_id AND a.state = 'APPROVED' ORDER BY c.code`);
    expect(rows.map((r) => [r.code, r.question_count, r.pass_min_correct, r.max_attempts, Number(r.n), Number(r.crit), Number(r.demo)])).toEqual([
      ['C01', 12, 10, 3, 12, 0, 0], ['C02', 10, 8, 3, 10, 0, 0], ['C03', 10, 8, 3, 10, 0, 0], ['C04', 10, 8, 3, 10, 4, 0]]);
    expect((await one<any>(`SELECT COUNT(*) AS n FROM academy_assessments WHERE state = 'APPROVED' AND source_note NOT LIKE 'BANCO_OFICIAL%' AND course_version_id IN (SELECT current_version_id FROM academy_courses)`)).n).toBe(0);
  });
});
