/**
 * Life Score — persistência, publicação, plano humano e lembretes PRIME.
 * Regras (Comando de integração 09/11/2026 + pacote v1.6):
 *  - O servidor calcula só depois da confirmação da enfermeira; nada é inferido de texto livre ou sinal vital.
 *  - Rascunho e prévia nunca aparecem ao paciente; publicada é imutável (retificação cria nova versão).
 *  - Preocupação de segurança é salva antes e independentemente do score.
 *  - Registros reais exigem liberação operacional assinada no servidor; contas fictícias (@exemplo.test) rodam em homologação.
 *  - Plano é decisão da enfermeira (sem pré-seleção pela nota). Lembretes: PRIME ativo + canal autorizado, D-7, D e D+7 às 9h.
 */
import { all, one, run } from '../../db/db.ts';
import { audit } from '../../lib/audit.ts';
import { sendEmail, emailConfigured } from '../../lib/email.ts';
import { hmac } from '../../lib/security.ts';
import { nowIso, uid } from '../../lib/util.ts';
import { notify } from '../prime/core.ts';
import { primeActive } from '../care/report-share.ts';
import { LIFESCORE_BUILD, compareAssessments, evaluate, model, modelHash, registry, signOperationalRelease, verifyOperationalRelease } from './core.ts';

export const RESPONSE_CODES = ['L0', 'L1', 'L2', 'L3', 'L4', 'NA', 'ND', 'QI', 'RECUSA', 'DESCONHECIDO'] as const;
export const DISCLAIMER = 'Índice descritivo ONEMA calculado a partir da avaliação profissional. Não representa percentual de saúde nem determina conduta.';
export const TASK_SET_ID = 'ONEMA-LS-TAREFAS-24-v1';
const CONTEXT = (modality: string) => `ONEMA-LS-CONTEXTO-${modality === 'REMOTO' ? 'REMOTO' : 'DOMICILIAR'}-v1`;
const EPISODE = (patientId: string) => `ACOMPANHAMENTO-${patientId}`;

export const DOMAIN_INFO: Record<string, { name: string; plain: string }> = {
  D01: { name: 'Condição clínica atual', plain: 'Sintomas, sinais e dor avaliados pela enfermeira neste atendimento.' },
  D02: { name: 'Capacidade funcional', plain: 'Como a pessoa realiza atividades do dia a dia, com ou sem ajuda.' },
  D03: { name: 'Pele, feridas e dispositivos', plain: 'Situação de pele, feridas e dispositivos, quando existirem.' },
  D04: { name: 'Medicamentos e autocuidado', plain: 'Uso de medicamentos e cuidados combinados.' },
  D06: { name: 'Apoio e ambiente', plain: 'Rede de apoio e condições do ambiente para o cuidado.' },
  D07: { name: 'Necessidades de cuidado atendidas', plain: 'Se o que foi combinado no cuidado está sendo atendido.' },
};
export const ISSUE_LABEL: Record<string, string> = {
  NOT_ASSESSED: 'Item não avaliado', MISSING_OR_INELIGIBLE: 'Resposta ausente, recusada, desconhecida ou de qualidade inadequada',
  NA_NOT_ALLOWED_OR_NOT_JUSTIFIED: 'Não se aplica sem permissão ou sem justificativa', INSUFFICIENT_DOMAIN: 'Domínio com itens aplicáveis insuficientes',
  OPERATIONAL_RELEASE_REQUIRED_FOR_REAL_RECORDS: 'Cálculo em registros reais aguardando a liberação operacional do RT',
  UNVERIFIED_OR_WRONG_CONTEXT: 'Resposta sem confirmação ou de outro atendimento', MODEL_MISMATCH: 'Versão do modelo diferente',
  IDENTIFIED_CONTEXT_REQUIRED: 'Contexto do atendimento incompleto', INVALID_SAFETY_EVENT: 'Evento de segurança inválido', UNKNOWN_ITEM: 'Item desconhecido',
};

