/**
 * Banco oficial das Avaliações Finais C01–C04 (42 questões aprovadas pelo RT — pacote Mestre).
 * Substitui as questões fictícias de demonstração: cria nova versão APROVADA da avaliação na versão vigente de cada curso
 * e aposenta a anterior. Gabarito fica só no servidor. Idempotente (marcador em source_note).
 */
import { all, one, run, tx } from '../../db/db.ts';
import { audit } from '../../lib/audit.ts';
import { nowIso, uid } from '../../lib/util.ts';
import BANK from '../../db/content/academy-avaliacoes-finais.json';

export const OFFICIAL_BANK_TAG = 'BANCO_OFICIAL_RT_42Q_v1';

export async function loadOfficialAssessments(opts: { force?: boolean } = {}) {
  if (process.env.ACADEMY_OFFICIAL_BANK_DISABLED === '1' && !opts.force) return 0;
  let created = 0;
  for (const c of (BANK as any).courses) {
    const course = await one<any>('SELECT id, current_version_id FROM academy_courses WHERE code = ?', c.code);
    if (!course?.current_version_id) continue;
    // Todas as versões do curso ainda não vinculadas ao banco oficial (vigente e rascunhos/revisões).
    const versions = await all<any>(`SELECT id FROM academy_course_versions WHERE course_id = ? AND state IN ('PUBLISHED','DRAFT','IN_REVIEW','APPROVED')`, course.id);
    for (const v of versions) {
      if (await one('SELECT 1 AS ok FROM academy_assessments WHERE course_version_id = ? AND source_note LIKE ?', v.id, `${OFFICIAL_BANK_TAG}%`)) continue;
      await tx(async () => {
        const now = nowIso();
        const next = Number((await one<any>('SELECT COALESCE(MAX(version), 0) + 1 AS n FROM academy_assessments WHERE course_version_id = ?', v.id))!.n);
        await run(`UPDATE academy_assessments SET state = 'RETIRED' WHERE course_version_id = ? AND state = 'APPROVED'`, v.id);
        const id = uid();
        await run(`INSERT INTO academy_assessments (id, course_version_id, version, question_count, pass_min_correct, max_attempts, critical_gate, source_note, state, created_at, approved_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, v.id, next, c.questionCount, c.passMin, c.maxAttempts, c.criticalGate ? 1 : 0,
          `${OFFICIAL_BANK_TAG} · ${(BANK as any).source}`, 'APPROVED', now, now);
        for (const q of c.questions) {
          await run(`INSERT INTO academy_questions (id, assessment_id, position, critical, stem, options_json, correct_option_id, created_at) VALUES (?,?,?,?,?,?,?,?)`,
            uid(), id, q.position, c.critical.includes(q.position) ? 1 : 0, q.stem, JSON.stringify(q.options.map((o: any) => ({ id: o.id, text: o.text }))), q.answer, now);
        }
        await audit({ actorId: null, action: 'ACADEMY_OFFICIAL_BANK_LOADED', subjectType: 'assessment', subjectId: id, meta: { course: c.code, questions: c.questions.length } });
        created++;
      });
    }
  }
  return created;
}

/** Modelo oficial do certificado (PDF assinado pelo RT em 01/11/2026). Aprovado na carga; QR com verificação real. */
export const OFFICIAL_CERT_TAG = 'MODELO_OFICIAL_RT_2026-11-01';
export async function loadOfficialCertificateTemplate() {
  if (await one(`SELECT 1 AS ok FROM academy_certificate_templates WHERE heading = 'CERTIFICADO DE CONCLUSÃO' AND state = 'APPROVED'`)) return 0;
  const now = nowIso();
  const v = Number((await one<any>('SELECT COALESCE(MAX(version),0)+1 AS v FROM academy_certificate_templates'))!.v);
  await run(`UPDATE academy_certificate_templates SET state = 'RETIRED' WHERE state = 'APPROVED'`);
  await run(`INSERT INTO academy_certificate_templates (id, version, heading, declaration, signatories_json, state, created_at, approved_at) VALUES (?,?,?,?,?,?,?,?)`,
    uid(), v, 'CERTIFICADO DE CONCLUSÃO',
    'concluiu, com aproveitamento, a Jornada de Integração ONEMA ONE, promovida pela ONEMA ACADEMY, cumprindo os quatro cursos e os critérios de avaliação estabelecidos no programa educacional. Este certificado comprova a conclusão da integração institucional, na modalidade de curso livre.',
    JSON.stringify([{ name: 'Enf. Marcos Roberto Alves', role: 'Responsável Técnico · COREN-SP nº 983558', signature: '/img/assinatura-rt-marcos-alves.png' }]), 'APPROVED', now, now);
  await audit({ actorId: null, action: 'CERTIFICATE_TEMPLATE_OFFICIAL_LOADED', subjectType: 'certificate_template', subjectId: String(v), meta: { tag: OFFICIAL_CERT_TAG } });
  return 1;
}
