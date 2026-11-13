/**
 * Carteira Digital — motor de alertas (especificação v1.0, aprovada pelo RT para desenvolvimento e homologação).
 * Famílias: LEMBRETE, CLINICO, ADMINISTRATIVO, TECNICO. Toda regra é versionada e só dispara com status APROVADA.
 * Regras CLÍNICAS exigem a matriz completa (dono, substituto, cobertura, prazos, escalonamento, deduplicação, teste)
 * e aprovação do RT; em produção ficam bloqueadas até CARTEIRA_CLINICAL_ALERTS_APPROVED.
 * Ciclo: PENDENTE → RECONHECIDO → EM_TRATAMENTO → RESOLVIDO/ENCERRADO. Entrega técnica ≠ leitura humana.
 * Falha de canal não encerra o alerta: gera pendência técnica (deduplicada por dia).
 */
import { all, one, run } from '../../db/db.ts';
import { config } from '../../config.ts';
import { audit } from '../../lib/audit.ts';
import { nowIso, uid } from '../../lib/util.ts';
import { notify } from '../prime/core.ts';

export interface RuleSeed {
  code: string; version: number; category: 'LEMBRETE' | 'CLINICO' | 'ADMINISTRATIVO' | 'TECNICO'; title: string; sourceProtocol: string | null; trigger: string;
  recipient: 'PACIENTE' | 'ENFERMEIRO' | 'RT' | 'OPERACAO' | 'TECNICA'; message: string; priority: 'BAIXA' | 'MEDIA' | 'ALTA'; ownerRole: string; substituteRole: string | null;
  coverage: string | null; ackHours: number | null; actionHours: number | null; escalateTo: string | null; channels: string[]; dedupe: string; testEvidence: string | null;
  status: 'RASCUNHO' | 'APROVADA';
}

/** Regras iniciais FICTÍCIAS (homologação). Não definem limiares clínicos. */
export const SEED_RULES: RuleSeed[] = [
  { code: 'LEM-PLANO-001', version: 1, category: 'LEMBRETE', title: 'Cuidado programado no plano', sourceProtocol: 'Plano de cuidados assinado',
    trigger: 'Tarefa do plano ATIVA com data nas próximas 24 h.', recipient: 'PACIENTE',
    message: 'Você tem um cuidado programado. Veja as orientações na sua Carteira Digital.', priority: 'BAIXA', ownerRole: 'OPERADOR_CENTRAL', substituteRole: 'AVALIADOR_RT',
    coverage: 'Dias úteis, 8h–18h (homologação)', ackHours: null, actionHours: null, escalateTo: null, channels: ['CARTEIRA', 'PUSH'],
    dedupe: 'Um lembrete por tarefa e data.', testEvidence: 'server/test/carteira.test.ts', status: 'APROVADA' },
  { code: 'ADM-PLANO-ATRASO-001', version: 1, category: 'ADMINISTRATIVO', title: 'Tarefa do plano sem confirmação', sourceProtocol: 'Plano de cuidados assinado',
    trigger: 'Tarefa ATIVA vencida há mais de 24 h sem confirmação do paciente.', recipient: 'ENFERMEIRO',
    message: 'Uma tarefa do plano de cuidados está vencida sem confirmação do paciente. Verifique e registre a providência.', priority: 'MEDIA',
    ownerRole: 'OPERADOR_CENTRAL', substituteRole: 'AVALIADOR_RT', coverage: 'Dias úteis, 8h–18h (homologação)', ackHours: 24, actionHours: 48, escalateTo: 'RT',
    channels: ['PAINEL'], dedupe: 'Um alerta por tarefa.', testEvidence: 'server/test/carteira.test.ts', status: 'APROVADA' },
  { code: 'CLI-FICT-001', version: 1, category: 'CLINICO', title: 'Resposta de acompanhamento "piorou" (FICTÍCIA)', sourceProtocol: null,
    trigger: 'Paciente responde "piorou" no acompanhamento de uma tarefa do plano.', recipient: 'ENFERMEIRO',
    message: 'O paciente informou piora no acompanhamento. Revise e registre a conduta.', priority: 'ALTA', ownerRole: 'AVALIADOR_RT', substituteRole: null,
    coverage: null, ackHours: 4, actionHours: 24, escalateTo: 'RT', channels: ['PAINEL'], dedupe: 'Um alerta por resposta.', testEvidence: null, status: 'RASCUNHO' },
  { code: 'TEC-CANAL-001', version: 1, category: 'TECNICO', title: 'Falha de entrega em canal externo', sourceProtocol: null,
    trigger: 'Entrega por canal externo (push) falhou ou o canal não está homologado.', recipient: 'TECNICA',
    message: 'Houve falha de entrega em canal externo. O alerta original continua pendente na Carteira e no painel.', priority: 'MEDIA',
    ownerRole: 'ADMIN_PRIME', substituteRole: 'OPERADOR_CENTRAL', coverage: 'Dias úteis (homologação)', ackHours: 24, actionHours: 72, escalateTo: null,
    channels: ['PAINEL'], dedupe: 'Um alerta técnico por canal e dia.', testEvidence: 'server/test/carteira.test.ts', status: 'APROVADA' },
];