// ---------------- Configuração: suspensão e liberação ----------------
const releaseSecret = () => hmac('lifescore-operational-release-v1');
export async function settingsState() {
  const row = await one<any>(`SELECT value FROM system_settings WHERE key = 'lifescore_suspension'`);
  const s = row ? JSON.parse(row.value) : {};
  return { calcSuspended: !!s.calc, remindersSuspended: !!s.reminders, reason: s.reason ?? null, at: s.at ?? null };
}
export async function setSuspension(actorId: string, b: { calc: boolean; reminders: boolean; reason: string }, correlationId: string) {
  const value = JSON.stringify({ calc: b.calc, reminders: b.reminders, reason: b.reason, by: actorId, at: nowIso() });
  await run(`INSERT INTO system_settings (key, value, created_at) VALUES ('lifescore_suspension', ?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, value, nowIso());
  await audit({ actorId, action: 'LIFESCORE_SUSPENSION_CHANGED', subjectType: 'lifescore', subjectId: 'config', correlationId, meta: { calc: b.calc, reminders: b.reminders, reason: b.reason } });
}
export async function currentRelease() {
  const r = await one<any>('SELECT * FROM lifescore_releases WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1');
  if (!r) return null;
  const v = verifyOperationalRelease({ payload: r.payload, signature: r.signature }, releaseSecret(), LIFESCORE_BUILD);
  return v ? { ...v, id: r.id } : null;
}
export async function registerRelease(actorId: string, b: { uatReportRef: string; rtApprovalRef: string }, correlationId: string) {
  const u = (await one<any>('SELECT name FROM users WHERE id = ?', actorId))!;
  const record = { scope: 'DESCRIPTIVE_PROFESSIONAL_RECORD_ONLY', model_id: model.model_id, model_hash: modelHash, app_build: LIFESCORE_BUILD,
    uat_report_ref: b.uatReportRef, rt_approval_ref: b.rtApprovalRef, approved_by: `${u.name} (${actorId})`, approved_at: nowIso(),
    clinical_validated: false, diagnostic_or_treatment_use_authorized: false };
  const env = signOperationalRelease(record, releaseSecret());
  const id = uid();
  await run('INSERT INTO lifescore_releases (id, payload, signature, created_by, created_at) VALUES (?,?,?,?,?)', id, env.payload, env.signature, actorId, nowIso());
  await audit({ actorId, action: 'LIFESCORE_RELEASE_REGISTERED', subjectType: 'lifescore_release', subjectId: id, correlationId, meta: { uat: b.uatReportRef, rt: b.rtApprovalRef, build: LIFESCORE_BUILD } });
  return id;
}
export async function revokeRelease(actorId: string, reason: string, correlationId: string) {
  const r = await run('UPDATE lifescore_releases SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE revoked_at IS NULL', nowIso(), actorId, reason);
  await audit({ actorId, action: 'LIFESCORE_RELEASE_REVOKED', subjectType: 'lifescore', subjectId: 'release', correlationId, meta: { reason, count: r.changes } });
  return r.changes;
}

// ---------------- Avaliação ----------------
export async function isSynthetic(patientId: string) {
  const u = await one<any>('SELECT email FROM users WHERE id = ?', patientId);
  return /@exemplo\.test$/i.test(u?.email ?? '');
}

/** Monta a entrada do núcleo a partir do rascunho (as respostas só valem como confirmadas na finalização/prévia). */
export async function buildPayload(a: any, assessedAt: string) {
  const responses: Record<string, any> = {};
  const stored = JSON.parse(a.responses_json || '{}');
  const evo = await one<any>('SELECT id FROM care_evolutions WHERE event_id = ?', a.event_id);
  const refs = [`atendimento:${a.event_id}`, ...(evo ? [`evolucao:${evo.id}`] : [])];
  for (const [itemId, r] of Object.entries<any>(stored)) {
    if (!r || r.code === 'ND') continue;
    const quality = ['L0', 'L1', 'L2', 'L3', 'L4', 'NA'].includes(r.code) ? 'ELIGIBLE' : r.code === 'QI' ? 'INADEQUATE' : 'NOT_ELIGIBLE';
    responses[itemId] = { patient_id: a.patient_id, encounter_id: a.event_id, professional_id: a.specialist_id, assessed_at: assessedAt,
      verified: true, source_refs: refs, response_code: r.code, quality, na_reason: r.naReason ?? undefined, rationale: r.rationale ?? undefined };
  }
  const safety = await one<any>(`SELECT * FROM lifescore_safety_events WHERE event_id = ? AND specialist_id = ? AND occurred_at <= ? ORDER BY CASE level WHEN 'IMMEDIATE' THEN 0 ELSE 1 END, occurred_at DESC LIMIT 1`,
    a.event_id, a.specialist_id, assessedAt);
  return {
    environment: a.environment, synthetic: !!a.synthetic, patient_id: a.patient_id, episode_id: a.episode_id, encounter_id: a.event_id,
    professional_id: a.specialist_id, assessment_id: a.id, assessed_at: assessedAt, task_set_id: a.task_set_id, measurement_context_id: a.measurement_context_id,
    model_id: a.model_id, model_hash: a.model_hash, responses,
    professional_safety_event: safety ? { patient_id: a.patient_id, encounter_id: a.event_id, professional_id: a.specialist_id, verified: true,
      level: safety.level, reason: safety.reason, occurred_at: safety.occurred_at } : undefined,
  };
}

export async function runEvaluation(a: any, assessedAt = nowIso()) {
  return evaluate(await buildPayload(a, assessedAt), registry(await currentRelease()));
}

/** Resultado em linguagem da tela (sem códigos crus). */
export function resultView(r: any) {
  return {
    calculable: r.calculation_status === 'CALCULABLE_DESCRIPTIVE', score: r.score_display, rawScore: r.raw_score,
    domains: Object.entries(r.domain_scores ?? {}).map(([d, v]) => ({ code: d, name: DOMAIN_INFO[d]?.name ?? d, plain: DOMAIN_INFO[d]?.plain ?? '', score: v == null ? null : Math.round(Number(v) * 100) / 100 })),
    issues: (r.issues ?? []).map((i: any) => ({ ...i, label: ISSUE_LABEL[i.code] ?? i.code })),
    safety: r.safety, modelId: r.model_id, modelHash: r.model_hash, productionAuthorized: r.descriptive_production_authorized, disclaimer: DISCLAIMER,
  };
}

export async function newDraft(e: any, specialistId: string, supersedes?: any) {
  const synthetic = await isSynthetic(e.patient_id);
  const id = uid(); const now = nowIso();
  await run(`INSERT INTO lifescore_assessments (id, patient_id, event_id, order_id, specialist_id, model_id, model_hash, app_build, episode_id, task_set_id, measurement_context_id,
      environment, synthetic, status, responses_json, supersedes_id, rectification_reason, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, e.patient_id, e.id, e.order_id, specialistId, model.model_id, modelHash, LIFESCORE_BUILD, EPISODE(e.patient_id), TASK_SET_ID, CONTEXT(e.modality),
    synthetic ? 'HOMOLOGATION' : 'PRODUCTION', synthetic ? 1 : 0, 'RASCUNHO', supersedes?.responses_json ?? '{}', supersedes?.id ?? null, supersedes?.reason ?? null, now, now);
  return id;
}

// ---------------- Plano e lembretes ----------------
const SP = 'America/Sao_Paulo';
const spDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: SP, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const spHour = (d = new Date()) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: SP, hour: '2-digit', hourCycle: 'h23' }).format(d));
/** 09h de São Paulo (UTC-3, sem horário de verão desde 2019) de uma data AAAA-MM-DD. */
const at9 = (date: string) => new Date(`${date}T09:00:00-03:00`).toISOString();
const addDays = (date: string, n: number) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** Programa até três contatos; não envia retroativos. No próprio dia após 9h, usa o próximo horário permitido (até 18h). */
export async function scheduleReminders(assessmentId: string, patientId: string, planDate: string, now = new Date()) {
  const today = spDate(now);
  let n = 0;
  for (const wave of [-7, 0, 7]) {
    const day = addDays(planDate, wave);
    let when = at9(day);
    if (day < today) continue;
    if (day === today && new Date(when) <= now) {
      if (spHour(now) >= 18) continue;
      when = new Date(now.getTime() + 60_000).toISOString();
    }
    await run(`INSERT INTO lifescore_reminders (id, assessment_id, patient_id, plan_date, wave, scheduled_at, status, updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT (assessment_id, wave) DO NOTHING`, uid(), assessmentId, patientId, planDate, wave, when, 'PROGRAMADO', nowIso());
    n++;
  }
  return n;
}
export async function cancelReminders(assessmentId: string, reason: string) {
  return (await run(`UPDATE lifescore_reminders SET status = 'CANCELADO', status_reason = ?, updated_at = ? WHERE assessment_id = ? AND status IN ('PROGRAMADO','FALHOU')`,
    reason, nowIso(), assessmentId)).changes;
}
export async function setPlanStatus(a: any, status: string, reason: string) {
  await run('UPDATE lifescore_assessments SET plan_status = ?, plan_status_at = ?, updated_at = ? WHERE id = ?', status, nowIso(), nowIso(), a.id);
  await cancelReminders(a.id, reason);
}

