/**
 * ONEMA PRIME - regras comerciais.
 * Fonte: "ONEMA PRIME · Documento oficial de implantação e experiência do cliente" v2.0 (decisão RT 28/09/2026):
 *  - mensalidade R$ 34,90, renovação mensal até cancelar (T1 §2)
 *  - 5% em UM pedido elegível por ciclo, teto R$ 20,00 (T1 §4; A04)
 *  - até 3 novas tentativas em janela de 7 dias; suspensão só de benefícios comerciais (T1 §5)
 *  - arrependimento em 7 dias (T1 §7)
 * Todos os parâmetros são versionados em prime_parameters (alteração com RBAC e log).
 */
import { config } from '../../config.ts';
import { all, one, run } from '../../db/db.ts';
import { audit } from '../../lib/audit.ts';
import { conflict, notFound, unprocessable } from '../../lib/errors.ts';
import { addDays, addMonths, brl, nowIso, protocol, uid } from '../../lib/util.ts';

export const OPEN_STATUSES = ['ASSINATURA_SOLICITADA', 'ACTIVE', 'PAYMENT_PENDING', 'SUSPENDED', 'CANCEL_SCHEDULED'];
export const SANDBOX_METHODS = {
  SANDBOX_APROVADO: 'Cartão de teste (sandbox) — pagamento aprovado',
  SANDBOX_RECUSADO: 'Cartão de teste (sandbox) — pagamento recusado',
} as const;
export type SandboxMethod = keyof typeof SANDBOX_METHODS;

export async function currentParams() {
  const p = await one<any>('SELECT * FROM prime_parameters ORDER BY version DESC LIMIT 1');
  if (!p) throw unprocessable('PRIME_NOT_CONFIGURED', 'Parâmetros do PRIME não configurados.');
  return p;
}
export async function paramsById(id: string) {
  return await one<any>('SELECT * FROM prime_parameters WHERE id = ?', id)!;
}
export async function latestText(code: string) {
  return await one<any>('SELECT * FROM legal_texts WHERE code = ? ORDER BY created_at DESC, version DESC LIMIT 1', code);
}

export async function openSubscription(patientId: string) {
  return await one<any>(`SELECT * FROM subscriptions WHERE patient_id = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 1`,
    patientId, ...OPEN_STATUSES);
}
export async function latestSubscription(patientId: string) {
  return await one<any>('SELECT * FROM subscriptions WHERE patient_id = ? ORDER BY created_at DESC LIMIT 1', patientId);
}
export const cycleById = async (id: string | null) => (id ? await one<any>('SELECT * FROM subscription_cycles WHERE id = ?', id) : undefined);

/** Benefício comercial ativo: assinatura ativa (ou cancelamento agendado) e ciclo pago vigente. */
export async function benefitState(sub: any, now = nowIso()) {
  if (!sub) return { active: false, reason: 'Sem assinatura PRIME ativa.' };
  const cycle = await cycleById(sub.current_cycle_id);
  if (!['ACTIVE', 'CANCEL_SCHEDULED'].includes(sub.status)) {
    const reasons: Record<string, string> = {
      SUSPENDED: 'Esta assinatura está com benefícios suspensos; veja como regularizar.',
      PAYMENT_PENDING: 'Há uma cobrança pendente. Regularize para usar os benefícios do ciclo.',
      ASSINATURA_SOLICITADA: 'Aguardando confirmação do pagamento.',
    };
    return { active: false, reason: reasons[sub.status] ?? 'Sem assinatura PRIME ativa.', cycle };
  }
  if (!cycle || cycle.status !== 'PAID' || !(cycle.starts_at <= now && now < cycle.ends_at)) {
    return { active: false, reason: 'Ciclo pago não vigente.', cycle };
  }
  return { active: true, reason: null, cycle };
}

