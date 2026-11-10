/**
 * ONEMA Life Score v1.6 — núcleo determinístico (porte fiel de src/core.mjs e src/release.mjs do pacote).
 * Modelo ativo: OLS-DESC-ITEM24-1.0 (tabela de 24 itens; SHA-256 conferido na carga).
 * Índice DESCRITIVO de 0 a 100 a partir de respostas confirmadas pela enfermeira. Não é percentual de saúde,
 * diagnóstico, risco ou prognóstico; não decide conduta nem retorno.
 */
import crypto from 'node:crypto';
import modelJson from './model-OLS-DESC-ITEM24-1.0.json';

export const MODEL_FILE_SHA256 = 'c14a255e85cd390598153af5c14381b7011ce524913572eff9913f9698d4fa90';
export const model: any = modelJson;
/** Hash do modelo = SHA-256 dos bytes do arquivo de configuração (o JSON importado é re-serializado; o hash fixo foi conferido no teste). */
export const modelHash = MODEL_FILE_SHA256;
/**
 * Identidade da integração do Life Score. A liberação operacional vale para este "build" do módulo:
 * mudar o código de cálculo, o modelo ou as regras de publicação exige trocar este valor e nova liberação do RT.
 */
export const LIFESCORE_BUILD = `ONEMA-APP-LS-1.0+${MODEL_FILE_SHA256.slice(0, 12)}`;

const text = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
const iso = (x: unknown) => text(x) && /(Z|[+-]\d\d:\d\d)$/.test(x) && Number.isFinite(Date.parse(x));
const round = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;
const key = (xs: unknown) => JSON.stringify(xs);
const contextMatches = (p: any, e: any) => e && e.patient_id === p.patient_id && e.encounter_id === p.encounter_id && e.professional_id === p.professional_id;
const evidence = (e: any) => Array.isArray(e?.source_refs) && e.source_refs.length > 0 && e.source_refs.every(text);

export interface Registry { model: any; modelHash: string; operationalRelease?: any }
export const registry = (operationalRelease?: any): Registry => ({ model, modelHash, operationalRelease });

