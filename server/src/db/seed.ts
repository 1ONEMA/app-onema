/**
 * Seeds.
 *  - await seedOfficial(): somente conteúdo e regras DOCUMENTADOS pela ONEMA (títulos, regras C01/C04, textos T1–T3,
 *    parâmetros PRIME). Nada é preenchido por estimativa: o que é pendente fica NULL/DRAFT com a referência.
 *  - seedDemo(): dados FICTÍCIOS para homologação local. Bloqueado em produção.
 */
import { config } from '../config.ts';
import { hashPassword } from '../lib/security.ts';
import { hashObj, nowIso, sha256, stableJson, uid } from '../lib/util.ts';
import { all, insertMany, one, run, tx } from './db.ts';

import primeTexts from './content/prime-texts.json';
const SRC_ACADEMY = 'Documento Mestre de Transferência Técnica ONEMA Academy v1.0 (25/09/2026)';

const COURSES = [
  {
    code: 'C01', title: 'Excelência no Atendimento', activity: 1, lessons: [
      ['C01-A01', 'Identidade ONEMA e papel do Enfermeiro'], ['C01-A02', 'Apresentação, acolhimento e comunicação'],
      ['C01-A03', 'Privacidade, consentimento e autonomia'], ['C01-A04', 'Situações difíceis e postura profissional'],
    ],
    note: `${SRC_ACADEMY}, seção 5. Atividade obrigatória (seção 7).`,
  },
  {
    code: 'C02', title: 'Segurança do Paciente', activity: 1, lessons: [
      ['C02-A01', 'Identificação segura'], ['C02-A02', 'Higiene das mãos e prevenção de infecções'],
      ['C02-A03', 'Alergias e segurança medicamentosa'], ['C02-A04', 'Reconhecimento de sinais de alerta'],
      ['C02-A05', 'Incidentes, comunicação e escalonamento'],
    ],
    note: `${SRC_ACADEMY}, seção 5. Atividade obrigatória; roteiro definitivo pendente (P-003).`,
  },
  {
    code: 'C03', title: 'Carteira Digital e Documentação', activity: 0, lessons: [
      ['C03-A01', 'Estrutura e finalidade da Carteira Digital'], ['C03-A02', 'Avaliação e registros assistenciais'],
      ['C03-A03', 'Evolução e continuidade assistencial'], ['C03-A04', 'Privacidade e rastreabilidade'],
    ],
    note: `${SRC_ACADEMY}, seção 5. Sem atividade segundo o Comando Mestre (fonte vinculante); divergência com materiais de apoio aberta (P-004).`,
  },
  {
    code: 'C04', title: 'Operação e Protocolos ONEMA', activity: 1, lessons: [
      ['C04-A01', 'Disponibilidade, ofertas e aceite'], ['C04-A02', 'Preparo e chegada ao domicílio'],
      ['C04-A03', 'Escopo, POPs e escalonamento'], ['C04-A04', 'Encerramento e continuidade'],
    ],
    note: `${SRC_ACADEMY}, seção 5. Rótulos internos C04-A03/A04 a corrigir no controle documental (P-007).`,
  },
];

const ASSESSMENT_RULES: Record<string, { q: number | null; p: number | null; m: number | null; critical: number; criticalPositions?: number[]; note: string }> = {
  C01: { q: 12, p: 10, m: 3, critical: 0, note: `${SRC_ACADEMY}, seção 7: 12 questões; mínimo 10/12; até 3 tentativas (regra aprovada). Banco de questões não fornecido.` },
  C02: { q: null, p: null, m: null, critical: 0, note: `${SRC_ACADEMY}, seção 7: banco, nota e tentativas pendentes (P-001).` },
  C03: { q: null, p: null, m: null, critical: 0, note: `${SRC_ACADEMY}, seção 7: banco, nota e tentativas pendentes (P-001).` },
  C04: { q: 10, p: 8, m: null, critical: 1, criticalPositions: [3, 6, 8, 10], note: `${SRC_ACADEMY}, seção 7: 10 questões; mínimo 8/10; críticas 03, 06, 08, 10 (gate independente). Limite de tentativas pendente (P-002).` },
};

const ACTIVITY_RULES: Record<string, { required: number | null; note: string }> = {
  C01: { required: 6, note: `${SRC_ACADEMY}, seção 7: obrigatória; seis decisões corretas após revisão. Roteiro/assets finais a confirmar.` },
  C02: { required: null, note: `${SRC_ACADEMY}: obrigatória; roteiro e regra de conclusão pendentes (P-003).` },
  C04: { required: null, note: `${SRC_ACADEMY}: obrigatória; roteiro e regra de conclusão pendentes (P-003).` },
};

