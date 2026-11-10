import fs from 'node:fs';
import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, emailOf, idOf, loginAs, one, run, setup } from './helpers.ts';
import { PRICING_V1 } from '../src/db/content/pricing-v1.ts';
import { MODEL_FILE_SHA256, compareAssessments, evaluate, model, registry, signOperationalRelease, verifyOperationalRelease } from '../src/modules/lifescore/core.ts';
import { runLifescoreReminders, scheduleReminders } from '../src/modules/lifescore/service.ts';

const CASES = JSON.parse(fs.readFileSync(new URL('./fixtures/lifescore_casos_fic.json', import.meta.url), 'utf8'));
const byId = (id: string) => structuredClone(CASES.find((c: any) => c.case_id === id).payload);

describe('Life Score — núcleo (bateria FIC do pacote v1.6)', () => {
  it('modelo íntegro e referências matemáticas: FIC01=100, FIC02=63,75, FIC03 sem número com prioridade, D07-I04 L3=99,06', () => {
    const bytes = fs.readFileSync(new URL('../src/modules/lifescore/model-OLS-DESC-ITEM24-1.0.json', import.meta.url));
    expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(MODEL_FILE_SHA256);
    expect(model.items).toHaveLength(24);
    const reg = registry();
    const f1 = evaluate(byId('FIC01'), reg);
    expect(f1.calculation_status).toBe('CALCULABLE_DESCRIPTIVE');
    expect(f1.score_display).toBe(100);
    expect(evaluate(byId('FIC02'), reg).score_display).toBe(63.75);
    const f3 = evaluate(byId('FIC03'), reg);
    expect(f3.score_display).toBeNull();
    expect(['IMMEDIATE', 'PRIORITY']).toContain(f3.safety.level);
    const v = byId('FIC01'); v.responses['D07-I04'].response_code = 'L3';
    expect(evaluate(v, reg).score_display).toBe(99.06);
    // U04/U05: item ausente ou NA indevido bloqueia; nunca zero
    const miss = byId('FIC01'); delete miss.responses['D01-I03'];
    expect(evaluate(miss, reg)).toMatchObject({ calculation_status: 'NOT_CALCULABLE', score_display: null });
    const na = byId('FIC01'); na.responses['D01-I01'].response_code = 'NA'; na.responses['D01-I01'].na_reason = 'x';
    expect(evaluate(na, reg).issues.map((i: any) => i.code)).toContain('NA_NOT_ALLOWED_OR_NOT_JUSTIFIED');
    // U06/U07: outro paciente ou modelo diferente
    const other = byId('FIC01'); other.responses['D02-I01'].patient_id = 'OUTRO';
    expect(evaluate(other, reg).calculation_status).toBe('NOT_CALCULABLE');
    expect(evaluate({ ...byId('FIC01'), model_hash: 'x' }, reg).issues.map((i: any) => i.code)).toContain('MODEL_MISMATCH');
    // U12: registro real sem liberação não calcula
    expect(evaluate({ ...byId('FIC01'), environment: 'PRODUCTION', synthetic: false }, reg).issues.map((i: any) => i.code)).toContain('OPERATIONAL_RELEASE_REQUIRED_FOR_REAL_RECORDS');
    // U08/U09: comparação descritiva apenas entre equivalentes
    const a = evaluate(byId('FIC01'), reg);
    const b2 = byId('FIC01'); b2.assessment_id = 'X2'; b2.assessed_at = '2026-11-10T12:00:00-03:00';
    for (const r of Object.values<any>(b2.responses)) r.assessed_at = b2.assessed_at;
    b2.responses['D07-I04'].response_code = 'L3';
    expect(compareAssessments(a, evaluate(b2, reg))).toMatchObject({ status: 'DESCRIPTIVE_COMPARISON_ONLY', delta: -0.94, clinical_improvement_inferred: false });
    expect(compareAssessments(a, evaluate({ ...b2, measurement_context_id: 'OUTRO' }, reg)).status).toBe('NOT_COMPARABLE');
  });

  it('U13: liberação adulterada ou de outro build é recusada', () => {
    const secret = 'x'.repeat(40);
    const rec = { scope: 'DESCRIPTIVE_PROFESSIONAL_RECORD_ONLY', model_id: 'm', model_hash: 'h', app_build: 'b1', uat_report_ref: 'u', rt_approval_ref: 'r', approved_by: 'a', approved_at: new Date().toISOString() };
    const env = signOperationalRelease(rec, secret);
    expect(verifyOperationalRelease(env, secret, 'b1')?.verified).toBe(true);
    expect(verifyOperationalRelease(env, secret, 'b2')).toBeNull();
    expect(verifyOperationalRelease({ ...env, payload: env.payload.replace('"u"', '"z"') }, secret, 'b1')).toBeNull();
  });
});