/** Agendamento: um pedido pago depois da publicação encerra o convite (e os lembretes) daquele plano. */
export async function syncScheduling(patientId: string) {
  const plans = await all<any>(`SELECT a.* FROM lifescore_assessments a WHERE a.patient_id = ? AND a.status = 'PUBLICADA' AND a.plan_status = 'VIGENTE' AND a.plan_kind = 'RETORNO'
    AND EXISTS (SELECT 1 FROM service_orders o WHERE o.patient_id = a.patient_id AND o.status = 'PAID' AND o.paid_at > a.published_at)`, patientId);
  for (const p of plans) await setPlanStatus(p, 'AGENDADO', 'Atendimento solicitado e pago após o plano.');
  return plans.length;
}

const REMINDER_TEXT = 'Está chegando a data prevista para o seu acompanhamento de enfermagem. Quando quiser, solicite o atendimento em Meu acompanhamento.';

/** Fila de lembretes (rotina de hora em hora). Rechecagem de elegibilidade imediatamente antes de cada envio. */
export async function runLifescoreReminders(now = new Date()) {
  const out = { sent: 0, skipped: 0, cancelled: 0, failed: 0 };
  if ((await settingsState()).remindersSuspended) return out;
  const due = await all<any>(`SELECT id FROM lifescore_reminders WHERE (status = 'PROGRAMADO' AND scheduled_at <= ?) OR (status = 'FALHOU' AND next_attempt_at <= ? AND attempts < 3) ORDER BY scheduled_at LIMIT 100`,
    now.toISOString(), now.toISOString());
  for (const { id } of due) {
    // Reserva atômica: só um processo pega cada contato.
    const claimed = await one<any>(`UPDATE lifescore_reminders SET status = 'EM_PROCESSAMENTO', updated_at = ? WHERE id = ? AND status IN ('PROGRAMADO','FALHOU') RETURNING *`, nowIso(), id);
    if (!claimed) continue;
    const a = (await one<any>('SELECT * FROM lifescore_assessments WHERE id = ?', claimed.assessment_id))!;
    await syncScheduling(a.patient_id);
    const cur = (await one<any>('SELECT * FROM lifescore_assessments WHERE id = ?', a.id))!;
    const finish = (status: string, reason: string) => run('UPDATE lifescore_reminders SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?', status, reason, nowIso(), id);
    if (cur.status !== 'PUBLICADA' || cur.plan_status !== 'VIGENTE' || cur.reminders_opt_out) {
      await finish('CANCELADO', cur.reminders_opt_out ? 'Paciente recusou os lembretes.' : `Plano ${cur.plan_status ?? 'substituído'}.`); out.cancelled++; continue;
    }
    // Sem PRIME ou sem canal autorizado neste momento: este contato não sai (ativação tardia vale para os próximos).
    const pref = await one<any>(`SELECT * FROM communication_preferences WHERE patient_id = ? AND purpose = 'LEMBRETES'`, a.patient_id);
    if (!(await primeActive(a.patient_id)) || !pref?.enabled || !(pref.channel_app || pref.channel_email)) {
      await finish('PULADO', !pref?.enabled ? 'Lembretes desativados nas preferências.' : 'Sem PRIME ativo no momento do envio.'); out.skipped++; continue;
    }
    try {
      let appSent = claimed.app_sent_at;
      if (pref.channel_app && !appSent) {
        await notify(a.patient_id, 'LEMBRETE', 'Acompanhamento de enfermagem', REMINDER_TEXT);
        appSent = nowIso();
        await run('UPDATE lifescore_reminders SET app_sent_at = ? WHERE id = ?', appSent, id);
      }
      let emailStatus = claimed.email_status;
      if (pref.channel_email && emailConfigured() && emailStatus !== 'ACEITO_PELO_PROVEDOR') {
        const u = (await one<any>('SELECT email FROM users WHERE id = ?', a.patient_id))!;
        const r = await sendEmail({ to: u.email, subject: 'ONEMA SAÚDE: seu acompanhamento', text: `${REMINDER_TEXT}\n\nhttps://onemasaude.com.br/acompanhamento`, html: `<p>${REMINDER_TEXT}</p>` });
        emailStatus = r.sent ? 'ACEITO_PELO_PROVEDOR' : 'FALHOU';
        if (!r.sent) throw new Error(`EMAIL_${r.error}`);
      }
      await run(`UPDATE lifescore_reminders SET status = 'ENVIADO', email_status = ?, attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE id = ?`, emailStatus ?? null, nowIso(), id);
      out.sent++;
      if (claimed.wave === 7) await run(`UPDATE lifescore_assessments SET plan_status = 'ENCERRADO_SEM_RESPOSTA', plan_status_at = ?, updated_at = ? WHERE id = ? AND plan_status = 'VIGENTE'`, nowIso(), nowIso(), a.id);
    } catch (e: any) {
      const attempts = claimed.attempts + 1;
      // Retentativa técnica: até 3 em 24 h (intervalos crescentes); não cria contato extra.
      const next = attempts < 3 ? new Date(now.getTime() + [15, 120, 480][attempts - 1] * 60_000).toISOString() : null;
      await run(`UPDATE lifescore_reminders SET status = 'FALHOU', attempts = ?, next_attempt_at = ?, last_error = ?, email_status = 'FALHOU', updated_at = ? WHERE id = ?`,
        attempts, next, String(e?.message ?? 'erro').slice(0, 200), nowIso(), id);
      out.failed++;
    }
  }
  return out;
}

