/**
 * ONEMA Life Score — núcleo determinístico do modelo OLS-8-HOM-0.1 (especificação v0.4).
 * Substitui o modelo de 24 itens (v1.6) para novas avaliações; registros v1.6 ficam arquivados e não são recalculados.
 * Índice DESCRITIVO 0–100 a partir das oito respostas confirmadas pela enfermeira. Sem faixas, cores clínicas ou rótulos
 * derivados do total; sem gatilho de queda; sem prazo de retorno derivado da nota.
 */
import crypto from 'node:crypto';
import { BLOCKING, MODEL8 } from './model8.ts';
import { sha256, stableJson } from '../../lib/util.ts';

export const model: any = MODEL8;
export const modelHash = sha256(stableJson(MODEL8));
/** Liberação operacional vale para este build: mudar cálculo, modelo ou regras exige novo valor e nova liberação do RT. */
export const LIFESCORE_BUILD = `ONEMA-APP-LS-8-0.4+${modelHash.slice(0, 12)}`;
export const LEGACY_MODEL_ID = 'OLS-DESC-ITEM24-1.0';

const text = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
const iso = (x: unknown) => text(x) && /(Z|[+-]\d\d:\d\d)$/.test(x) && Number.isFinite(Date.parse(x));
/** Precisão interna total; arredonda só a exibição (duas casas). */
export const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

export interface Registry { model: any; modelHash: string; operationalRelease?: any }
export const registry = (operationalRelease?: any): Registry => ({ model, modelHash, operationalRelease });

/** Contexto que torna duas avaliações comparáveis (tarefas, atividades e executor do plano). */
export function contextSignature(responses: Record<string, any>) {
  const c = (id: string) => responses?.[id]?.context ?? {};
  return stableJson({ model: MODEL8.model_id, task: String(c('A1').task ?? '').trim().toLowerCase(),
    activities: [...(c('A2').activities ?? [])].map((x: string) => x.trim().toLowerCase()).sort(), executor: c('K1').executor ?? null });
}

export function evaluate(p: any, reg: Registry) {
  const issues: any[] = [], review: any[] = [];
  const result: any = {
    model_id: MODEL8.model_id, model_hash: reg.modelHash, patient_id: p.patient_id, encounter_id: p.encounter_id, episode_id: p.episode_id,
    assessment_id: p.assessment_id, assessed_at: p.assessed_at, calculation_status: 'NOT_CALCULABLE', raw_score: null, score_display: null,
    domain_scores: {}, contributions: {}, issues, review, context_signature: contextSignature(p.responses ?? {}),
    safety: { professional: null as any, note: 'Preocupação de segurança é registro profissional independente; total alto não encerra pendência.' },
    interpretation: 'DESCRIPTIVE_INDEX_NOT_A_HEALTH_PERCENTAGE', clinical_validated: false,
  };
  if (!['patient_id', 'encounter_id', 'assessment_id'].every((f) => text(p[f])) || !iso(p.assessed_at)) issues.push({ code: 'IDENTIFIED_CONTEXT_REQUIRED' });
  if (p.model_id !== MODEL8.model_id || p.model_hash !== reg.modelHash) issues.push({ code: 'MODEL_MISMATCH' });
  const release = reg.operationalRelease;
  const productionAllowed = p.environment === 'PRODUCTION' && p.synthetic === false && release?.verified === true &&
    release.scope === 'DESCRIPTIVE_PROFESSIONAL_RECORD_ONLY' && release.model_hash === reg.modelHash && release.model_id === MODEL8.model_id;
  result.descriptive_production_authorized = productionAllowed;
  if (!productionAllowed && !(p.environment === 'HOMOLOGATION' && p.synthetic === true)) issues.push({ code: 'OPERATIONAL_RELEASE_REQUIRED_FOR_REAL_RECORDS' });
  const responses = p.responses ?? {};
  const known = new Set(MODEL8.items.map((i) => i.item_id as string));
  for (const iid of Object.keys(responses)) if (!known.has(iid)) issues.push({ code: 'UNKNOWN_ITEM', item_id: iid });
  if (p.professional_safety_event) result.safety.professional = p.professional_safety_event;

  const fractions: Record<string, number | null> = {};
  for (const it of MODEL8.items) {
    const r = responses[it.item_id];
    const c = r?.code;
    fractions[it.item_id] = null;
    if (!r || !c) { issues.push({ code: 'NOT_ASSESSED', item_id: it.item_id }); continue; }
    if (c in BLOCKING) { issues.push({ code: 'BLOCKED_RESPONSE', item_id: it.item_id, response_code: c }); continue; }
    if (!(c in MODEL8.fractions)) { issues.push({ code: 'INVALID_RESPONSE', item_id: it.item_id, response_code: c }); continue; }
    const ctx = r.context ?? {};
    const needs = (it as any).context;
    const ctxOk = !needs || (needs === 'TASK' && text(ctx.task)) || (needs === 'ACTIVITIES' && Array.isArray(ctx.activities) && ctx.activities.some(text))
      || (needs === 'EXECUTOR' && ['PACIENTE', 'CUIDADOR', 'AMBOS'].includes(ctx.executor))
      || (needs === 'OBJECTS' && (ctx.noneConfirmed === true || (Array.isArray(ctx.objects) && ctx.objects.length > 0)))
      || (needs === 'WOUND' && typeof ctx.wound === 'boolean');
    if (!ctxOk) { issues.push({ code: 'CONTEXT_REQUIRED', item_id: it.item_id }); continue; }
    if (c === 'R0' && !text(r.rationale)) { issues.push({ code: 'RATIONALE_REQUIRED', item_id: it.item_id }); continue; }
    if (c === 'R0' && (MODEL8.review_r0 as readonly string[]).includes(it.item_id)) review.push({ item_id: it.item_id, automatic_urgency: false });
    fractions[it.item_id] = MODEL8.fractions[c];
  }
  let total = 0, complete = true;
  for (const d of MODEL8.domains) {
    const ids = MODEL8.items.filter((i) => i.domain === d.code).map((i) => i.item_id as string);
    const fs = ids.map((i) => fractions[i]);
    for (const i of ids) if (fractions[i] != null) result.contributions[i] = (d.weight / 2) * (fractions[i] as number);
    // Domínio só tem resultado com os dois itens completos (exibido como parcial se o global estiver indisponível).
    if (fs.every((f) => f != null)) {
      result.domain_scores[d.code] = ((fs[0]! + fs[1]!) / 2) * 100;
      total += ids.reduce((a, i) => a + result.contributions[i], 0);
    } else { result.domain_scores[d.code] = null; complete = false; }
  }
  if (!issues.length && complete) {
    result.raw_score = total;
    result.score_display = round2(total);
    result.calculation_status = 'CALCULABLE_DESCRIPTIVE';
  }
  return result;
}

