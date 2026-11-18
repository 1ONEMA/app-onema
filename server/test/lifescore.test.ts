import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, emailOf, idOf, loginAs, one, run, setup } from './helpers.ts';
import { PRICING_V1 } from '../src/db/content/pricing-v1.ts';
import { compareAssessments, evaluate, model, modelHash, registry, signOperationalRelease, verifyOperationalRelease } from '../src/modules/lifescore/core.ts';
import { runLifescoreReminders, scheduleReminders } from '../src/modules/lifescore/service.ts';

/** Respostas válidas (contexto e fundamento quando exigidos) com o mesmo código em todos os itens. */
const CTX: Record<string, any> = { A1: { task: 'Transferência cama-cadeira' }, A2: { activities: ['Banho', 'Vestir-se'] }, K1: { executor: 'CUIDADOR' }, S1: { objects: ['MEDICAMENTOS'] }, S2: { wound: false } };
const all = (code: string) => Object.fromEntries(model.items.map((i: any) => [i.item_id, { code, context: CTX[i.item_id], rationale: code === 'R0' ? 'Fundamento registrado.' : undefined }]));
const payload = (responses: any, extra: any = {}) => ({ environment: 'HOMOLOGATION', synthetic: true, patient_id: 'P1', encounter_id: 'E1', episode_id: 'EP', assessment_id: 'A1',
  assessed_at: '2026-11-18T10:00:00-03:00', model_id: model.model_id, model_hash: modelHash, responses, ...extra });

