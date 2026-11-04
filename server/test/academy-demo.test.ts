import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { all, one, setup } from './helpers.ts';
import { tx } from '../src/db/db.ts';
import { seedAcademyDemoRest } from '../src/db/seed.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); void app; });

describe('Demonstração: C02–C04 testáveis', () => {
  it('libera atividade/avaliação com regra provisória só onde está em branco; mantém regra oficial cadastrada; idempotente', async () => {
    const n = await tx(async () => await seedAcademyDemoRest());
    expect(n).toBeGreaterThan(0);
    expect(await tx(async () => await seedAcademyDemoRest())).toBe(0);
    const rows = await all<any>(`SELECT c.code, a.state, a.question_count, a.pass_min_correct, a.max_attempts,
        (SELECT COUNT(*) FROM academy_questions q WHERE q.assessment_id = a.id) AS q
      FROM academy_assessments a JOIN academy_courses c ON c.current_version_id = a.course_version_id WHERE c.code IN ('C02','C03','C04') ORDER BY c.code`);
    for (const r of rows) {
      expect(r.state).toBe('APPROVED');
      expect(Number(r.q)).toBe(r.question_count);
    }
    const c04 = rows.find((r) => r.code === 'C04');
    expect([c04.question_count, c04.pass_min_correct]).toEqual([10, 8]); // regra oficial 8/10 preservada
    expect((await one<any>(`SELECT COUNT(*) AS n FROM academy_questions q JOIN academy_assessments a ON a.id = q.assessment_id JOIN academy_courses c ON c.current_version_id = a.course_version_id WHERE c.code = 'C04' AND q.critical = 1`)).n).toBe(4);
  });
});