export async function ensureAlertRules() {
  const now = nowIso();
  for (const r of SEED_RULES) {
    await run(`INSERT INTO alert_rules (code, version, category, title, source_protocol, trigger_desc, recipient, message, priority, owner_role, substitute_role, coverage,
      ack_hours, action_hours, escalate_to, channels_json, dedupe_desc, test_evidence, fictitious, status, approved_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?) ON CONFLICT (code, version) DO NOTHING`,
      r.code, r.version, r.category, r.title, r.sourceProtocol, r.trigger, r.recipient, r.message, r.priority, r.ownerRole, r.substituteRole, r.coverage,
      r.ackHours, r.actionHours, r.escalateTo, JSON.stringify(r.channels), r.dedupe, r.testEvidence, r.status, r.status === 'APROVADA' ? now : null, now);
  }
}

/** Campos obrigatórios da matriz mestre antes da ativação. */
export function ruleGaps(r: any): string[] {
  const gaps: string[] = [];
  if (!r.trigger_desc) gaps.push('gatilho');
  if (!r.message) gaps.push('mensagem aprovada');
  if (!r.owner_role) gaps.push('responsável');
  if (!r.dedupe_desc) gaps.push('deduplicação');
  if (!r.test_evidence) gaps.push('evidência de teste');
  if (r.category === 'CLINICO' || r.category === 'ADMINISTRATIVO') {
    if (!r.ack_hours || !r.action_hours) gaps.push('prazos de ciência e de ação');
    if (!r.escalate_to) gaps.push('escalonamento');
    if (!r.coverage) gaps.push('horário de cobertura e contingência');
  }
  if (r.category === 'CLINICO') {
    if (!r.substitute_role) gaps.push('substituto');
    if (!r.source_protocol) gaps.push('POP/protocolo de origem');
  }
  return gaps;
}

/** Regra vigente (maior versão APROVADA). Clínicas: bloqueadas fora de homologação sem autorização específica. */
export async function activeRule(code: string) {
  const r = await one<any>(`SELECT * FROM alert_rules WHERE code = ? AND status = 'APROVADA' ORDER BY version DESC LIMIT 1`, code);
  if (!r) return null;
  if (r.category === 'CLINICO' && config.appEnv === 'production' && process.env.CARTEIRA_CLINICAL_ALERTS_APPROVED !== '1') return null;
  if (ruleGaps(r).length) return null;
  return r;
}

export async function alertEvent(alertId: string, actorId: string | null, action: string, channel: string | null = null, note: string | null = null) {
  await run('INSERT INTO care_alert_events (id, alert_id, actor_id, action, channel, note, created_at) VALUES (?,?,?,?,?,?,?)', uid(), alertId, actorId, action, channel, note, nowIso());
}

const addH = (iso: string, h: number | null) => (h ? new Date(new Date(iso).getTime() + h * 3600_000).toISOString() : null);

/**
 * Cria o alerta (uma vez por chave de deduplicação) e registra as entregas por canal.
 * Notificação externa nunca leva dado clínico; entrega não é leitura.
 */