export async function seedOfficial() {
  return await tx(async () => {
    const now = nowIso();
    const created: string[] = [];
    // Academy: cursos e versão 1 em RASCUNHO (conteúdo das aulas pendente - P-006). Inserções em lote.
    const existing = new Set((await all<any>('SELECT code FROM academy_courses')).map((r) => r.code));
    const courses: any[][] = [], versions: any[][] = [], lessons: any[][] = [], assessments: any[][] = [], activities: any[][] = [];
    for (const [i, c] of COURSES.entries()) {
      if (existing.has(c.code)) continue;
      const courseId = uid(), cvId = uid();
      courses.push([courseId, c.code, i + 1, 'ACTIVE', now]);
      versions.push([cvId, courseId, 1, c.title, c.activity, null, c.note, 'DRAFT', now]);
      for (const [j, [code, title]] of c.lessons.entries()) lessons.push([uid(), cvId, code, j + 1, 1, title]);
      const r = ASSESSMENT_RULES[c.code];
      assessments.push([uid(), cvId, 1, r.q, r.p, r.m, r.critical, r.note, 'DRAFT', now]);
      const act = ACTIVITY_RULES[c.code];
      if (act) activities.push([uid(), cvId, 1, `Atividade integradora ${c.code}`, act.required, act.note, 'DRAFT', now]);
      created.push(c.code);
    }
    await insertMany('academy_courses', ['id', 'code', 'sort_order', 'status', 'created_at'], courses);
    await insertMany('academy_course_versions', ['id', 'course_id', 'version', 'title', 'activity_required', 'workload_text', 'source_note', 'state', 'created_at'], versions);
    await insertMany('academy_lessons', ['id', 'course_version_id', 'code', 'sort_order', 'required', 'title'], lessons);
    await insertMany('academy_assessments', ['id', 'course_version_id', 'version', 'question_count', 'pass_min_correct', 'max_attempts', 'critical_gate', 'source_note', 'state', 'created_at'], assessments);
    await insertMany('academy_activities', ['id', 'course_version_id', 'version', 'title', 'required_correct', 'source_note', 'state', 'created_at'], activities);

    // PRIME: parâmetros v1 (T1 §2, §4, §5, §7)
    await run(`INSERT INTO prime_parameters (id, version, monthly_price_cents, discount_bps, discount_cap_cents, uses_per_cycle, retry_max, retry_window_days, refund_withdrawal_days, source_note, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (version) DO NOTHING`, uid(), 1, 3490, 500, 2000, 1, 3, 7, 7,
      'ONEMA PRIME v2.0 (decisão RT 28/09/2026): R$ 34,90/mês; 5% em um pedido elegível por ciclo, teto R$ 20; até 3 novas tentativas em 7 dias; arrependimento em 7 dias.', now);
    const texts = primeTexts as any;
    const haveTexts = new Set((await all<any>('SELECT code FROM legal_texts WHERE version = ?', texts.version)).map((r) => r.code));
    const textRows: any[][] = [];
    for (const t of texts.texts) {
      if (haveTexts.has(t.code)) continue;
      const body = JSON.stringify({ title: t.title, sections: t.sections, source: texts.source });
      textRows.push([uid(), t.code, texts.version, t.title, body, sha256(body), texts.rtApprovedAt, 'PENDENTE', now]);
      created.push(t.code);
    }
    await insertMany('legal_texts', ['id', 'code', 'version', 'title', 'body', 'content_hash', 'rt_approved_at', 'legal_review', 'created_at'], textRows);
    await run('INSERT INTO provider_identity (id, validated) VALUES (1, 0) ON CONFLICT (id) DO NOTHING');
    return created;
  });
}