/** Desconto: 5% com arredondamento a centavos (meio para cima) e teto (A04). */
export function discountFor(priceCents: number, bps: number, capCents: number) {
  const raw = Math.floor((priceCents * bps + 5000) / 10000);
  return Math.min(raw, capCents);
}

export async function cycleUsage(cycleId: string | undefined) {
  if (!cycleId) return { used: 0, reserved: 0 };
  const rows = await all<any>(`SELECT status, COUNT(*) AS n FROM discount_reservations WHERE cycle_id = ? AND status IN ('RESERVED','USED') GROUP BY status`, cycleId);
  return {
    used: rows.find((r) => r.status === 'USED')?.n ?? 0,
    reserved: rows.find((r) => r.status === 'RESERVED')?.n ?? 0,
  };
}

export async function quote(patientId: string, itemCode: string, now = nowIso()) {
  const item = await one<any>('SELECT * FROM catalog_items WHERE code = ?', itemCode);
  if (!item || !item.active) throw notFound('Serviço ou pacote não disponível no catálogo.');
  if ((item.valid_from && item.valid_from > now) || (item.valid_to && item.valid_to < now)) throw notFound('Item fora da vigência do catálogo.');
  const sub = await openSubscription(patientId);
  const benefit = await benefitState(sub, now);
  const params = sub ? await paramsById(sub.parameters_id) : await currentParams();
  let discount = 0;
  let reason: string | null = null;
  let remaining = 0;
  if (!benefit.active) reason = sub ? benefit.reason : null;
  else {
    const usage = await cycleUsage(benefit.cycle!.id);
    remaining = Math.max(0, params.uses_per_cycle - usage.used - usage.reserved);
    if (!item.prime_eligible) reason = 'Este item não é elegível ao desconto PRIME.';
    else if (remaining <= 0) reason = usage.reserved ? 'Há um pedido com desconto em processamento neste ciclo.' : 'O desconto PRIME já foi usado neste ciclo';
    else discount = discountFor(item.price_cents, params.discount_bps, params.discount_cap_cents);
  }
  return {
    item: { code: item.code, name: item.name, kind: item.kind, isDemo: !!item.is_demo },
    fullPriceCents: item.price_cents,
    discountCents: discount,
    finalPriceCents: item.price_cents - discount,
    primeActive: benefit.active,
    usesRemaining: remaining,
    noDiscountReason: discount ? null : reason,
    rule: { bps: params.discount_bps, capCents: params.discount_cap_cents, usesPerCycle: params.uses_per_cycle },
    _internal: { item, sub, cycle: benefit.cycle, params },
  };
}

/** Provedor de pagamento simulado. Nunca usado quando PAYMENT_PROVIDER != SANDBOX. */
export function sandboxCharge(method: string) {
  if (config.paymentProvider !== 'SANDBOX') throw unprocessable('PAYMENT_PROVIDER_UNAVAILABLE', 'Provedor de pagamento não configurado.');
  if (!(method in SANDBOX_METHODS)) throw unprocessable('INVALID_PAYMENT_METHOD', 'Meio de pagamento inválido.');
  const ok = method === 'SANDBOX_APROVADO';
  return { ok, ref: `sbx_${uid().slice(0, 12)}`, reason: ok ? null : 'Recusado pelo emissor (simulação)' };
}

export async function notify(userId: string, purpose: 'ESSENCIAL' | 'LEMBRETE' | 'RESUMO' | 'OFERTA', title: string, body: string) {
  await run('INSERT INTO notifications (id, user_id, purpose, title, body, created_at) VALUES (?,?,?,?,?,?)', uid(), userId, purpose, title, body, nowIso());
}
export async function receipt(patientId: string, kind: string, proto: string | null, text: string) {
  await run('INSERT INTO prime_receipts (id, patient_id, kind, protocol, text, created_at) VALUES (?,?,?,?,?,?)', uid(), patientId, kind, proto, text, nowIso());
}

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const fmtDateTime = (iso: string) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
export { fmtDate, fmtDateTime };