let app: FastifyInstance;
const NEED_OF = Object.fromEntries(PRICING_V1.map((d) => [d.code, d.need]));
async function accepted(patientKey: 'paciente' | 'responsavel' = 'paciente') {
  const c = new Client(app); await c.login(emailOf(patientKey));
  const form = { need: NEED_OF['CAT-01'], itemCode: 'CAT-01', infoText: '', materials: 'SIM', materialsDetail: '', materialsSupplyRequested: false,
    patientName: 'Paciente Fictício', phone: '(11) 99999-0000', location: 'Vila Mariana', whenPref: 'PROXIMOS_DIAS', whenDate: null, notes: '', forSelf: true, responsibleAuthorized: false };
  const req = (await c.post('/api/care/requests', form, true)).body.request;
  await c.post(`/api/care/requests/${req.id}/accept`, { quoteVersion: req.quoteVersion });
  await c.post(`/api/care/requests/${req.id}/checkout`, { quoteVersion: req.quoteVersion, paymentMethod: 'SANDBOX_APROVADO', expectedTotalCents: req.quote.totalCents }, true);
  const sp = new Client(app); await sp.login(emailOf('especialistaOne'));
  const ev = (await sp.get('/api/care/specialist/offers')).body.offers.find((o: any) => o.label);
  await sp.post(`/api/care/specialist/events/${ev.id}/accept`);
  return { c, sp, eventId: ev.id as string };
}
const ALL_L4 = Object.fromEntries(model.items.map((i: any) => [i.item_id, { code: 'L4', rationale: 'Avaliado no atendimento' }]));
const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

describe('Life Score — integração no app', () => {
  beforeEach(async () => { app = await setup(); });

  it('rascunho privado → prévia → publicação idempotente; paciente vê só o publicado; outra profissional não acessa; retificação preserva a original', async () => {
    const { c, sp, eventId } = await accepted();
    const base = `/api/care/specialist/events/${eventId}/lifescore`;
    // antes: card sem número
    expect((await c.get('/api/lifescore/me')).body).toMatchObject({ latest: null, emptyText: expect.stringMatching(/após uma avaliação/) });
    // preocupação de segurança salva sem score
    expect((await sp.post(`/api/care/specialist/events/${eventId}/safety-events`, { level: 'PRIORITY', reason: 'Queixa de tontura relatada.' })).status).toBe(200);
    // rascunho incompleto: não calculável com motivos (sem zero)
    const s1 = await sp.put(base, { revision: 0, responses: { 'D01-I01': { code: 'L4' } } });
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
    expect(ok.safety.level).toBe('PRIORITY'); // preocupação registrada é preservada acima do número
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
    const intruso = new Client(app); await intruso.login(emailOf('responsavel'));
    expect((await intruso.get('/api/lifescore/me')).body.latest).toBeNull();
    expect((await intruso.post(`/api/lifescore/me/${pub.body.id}/plan`, { action: 'RECUSAR_LEMBRETES' })).status).toBe(404);
    // publicada é imutável
    await expect(run(`UPDATE lifescore_assessments SET score_display = '1' WHERE id = ?`, pub.body.id)).rejects.toThrow(/immutable/);
    // retificação: nova versão; a original fica como RETIFICADA no histórico
    expect((await sp.post(`/api/lifescore/assessments/${pub.body.id}/rectify`, { reason: 'curto' })).status).toBe(400);
    expect((await sp.post(`/api/lifescore/assessments/${pub.body.id}/rectify`, { reason: 'Item D07-I04 registrado com nível errado.' })).status).toBe(200);
    const d = (await sp.get(base)).body.draft;
    const resp = { ...d.responses, 'D07-I04': { code: 'L3', rationale: 'Correção' } };
    const s3 = await sp.put(base, { revision: d.revision, responses: resp });
    const pub2 = await sp.post(`${base}/finalize`, { ...fin, revision: s3.body.revision, plan: { kind: 'SEM_RETORNO' } });
    expect(pub2.body.result.score).toBe(99.06);
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
    expect((await rt.get(`/api/admin/lifescore/assessments/${list.assessments[0].id}`)).body.assessment.responses['D01-I01'].code).toBe('L4');
    // suspensão pelo RT bloqueia novas pontuações sem apagar nada
    expect((await rt.post('/api/admin/lifescore/suspension', { calc: true, reminders: true, reason: 'Revisão do primeiro lote de 30.' })).body.calcSuspended).toBe(true);
    expect((await sp.put(base, { revision: 0, responses: ALL_L4 })).body.error.code).toBe('LIFESCORE_SUSPENDED');
    expect((await sp.post(`/api/care/specialist/events/${eventId}/safety-events`, { level: 'IMMEDIATE', reason: 'Dispneia importante.' })).status).toBe(200);
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
});