// ------------------------------------------------------------------------------------------
// DEMONSTRAÇÃO (fictício). Nenhum dado pessoal real; nenhum conteúdo clínico inventado.
// ------------------------------------------------------------------------------------------
export const DEMO_PASSWORD = 'Onema-Demo-2026';
export const DEMO_USERS = [
  { key: 'paciente', email: 'paciente.demo@exemplo.test', name: 'Paciente Demonstração', roles: ['PACIENTE'] },
  { key: 'responsavel', email: 'responsavel.demo@exemplo.test', name: 'Responsável Demonstração', roles: ['PACIENTE'] },
  { key: 'especialista', email: 'especialista.demo@exemplo.test', name: 'Especialista Demonstração', roles: ['ESPECIALISTA'], eligible: true },
  { key: 'especialista2', email: 'especialista2.demo@exemplo.test', name: 'Especialista Não Elegível', roles: ['ESPECIALISTA'] },
  { key: 'gestor', email: 'gestor.demo@exemplo.test', name: 'Gestor de Conteúdo Demo', roles: ['GESTOR_CONTEUDO'] },
  { key: 'rt', email: 'rt.demo@exemplo.test', name: 'Avaliador RT Demo', roles: ['AVALIADOR_RT'] },
  { key: 'adminAcademy', email: 'admin.academy.demo@exemplo.test', name: 'Admin Academy Demo', roles: ['ADMIN_ACADEMY'] },
  { key: 'credenciamento', email: 'credenciamento.demo@exemplo.test', name: 'Credenciamento Demo', roles: ['CREDENCIAMENTO'] },
  { key: 'suporte', email: 'suporte.demo@exemplo.test', name: 'Suporte Academy Demo', roles: ['SUPORTE_ACADEMY'] },
  { key: 'financeiro', email: 'financeiro.demo@exemplo.test', name: 'Financeiro Demo', roles: ['FINANCEIRO'] },
  { key: 'auditor', email: 'auditor.demo@exemplo.test', name: 'Auditor Demo', roles: ['AUDITOR'] },
  { key: 'operador', email: 'operador.demo@exemplo.test', name: 'Operador Central Demo', roles: ['OPERADOR_CENTRAL'] },
  { key: 'adminPrime', email: 'admin.prime.demo@exemplo.test', name: 'Admin PRIME Demo', roles: ['ADMIN_PRIME'] },
] as const;

let demoHash: string | null = null;
export const DEMO_LABEL = '[DEMONSTRAÇÃO FICTÍCIA — não é conteúdo oficial ONEMA]';

