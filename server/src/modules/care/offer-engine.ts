/**
 * Motor de ofertas (PAC-03 · Pós-Alta 30 dias, proposta v1.0 do RT, 17/11/2026).
 *  - Um pedido reúne todos os eventos. Pago o pedido, só o PRIMEIRO evento (avaliação inicial) entra em oferta, com a janela
 *    pedida pelo paciente ("Hoje à noite" → data e faixa no fuso America/Sao_Paulo, gravada no momento da solicitação).
 *  - Os demais ficam "A programar" até a Central validar a janela; entram em oferta quando a antecedência configurada é
 *    atingida e a dependência (avaliação inicial realizada) está satisfeita. A Central pode antecipar o convite.
 *  - Primeira onda: profissional de referência do paciente (quem já o acompanha neste pedido), por um prazo curto;
 *    vencido o prazo ou recusado, a oferta é ampliada para a rede habilitada. Janela próxima do fim: onda paralela direta.
 *  - Aceite: uma transação confirma um único profissional por evento; repetição do vencedor devolve o mesmo resultado;
 *    os demais recebem "Esta oferta já foi preenchida".
 *  - Janela vencida sem aceite: pausa a oferta, aciona a Central e avisa o paciente. Sem elegíveis: Central.
 * Pedido de evento único segue a mesma janela (oferta imediata).
 */
import { all, one, run } from '../../db/db.ts';
import { audit } from '../../lib/audit.ts';
import { nowIso, uid } from '../../lib/util.ts';
import { notify } from '../prime/core.ts';
import { notifyRole } from '../finance/payouts.ts';
import { partnerActive } from '../specialist/validation.ts';
import { specialistNeeds, specialistPrefs } from './specialist-panel.ts';

// ---------------- Parâmetros (Gestão) ----------------
export interface EngineParams {
  /** Faixas de horário (hora inicial e final, fuso de São Paulo). */
  faixas: Record<'MANHA' | 'TARDE' | 'NOITE' | 'QUALQUER', [number, number]>;
  /** "Agora": janela a partir do pedido, em horas. */
  agoraHours: number;
  /** "Próximos dias": de amanhã até N dias. */
  proximosDias: number;
  /** Prazo exclusivo do profissional de referência (minutos). */
  referenceMinutes: number;
  /** Antecedência de abertura da oferta por modalidade (horas antes do início da janela). */
  leadHours: { PRESENCIAL: number; REMOTO: number };
}
export const ENGINE_DEFAULTS: EngineParams = {
  faixas: { MANHA: [8, 12], TARDE: [12, 18], NOITE: [18, 22], QUALQUER: [8, 22] },
  agoraHours: 4, proximosDias: 3, referenceMinutes: 30, leadHours: { PRESENCIAL: 48, REMOTO: 24 },
};
const SETTINGS_KEY = 'offer_engine_params';