// ---------------- Visões ----------------
export async function historyFor(patientId: string, opts: { includeRetified?: boolean } = {}) {
  const rows = await all<any>(`SELECT a.*, u.name AS specialist_name FROM lifescore_assessments a JOIN users u ON u.id = a.specialist_id
    WHERE a.patient_id = ? AND a.status IN ('PUBLICADA'${opts.includeRetified ? ",'RETIFICADA'" : ''}) ORDER BY a.published_at DESC LIMIT 100`, patientId);
  const items = rows.map((a) => {
    const r = JSON.parse(a.result_json);
    return { id: a.id, status: a.status, publishedAt: a.published_at, specialist: a.specialist_name, score: a.score_display, result: r,
      domains: resultView(r).domains, summary: a.patient_summary, interpretation: a.interpretation,
      plan: { kind: a.plan_kind, date: a.plan_date, justification: a.plan_justification, status: a.plan_status, remindersOptOut: !!a.reminders_opt_out },
      rectificationReason: a.rectification_reason, supersedesId: a.supersedes_id };
  });
  // Comparação só entre avaliações publicadas consecutivas e equivalentes (mesmo modelo, contexto e composição).
  const pub = items.filter((i) => i.status === 'PUBLICADA');
  for (let k = 0; k < pub.length - 1; k++) {
    const c = compareAssessments(pub[k + 1].result, pub[k].result);
    (pub[k] as any).comparison = c.status === 'DESCRIPTIVE_COMPARISON_ONLY'
      ? { comparable: true, delta: c.delta, note: 'Diferença descritiva entre avaliações equivalentes. Não indica melhora ou piora por si só.' }
      : { comparable: false, note: 'Esta avaliação e a anterior não são diretamente comparáveis (itens ou contexto diferentes).' };
  }
  return items.map(({ result: _r, ...rest }) => rest);
}

export const modelView = () => ({
  modelId: model.model_id, modelHash, build: LIFESCORE_BUILD, disclaimer: DISCLAIMER, weights: model.global_weights, minApplicable: model.domain_min_applicable,
  domains: Object.keys(model.global_weights).map((d) => ({ code: d, ...DOMAIN_INFO[d], weight: Number(model.global_weights[d]), min: model.domain_min_applicable[d],
    items: model.items.filter((i: any) => i.domain === d).map((i: any) => ({ id: i.item_id, name: i.name, question: i.question, allowNa: !!i.allow_na, naCondition: i.na_condition,
      anchors: Object.fromEntries(Object.entries<any>(i.response_anchors).map(([k, v]) => [k, { points: v.points, description: v.description }])) })) })),
});