/** Tenta cobrar o ciclo pendente da assinatura (ativação inicial, renovação ou regularização). */
export async function chargeCycle(sub: any, method: string, actorId: string | null, correlationId: string | null) {
  const params = await paramsById(sub.parameters_id);
  const cycle = await cycleById(sub.current_cycle_id);
  if (!cycle || cycle.status === 'PAID') throw conflict('NOTHING_TO_CHARGE', 'Não há cobrança pendente nesta assinatura.');
  const attemptNo = (await one<any>('SELECT COUNT(*)+1 AS n FROM charges WHERE cycle_id = ?', cycle.id))!.n;
  const result = sandboxCharge(method);
  const now = nowIso();
  const chargeId = uid();
  await run(`INSERT INTO charges (id, subscription_id, cycle_id, amount_cents, attempt_no, status, provider, provider_ref, failure_reason, created_at, settled_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`, chargeId, sub.id, cycle.id, params.monthly_price_cents, attemptNo, result.ok ? 'CONFIRMED' : 'FAILED',
    config.paymentProvider, result.ref, result.reason, now, now);
  await run('UPDATE subscriptions SET payment_method = ?, updated_at = ? WHERE id = ?', method, now, sub.id);
  if (!result.ok) {
    await run(`UPDATE subscription_cycles SET status = 'FAILED' WHERE id = ? AND status = 'PENDING'`, cycle.id);
    if (sub.status === 'ASSINATURA_SOLICITADA' || sub.status === 'ACTIVE') {
      await run(`UPDATE subscriptions SET status = 'PAYMENT_PENDING', updated_at = ? WHERE id = ?`, now, sub.id);
    }
    await audit({ actorId, action: 'PAYMENT_PENDING', subjectType: 'subscription', subjectId: sub.id, correlationId, meta: { attemptNo, provider: config.paymentProvider } });
    await notify(sub.patient_id, 'ESSENCIAL', 'Pagamento não confirmado',
      'Não foi possível confirmar o pagamento; nenhum benefício foi consumido. Tente novamente em "PRIME > Minha assinatura".');
    return { ok: false as const, chargeId };
  }
  // Pagamento confirmado: define o ciclo a partir de agora (primeiro) ou mantém a janela (renovação).
  const starts = cycle.starts_at ?? now;
  const ends = cycle.ends_at ?? addMonths(starts, 1);
  await run(`UPDATE subscription_cycles SET status = 'PAID', starts_at = ?, ends_at = ? WHERE id = ?`, starts, ends, cycle.id);
  const first = !sub.activated_at;
  await run(`UPDATE subscriptions SET status = CASE WHEN status = 'CANCEL_SCHEDULED' THEN status ELSE 'ACTIVE' END,
       activated_at = COALESCE(activated_at, ?), updated_at = ? WHERE id = ?`, now, now, sub.id);
  await audit({ actorId, action: first ? 'PRIME_ACTIVE' : 'PRIME_CYCLE_PAID', subjectType: 'subscription', subjectId: sub.id, correlationId, meta: { cycle: cycle.cycle_no } });
  const text = first
    ? `Seu ONEMA PRIME foi ativado. Mensalidade: ${brl(params.monthly_price_cents)}. Ciclo atual: ${fmtDate(starts)} a ${fmtDate(ends)}. ` +
      `Próxima cobrança prevista: ${fmtDate(ends)}. Desconto disponível neste ciclo: ${params.discount_bps / 100}% em um pedido elegível, até ${brl(params.discount_cap_cents)}. ` +
      `Veja seus termos, preferências e protocolo ${sub.protocol} na Central PRIME.`
    : `Pagamento do ciclo ${cycle.cycle_no} confirmado (${brl(params.monthly_price_cents)}). Ciclo: ${fmtDate(starts)} a ${fmtDate(ends)}.`;
  await receipt(sub.patient_id, first ? 'CONTRATACAO' : 'RENOVACAO', sub.protocol, text);
  await notify(sub.patient_id, 'ESSENCIAL', first ? 'ONEMA PRIME ativado' : 'Pagamento confirmado', text);
  return { ok: true as const, chargeId };
}