export async function engineParams(): Promise<EngineParams> {
  const row = await one<any>('SELECT value FROM system_settings WHERE key = ?', SETTINGS_KEY);
  if (!row) return ENGINE_DEFAULTS;
  try {
    const v = JSON.parse(row.value);
    return { ...ENGINE_DEFAULTS, ...v, faixas: { ...ENGINE_DEFAULTS.faixas, ...(v.faixas ?? {}) }, leadHours: { ...ENGINE_DEFAULTS.leadHours, ...(v.leadHours ?? {}) } };
  } catch { return ENGINE_DEFAULTS; }
}
export async function saveEngineParams(p: EngineParams) {
  await run(`INSERT INTO system_settings (key, value, created_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, SETTINGS_KEY, JSON.stringify(p), nowIso());
}

// ---------------- Datas no fuso de São Paulo (UTC−3, sem horário de verão desde 2019) ----------------
const SP_OFFSET = '-03:00';
export function spDate(iso = nowIso()): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}
const addDays = (ymd: string, n: number) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const at = (ymd: string, hour: number) => new Date(`${ymd}T${String(Math.min(hour, 23)).padStart(2, '0')}:${hour >= 24 ? '59' : '00'}:00${SP_OFFSET}`).toISOString();
const br = (ymd: string) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`;
const FAIXA_TXT: Record<string, string> = { MANHA: 'pela manhã', TARDE: 'à tarde', NOITE: 'à noite', QUALQUER: 'em qualquer horário' };
export const fmtSp = (iso: string) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
const hh = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).replace(':00', 'h').replace(':', 'h');

/**
 * Converte a preferência do paciente em janela absoluta, no momento da solicitação. A janela gravada não muda com a troca
 * de dia nem com o reprocessamento do pagamento. Faixa de hoje já encerrada: vale até o fim do dia (a Central confirma).
 */
export function requestWindow(p: { whenPref: string; whenDate?: string | null; timeWindow?: string | null }, params: EngineParams = ENGINE_DEFAULTS, now = nowIso()) {
  const faixaKey = (p.timeWindow && p.timeWindow in params.faixas ? p.timeWindow : 'QUALQUER') as keyof EngineParams['faixas'];
  const [h0, h1] = params.faixas[faixaKey];
  const today = spDate(now);
  if (p.whenPref === 'AGORA') {
    const end = new Date(new Date(now).getTime() + params.agoraHours * 3600_000).toISOString();
    return { start: now, end, label: `agora, até ${hh(end)}` };
  }
  if (p.whenPref === 'PROXIMOS_DIAS') {
    const d0 = addDays(today, 1), d1 = addDays(today, params.proximosDias);
    return { start: at(d0, h0), end: at(d1, h1), label: `${FAIXA_TXT[faixaKey]}, ${h0}h–${h1}h` };
  }
  const day = p.whenPref === 'AGENDAR' && p.whenDate ? p.whenDate : today;
  let start = at(day, h0), end = at(day, h1), label = `${FAIXA_TXT[faixaKey]}, ${h0}h–${h1}h`;
  if (day === today && new Date(end).getTime() <= new Date(now).getTime()) { start = now; end = at(day, 24); label = 'até o fim do dia'; }
  return { start, end, label };
}

/** Janela para exibição: data completa, com "Hoje"/"Amanhã" como complemento enquanto couber. */
export function windowDisplay(start: string, end: string, label?: string | null, now = nowIso()) {
  const d0 = spDate(start), d1 = spDate(end), today = spDate(now);
  if (!label) return windowText(start, end);
  if (d0 !== d1) return `${br(d0)} a ${br(d1)}, ${label}`;
  const word = d0 === today ? 'Hoje' : d0 === addDays(today, 1) ? 'Amanhã' : null;
  return word ? `${word} ${label} · ${br(d0)}` : `${br(d0)} ${label}`;
}

// ---------------- Histórico ----------------
export async function offerLog(eventId: string, kind: string, extra: { wave?: number | null; specialistId?: string | null; actorId?: string | null; note?: string | null } = {}) {
  await run('INSERT INTO care_offer_log (id, event_id, kind, wave, specialist_id, actor_id, note, created_at) VALUES (?,?,?,?,?,?,?,?)',
    uid(), eventId, kind, extra.wave ?? null, extra.specialistId ?? null, extra.actorId ?? null, extra.note ?? null, nowIso());
}

/** Profissional de referência: quem atende (ou atendeu) outro evento deste pedido, mais recente, ainda ativo. */
async function referenceFor(orderId: string, eventId: string): Promise<string | null> {
  const r = await one<any>(`SELECT specialist_id FROM care_events WHERE order_id = ? AND id <> ? AND specialist_id IS NOT NULL AND status IN ('ACEITO','CONCLUIDO')
    ORDER BY COALESCE(completed_at, accepted_at) DESC LIMIT 1`, orderId, eventId);
  if (!r?.specialist_id) return null;
  return (await partnerActive(r.specialist_id)) ? r.specialist_id : null;
}

/** Publica a oferta de um evento (primeira onda). Chamar dentro de transação. */
export async function publishOffer(e: { id: string; order_id: string; window_start: string | null; window_end: string | null }, params: EngineParams, actorId: string | null = null, note: string | null = null) {
  const now = nowIso();
  const ref = await referenceFor(e.order_id, e.id);
  // Janela próxima do limite: sem prazo exclusivo (onda paralela já na primeira tentativa).
  const remainingMs = e.window_end ? new Date(e.window_end).getTime() - Date.now() : Infinity;
  const exclusive = ref && remainingMs > 3 * params.referenceMinutes * 60_000;
  const until = exclusive ? new Date(Date.now() + params.referenceMinutes * 60_000).toISOString() : null;
  await run(`UPDATE care_events SET status = 'DISPONIVEL', offer_published_at = ?, offer_wave = 1, reference_specialist_id = ?, reference_until = ?, attention = NULL, attention_at = NULL, updated_at = ?
    WHERE id = ?`, now, exclusive ? ref : null, until, now, e.id);
  await offerLog(e.id, 'PUBLICADA', { wave: 1, specialistId: exclusive ? ref : null, actorId, note: note ?? (exclusive ? 'Primeira onda: profissional de referência do paciente.' : 'Primeira onda: rede habilitada (onda paralela).') });
  if (exclusive && ref) await notify(ref, 'ESSENCIAL', 'Nova oferta para você', 'Um paciente que você acompanha tem um novo atendimento. A oferta fica reservada para você por alguns minutos.');
}

async function flagAttention(eventId: string, reason: 'JANELA_VENCIDA' | 'SEM_COBERTURA' | 'REVISAR_AGENDA', note: string) {
  const now = nowIso();
  await run('UPDATE care_events SET attention = ?, attention_at = ?, updated_at = ? WHERE id = ?', reason, now, now, eventId);
  await offerLog(eventId, reason, { note });
}

/**
 * Pagamento confirmado: cria o estado inicial dos eventos uma única vez (só toca eventos AGUARDANDO_PAGAMENTO, então
 * reprocessar o pagamento não altera nada). Chamar dentro da transação do pagamento.
 */
export async function onOrderPaid(orderId: string, requestId: string | null) {
  const events = await all<any>(`SELECT id, seq, order_id FROM care_events WHERE order_id = ? AND status = 'AGUARDANDO_PAGAMENTO' ORDER BY seq`, orderId);
  if (!events.length) return;
  const first = (await one<any>('SELECT MIN(seq) AS s FROM care_events WHERE order_id = ?', orderId))!.s;
  const req = requestId ? await one<any>('SELECT window_start, window_end, window_label, when_pref, when_date, time_window, created_at FROM care_requests WHERE id = ?', requestId) : null;
  const params = await engineParams();
  // Pedidos anteriores à regra sem janela gravada: calcula a partir da solicitação original.
  const w = req ? (req.window_start ? { start: req.window_start, end: req.window_end, label: req.window_label }
    : requestWindow({ whenPref: req.when_pref, whenDate: req.when_date, timeWindow: req.time_window }, params, req.created_at)) : null;
  const now = nowIso();
  for (const e of events) {
    if (e.seq === first) {
      await run('UPDATE care_events SET window_start = ?, window_end = ?, window_label = ?, updated_at = ? WHERE id = ?', w?.start ?? null, w?.end ?? null, w?.label ?? null, now, e.id);
      if (w && new Date(w.end).getTime() <= Date.now()) {
        await run(`UPDATE care_events SET status = 'A_PROGRAMAR', updated_at = ? WHERE id = ?`, now, e.id);
        await flagAttention(e.id, 'JANELA_VENCIDA', 'A janela pedida já tinha terminado quando o pagamento foi confirmado.');
        await windowExpiredNotices(e.id);
      } else {
        await publishOffer({ ...e, window_start: w?.start ?? null, window_end: w?.end ?? null }, params);
      }
    } else {
      await run(`UPDATE care_events SET status = 'A_PROGRAMAR', depends_on_seq = ?, updated_at = ? WHERE id = ?`, first, now, e.id);
      await offerLog(e.id, 'A_PROGRAMAR', { note: 'Aguardando a Central validar a janela no plano.' });
    }
  }
}

async function windowExpiredNotices(eventId: string) {
  const e = await one<any>('SELECT e.label, o.patient_id FROM care_events e JOIN service_orders o ON o.id = e.order_id WHERE e.id = ?', eventId);
  if (!e) return;
  await notify(e.patient_id, 'ESSENCIAL', 'Estamos verificando a disponibilidade',
    `A equipe ONEMA está verificando a disponibilidade para "${e.label}" e vai confirmar uma nova janela com você.`);
  await notifyRole(['OPERADOR_CENTRAL'], 'Janela vencida sem especialista', `"${e.label}": a janela terminou sem aceite. Defina nova janela com o paciente em Gestão › Agenda de pacotes.`);
}

/** Restam profissionais elegíveis que não recusaram? Sem nenhum: Central acionada. */
export async function checkCoverage(eventId: string) {
  const e = await one<any>(`SELECT e.id, e.status, e.attention, ci.need FROM care_events e JOIN service_orders o ON o.id = e.order_id LEFT JOIN catalog_items ci ON ci.code = o.item_code WHERE e.id = ?`, eventId);
  if (!e || e.status !== 'DISPONIVEL' || e.attention === 'SEM_COBERTURA') return;
  const cands = await all<any>(`SELECT DISTINCT r.user_id FROM user_roles r JOIN users u ON u.id = r.user_id WHERE r.role = 'ESPECIALISTA' AND u.status = 'ACTIVE'
    AND NOT EXISTS (SELECT 1 FROM specialist_offer_declines d WHERE d.event_id = ? AND d.specialist_id = r.user_id)`, eventId);
  for (const c of cands) {
    if (!(await partnerActive(c.user_id))) continue;
    if (!(await specialistPrefs(c.user_id)).available) continue;
    const needs = await specialistNeeds(c.user_id);
    if (needs && e.need && !needs.includes(e.need)) continue;
    return;
  }
  await flagAttention(eventId, 'SEM_COBERTURA', 'Nenhum profissional elegível restante (recusas ou indisponibilidade).');
  await notifyRole(['OPERADOR_CENTRAL'], 'Oferta sem cobertura', 'Uma oferta ficou sem profissional elegível. Veja em Gestão › Agenda de pacotes.');
}

// ---------------- Varredura (abertura programada, ampliação de onda e vencimento) ----------------
let lastSweep = 0;
/** Leve e idempotente. `force` ignora o intervalo mínimo (testes e Gestão). */
export async function runOfferSweep(force = false) {
  if (!force && Date.now() - lastSweep < 10_000) return;
  lastSweep = Date.now();
  const now = nowIso();
  const params = await engineParams();
  // 1) Eventos programados pela Central: abrem na antecedência configurada, com a dependência satisfeita.
  const due = await all<any>(`SELECT e.id, e.order_id, e.window_start, e.window_end FROM care_events e JOIN service_orders o ON o.id = e.order_id
    WHERE e.status = 'A_PROGRAMAR' AND o.status = 'PAID' AND e.plan_validated_at IS NOT NULL AND e.attention IS NULL AND e.offer_opens_at IS NOT NULL AND e.offer_opens_at <= ?
      AND e.window_end > ?
      AND (e.depends_on_seq IS NULL OR EXISTS (SELECT 1 FROM care_events d WHERE d.order_id = e.order_id AND d.seq = e.depends_on_seq AND d.status = 'CONCLUIDO'))`, now, now);
  for (const e of due) {
    const r = await run(`UPDATE care_events SET status = 'DISPONIVEL', updated_at = ? WHERE id = ? AND status = 'A_PROGRAMAR'`, now, e.id);
    if (r.changes) await publishOffer(e, params);
  }
  // 2) Prazo da referência vencido: amplia para a rede (segunda onda).
  for (const e of await all<any>(`SELECT id FROM care_events WHERE status = 'DISPONIVEL' AND offer_wave = 1 AND reference_until IS NOT NULL AND reference_until <= ?`, now)) {
    const r = await run(`UPDATE care_events SET offer_wave = 2, updated_at = ? WHERE id = ? AND offer_wave = 1`, now, e.id);
    if (r.changes) { await offerLog(e.id, 'ONDA_AMPLIADA', { wave: 2, note: 'Prazo do profissional de referência vencido.' }); await checkCoverage(e.id); }
  }
  // 3) Janela vencida sem aceite: pausa a oferta, aciona a Central e avisa o paciente.
  for (const e of await all<any>(`SELECT id FROM care_events WHERE status = 'DISPONIVEL' AND window_end IS NOT NULL AND window_end <= ?`, now)) {
    const r = await run(`UPDATE care_events SET status = 'A_PROGRAMAR', updated_at = ? WHERE id = ? AND status = 'DISPONIVEL'`, now, e.id);
    if (r.changes) {
      await flagAttention(e.id, 'JANELA_VENCIDA', 'Janela terminou sem aceite: ofertas pausadas.');
      await windowExpiredNotices(e.id);
      await audit({ actorId: null, action: 'OFFER_WINDOW_EXPIRED', subjectType: 'care_event', subjectId: e.id });
    }
  }
}

/** Filtro SQL da onda: a oferta aparece para a referência, ou para todos depois do prazo/recusa da referência. */
export const WAVE_FILTER_SQL = `(e.reference_specialist_id IS NULL OR e.reference_specialist_id = ? OR e.reference_until IS NULL OR e.reference_until <= ?
  OR EXISTS (SELECT 1 FROM specialist_offer_declines rd WHERE rd.event_id = e.id AND rd.specialist_id = e.reference_specialist_id))`;

// ---------------- Estado exibido (mesmo nome nas telas do paciente, da especialista e da Gestão) ----------------
export const SCHEDULE_LABEL: Record<string, string> = {
  AGUARDANDO_PACIENTE: 'Aguardando confirmação do paciente', CONFIRMADO: 'Confirmado', ALTERACAO_SOLICITADA: 'Alteração solicitada',
};
export function eventState(e: any): { code: string; label: string; detail: string | null } {
  const win = e.window_start && e.window_end ? windowText(e.window_start, e.window_end) : null;
  switch (e.status) {
    case 'AGUARDANDO_PAGAMENTO': return { code: 'AGUARDANDO_PAGAMENTO', label: 'Aguardando pagamento', detail: null };
    case 'A_PROGRAMAR':
      if (e.attention === 'JANELA_VENCIDA' || e.attention === 'SEM_COBERTURA') return { code: 'VERIFICANDO', label: 'Verificando disponibilidade', detail: 'A equipe ONEMA vai confirmar uma nova janela com você.' };
      if (e.plan_validated_at && win) return { code: 'PREVISTO', label: `Previsto para ${win}`, detail: null };
      return { code: 'A_PROGRAMAR', label: 'A programar', detail: null };
    case 'DISPONIVEL':
      return { code: 'BUSCANDO', label: 'Buscando especialista', detail: e.window_start && e.window_end ? `Solicitado para ${windowDisplay(e.window_start, e.window_end, e.window_label).replace(/^(Hoje|Amanhã)/, (m) => m.toLowerCase())}` : null };
    case 'ACEITO':
      if (e.call_scheduled_at && e.schedule_status === 'CONFIRMADO') return { code: 'AGENDADO', label: 'Agendado', detail: fmtSp(e.call_scheduled_at) };
      if (e.call_scheduled_at && e.schedule_status === 'ALTERACAO_SOLICITADA') return { code: 'ALTERACAO_SOLICITADA', label: 'Alteração solicitada', detail: e.schedule_change_at ? `Nova proposta: ${fmtSp(e.schedule_change_at)}` : null };
      if (e.call_scheduled_at) return { code: 'AGUARDANDO_PACIENTE', label: 'Aguardando confirmação do horário', detail: `Proposta: ${fmtSp(e.call_scheduled_at)}` };
      return { code: 'CONFIRMADA', label: 'Especialista confirmada', detail: win ? `Janela: ${win}` : null };
    case 'CONCLUIDO': return { code: 'CONCLUIDO', label: 'Concluído', detail: e.completed_at ? fmtSp(e.completed_at) : null };
    default: return { code: 'CANCELADO', label: 'Cancelado', detail: null };
  }
}
export function windowText(start: string, end: string) {
  const d0 = spDate(start), d1 = spDate(end);
  return d0 === d1 ? `${br(d0)}, ${hh(start)}–${hh(end)}` : `${br(d0)} a ${br(d1)}`;
}
