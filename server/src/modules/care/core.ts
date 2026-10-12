/**
 * Motor de pedidos de cuidado (Comando Oficial de Precificação, seções 4, 5 e 6).
 *  - orçamento: preço da versão vigente + desconto PRIME (5%, teto R$ 20, um pedido por ciclo) + total
 *  - pedido: cópia dos valores aceitos, eventos filhos (atos) com repasse por componente
 *  - pagamento: eventos do provedor aplicados uma única vez (provider_event_id único)
 *  - repasse integral ao especialista, independente do desconto; um repasse por evento
 */
import { config } from '../../config.ts';
import { all, isUniqueViolation, one, run } from '../../db/db.ts';
import { REPORT_PARAMS } from '../../db/content/pricing-v1.ts';
import { audit } from '../../lib/audit.ts';
import { conflict, notFound, unprocessable } from '../../lib/errors.ts';
import { brl, nowIso, uid } from '../../lib/util.ts';
import { currentParams, notify, quote, receipt, sandboxCharge } from '../prime/core.ts';
import { offerByCode, publicOffer } from './catalog.ts';

/** Mês de referência (São Paulo) para ofertas mensais: chave de não duplicidade CAT-08/PAC-05. */
export function billingPeriod(iso = nowIso()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).formatToParts(new Date(iso));
  return `${p.find((x) => x.type === 'year')!.value}-${p.find((x) => x.type === 'month')!.value}`;
}

/** Contribuição gerencial (seção 6.5). Não é lucro líquido nem cálculo fiscal. */
export function contribution(receivedCents: number, payoutCents: number, acts: number) {
  const costs = Math.floor((receivedCents * REPORT_PARAMS.rateBps + 5000) / 10000);
  const value = receivedCents - payoutCents - costs - acts * REPORT_PARAMS.opCostPerActCents;
  const marginBps = receivedCents > 0 ? Math.round((value * 10000) / receivedCents) : 0;
  return { costsCents: costs, contributionCents: value, marginBps, warn: marginBps < REPORT_PARAMS.warnBelowBps };
}

export interface RequestFields {
  need: string; itemCode: string; materials: 'SIM' | 'NAO' | 'NAO_SEI'; materialsSupplyRequested: boolean;
}

/** Orçamento completo de uma solicitação (sem efeitos colaterais). */
export async function buildQuote(patientId: string, f: RequestFields, quoteVersion: number, now = nowIso()) {
  const offer = await offerByCode(f.itemCode, now);
  if (!offer || !offer.item.active) throw notFound('Atendimento não disponível no catálogo.');
  if (offer.item.need !== f.need) throw unprocessable('NEED_MISMATCH', 'O atendimento escolhido não corresponde à necessidade selecionada.');
  const q = await quote(patientId, f.itemCode, now);
  const params = await currentParams();
  const pendingReasons: string[] = [];
  if (f.materialsSupplyRequested) {
    pendingReasons.push('Fornecimento de materiais pela ONEMA: não há item, preço e fornecedor aprovados. O orçamento fica pendente e o pagamento bloqueado até o valor completo.');
  }
  const noDiscountReason = q.discountCents ? null
    : q.noDiscountReason ?? `Desconto PRIME disponível somente para assinantes ativos (adesão separada de ${brl(params.monthly_price_cents)}/mês).`;
  return {
    quoteVersion, issuedAt: now,
    offer: publicOffer(offer),
    basePriceCents: q.fullPriceCents,
    additions: [] as { label: string; cents: number }[],
    discountCents: q.discountCents,
    totalCents: q.finalPriceCents,
    noDiscountReason,
    primeActive: q.primeActive,
    prime: { monthlyPriceCents: params.monthly_price_cents, discountBps: params.discount_bps, capCents: params.discount_cap_cents },
    pending: pendingReasons.length > 0,
    pendingReasons,
    materials: f.materials,
  };
}

interface PlaceOrderInput {
  patientId: string; itemCode: string; paymentMethod: string; expectedTotalCents: number;
  request?: { id: string; location: string; acceptedSnapshot: any } | null;
  correlationId: string | null;
}