export async function seedDemo() {
  if (config.appEnv === 'production') throw new Error('seed-demo é proibido em produção.');
  await seedOfficial();
  return await tx(async () => {
    const now = nowIso();
    const ids: Record<string, string> = {};
    const known = new Map((await all<any>(`SELECT id, email FROM users WHERE email IN (${DEMO_USERS.map(() => '?').join(',')})`, ...DEMO_USERS.map((u) => u.email)))
      .map((r) => [r.email, r.id]));
    const userRows: any[][] = [], roleRows: any[][] = [];
    for (const u of DEMO_USERS) {
      if (known.has(u.email)) { ids[u.key] = known.get(u.email); continue; }
      const id = uid();
      userRows.push([id, u.email, u.name, (demoHash ??= hashPassword(DEMO_PASSWORD)), (u as any).eligible ? 1 : 0, now, now]);
      for (const r of u.roles) roleRows.push([id, r, now]);
      ids[u.key] = id;
    }
    await insertMany('users', ['id', 'email', 'name', 'password_hash', 'academy_eligible', 'created_at', 'updated_at'], userRows);
    await insertMany('user_roles', ['user_id', 'role', 'granted_at'], roleRows);
    // Catálogo fictício com os valores dos critérios de aceite A04
    const demoItems: [string, string, 'SERVICO' | 'PACOTE', number][] = [
      ['DEMO-SERV-A', 'Serviço de demonstração A (fictício)', 'SERVICO', 8990],
      ['DEMO-SERV-B', 'Serviço de demonstração B (fictício)', 'SERVICO', 26990],
      ['DEMO-SERV-C', 'Serviço de demonstração C (fictício)', 'SERVICO', 44990],
      ['DEMO-PACOTE', 'Pacote de demonstração (fictício)', 'PACOTE', 72990],
    ];
    await run(`INSERT INTO catalog_items (id, code, name, kind, price_cents, prime_eligible, active, is_demo, created_at, updated_at) VALUES
      ${demoItems.map(() => '(?,?,?,?,?,1,1,1,?,?)').join(', ')} ON CONFLICT (code) DO NOTHING`,
      ...demoItems.flatMap(([code, name, kind, price]) => [uid(), code, name, kind, price, now, now]));

    // Academy: conteúdo neutro de demonstração em TODAS as aulas, aprovado pelo RT demo e publicado.
    for (const c of await all<any>('SELECT * FROM academy_courses ORDER BY sort_order')) {
      const cv = await one<any>(`SELECT * FROM academy_course_versions WHERE course_id = ? AND version = 1`, c.id)!;
      if (cv.state !== 'DRAFT') continue;
      await run(`UPDATE academy_lessons SET completion_min_percent = 100, body = ? || title || ? WHERE course_version_id = ?`,
        `${DEMO_LABEL}\n\nEste texto substitui temporariamente o conteúdo oficial da aula "`,
        '", que ainda não foi disponibilizado (P-006).\n\nRole até o final e marque a aula como concluída para testar o registro de progresso.', cv.id);
      await run('UPDATE academy_course_versions SET created_by = ?, objectives = ? WHERE id = ?', ids.gestor, `${DEMO_LABEL} Objetivos oficiais pendentes.`, cv.id);
      const snap = {
        cv: await one('SELECT id, version, title, objectives, activity_required, workload_text FROM academy_course_versions WHERE id = ?', cv.id),
        lessons: await all('SELECT code, sort_order, required, title, body, video_asset_id, caption_asset_id, transcript_asset_id, completion_min_percent FROM academy_lessons WHERE course_version_id = ? ORDER BY sort_order', cv.id),
      };
      await run(`UPDATE academy_course_versions SET state = 'PUBLISHED', submitted_at = ?, approved_by = ?, approved_at = ?, published_at = ?, content_hash = ? WHERE id = ?`,
        now, ids.rt, now, now, hashObj(snap), cv.id);
      await run('UPDATE academy_courses SET current_version_id = ? WHERE id = ?', cv.id, c.id);
    }

    // C01: roteiro e banco fictícios e neutros sob a REGRA OFICIAL (6 decisões; 12 questões, 10/12, 3 tentativas).
    const c01cv = (await one<any>(`SELECT cv.id FROM academy_course_versions cv JOIN academy_courses c ON c.id = cv.course_id WHERE c.code = 'C01' AND cv.version = 1`))!.id;
    const act = await one<any>(`SELECT * FROM academy_activities WHERE course_version_id = ? AND version = 1`, c01cv)!;
    if (act.state === 'DRAFT') {
      await run('UPDATE academy_activities SET intro = ?, created_by = ? WHERE id = ?', `${DEMO_LABEL} Micro-simulação neutra para testar o fluxo de decisões e feedback.`, ids.gestor, act.id);
      const options = JSON.stringify([
        { id: 'o1', text: 'Opção incorreta (demonstração)', correct: false, feedback: 'Feedback de demonstração: esta não é a opção esperada. Revise e tente novamente.' },
        { id: 'o2', text: 'Opção correta (demonstração)', correct: true, feedback: 'Feedback de demonstração: decisão registrada como correta.' },
        { id: 'o3', text: 'Outra opção incorreta (demonstração)', correct: false, feedback: 'Feedback de demonstração: revise e tente novamente.' },
      ]);
      await insertMany('academy_activity_steps', ['id', 'activity_id', 'sort_order', 'prompt', 'options_json'],
        [1, 2, 3, 4, 5, 6].map((i) => [uid(), act.id, i, `Decisão de demonstração ${i}: escolha a opção marcada como "correta (demonstração)".`, options]));
      await run(`UPDATE academy_activities SET state = 'APPROVED', approved_by = ?, approved_at = ? WHERE id = ?`, ids.rt, now, act.id);
    }
    const asm = await one<any>(`SELECT * FROM academy_assessments WHERE course_version_id = ? AND version = 1`, c01cv)!;
    if (asm.state === 'DRAFT') {
      const qopts = JSON.stringify([{ id: 'o1', text: 'Alternativa A (demonstração)' }, { id: 'o2', text: 'Resposta esperada (demonstração)' }, { id: 'o3', text: 'Alternativa C (demonstração)' }, { id: 'o4', text: 'Alternativa D (demonstração)' }]);
      await insertMany('academy_questions', ['id', 'assessment_id', 'position', 'critical', 'stem', 'options_json', 'correct_option_id', 'created_by', 'created_at'],
        Array.from({ length: 12 }, (_, k) => [uid(), asm.id, k + 1, 0, `${DEMO_LABEL} Questão ${k + 1}: selecione a alternativa "Resposta esperada (demonstração)".`, qopts, 'o2', ids.gestor, now]));
      await run(`UPDATE academy_assessments SET state = 'APPROVED', approved_by = ?, approved_at = ? WHERE id = ?`, ids.rt, now, asm.id);
    }
    return { users: DEMO_USERS.map((u) => u.email), password: DEMO_PASSWORD };
  });
}

export { stableJson };
