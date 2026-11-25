/**
 * Lembretes do plano de cuidados (comando do RT, 20/11/2026 — "Lembretes úteis, com prazo e liberdade de escolha").
 *
 * - Orientação (série) ≠ lembrete (ocorrência) ≠ ciência ≠ execução. "Ciente" registra a ciência daquela ocorrência,
 *   uma única vez; não significa execução, melhora nem agendamento.
 * - Agenda fixa: a próxima ocorrência é calculada pela programação (horário original), sem depender de resposta e sem
 *   deslocar a série para a hora do clique. Ocorrências passadas não são acumuladas nem reenviadas.
 * - Vigência obrigatória (encerramento ou revisão) definida pelo enfermeiro: nada é disparado depois dela; a revisão
 *   interrompe os envios e abre pendência para a Enfermagem (não renova sozinha; não é alta clínica).
 * - Preferências do paciente por orientação: espaçar (5/10/15/20/30 dias, nunca menor que o original), pausar até uma data,
 *   desativar e reativar. Edição clínica nunca reativa aviso desativado pelo paciente.
 * - Avisos gerais: no máximo um resumo por dia por paciente.
 * Fuso: America/Sao_Paulo.
 */
import { all, one, run } from '../../db/db.ts';
import { audit } from '../../lib/audit.ts';
import { nowIso, uid } from '../../lib/util.ts';
import { notify } from '../prime/core.ts';
import { notifyRole } from '../finance/payouts.ts';

export const ITEM_KINDS = ['GERAL', 'AGENDAR', 'HORARIO'] as const;
export const KIND_LABEL: Record<string, string> = { GERAL: 'Orientação geral', AGENDAR: 'Ação de agendar', HORARIO: 'Horário específico' };
export const SPACING_OPTIONS = [5, 10, 15, 20, 30];
const DAY = 86400_000;

export interface Pref { mode: 'ATIVO' | 'ESPACADO' | 'PAUSADO' | 'DESATIVADO' | 'SUSPENSO_SEM_INTERACAO'; intervalDays: number | null; pausedUntil: string | null; updatedAt: string | null }

export async function reminderEvent(seriesId: string, itemId: string | null, patientId: string, kind: string, actorId: string | null, detail: string | null = null) {
  try {
    await run('INSERT INTO care_plan_reminder_events (id, series_id, item_id, patient_id, kind, actor_id, detail, created_at) VALUES (?,?,?,?,?,?,?,?)',
      uid(), seriesId, itemId, patientId, kind, actorId, detail, nowIso());
    return true;
  } catch (e: any) {
    if (String(e?.code) === '23505' || /unique/i.test(String(e?.message))) return false; // já registrado (uma vez por ocorrência)
    throw e;
  }
}

export async function prefOf(seriesId: string): Promise<Pref> {
  const p = await one<any>('SELECT * FROM care_plan_reminder_prefs WHERE series_id = ?', seriesId);
  return p ? { mode: p.mode, intervalDays: p.interval_days, pausedUntil: p.paused_until, updatedAt: p.updated_at } : { mode: 'ATIVO', intervalDays: null, pausedUntil: null, updatedAt: null };
}

/** Intervalo efetivo dos avisos: o original do enfermeiro ou o espaçamento escolhido pelo paciente (nunca menor). */
export function effectiveInterval(recurrenceDays: number | null, pref: Pref) {
  if (!recurrenceDays) return null;
  return pref.mode === 'ESPACADO' && pref.intervalDays ? Math.max(pref.intervalDays, recurrenceDays) : recurrenceDays;
}

/** Próxima data da agenda (mesmo horário original) estritamente depois de `after` e não antes de `notBefore`. */
export function nextAligned(baseDue: string, intervalDays: number, after: number, notBefore = 0) {
  const base = new Date(baseDue).getTime(), step = intervalDays * DAY, min = Math.max(after, notBefore - 1);
  const k = Math.max(1, Math.floor((min - base) / step) + 1);
  return new Date(base + k * step).toISOString();
}

async function openReview(seriesId: string, patientId: string, kind: 'PEDIDO_PACIENTE' | 'PARAMETRIZACAO' | 'REVISAO_PROGRAMADA' | 'AJUDA_AGENDAR', note: string) {
  const r = await run(`INSERT INTO care_plan_reviews (id, series_id, patient_id, kind, status, note, created_at) VALUES (?,?,?,?,'ABERTA',?,?) ON CONFLICT DO NOTHING`,
    uid(), seriesId, patientId, kind, note, nowIso());
  return r.changes > 0;
}