/** Motor de ciclos (renovação, novas tentativas, suspensão, encerramento). Idempotente. */
export async function runBilling(now = nowIso(), correlationId: string | null = null) {
  const summary = { renewed: 0, failed: 0, suspended: 0, cancelled: 0, retried: 0 };
  for (const sub of await all<any>(`SELECT * FROM subscriptions WHERE status IN ('ACTIVE','CANCEL_SCHEDULED','PAYMENT_PENDING')`)) {
    const cycle = await cycleById(sub.current_cycle_id);
    const params = await paramsById(sub.parameters_id);
    if (!cycle) continue;
    if (sub.status === 'CANCEL_SCHEDULED' && cycle.ends_at && cycle.ends_at <= now) {
      await run(`UPDATE subscriptions SET status = 'CANCELLED', ended_at = ?, updated_at = ? WHERE id = ?`, cycle.ends_at, now, sub.id);
      await audit({ actorId: null, action: 'CANCELLED', subjectType: 'subscription', subjectId: sub.id, correlationId });
      summary.cancelled++;
      continue;
    }
    if (sub.status === 'ACTIVE' && cycle.status === 'PAID' && cycle.ends_at <= now) {
      const next = uid();
      await run(`INSERT INTO subscription_cycles (id, subscription_id, cycle_no, starts_at, ends_at, status, created_at) VALUES (?,?,?,?,?,?,?)`,
        next, sub.id, cycle.cycle_no + 1, cycle.ends_at, addMonths(cycle.ends_at, 1), 'PENDING', now);
      await run('UPDATE subscriptions SET current_cycle_id = ?, updated_at = ? WHERE id = ?', next, now, sub.id);
      const r = await chargeCycle({ ...sub, current_cycle_id: next }, sub.payment_method, null, correlationId);
      if (r.ok) summary.renewed++; else summary.failed++;
      continue;
    }
    if (sub.status === 'PAYMENT_PENDING' && sub.activated_at && cycle.status !== 'PAID') {
      const attempts = await one<any>('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM charges WHERE cycle_id = ?', cycle.id)!;
      const windowEnd = addDays(cycle.starts_at, params.retry_window_days);
      const retriesDone = attempts.n - 1;
      if (retriesDone >= params.retry_max || now >= windowEnd) {
        await run(`UPDATE subscriptions SET status = 'SUSPENDED', updated_at = ? WHERE id = ?`, now, sub.id);
        await audit({ actorId: null, action: 'PRIME_SUSPENDED', subjectType: 'subscription', subjectId: sub.id, correlationId });
        await notify(sub.patient_id, 'ESSENCIAL', 'Benefícios PRIME suspensos',
          'Os benefícios comerciais do PRIME foram suspensos por pagamento não confirmado. Seus registros e documentos continuam acessíveis. Regularize em "PRIME > Minha assinatura".');
        summary.suspended++;
        continue;
      }
      // Tentativas espaçadas igualmente dentro da janela (configuração provisória).
      const spacingMs = (params.retry_window_days * 86400000) / (params.retry_max + 1);
      if (new Date(now).getTime() - new Date(attempts.last).getTime() >= spacingMs) {
        await chargeCycle(sub, sub.payment_method, null, correlationId);
        summary.retried++;
      }
    }
  }
  // Convites de responsável expirados
  await run(`UPDATE share_grants SET status = 'EXPIRED', updated_at = ? WHERE status IN ('INVITED','ACCEPTED') AND expires_at <= ?`, now, now);
  return summary;
}

export function newSubscriptionProtocol() { return protocol('PRIME'); }