describe('Life Score v0.4 — núcleo OLS-8-HOM-0.1 (gabaritos SIM8)', () => {
  const reg = registry();
  it('SIM8-01..06: todos R3=100, R2=66,67, R1=33,33, R0=0 com pendências; C1 R0=85; A1 R2=96,67', () => {
    expect(model.items).toHaveLength(8);
    expect(evaluate(payload(all('R3')), reg).score_display).toBe(100);
    expect(evaluate(payload(all('R2')), reg).score_display).toBe(66.67);
    expect(evaluate(payload(all('R1')), reg).score_display).toBe(33.33);
    const z = evaluate(payload(all('R0')), reg);
    expect(z).toMatchObject({ calculation_status: 'CALCULABLE_DESCRIPTIVE', score_display: 0 });
    expect(z.review.map((r: any) => r.item_id)).toEqual(['C1', 'C2', 'S1', 'S2']);
    expect(z.review.every((r: any) => r.automatic_urgency === false)).toBe(true);
    const c1 = all('R3'); c1.C1 = { code: 'R0', rationale: 'Dor intensa não controlada.' };
    const r5 = evaluate(payload(c1), reg);
    expect(r5.score_display).toBe(85);
    expect(r5.review.map((r: any) => r.item_id)).toEqual(['C1']);
    expect(JSON.stringify(r5)).not.toMatch(/estável|est[aá]vel|atenção|prioridade/i);
    const a1 = all('R3'); a1.A1 = { code: 'R2', context: CTX.A1 };
    const r6 = evaluate(payload(a1), reg);
    expect(r6.score_display).toBe(96.67);
    expect(r6.raw_score).toBeCloseTo(96.6666667, 6); // precisão interna; arredonda só a exibição
    expect(r6.domain_scores.A).toBeCloseTo(83.333333, 5);
  });

  it('SIM8-07/08 e bloqueios: C1 não avaliado → global indisponível e domínio incompleto; S1 sem medicamento confirmado = 100', () => {
    const r7in = all('R3'); r7in.C1 = { code: 'NAO_AVALIADO' };
    const r7 = evaluate(payload(r7in), reg);
    expect(r7).toMatchObject({ calculation_status: 'NOT_CALCULABLE', score_display: null });
    expect(r7.domain_scores.C).toBeNull();
    expect(r7.domain_scores.A).toBe(100); // domínios completos exibidos como parciais
    const r8in = all('R3'); r8in.S1 = { code: 'R3', context: { noneConfirmed: true } };
    expect(evaluate(payload(r8in), reg).score_display).toBe(100);
    for (const code of ['DESCONHECIDO', 'RECUSA', 'QI']) { const x = all('R3'); x.K2 = { code }; expect(evaluate(payload(x), reg).score_display).toBeNull(); }
    const noCtx = all('R3'); delete noCtx.A1.context;
    expect(evaluate(payload(noCtx), reg).issues.map((i: any) => i.code)).toContain('CONTEXT_REQUIRED');
    const noWhy = all('R3'); noWhy.K2 = { code: 'R0' };
    expect(evaluate(payload(noWhy), reg).issues.map((i: any) => i.code)).toContain('RATIONALE_REQUIRED');
    expect(evaluate(payload(all('R3'), { model_hash: 'x' }), reg).issues.map((i: any) => i.code)).toContain('MODEL_MISMATCH');
    expect(evaluate(payload(all('R3'), { environment: 'PRODUCTION', synthetic: false }), reg).issues.map((i: any) => i.code)).toContain('OPERATIONAL_RELEASE_REQUIRED_FOR_REAL_RECORDS');
  });

  it('comparação só com o mesmo modelo e contexto equivalente (tarefas, atividades, executor)', () => {
    const a = evaluate(payload(all('R3')), reg);
    const b = evaluate(payload(all('R2'), { assessment_id: 'A2' }), reg);
    expect(compareAssessments(a, b)).toMatchObject({ status: 'DESCRIPTIVE_COMPARISON_ONLY', delta: -33.33, clinical_improvement_inferred: false });
    const other = all('R2'); other.K1 = { code: 'R2', context: { executor: 'PACIENTE' } };
    expect(compareAssessments(a, evaluate(payload(other), reg)).status).toBe('NOT_COMPARABLE');
  });

  it('liberação adulterada ou de outro build é recusada', () => {
    const secret = 'x'.repeat(40);
    const rec = { scope: 'DESCRIPTIVE_PROFESSIONAL_RECORD_ONLY', model_id: 'm', model_hash: 'h', app_build: 'b1', uat_report_ref: 'u', rt_approval_ref: 'r', approved_by: 'a', approved_at: new Date().toISOString() };
    const env = signOperationalRelease(rec, secret);
    expect(verifyOperationalRelease(env, secret, 'b1')?.verified).toBe(true);
    expect(verifyOperationalRelease(env, secret, 'b2')).toBeNull();
  });
});

let app: FastifyInstance;
const NEED_OF = Object.fromEntries(PRICING_V1.map((d) => [d.code, d.need]));
async function accepted(patientKey: 'paciente' | 'responsavel' = 'paciente') {
  const c = new Client(app); await c.login(emailOf(patientKey));
  const form = { need: NEED_OF['CAT-01'], itemCode: 'CAT-01', infoText: '', materials: 'SIM', materialsDetail: '', materialsSupplyRequested: false,
    patientName: 'Paciente Fictício', phone: '(11) 99999-0000', location: 'Vila Mariana', whenPref: 'PROXIMOS_DIAS', whenDate: null, notes: '', forSelf: true, responsibleAuthorized: false, address: { cep: '04101-000', street: 'Rua Fictícia', number: '100', complement: '', district: 'Vila Mariana', city: 'São Paulo', reference: '' }, timeWindow: 'MANHA' };
  const req = (await c.post('/api/care/requests', form, true)).body.request;
  await c.post(`/api/care/requests/${req.id}/accept`, { quoteVersion: req.quoteVersion });
  await c.post(`/api/care/requests/${req.id}/checkout`, { quoteVersion: req.quoteVersion, paymentMethod: 'SANDBOX_APROVADO', expectedTotalCents: req.quote.totalCents }, true);
  const sp = new Client(app); await sp.login(emailOf('especialistaOne'));
  const ev = (await sp.get('/api/care/specialist/offers')).body.offers.find((o: any) => o.label);
  await sp.post(`/api/care/specialist/events/${ev.id}/accept`);
  return { c, sp, eventId: ev.id as string };
}
const ALL_L4 = Object.fromEntries(model.items.map((i: any) => [i.item_id, { code: 'R3', context: CTX[i.item_id], rationale: 'Avaliado no atendimento' }]));
const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