/**
 * Garante a próxima ocorrência da série (no máximo uma pendente). Respeita vigência, preferência e parametrização.
 * Devolve o motivo quando não há próximo aviso (exibido ao paciente, sem inventar disparo).
 */
export async function ensureNext(seriesId: string): Promise<{ nextAt: string | null; reason: string | null }> {
  const items = await all<any>('SELECT * FROM care_plan_items WHERE series_id = ? ORDER BY due_at, created_at', seriesId);
  if (!items.length) return { nextAt: null, reason: null };
  const root = items[0], last = items[items.length - 1];
  const pending = items.find((i) => i.status === 'ATIVO' && !i.released_at && new Date(i.due_at).getTime() > Date.now());
  if (pending) return { nextAt: pending.due_at, reason: null };
  if (last.status === 'CANCELADO' && !last.cancel_reason?.startsWith('Preferência')) return { nextAt: null, reason: 'Orientação encerrada pela Enfermagem.' };
  if (!root.recurrence_days) return { nextAt: null, reason: null };
  if (last.schedule_report === 'INFORMADO_PACIENTE') return { nextAt: null, reason: 'Agendamento informado por você: avisos de agendar encerrados.' };
  if (!root.reminders_until) return { nextAt: null, reason: 'Programação em revisão pela Enfermagem (sem data de término definida).' };
  const pref = await prefOf(seriesId);
  if (pref.mode === 'DESATIVADO') return { nextAt: null, reason: 'Avisos desativados por você.' };
  if (pref.mode === 'SUSPENSO_SEM_INTERACAO') return { nextAt: null, reason: 'Avisos suspensos por falta de interação.' };
  const interval = effectiveInterval(root.recurrence_days, pref)!;
  const notBefore = pref.mode === 'PAUSADO' && pref.pausedUntil ? new Date(pref.pausedUntil).getTime() : 0;
  const next = nextAligned(root.due_at, interval, Math.max(Date.now(), new Date(last.due_at).getTime()), notBefore);
  if (new Date(next).getTime() > new Date(root.reminders_until).getTime()) {
    if (root.until_kind === 'REVISAO') await openReview(seriesId, root.patient_id, 'REVISAO_PROGRAMADA', 'Data de revisão da programação de avisos atingida.');
    return { nextAt: null, reason: `Programação de avisos ${root.until_kind === 'REVISAO' ? 'em revisão desde' : 'encerrada em'} ${fmt(root.reminders_until)}.` };
  }
  if (pref.mode === 'PAUSADO' && pref.pausedUntil && new Date(pref.pausedUntil).getTime() > new Date(root.reminders_until).getTime()) {
    return { nextAt: null, reason: `Lembretes pausados até ${fmtDay(pref.pausedUntil)} (depois do término da programação).` };
  }
  const now = nowIso();
  await run(`INSERT INTO care_plan_items (id, patient_id, created_by, source_event_id, previous_item_id, series_id, title, instructions, due_at, recurrence_days, ask_followup, status,
      item_kind, care_frequency, reminders_until, until_kind, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'ATIVO',?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
    uid(), root.patient_id, root.created_by, root.source_event_id, last.id, seriesId, root.title, root.instructions, next, root.recurrence_days, root.ask_followup,
    root.item_kind, root.care_frequency, root.reminders_until, root.until_kind, now, now);
  const created = await one<any>(`SELECT due_at FROM care_plan_items WHERE series_id = ? AND status = 'ATIVO' AND released_at IS NULL ORDER BY due_at LIMIT 1`, seriesId);
  return { nextAt: created?.due_at ?? next, reason: null };
}

export const fmt = (iso: string) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', ' às');
export const fmtDay = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const spDay = (iso = nowIso()) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

/**
 * Motor (de hora em hora e ao abrir a Carteira): disponibiliza ocorrências que chegaram na data, encerra as que passaram
 * sem resposta (sem reenviar), retoma pausas vencidas e envia no máximo um resumo diário por paciente.
 */
export async function runPlanReminders(opts: { patientId?: string; notify?: boolean } = {}) {
  const now = nowIso(); let released = 0, expired = 0;
  const scope = opts.patientId ? 'AND patient_id = ?' : '';
  const args = opts.patientId ? [opts.patientId] : [];
  // Pausas vencidas: retomam sem retroativos.
  for (const p of await all<any>(`SELECT series_id FROM care_plan_reminder_prefs WHERE mode = 'PAUSADO' AND paused_until <= ? ${scope}`, now, ...args)) {
    await run(`UPDATE care_plan_reminder_prefs SET mode = CASE WHEN interval_days IS NULL THEN 'ATIVO' ELSE 'ESPACADO' END, paused_until = NULL, updated_at = ? WHERE series_id = ?`, now, p.series_id);
    await ensureNext(p.series_id);
  }
  // Disponibilização no App (uma vez por ocorrência).
  const due = await all<any>(`SELECT i.id, i.series_id, i.patient_id, i.title FROM care_plan_items i WHERE i.status = 'ATIVO' AND i.released_at IS NULL AND i.due_at <= ? ${scope.replace('patient_id', 'i.patient_id')}`, now, ...args);
  const byPatient = new Map<string, string[]>();
  for (const it of due) {
    const pref = await prefOf(it.series_id);
    if (['DESATIVADO', 'PAUSADO', 'SUSPENSO_SEM_INTERACAO'].includes(pref.mode)) {
      await run(`UPDATE care_plan_items SET status = 'CANCELADO', cancel_reason = ?, updated_at = ? WHERE id = ? AND status = 'ATIVO'`, 'Preferência do paciente: avisos não enviados.', now, it.id);
      continue;
    }
    const r = await run('UPDATE care_plan_items SET released_at = ?, updated_at = ? WHERE id = ? AND released_at IS NULL', now, now, it.id);
    if (!r.changes) continue;
    released++;
    await reminderEvent(it.series_id, it.id, it.patient_id, 'DISPONIBILIZADO', null, 'Disponibilizado no App');
    byPatient.set(it.patient_id, [...(byPatient.get(it.patient_id) ?? []), it.title]);
  }
  // Ocorrência sem resposta cuja próxima data da agenda já chegou: encerra (sem reenviar) e programa a próxima.
  for (const it of await all<any>(`SELECT i.id, i.series_id, i.due_at, i.recurrence_days FROM care_plan_items i WHERE i.status = 'ATIVO' AND i.released_at IS NOT NULL
      AND i.recurrence_days IS NOT NULL ${scope.replace('patient_id', 'i.patient_id')}`, ...args)) {
    const pref = await prefOf(it.series_id);
    const interval = effectiveInterval(it.recurrence_days, pref)!;
    if (new Date(it.due_at).getTime() + interval * DAY > Date.now()) continue;
    const r = await run(`UPDATE care_plan_items SET status = 'EXPIRADO', updated_at = ? WHERE id = ? AND status = 'ATIVO'`, now, it.id);
    if (r.changes) { expired++; await ensureNext(it.series_id); }
  }
  // Garante a próxima ocorrência das séries ativas sem pendente.
  for (const s of await all<any>(`SELECT DISTINCT series_id FROM care_plan_items WHERE recurrence_days IS NOT NULL ${scope} AND series_id NOT IN
      (SELECT series_id FROM care_plan_items WHERE status = 'ATIVO' AND released_at IS NULL)`, ...args)) {
    const last = await one<any>('SELECT status FROM care_plan_items WHERE series_id = ? ORDER BY due_at DESC, created_at DESC LIMIT 1', s.series_id);
    if (last && ['CIENTE', 'CONCLUIDO', 'EXPIRADO'].includes(last.status)) await ensureNext(s.series_id);
  }
  // Um resumo por dia por paciente (avisos gerais), no App.
  if (opts.notify !== false) {
    for (const [patientId, titles] of byPatient) {
      const today = spDay();
      const key = `plan_summary:${patientId}:${today}`;
      const ins = await run(`INSERT INTO system_settings (key, value, created_at) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING`, key, String(titles.length), now);
      if (!ins.changes) continue;
      await notify(patientId, 'LEMBRETE', 'Lembretes do seu plano de cuidados',
        // Sem dado clínico na notificação: o conteúdo fica na Carteira.
        titles.length === 1 ? 'Você tem um lembrete no plano de cuidados. Veja na sua Carteira Digital.' : `Você tem ${titles.length} lembretes no plano de cuidados. Veja na sua Carteira Digital.`);
    }
  }
  return { released, expired };
}

/** Estado legível da série para o paciente e para a Enfermagem. */
export async function seriesState(seriesId: string) {
  const root = await one<any>('SELECT * FROM care_plan_items WHERE id = ?', seriesId) ?? await one<any>('SELECT * FROM care_plan_items WHERE series_id = ? ORDER BY due_at LIMIT 1', seriesId);
  const pref = await prefOf(seriesId);
  const next = await one<any>(`SELECT due_at FROM care_plan_items WHERE series_id = ? AND status = 'ATIVO' AND released_at IS NULL ORDER BY due_at LIMIT 1`, seriesId);
  const review = await one<any>(`SELECT kind, created_at FROM care_plan_reviews WHERE series_id = ? AND status = 'ABERTA' ORDER BY created_at DESC LIMIT 1`, seriesId);
  const last = await one<any>('SELECT status, cancel_reason, schedule_report FROM care_plan_items WHERE series_id = ? ORDER BY due_at DESC, created_at DESC LIMIT 1', seriesId);
  const ended = root?.reminders_until && new Date(root.reminders_until).getTime() < Date.now();
  let flag: { code: string; text: string };
  if (last?.status === 'CANCELADO' && !last.cancel_reason?.startsWith('Preferência')) flag = { code: 'ENCERRADA', text: 'Orientação encerrada pela Enfermagem' };
  else if (pref.mode === 'DESATIVADO') flag = { code: 'DESATIVADO', text: 'Avisos desativados por você' };
  else if (pref.mode === 'PAUSADO') flag = { code: 'PAUSADO', text: `Lembretes pausados até ${fmtDay(pref.pausedUntil!)}` };
  else if (pref.mode === 'SUSPENSO_SEM_INTERACAO') flag = { code: 'SUSPENSO', text: 'Avisos suspensos por falta de interação' };
  else if (ended) flag = { code: 'ENCERRADO', text: `Programação de avisos ${root.until_kind === 'REVISAO' ? 'em revisão desde' : 'encerrada em'} ${fmtDay(root.reminders_until)}` };
  else if (root?.recurrence_days && !root.reminders_until) flag = { code: 'PARAMETRIZACAO', text: 'Programação em revisão pela Enfermagem' };
  else if (pref.mode === 'ESPACADO') flag = { code: 'ESPACADO', text: `Avisos a cada ${effectiveInterval(root.recurrence_days, pref)} dias` };
  else flag = { code: 'ATIVO', text: root?.recurrence_days ? `Avisos a cada ${root.recurrence_days} dia(s)` : 'Aviso único' };
  return {
    seriesId, title: root?.title, instructions: root?.instructions, kind: root?.item_kind ?? 'GERAL', kindLabel: KIND_LABEL[root?.item_kind ?? 'GERAL'], careFrequency: root?.care_frequency,
    originalIntervalDays: root?.recurrence_days ?? null, remindersUntil: root?.reminders_until ?? null, untilKind: root?.until_kind ?? null, pref, flag,
    nextAt: next?.due_at ?? null, reviewOpen: review ? { kind: review.kind, at: review.created_at } : null,
    spacingOptions: root?.recurrence_days ? SPACING_OPTIONS.filter((d) => d >= root.recurrence_days) : [],
  };
}

/** Pendência para a Central/RT (pedido do paciente, ajuda para agendar). Não encerra a orientação. */
export async function requestReview(seriesId: string, patientId: string, kind: 'PEDIDO_PACIENTE' | 'AJUDA_AGENDAR', note: string, actorId: string) {
  const created = await openReview(seriesId, patientId, kind, note);
  await reminderEvent(seriesId, null, patientId, kind === 'PEDIDO_PACIENTE' ? 'REVISAO_SOLICITADA' : 'AJUDA_AGENDAR', actorId, note);
  if (created) {
    await notifyRole(['AVALIADOR_RT', 'OPERADOR_CENTRAL'], kind === 'PEDIDO_PACIENTE' ? 'Pedido de revisão de orientação' : 'Paciente pediu ajuda para agendar',
      'Há uma pendência do plano de cuidados em Gestão › Alertas da Carteira.');
    await audit({ actorId, action: kind === 'PEDIDO_PACIENTE' ? 'CARE_PLAN_REVIEW_REQUESTED' : 'CARE_PLAN_SCHEDULE_HELP', subjectType: 'care_plan_series', subjectId: seriesId });
  }
  return created;
}