/** Cria o pedido (dentro da transação do chamador) e processa a cobrança simulada. */
export async function placeOrder(inp: PlaceOrderInput) {
  const now = nowIso();
  const q = await quote(inp.patientId, inp.itemCode, now);
  const { sub, cycle } = q._internal;
  if (q.finalPriceCents !== inp.expectedTotalCents) {
    const { _internal, ...fresh } = q;
    throw conflict('PRICE_CHANGED', q.noDiscountReason
      ? `O valor mudou desde a sua consulta: ${q.noDiscountReason}. Confira o novo total antes de pagar.`
      : 'O valor mudou desde a sua consulta. Confira o novo total antes de pagar.', { quote: fresh });
  }
  const offer = (await offerByCode(inp.itemCode, now))!;
  const { item, version, components } = offer;
  const period = version.recurring === 'MENSAL' ? billingPeriod(now) : null;
  if (period && await one(`SELECT 1 FROM service_orders WHERE patient_id = ? AND canonical_code = ? AND billing_period = ? AND status IN ('PENDING_PAYMENT','PAID')`,
    inp.patientId, item.canonical_code, period)) {
    throw conflict('ALREADY_CONTRACTED', 'Este monitoramento mensal já está contratado neste mês. CAT-08 e PAC-05 são a mesma oferta: não há segunda cobrança.');
  }
  const orderId = uid();
  const snapshot = {
    item: publicOffer(offer), versionId: version.id, versionNo: version.version, components,
    payoutTotalCents: version.payout_total_cents, actsTotal: version.acts_total,
    basePriceCents: q.fullPriceCents, discountCents: q.discountCents, totalCents: q.finalPriceCents,
    noDiscountReason: q.noDiscountReason, cycleId: q.discountCents ? cycle!.id : null, request: inp.request?.acceptedSnapshot ?? null,
  };
  try {
    await run(`INSERT INTO service_orders (id, patient_id, catalog_item_id, item_code, item_name, item_kind, full_price_cents, discount_cents, final_price_cents,
         payout_basis_cents, no_discount_reason, status, provider, created_at, request_id, version_id, version_no, canonical_code, billing_period,
         payout_total_cents, acts_total, snapshot_json, cycle_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      orderId, inp.patientId, item.id, item.code, item.name, item.kind, q.fullPriceCents, q.discountCents, q.finalPriceCents,
      q.fullPriceCents, q.noDiscountReason, 'PENDING_PAYMENT', config.paymentProvider, now, inp.request?.id ?? null, version.id, version.version,
      item.canonical_code ?? item.code, period, version.payout_total_cents, version.acts_total, JSON.stringify(snapshot), q.discountCents ? cycle!.id : null);
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('ALREADY_CONTRACTED', 'Já existe um pedido em andamento ou pago para esta contratação.');
    throw e;
  }
  // Eventos filhos (quantidade finita); aguardam pagamento antes de virar oferta ao especialista.
  let seq = 0;
  for (const c of components) {
    for (let i = 0; i < c.qty; i++) {
      seq++;
      const label = c.unitLabels?.[i] ?? (c.qty > 1 ? `${c.label} ${i + 1}/${c.qty}` : c.label);
      await run(`INSERT INTO care_events (id, order_id, seq, act_type, label, modality, unit_payout_cents, status, region, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`, uid(), orderId, seq, c.act, label, c.modality, c.unit, 'AGUARDANDO_PAGAMENTO', inp.request?.location ?? null, now, now);
    }
  }
  if (q.discountCents > 0) {
    try {
      await run(`INSERT INTO discount_reservations (id, subscription_id, cycle_id, order_id, amount_cents, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
        uid(), sub.id, cycle.id, orderId, q.discountCents, 'RESERVED', now, now);
    } catch {
      throw conflict('DISCOUNT_ALREADY_USED', 'O desconto PRIME já foi usado neste ciclo');
    }
    await audit({ actorId: inp.patientId, action: 'DESCONTO_RESERVADO', subjectType: 'service_order', subjectId: orderId, correlationId: inp.correlationId, meta: { cycleId: cycle.id } });
  }
  await audit({ actorId: inp.patientId, action: 'ORDER_CREATED', subjectType: 'service_order', subjectId: orderId, correlationId: inp.correlationId,
    meta: { item: item.code, version: version.version, total: q.finalPriceCents } });
  const pay = sandboxCharge(inp.paymentMethod);
  await run('UPDATE service_orders SET provider_ref = ? WHERE id = ?', pay.ref, orderId);
  // O retorno do provedor é tratado como evento (o mesmo caminho do webhook): idempotente por id do evento.
  await applyPaymentEvent({ eventId: `${pay.ref}_${pay.ok ? 'ok' : 'fail'}`, orderId, type: pay.ok ? 'PAYMENT_CONFIRMED' : 'PAYMENT_DECLINED' }, inp.correlationId);
  const order = await one<any>('SELECT * FROM service_orders WHERE id = ?', orderId);
  return { order, paid: pay.ok };
}

const TRANSITIONS: Record<string, { from: string; to: string }> = {
  PAYMENT_CONFIRMED: { from: 'PENDING_PAYMENT', to: 'PAID' },
  PAYMENT_DECLINED: { from: 'PENDING_PAYMENT', to: 'FAILED' },
  PAYMENT_REFUNDED: { from: 'PAID', to: 'REFUNDED' },
};
export type PaymentEventType = keyof typeof TRANSITIONS;

/**
 * Aplica um evento do provedor de pagamento (sandbox ou webhook). Repetição do mesmo evento,
 * ou evento fora de ordem, não altera nada (P05/P06). Deve rodar dentro de transação.
 */
export async function applyPaymentEvent(ev: { eventId: string; orderId: string; type: PaymentEventType; actorId?: string | null }, correlationId: string | null) {
  const o = await one<any>('SELECT * FROM service_orders WHERE id = ? FOR UPDATE', ev.orderId);
  if (!o) throw notFound('Pedido não encontrado.');
  if (await one('SELECT 1 FROM care_payment_events WHERE provider_event_id = ?', ev.eventId)) {
    return { duplicate: true, applied: false, status: o.status };
  }
  const t = TRANSITIONS[ev.type];
  const applies = o.status === t.from;
  const now = nowIso();
  await run('INSERT INTO care_payment_events (id, provider_event_id, order_id, type, applied, received_at) VALUES (?,?,?,?,?,?)',
    uid(), ev.eventId, o.id, ev.type, applies ? 1 : 0, now);
  if (!applies) {
    await audit({ actorId: ev.actorId ?? null, action: 'PAYMENT_EVENT_IGNORED', subjectType: 'service_order', subjectId: o.id, correlationId, meta: { type: ev.type, status: o.status } });
    return { duplicate: false, applied: false, status: o.status };
  }
  const reservation = await one<any>(`SELECT * FROM discount_reservations WHERE order_id = ? AND status IN ('RESERVED','USED')`, o.id);
  if (ev.type === 'PAYMENT_CONFIRMED') {
    await run(`UPDATE service_orders SET status = 'PAID', paid_at = ? WHERE id = ?`, now, o.id);
    if (reservation?.status === 'RESERVED') {
      await run(`UPDATE discount_reservations SET status = 'USED', updated_at = ? WHERE id = ?`, now, reservation.id);
      await audit({ actorId: ev.actorId ?? null, action: 'DESCONTO_USADO', subjectType: 'service_order', subjectId: o.id, correlationId });
    }
    await run(`UPDATE care_events SET status = 'DISPONIVEL', updated_at = ? WHERE order_id = ? AND status = 'AGUARDANDO_PAGAMENTO'`, now, o.id);
    // Reserva do repasse integral por evento (unicidade por evento impede reserva dupla).
    for (const e of await all<any>('SELECT id, unit_payout_cents FROM care_events WHERE order_id = ?', o.id)) {
      await run(`INSERT INTO payout_entries (id, order_id, event_id, amount_cents, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)
           ON CONFLICT (event_id) DO NOTHING`, uid(), o.id, e.id, e.unit_payout_cents, 'RESERVADO', now, now);
    }
    if (o.request_id) await run(`UPDATE care_requests SET status = 'PEDIDO_GERADO', order_id = ?, updated_at = ? WHERE id = ?`, o.id, now, o.request_id);
    await audit({ actorId: ev.actorId ?? null, action: 'ORDER_PAID', subjectType: 'service_order', subjectId: o.id, correlationId, meta: { item: o.item_code } });
    const text = `Pedido ${o.item_code} — ${o.item_name} (versão ${o.version_no ?? 1}). Preço: ${brl(o.full_price_cents)}. Desconto PRIME: ${brl(o.discount_cents)}. ` +
      `Total pago: ${brl(o.final_price_cents)} (pagamento simulado). Próximo passo: a Central ONEMA confirma a agenda com um especialista validado.`;
    await receipt(o.patient_id, 'PEDIDO', o.id.slice(0, 8).toUpperCase(), text);
    await notify(o.patient_id, 'ESSENCIAL', 'Pedido confirmado', text);
  } else if (ev.type === 'PAYMENT_DECLINED') {
    await run(`UPDATE service_orders SET status = 'FAILED' WHERE id = ?`, o.id);
    if (reservation) {
      await run(`UPDATE discount_reservations SET status = 'RELEASED', release_reason = 'PAGAMENTO_NAO_CONFIRMADO', updated_at = ? WHERE id = ?`, now, reservation.id);
      await audit({ actorId: ev.actorId ?? null, action: 'DESCONTO_LIBERADO', subjectType: 'service_order', subjectId: o.id, correlationId });
    }
    await run(`UPDATE care_events SET status = 'CANCELADO', updated_at = ? WHERE order_id = ?`, now, o.id);
    await audit({ actorId: ev.actorId ?? null, action: 'ORDER_PAYMENT_FAILED', subjectType: 'service_order', subjectId: o.id, correlationId });
  } else {
    // Estorno: atualiza pelo evento original; o uso do desconto do ciclo NÃO é devolvido como novo uso.
    await run(`UPDATE service_orders SET status = 'REFUNDED', refunded_at = ? WHERE id = ?`, now, o.id);
    if (reservation) await run(`UPDATE discount_reservations SET release_reason = 'PEDIDO_ESTORNADO_SEM_NOVO_USO', updated_at = ? WHERE id = ?`, now, reservation.id);
    const open = await all<any>(`SELECT id FROM care_events WHERE order_id = ? AND status <> 'CONCLUIDO'`, o.id);
    for (const e of open) {
      await run(`UPDATE care_events SET status = 'CANCELADO', updated_at = ? WHERE id = ?`, now, e.id);
      await run(`UPDATE payout_entries SET status = 'CANCELADO', updated_at = ? WHERE event_id = ? AND status = 'RESERVADO'`, now, e.id);
    }
    await audit({ actorId: ev.actorId ?? null, action: 'ORDER_REFUNDED', subjectType: 'service_order', subjectId: o.id, correlationId, meta: { cancelledEvents: open.length } });
    await notify(o.patient_id, 'ESSENCIAL', 'Pedido estornado', `O pedido ${o.item_code} — ${o.item_name} foi estornado (${brl(o.final_price_cents)}, simulação).`);
  }
  return { duplicate: false, applied: true, status: t.to };
}

/** Visão do pedido para o titular: sem repasses nem margens. */
export function patientOrderView(o: any) {
  const snap = o.snapshot_json ? JSON.parse(o.snapshot_json) : null;
  return {
    id: o.id, itemCode: o.item_code, itemName: o.item_name, kind: o.item_kind, versionNo: o.version_no, status: o.status,
    basePriceCents: o.full_price_cents, discountCents: o.discount_cents, totalCents: o.final_price_cents, noDiscountReason: o.no_discount_reason,
    actsTotal: o.acts_total, billingPeriod: o.billing_period, provider: o.provider, providerRef: o.provider_ref,
    createdAt: o.created_at, paidAt: o.paid_at, refundedAt: o.refunded_at, offer: snap?.item ?? null, cycleId: o.cycle_id,
  };
}