describe('Life Score — integração no app', () => {
  beforeEach(async () => { app = await setup(); });

  it('rascunho privado → prévia → publicação idempotente; paciente vê só o publicado; outra profissional não acessa; retificação preserva a original', async () => {
    const { c, sp, eventId } = await accepted();
    const base = `/api/care/specialist/events/${eventId}/lifescore`;
    // antes: card sem número
    expect((await c.get('/api/lifescore/me')).body).toMatchObject({ latest: null, emptyText: expect.stringMatching(/após uma avaliação/) });
    // preocupação de segurança salva sem score
    expect((await sp.post(`/api/care/specialist/events/${eventId}/safety-events`, { level: 'PRIORITY', reason: 'Queixa de tontura relatada.', action: 'Orientado repouso e reavaliação.', responsible: 'Enf. responsável' })).status).toBe(200);
    // rascunho incompleto: não calculável com motivos (sem zero)
    const s1 = await sp.put(base, { revision: 0, responses: { C1: { code: 'R3' } } });
    expect(s1.body.revision).toBe(2);
    const pv = (await sp.post(`${base}/preview`)).body.preview;
    expect(pv).toMatchObject({ calculable: false, score: null });
    expect(pv.issues.length).toBeGreaterThan(0);
    expect((await c.get('/api/lifescore/me')).body.latest).toBeNull();
    // concorrência: revisão antiga é recusada
    expect((await sp.put(base, { revision: 1, responses: ALL_L4 })).body.error.code).toBe('STALE_REVISION');
    const s2 = await sp.put(base, { revision: 2, responses: ALL_L4 });
    const ok = (await sp.post(`${base}/preview`)).body.preview;
    expect(ok).toMatchObject({ calculable: true, score: 100 });
    expect(ok.safety.professional.level).toBe('PRIORITY'); // preocupação registrada é preservada, independente do número
    // outra especialista não vê nem altera
    const other = new Client(app); await other.login(emailOf('especialista'));
    await run(`INSERT INTO partner_training_status (partner_id, journey_state, credentialing_decision, updated_at) VALUES (?, 'NAO_INICIADA', 'APTO', '2026-01-01') ON CONFLICT (partner_id) DO UPDATE SET credentialing_decision = 'APTO'`, await idOf('especialista'));
    expect((await other.get(base)).status).toBe(404);
    // finalizar exige plano e textos; data passada recusada
    const fin = { confirm: true, revision: s2.body.revision, interpretation: 'Avaliação sem alterações relevantes.', patientSummary: 'Sua avaliação de hoje foi registrada; mantenha os cuidados combinados.' };
    expect((await sp.post(`${base}/finalize`, fin)).body.error.code).toBe('FINALIZE_FIELDS_REQUIRED');
    expect((await sp.post(`${base}/finalize`, { ...fin, plan: { kind: 'RETORNO', date: '2020-01-01' } })).body.error.code).toBe('INVALID_PLAN_DATE');
    const pub = await sp.post(`${base}/finalize`, { ...fin, plan: { kind: 'RETORNO', date: inDays(30) } });
    expect(pub.body).toMatchObject({ status: 'PUBLICADA', result: { score: 100 } });
    expect((await sp.post(`${base}/finalize`, { ...fin, plan: { kind: 'RETORNO', date: inDays(30) } })).body).toMatchObject({ already: true, id: pub.body.id });
    expect((await one<any>('SELECT COUNT(*) AS n FROM lifescore_reminders WHERE assessment_id = ?', pub.body.id)).n).toBe(3);
    // paciente: publicado com aviso; sem respostas cruas
    const me = (await c.get('/api/lifescore/me')).body;
    expect(me.latest).toMatchObject({ score: '100.00', summary: expect.any(String), plan: { kind: 'RETORNO', status: 'VIGENTE' } });
    expect(me.disclaimer).toMatch(/Não representa percentual de saúde/);
    expect(JSON.stringify(me)).not.toContain('Avaliado no atendimento');
    expect(JSON.stringify(me)).not.toContain('Avaliação sem alterações relevantes'); // interpretação profissional é interna
    await expect(run(`UPDATE lifescore_assessments SET patient_id = ? WHERE id = ?`, await idOf('responsavel'), pub.body.id)).rejects.toThrow(/immutable/);
    const intruso = new Client(app); await intruso.login(emailOf('responsavel'));
    expect((await intruso.get('/api/lifescore/me')).body.latest).toBeNull();
    expect((await intruso.post(`/api/lifescore/me/${pub.body.id}/plan`, { action: 'RECUSAR_LEMBRETES' })).status).toBe(404);
    // publicada é imutável
    await expect(run(`UPDATE lifescore_assessments SET score_display = '1' WHERE id = ?`, pub.body.id)).rejects.toThrow(/immutable/);
    // retificação: nova versão; a original fica como RETIFICADA no histórico
    expect((await sp.post(`/api/lifescore/assessments/${pub.body.id}/rectify`, { reason: 'curto' })).status).toBe(400);
    expect((await sp.post(`/api/lifescore/assessments/${pub.body.id}/rectify`, { reason: 'Item A1 registrado com nível errado.' })).status).toBe(200);
    const d = (await sp.get(base)).body.draft;
    const resp = { ...d.responses, A1: { code: 'R2', context: CTX.A1, rationale: 'Correção' } };
    const s3 = await sp.put(base, { revision: d.revision, responses: resp });
    const pub2 = await sp.post(`${base}/finalize`, { ...fin, revision: s3.body.revision, plan: { kind: 'SEM_RETORNO' } });
    expect(pub2.body.result.score).toBe(96.67);
    const h = (await c.get('/api/lifescore/me')).body.history;
    expect(h.map((x: any) => x.status)).toEqual(['PUBLICADA', 'RETIFICADA']);
    expect((await one<any>('SELECT COUNT(*) AS n FROM lifescore_reminders WHERE assessment_id = ? AND status = ?', pub.body.id, 'CANCELADO')).n).toBe(3);
  });

  it('Central: operação vê estados sem conteúdo clínico; RT vê detalhe auditado, suspende e registra liberação; registro real só calcula com liberação', async () => {
    const { sp, eventId } = await accepted();
    // paciente demonstração → homologação; marca o paciente como real para testar o bloqueio
    await run(`UPDATE users SET email = 'paciente.real@onema.test' WHERE email = ?`, emailOf('paciente'));
    const base = `/api/care/specialist/events/${eventId}/lifescore`;
    await sp.put(base, { revision: 0, responses: ALL_L4 });
    const pv = (await sp.post(`${base}/preview`)).body.preview;
    expect(pv.calculable).toBe(false);
    expect(pv.issues.map((i: any) => i.code)).toContain('OPERATIONAL_RELEASE_REQUIRED_FOR_REAL_RECORDS');
    const rt = await loginAs(app, 'rt');
    expect((await rt.post('/api/admin/lifescore/release', { uatReportRef: 'UAT-LS-001', rtApprovalRef: 'RT-2026-11-10', confirm: true })).body.release.verified).toBe(true);
    expect((await sp.post(`${base}/preview`)).body.preview).toMatchObject({ calculable: true, score: 100, productionAuthorized: true });
    const op = await loginAs(app, 'operador');
    const list = (await op.get('/api/admin/lifescore')).body;
    expect(list.clinical).toBe(false);
    expect(list.assessments[0].score_display).toBeUndefined();
    expect((await op.get(`/api/admin/lifescore/assessments/${list.assessments[0].id}`)).status).toBe(403);
    expect((await rt.get(`/api/admin/lifescore/assessments/${list.assessments[0].id}`)).body.assessment.responses.C1.code).toBe('R3');
    // suspensão pelo RT bloqueia novas pontuações sem apagar nada
    expect((await rt.post('/api/admin/lifescore/suspension', { calc: true, reminders: true, reason: 'Revisão do primeiro lote de 30.' })).body.calcSuspended).toBe(true);
    expect((await sp.put(base, { revision: 0, responses: ALL_L4 })).body.error.code).toBe('LIFESCORE_SUSPENDED');
    expect((await sp.post(`/api/care/specialist/events/${eventId}/safety-events`, { level: 'IMMEDIATE', reason: 'Dispneia importante.', action: 'Orientado acionar SAMU 192.', responsible: 'Enf. responsável' })).status).toBe(200);
    await rt.post('/api/admin/lifescore/release/revoke', { reason: 'Nova rodada de homologação.' });
    await rt.post('/api/admin/lifescore/suspension', { calc: false, reminders: false, reason: 'Retomada após revisão.' });
    expect((await sp.post(`${base}/preview`)).body.preview.calculable).toBe(false);
  });

  it('lembretes PRIME: só com PRIME e canal autorizado; D-7, D, D+7 às 9h; sem retroativos; cancelados ao recusar ou agendar', async () => {
    const { c, sp, eventId } = await accepted();
    const base = `/api/care/specialist/events/${eventId}/lifescore`;
    const s = await sp.put(base, { revision: 0, responses: ALL_L4 });
    const pub = (await sp.post(`${base}/finalize`, { confirm: true, revision: s.body.revision, interpretation: 'Sem alterações relevantes hoje.', patientSummary: 'Avaliação registrada; siga os cuidados combinados.', plan: { kind: 'RETORNO', date: inDays(3) } })).body;
    // D-7 já passou: não é criado (sem retroativo)
    const waves = await (await import('../src/db/db.ts')).all<any>('SELECT wave, scheduled_at FROM lifescore_reminders WHERE assessment_id = ? ORDER BY wave', pub.id);
    expect(waves.map((w) => w.wave)).toEqual([0, 7]);
    expect(waves[0].scheduled_at).toBe(new Date(`${inDays(3)}T09:00:00-03:00`).toISOString());
    // sem PRIME no horário: contato pulado (não cancela os próximos)
    const later = new Date(Date.now() + 4 * 86400000);
    expect((await runLifescoreReminders(later)).skipped).toBe(1);
    // com PRIME + lembretes no app: envia o próximo
    const offer = await c.get('/api/prime/offer');
    const on = { enabled: true, channels: { app: true, email: false, whatsapp: false } }, off = { enabled: false, channels: { app: false, email: false, whatsapp: false } };
    await c.post('/api/prime/subscriptions', { acceptTerms: true, termsTextId: offer.body.terms.id, privacyTextId: offer.body.privacy.id, paymentMethod: 'SANDBOX_APROVADO', preferences: { LEMBRETES: { ...on, frequency: 'SEMANAL' }, RESUMO_MENSAL: off, OFERTAS: off } }, true);
    expect((await runLifescoreReminders(new Date(Date.now() + 11 * 86400000))).sent).toBe(1);
    expect((await one<any>(`SELECT COUNT(*) AS n FROM notifications WHERE title = 'Acompanhamento de enfermagem'`)).n).toBe(1);
    const n = await one<any>(`SELECT body FROM notifications WHERE title = 'Acompanhamento de enfermagem'`);
    expect(n.body).not.toMatch(/\d{2,3}[,.]\d{2}|score|pontua/i); // sem pontuação nem dado clínico
    expect((await one<any>('SELECT plan_status FROM lifescore_assessments WHERE id = ?', pub.id)).plan_status).toBe('ENCERRADO_SEM_RESPOSTA');
    // novo plano: recusar lembretes cancela os futuros; recusar acompanhamento é outra ação
    await scheduleReminders(pub.id, await idOf('paciente'), inDays(40));
    expect((await c.post(`/api/lifescore/me/${pub.id}/plan`, { action: 'RECUSAR_LEMBRETES' })).status).toBe(200);
    expect((await one<any>(`SELECT COUNT(*) AS n FROM lifescore_reminders WHERE assessment_id = ? AND status = 'PROGRAMADO'`, pub.id)).n).toBe(0);
  });

  it('Guardian: card do paciente com explicação exata; solicitar, lembrar depois, já agendei e não quero retornar; contratação não é sobrescrita', async () => {
    const { c, sp, eventId } = await accepted();
    const base = `/api/care/specialist/events/${eventId}/lifescore`;
    const s = await sp.put(base, { revision: 0, responses: ALL_L4 });
    const pub = (await sp.post(`${base}/finalize`, { confirm: true, revision: s.body.revision, interpretation: 'Sem alterações relevantes hoje.', patientSummary: 'Avaliação registrada; siga os cuidados combinados.', plan: { kind: 'RETORNO', date: inDays(20) } })).body;
    const me = (await c.get('/api/lifescore/me')).body;
    expect(me.explanation).toBe('O Life Score resume aspectos da sua avaliação de Enfermagem. Não representa percentual de saúde nem define sozinho os cuidados necessários. As orientações são individualizadas pelo enfermeiro.');
    expect(me.urgencyNotice).toMatch(/SAMU 192/);
    expect(JSON.stringify(me.latest)).not.toMatch(/"C1"|"R3"|"R0"/); // sem códigos ou âncoras ao paciente
    const later = (await c.post(`/api/lifescore/me/${pub.id}/plan`, { action: 'LEMBRAR_DEPOIS' })).body;
    expect(later.message).toMatch(/equipe/);
    expect((await one<any>('SELECT plan_status FROM lifescore_assessments WHERE id = ?', pub.id)).plan_status).toBe('PAUSADO');
    expect((await one<any>(`SELECT COUNT(*) AS n FROM lifescore_reminders WHERE assessment_id = ? AND status = 'PROGRAMADO'`, pub.id)).n).toBe(0);
    const req = (await c.post(`/api/lifescore/me/${pub.id}/plan`, { action: 'SOLICITAR_ATENDIMENTO' })).body;
    expect(req).toMatchObject({ next: '/solicitar' });
    expect((await c.post(`/api/lifescore/me/${pub.id}/plan`, { action: 'JA_AGENDEI' })).status).toBe(200);
    // contratação confirmada (pedido pago depois do plano) não é sobrescrita
    await run(`UPDATE lifescore_assessments SET plan_status = 'CONTRATADO' WHERE id = ?`, pub.id);
    expect((await c.post(`/api/lifescore/me/${pub.id}/plan`, { action: 'NAO_QUERO_RETORNAR' })).body.error.code).toBe('PLAN_CONTRACTED');
    expect((await one<any>('SELECT COUNT(*) AS n FROM lifescore_plan_responses WHERE assessment_id = ?', pub.id)).n).toBe(3);
    // RT: modo de testes registra esperado × observado sem ativar produção
    const rt = await loginAs(app, 'rt');
    expect((await rt.post('/api/admin/lifescore/tests', { caseCode: 'SIM8-01', expected: '100,00', observed: '100,00', status: 'APROVADO', assessmentId: pub.id })).status).toBe(200);
    expect((await rt.get('/api/admin/lifescore')).body.release).toBeNull();
  });
});