/** Comparação só entre o mesmo paciente, modelo e contexto equivalente (tarefas/atividades/executor). Sem inferir melhora ou piora. */
export function compareAssessments(a: any, b: any) {
  const reasons: string[] = [];
  if (!a || !b || a.model_id !== b.model_id) reasons.push('DIFFERENT_MODEL');
  if (a?.patient_id !== b?.patient_id) reasons.push('DIFFERENT_PATIENT');
  if (a?.context_signature !== b?.context_signature) reasons.push('DIFFERENT_CONTEXT');
  if (a?.calculation_status !== 'CALCULABLE_DESCRIPTIVE' || b?.calculation_status !== 'CALCULABLE_DESCRIPTIVE') reasons.push('INCOMPLETE');
  if (reasons.length) return { status: 'NOT_COMPARABLE', reasons, delta: null };
  return { status: 'DESCRIPTIVE_COMPARISON_ONLY', delta: round2(b.raw_score - a.raw_score), clinical_improvement_inferred: false, clinical_deterioration_inferred: false };
}

// ---------- Liberação operacional (release.mjs): integridade por HMAC, só no servidor ----------
const REQUIRED = ['model_id', 'model_hash', 'app_build', 'uat_report_ref', 'rt_approval_ref', 'approved_by', 'approved_at'];
const validRelease = (r: any) => r && r.scope === 'DESCRIPTIVE_PROFESSIONAL_RECORD_ONLY' && REQUIRED.every((k) => typeof r[k] === 'string' && r[k].trim()) &&
  Number.isFinite(Date.parse(r.approved_at)) && !r.revoked_at;
const secretCheck = (s: string) => { if (typeof s !== 'string' || Buffer.byteLength(s) < 32) throw new Error('SERVER_SECRET_MINIMUM_32_BYTES_REQUIRED'); };
const mac = (payload: string, secret: string) => crypto.createHmac('sha256', secret).update(payload).digest('hex');

export function signOperationalRelease(record: any, secret: string) {
  secretCheck(secret);
  if (!validRelease(record)) throw new Error('INCOMPLETE_OPERATIONAL_RELEASE');
  const copy = { ...record }; delete copy.verified;
  const payload = JSON.stringify(copy);
  return { payload, signature: mac(payload, secret) };
}
export function verifyOperationalRelease(envelope: any, secret: string, currentAppBuild: string) {
  secretCheck(secret);
  if (typeof envelope?.payload !== 'string' || !/^[a-f0-9]{64}$/.test(envelope?.signature ?? '')) return null;
  const expected = Buffer.from(mac(envelope.payload, secret), 'hex'), actual = Buffer.from(envelope.signature, 'hex');
  if (!crypto.timingSafeEqual(expected, actual)) return null;
  let record: any; try { record = JSON.parse(envelope.payload); } catch { return null; }
  if (!validRelease(record) || record.app_build !== currentAppBuild) return null;
  return { ...record, verified: true };
}