export async function raiseAlert(rule: any, p: { patientId: string | null; subjectType: string; subjectId: string; dedupeKey: string; assignedTo?: string | null; title?: string }) {
  const id = uid(); const now = nowIso();
  const r = await run(`INSERT INTO care_alerts (id, rule_code, rule_version, category, priority, patient_id, subject_type, subject_id, dedupe_key, recipient, owner_role, assigned_to, status,
      title, message, ack_due_at, action_due_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'PENDENTE',?,?,?,?,?,?) ON CONFLICT (dedupe_key) DO NOTHING`,
    id, rule.code, rule.version, rule.category, rule.priority, p.patientId, p.subjectType, p.subjectId, p.dedupeKey, rule.recipient, rule.owner_role, p.assignedTo ?? null,
    p.title ?? rule.title, rule.message, addH(now, rule.ack_hours), addH(now, rule.action_hours), now, now);
  if (!r.changes) return null; // duplicado: anti-fadiga
  await alertEvent(id, null, 'CRIADO');
  for (const ch of JSON.parse(rule.channels_json) as string[]) {
    if (ch === 'CARTEIRA' && p.patientId) {
      await notify(p.patientId, 'LEMBRETE', 'Cuidado programado', rule.message);
      await alertEvent(id, null, 'ENTREGUE', 'CARTEIRA');
    } else if (ch === 'PAINEL') {
      await alertEvent(id, null, 'ENTREGUE', 'PAINEL');
      if (p.assignedTo) await notify(p.assignedTo, 'ESSENCIAL', 'Nova pendência na Carteira', 'Há uma pendência atribuída a você no painel da Carteira Digital.');
    } else if (ch === 'PUSH') {
      // Canal externo ainda não homologado: registra a falha e abre pendência técnica (o alerta continua pendente).
      await alertEvent(id, null, 'FALHA_CANAL', 'PUSH', 'Canal push não homologado.');
      const tec = await activeRule('TEC-CANAL-001');
      if (tec) await raiseAlert(tec, { patientId: null, subjectType: 'canal', subjectId: 'PUSH', dedupeKey: `TEC-CANAL-001:PUSH:${now.slice(0, 10)}` });
    }
  }
  return id;
}

/** Job: lembretes do plano, tarefas vencidas e escalonamento por prazo de ciência vencido. */
export async function runCarteiraAlerts(now = new Date()) {
  await ensureAlertRules();
  const iso = now.toISOString();
  let reminders = 0, overdue = 0, escalated = 0;
  const lem = await activeRule('LEM-PLANO-001');
  if (lem) {
    const soon = new Date(now.getTime() + 24 * 3600_000).toISOString();
    for (const it of await all<any>(`SELECT id, patient_id, due_at FROM care_plan_items WHERE status = 'ATIVO' AND due_at <= ? AND due_at >= ?`, soon, new Date(now.getTime() - 24 * 3600_000).toISOString())) {
      if (await raiseAlert(lem, { patientId: it.patient_id, subjectType: 'care_plan_item', subjectId: it.id, dedupeKey: `LEM-PLANO-001:${it.id}:${it.due_at}` })) reminders++;
    }
  }
  const adm = await activeRule('ADM-PLANO-ATRASO-001');
  if (adm) {
    for (const it of await all<any>(`SELECT id, patient_id, created_by FROM care_plan_items WHERE status = 'ATIVO' AND due_at < ?`, new Date(now.getTime() - 24 * 3600_000).toISOString())) {
      if (await raiseAlert(adm, { patientId: it.patient_id, subjectType: 'care_plan_item', subjectId: it.id, dedupeKey: `ADM-PLANO-ATRASO-001:${it.id}`, assignedTo: it.created_by })) overdue++;
    }
  }
  // Escalonamento: prazo de ciência vencido sem reconhecimento → destinatário de escalonamento (registrado).
  for (const a of await all<any>(`SELECT a.*, r.escalate_to FROM care_alerts a JOIN alert_rules r ON r.code = a.rule_code AND r.version = a.rule_version
      WHERE a.status = 'PENDENTE' AND a.ack_due_at IS NOT NULL AND a.ack_due_at < ? AND a.escalation_level = 0 AND r.escalate_to IS NOT NULL`, iso)) {
    const u = await run(`UPDATE care_alerts SET escalation_level = 1, recipient = ?, assigned_to = NULL, rev = rev + 1, updated_at = ? WHERE id = ? AND escalation_level = 0 AND status = 'PENDENTE'`,
      a.escalate_to, iso, a.id);
    if (u.changes) {
      escalated++;
      await alertEvent(a.id, null, 'ESCALONADO', 'PAINEL', `Prazo de ciência vencido; encaminhado para ${a.escalate_to}.`);
      await audit({ actorId: null, action: 'CARE_ALERT_ESCALATED', subjectType: 'care_alert', subjectId: a.id });
    }
  }
  return { reminders, overdue, escalated };
}