export function evaluate(p: any, reg: Registry) {
  const { model: m, modelHash: mh } = reg;
  const issues: any[] = [], immediate: any[] = [], priority: any[] = [], review: any[] = [];
  const result: any = {
    package_version: '1.6', model_id: m.model_id, model_hash: mh,
    patient_id: p.patient_id, encounter_id: p.encounter_id, episode_id: p.episode_id,
    assessment_id: p.assessment_id, assessed_at: p.assessed_at,
    task_set_id: p.task_set_id, measurement_context_id: p.measurement_context_id,
    calculation_status: 'NOT_CALCULABLE', raw_score: null, score_display: null,
    domain_scores: {}, applicability_signature: [], issues,
    safety: { level: 'UNDETERMINED', immediate, priority, review },
    clinical_validated: false, diagnostic_or_treatment_use_authorized: false, patient_publication_allowed: false,
    descriptive_production_authorized: false,
    patient_score: null, followup_days: null, clinical_band: null,
    interpretation: 'ORIGINAL_DESCRIPTIVE_RECORD_INDEX_NOT_A_HEALTH_PERCENTAGE',
  };
  const validContext = ['patient_id', 'encounter_id', 'episode_id', 'professional_id', 'assessment_id', 'task_set_id', 'measurement_context_id'].every((f) => text(p[f])) && iso(p.assessed_at);
  if (!validContext) issues.push({ code: 'IDENTIFIED_CONTEXT_REQUIRED' });
  if (p.model_id !== m.model_id || p.model_hash !== mh) issues.push({ code: 'MODEL_MISMATCH' });
  const release = reg.operationalRelease;
  const productionAllowed = p.environment === 'PRODUCTION' && p.synthetic === false && release?.verified === true &&
    release.scope === 'DESCRIPTIVE_PROFESSIONAL_RECORD_ONLY' && release.model_hash === mh &&
    release.model_id === m.model_id && text(release.app_build) && text(release.uat_report_ref) &&
    text(release.rt_approval_ref) && text(release.approved_by) && iso(release.approved_at);
  result.descriptive_production_authorized = productionAllowed;
  if (!productionAllowed && !(p.environment === 'HOMOLOGATION' && p.synthetic === true)) issues.push({ code: 'OPERATIONAL_RELEASE_REQUIRED_FOR_REAL_RECORDS' });
  const responses = p.responses ?? {};
  const known = new Set(m.items.map((i: any) => i.item_id));
  for (const iid of Object.keys(responses)) if (!known.has(iid)) issues.push({ code: 'UNKNOWN_ITEM', item_id: iid });
  const s = p.professional_safety_event;
  if (s) {
    if (validContext && contextMatches(p, s) && s.verified === true && text(s.reason) && iso(s.occurred_at) &&
        Date.parse(s.occurred_at) <= Date.parse(p.assessed_at) && ['IMMEDIATE', 'PRIORITY'].includes(s.level)) {
      (s.level === 'IMMEDIATE' ? immediate : priority).push({ source: 'PROFESSIONAL_EVENT', reason: s.reason });
    } else issues.push({ code: 'INVALID_SAFETY_EVENT' });
  }
  const sums: Record<string, number> = {}, counts: Record<string, number> = {};
  for (const d of Object.keys(m.global_weights)) { sums[d] = 0; counts[d] = 0; }
  let safetyCovered = true;
  for (const i of m.items) {
    const e = responses[i.item_id];
    const prefix = ['D01', 'D03'].includes(i.domain);
    if (!e) { issues.push({ code: 'NOT_ASSESSED', item_id: i.item_id }); if (prefix) safetyCovered = false; continue; }
    if (!validContext || !contextMatches(p, e) || e.verified !== true || !evidence(e) || !iso(e.assessed_at) ||
        Date.parse(e.assessed_at) > Date.parse(p.assessed_at)) {
      issues.push({ code: 'UNVERIFIED_OR_WRONG_CONTEXT', item_id: i.item_id }); if (prefix) safetyCovered = false; continue;
    }
    const c = e.response_code;
    const recognized = Object.hasOwn(i.response_anchors, c);
    // Sinal de segurança é preservado mesmo se a qualidade impedir o cálculo do item.
    if (prefix && c === 'L0') immediate.push({ source: 'ITEM', item_id: i.item_id });
    if (prefix && c === 'L1') priority.push({ source: 'ITEM', item_id: i.item_id });
    if (!prefix && ['L0', 'L1'].includes(c)) review.push({ source: 'ITEM', item_id: i.item_id, automatic_urgency: false });
    if (c === 'NA') {
      if (!i.allow_na || !text(e.na_reason) || e.quality !== 'ELIGIBLE') { issues.push({ code: 'NA_NOT_ALLOWED_OR_NOT_JUSTIFIED', item_id: i.item_id }); if (prefix) safetyCovered = false; }
      continue;
    }
    if (!recognized || e.quality !== 'ELIGIBLE') { issues.push({ code: 'MISSING_OR_INELIGIBLE', item_id: i.item_id, response_code: c }); if (prefix) safetyCovered = false; continue; }
    counts[i.domain]++;
    sums[i.domain] += Number(i.response_anchors[c].points);
    result.applicability_signature.push(i.item_id);
  }
  result.applicability_signature.sort();
  for (const d of Object.keys(sums)) {
    if (counts[d] < m.domain_min_applicable[d]) issues.push({ code: 'INSUFFICIENT_DOMAIN', domain: d });
    result.domain_scores[d] = counts[d] ? sums[d] / counts[d] : null;
  }
  result.safety.level = immediate.length ? 'IMMEDIATE' : priority.length ? 'PRIORITY'
    : !safetyCovered || issues.some((x) => ['INVALID_SAFETY_EVENT', 'MODEL_MISMATCH', 'IDENTIFIED_CONTEXT_REQUIRED'].includes(x.code)) ? 'UNDETERMINED' : 'NO_ITEM_TRIGGER_IDENTIFIED';
  result.safety.note = 'Ausência de gatilho não demonstra ausência de risco. Preocupação profissional independe do score.';
  if (!issues.length) {
    result.raw_score = Object.entries(m.global_weights).reduce((a, [d, w]) => a + Number(w) * result.domain_scores[d], 0);
    result.score_display = round(result.raw_score);
    result.calculation_status = 'CALCULABLE_DESCRIPTIVE';
  } else {
    // Não publicar médias parciais como domínios completos.
    result.domain_scores = {};
  }
  return result;
}

export function compareAssessments(a: any, b: any) {
  const reasons: string[] = [];
  for (const f of ['patient_id', 'episode_id', 'model_id', 'model_hash', 'task_set_id', 'measurement_context_id'])
    if (!text(a[f]) || a[f] !== b[f]) reasons.push('DIFFERENT_' + f.toUpperCase());
  if (a.assessment_id === b.assessment_id) reasons.push('SAME_ASSESSMENT');
  if (!iso(a.assessed_at) || !iso(b.assessed_at) || Date.parse(b.assessed_at) <= Date.parse(a.assessed_at)) reasons.push('INVALID_ORDER');
  if (a.calculation_status !== 'CALCULABLE_DESCRIPTIVE' || b.calculation_status !== 'CALCULABLE_DESCRIPTIVE') reasons.push('INCOMPLETE');
  if (key(a.applicability_signature) !== key(b.applicability_signature)) reasons.push('DIFFERENT_APPLICABILITY');
  if (reasons.length) return { status: 'NOT_COMPARABLE', reasons, delta: null };
  return { status: 'DESCRIPTIVE_COMPARISON_ONLY', delta: round(b.raw_score - a.raw_score),
    elapsed_hours: (Date.parse(b.assessed_at) - Date.parse(a.assessed_at)) / 3600000,
    clinical_improvement_inferred: false, clinical_deterioration_inferred: false,
    safety_before: a.safety.level, safety_after: b.safety.level };
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
