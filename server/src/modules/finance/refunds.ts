/**
 * Política de reembolso (governança ONEMA, 04/11/2026):
 * - Antes do início do atendimento: reembolso integral, sem multa automática.
 * - Pacote parcialmente realizado: análise do Financeiro com memória de cálculo do saldo.
 * - Sequência: solicitação recebida → análise → valor definido → devolução solicitada ao Asaas → devolvido.
 *   "Devolução solicitada" (estorno pedido) é diferente de "devolvido" (confirmação do Asaas pelo webhook).
 * - As tarifas do provedor são absorvidas pela ONEMA (o paciente recebe o valor definido, sem desconto de taxa).
 */
import { config } from '../../config.ts';
import { all, one, run, tx } from '../../db/db.ts';
import { audit } from '../../lib/audit.ts';
import { refundPayment } from '../../lib/asaas.ts';
import { AppError, conflict, notFound, unprocessable } from '../../lib/errors.ts';
import { brl, nowIso, randomToken, uid } from '../../lib/util.ts';
import { notify, receipt } from '../prime/core.ts';
import { applyPaymentEvent } from '../care/core.ts';
import { notifyRole } from './payouts.ts';

export const REFUND_LABEL: Record<string, string> = {
  SOLICITADO: 'Solicitação recebida', EM_ANALISE: 'Em análise', VALOR_DEFINIDO: 'Valor definido', DEVOLUCAO_SOLICITADA: 'Devolução solicitada ao Asaas',
  DEVOLVIDO: 'Dinheiro devolvido', RECUSADO: 'Não aprovado', FALHA: 'Falha ao solicitar a devolução',
};

/** Memória de cálculo: valor dos atos realizados proporcional ao repasse de cada ato (atos presenciais pesam mais). */
export async function refundCalc(orderId: string) {
  const o = (await one<any>('SELECT * FROM service_orders WHERE id = ?', orderId))!;
  const events = await all<any>(`SELECT e.id, e.label, e.status, e.modality, e.started_at, e.unit_payout_cents, e.specialist_id,
      (SELECT COUNT(*) FROM care_evolutions v WHERE v.event_id = e.id) AS evolutions FROM care_events e WHERE e.order_id = ? ORDER BY e.seq`, orderId);
  // Realizado = concluído, iniciado com o código do paciente ou com evolução registrada (atos remotos não têm "início").
  const done = events.filter((e) => e.status === 'CONCLUIDO' || e.started_at || Number(e.evolutions) > 0);
  // Ato remoto já aceito pode ter acontecido sem registro ainda: nunca é estorno automático.
  const remoteAccepted = events.some((e) => e.status === 'ACEITO' && e.modality === 'REMOTO' && !done.includes(e));
  const paid = o.final_price_cents - (o.refunded_cents ?? 0);
  const weight = (list: any[]) => list.reduce((s, e) => s + (e.unit_payout_cents || 1), 0);
  const total = weight(events) || 1;
  const doneValue = done.length ? Math.round(o.final_price_cents * weight(done) / total) : 0;
  const suggested = Math.max(0, Math.min(paid, o.final_price_cents - doneValue));
  const memo = [
    `Valor pago: ${brl(o.final_price_cents)}${o.refunded_cents ? ` (já devolvido: ${brl(o.refunded_cents)})` : ''}.`,
    `Atos contratados: ${events.length}; realizados ou iniciados: ${done.length}; a cancelar: ${events.length - done.length}.`,
    done.length
      ? `Valor dos atos realizados (proporcional ao peso de cada ato no pacote): ${brl(doneValue)}.`
      : 'Nenhum ato iniciado: reembolso integral, sem multa.',
    `Saldo a devolver: ${brl(suggested)}. Tarifas do meio de pagamento absorvidas pela ONEMA.`,
  ];
  return { order: o, events, done, remoteAccepted, actsTotal: events.length, actsDone: done.length, paid, suggested, memo };
}

/** Paciente (ou o Financeiro em nome dele) pede o reembolso. Sem atos iniciados: integral e automático. */
export async function requestRefund(orderId: string, actorId: string, reason: string, opts: { byStaff?: boolean; correlationId: string }) {
  const r = await tx(async () => {
    const o = await one<any>('SELECT * FROM service_orders WHERE id = ? FOR UPDATE', orderId);
    if (!o) throw notFound('Pedido não encontrado.');
    if (!opts.byStaff && o.patient_id !== actorId) throw notFound('Pedido não encontrado.');
    if (o.status !== 'PAID') throw conflict('NOT_REFUNDABLE', 'Somente pedidos pagos podem ser reembolsados.');
    if (o.contested_at) throw conflict('ORDER_CONTESTED', 'Este pagamento está em contestação no cartão; o reembolso segue pelo processo da contestação.');
    if (await one(`SELECT 1 AS ok FROM care_refunds WHERE order_id = ? AND status NOT IN ('RECUSADO','FALHA','DEVOLVIDO')`, orderId)) throw conflict('REFUND_IN_PROGRESS', 'Já existe um pedido de reembolso em andamento.');
    const c = await refundCalc(orderId);
    if (c.paid <= 0) throw conflict('NOT_REFUNDABLE', 'Não há saldo a devolver neste pedido.');
    const now = nowIso();
    const id = uid();
    const protocol = `REE-${now.slice(0, 10).replace(/-/g, '')}-${randomToken(4).replace(/[^A-Za-z0-9]/g, '').slice(0, 5).toUpperCase()}`;
    const automatic = c.actsDone === 0 && !c.remoteAccepted;
    await run(`INSERT INTO care_refunds (id, order_id, protocol, requested_by, reason, status, acts_total, acts_done, acts_cancelled, paid_cents, suggested_cents, amount_cents, balance_cents, calc_memo,
        decided_by, decision_note, decided_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, orderId, protocol, actorId, reason, automatic ? 'VALOR_DEFINIDO' : 'EM_ANALISE', c.actsTotal, c.actsDone, c.actsTotal - c.actsDone, c.paid, c.suggested,
      automatic ? c.paid : null, automatic ? 0 : null, c.memo.join('\n'), automatic ? null : null, automatic ? 'Regra automática: nenhum ato iniciado — reembolso integral.' : null, automatic ? now : null, now, now);
    await audit({ actorId, action: 'REFUND_REQUESTED', subjectType: 'care_refund', subjectId: id, correlationId: opts.correlationId, meta: { orderId, automatic, byStaff: !!opts.byStaff } });
    if (!automatic) {
      await notifyRole(['FINANCEIRO'], 'Reembolso para análise', `Pedido de reembolso ${protocol} com atos já realizados: definir o saldo em Central › Financeiro.`);
      await notify(o.patient_id, 'ESSENCIAL', 'Reembolso em análise', `Recebemos seu pedido de reembolso (protocolo ${protocol}). Como parte do atendimento já foi realizada, o Financeiro ONEMA calcula o saldo e avisa você.`);
    }
    return { id, automatic };
  });
  if (r.automatic) await executeRefund(r.id, null, opts.correlationId);
  return await refundView(r.id);
}

/** Financeiro define o valor (até o saldo pago) ou recusa, com justificativa. */
export async function decideRefund(id: string, actorId: string, b: { approve: boolean; amountCents?: number; note: string }, correlationId: string) {
  await tx(async () => {
    const f = await one<any>('SELECT * FROM care_refunds WHERE id = ? FOR UPDATE', id);
    if (!f) throw notFound('Reembolso não encontrado.');
    if (f.status !== 'EM_ANALISE') throw conflict('REFUND_NOT_IN_ANALYSIS', 'Este reembolso não está em análise.');
    const now = nowIso();
    if (!b.approve) {
      await run(`UPDATE care_refunds SET status = 'RECUSADO', decided_by = ?, decision_note = ?, decided_at = ?, updated_at = ? WHERE id = ?`, actorId, b.note, now, now, id);
      const o = (await one<any>('SELECT patient_id FROM service_orders WHERE id = ?', f.order_id))!;
      await notify(o.patient_id, 'ESSENCIAL', 'Reembolso não aprovado', `Pedido ${f.protocol}: ${b.note}`);
    } else {
      const amount = b.amountCents ?? f.suggested_cents;
      if (amount < 1 || amount > f.paid_cents) throw unprocessable('INVALID_AMOUNT', `O valor deve ficar entre R$ 0,01 e ${brl(f.paid_cents)}.`);
      const memo = `${f.calc_memo}\nValor definido pelo Financeiro: ${brl(amount)}${amount !== f.suggested_cents ? ` (sugerido ${brl(f.suggested_cents)})` : ''}. Justificativa: ${b.note}`;
      await run(`UPDATE care_refunds SET status = 'VALOR_DEFINIDO', amount_cents = ?, balance_cents = ?, calc_memo = ?, decided_by = ?, decision_note = ?, decided_at = ?, updated_at = ? WHERE id = ?`,
        amount, f.paid_cents - amount, memo, actorId, b.note, now, now, id);
    }
    await audit({ actorId, action: b.approve ? 'REFUND_AMOUNT_DEFINED' : 'REFUND_REJECTED', subjectType: 'care_refund', subjectId: id, correlationId, meta: { amount: b.amountCents ?? null } });
  });
  if (b.approve) await executeRefund(id, actorId, correlationId);
  return await refundView(id);
}

/** Cancela os atos não iniciados (e seus repasses) e solicita a devolução ao Asaas. */
async function executeRefund(id: string, actorId: string | null, correlationId: string) {
  const f = (await one<any>('SELECT * FROM care_refunds WHERE id = ?', id))!;
  const o = (await one<any>('SELECT * FROM service_orders WHERE id = ?', f.order_id))!;
  const full = f.amount_cents >= o.final_price_cents - (o.refunded_cents ?? 0) && f.acts_done === 0;
  const now = nowIso();
  if (o.provider === 'ASAAS' && o.provider_ref) {
    try {
      await refundPayment(o.provider_ref, `Reembolso ONEMA ${f.protocol}`, full ? undefined : f.amount_cents);
    } catch (e: any) {
      if (e instanceof AppError && e.code === 'PAYMENT_PROVIDER_UNAVAILABLE') {
        // Sem resposta: o Asaas pode ter processado. Trata como solicitado; o webhook confirma ou o Financeiro confere no painel.
        await tx(async () => {
          await cancelOpenActs(o.id);
          await run(`UPDATE care_refunds SET status = 'DEVOLUCAO_SOLICITADA', provider_status = 'SEM_RESPOSTA', requested_to_provider_at = ?, updated_at = ? WHERE id = ?`, now, now, id);
        });
        await notifyRole(['FINANCEIRO'], 'Reembolso sem resposta do Asaas', `Confira no painel do Asaas se a devolução do protocolo ${f.protocol} foi registrada. Não repita sem conferir.`);
        await audit({ actorId, action: 'REFUND_PROVIDER_UNCERTAIN', subjectType: 'care_refund', subjectId: id, correlationId });
        return;
      }
      await run(`UPDATE care_refunds SET status = 'FALHA', provider_status = ?, updated_at = ? WHERE id = ?`, String(e?.code ?? 'ERRO').slice(0, 60), nowIso(), id);
      await notifyRole(['FINANCEIRO'], 'Falha ao solicitar reembolso', `O Asaas não aceitou a devolução do protocolo ${f.protocol}: ${String(e?.message ?? '').slice(0, 200)}`);
      await audit({ actorId, action: 'REFUND_PROVIDER_FAILED', subjectType: 'care_refund', subjectId: id, correlationId });
      if (e instanceof AppError) throw e;
      throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'Não foi possível solicitar a devolução agora.');
    }
  }
  await tx(async () => {
    await cancelOpenActs(o.id);
    await run(`UPDATE care_refunds SET status = 'DEVOLUCAO_SOLICITADA', requested_to_provider_at = ?, updated_at = ? WHERE id = ?`, now, now, id);
    await audit({ actorId, action: 'REFUND_SENT_TO_PROVIDER', subjectType: 'care_refund', subjectId: id, correlationId, meta: { amount: f.amount_cents, full } });
    await notify(o.patient_id, 'ESSENCIAL', 'Devolução solicitada', `Protocolo ${f.protocol}: solicitamos a devolução de ${brl(f.amount_cents)}. Você recebe outro aviso quando o dinheiro for devolvido (cartão: conforme a fatura; Pix: na conta de origem).`);
    // Sem provedor real (simulação): a confirmação é imediata.
    if (o.provider !== 'ASAAS') await confirmRefund(o.id, f.amount_cents, `sandbox_refund_${id}`, correlationId);
  });
}

/** Cancela atos ainda não iniciados e os repasses correspondentes (nada é pago por ato cancelado). */
async function cancelOpenActs(orderId: string) {
  const now = nowIso();
  for (const e of await all<any>(`SELECT id, specialist_id FROM care_events WHERE order_id = ? AND status IN ('AGUARDANDO_PAGAMENTO','DISPONIVEL','ACEITO') AND started_at IS NULL`, orderId)) {
    await run(`UPDATE care_events SET status = 'CANCELADO', updated_at = ? WHERE id = ?`, now, e.id);
    await run(`UPDATE payout_entries SET status = 'CANCELADO', updated_at = ? WHERE event_id = ? AND status IN ('RESERVADO','A_LIQUIDAR')`, now, e.id);
    if (e.specialist_id) await notify(e.specialist_id, 'ESSENCIAL', 'Atendimento cancelado', 'Um atendimento que você aceitou foi cancelado pelo paciente antes do início. Ele saiu da sua agenda.');
  }
}

/** Confirmação do dinheiro devolvido (webhook PAYMENT_REFUNDED / PAYMENT_PARTIALLY_REFUNDED ou simulação). */
export async function confirmRefund(orderId: string, amountCents: number | null, effectId: string, correlationId: string | null) {
  const f = await one<any>(`SELECT * FROM care_refunds WHERE order_id = ? AND status = 'DEVOLUCAO_SOLICITADA' ORDER BY created_at DESC LIMIT 1`, orderId);
  const o = (await one<any>('SELECT * FROM service_orders WHERE id = ?', orderId))!;
  const amount = f?.amount_cents ?? amountCents ?? o.final_price_cents;
  const now = nowIso();
  const newRefunded = Math.min(o.final_price_cents, (o.refunded_cents ?? 0) + amount);
  await run('UPDATE service_orders SET refunded_cents = ? WHERE id = ?', newRefunded, orderId);
  // Devolução integral: pedido passa a REFUNDED pelo mesmo caminho do evento do provedor.
  if (newRefunded >= o.final_price_cents && o.status === 'PAID') await applyPaymentEvent({ eventId: effectId, orderId, type: 'PAYMENT_REFUNDED' }, correlationId);
  if (f) {
    const text = `Reembolso ${f.protocol}: ${brl(amount)} devolvido${o.provider === 'ASAAS' ? '' : ' (simulação)'} em ${new Date(now).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}. ` +
      `Pedido ${o.item_code} — ${o.item_name}. Nota fiscal: ${f.nf_status === 'PENDENTE_CONTADOR' ? 'tratamento conforme orientação do contador' : f.nf_status}.`;
    await run(`UPDATE care_refunds SET status = 'DEVOLVIDO', refunded_at = ?, provider_status = 'REFUNDED', receipt_text = ?, updated_at = ? WHERE id = ?`, now, text, now, f.id);
    await receipt(o.patient_id, 'REEMBOLSO', f.protocol, text);
    await notify(o.patient_id, 'ESSENCIAL', 'Dinheiro devolvido', text);
    await audit({ actorId: null, action: 'REFUND_CONFIRMED', subjectType: 'care_refund', subjectId: f.id, correlationId, meta: { amount } });
  }
  return f ? 'REEMBOLSO_DEVOLVIDO' : 'ESTORNO_SEM_SOLICITACAO';
}

export async function refundView(id: string) {
  const f = (await one<any>('SELECT * FROM care_refunds WHERE id = ?', id))!;
  return { refund: { id: f.id, protocol: f.protocol, orderId: f.order_id, status: f.status, statusLabel: REFUND_LABEL[f.status], reason: f.reason, paidCents: f.paid_cents,
    suggestedCents: f.suggested_cents, amountCents: f.amount_cents, balanceCents: f.balance_cents, actsTotal: f.acts_total, actsDone: f.acts_done, actsCancelled: f.acts_cancelled,
    calcMemo: f.calc_memo.split('\n'), decisionNote: f.decision_note, nfStatus: f.nf_status, createdAt: f.created_at, decidedAt: f.decided_at,
    requestedToProviderAt: f.requested_to_provider_at, refundedAt: f.refunded_at, receipt: f.receipt_text } };
}

export const providerIsReal = () => config.paymentProvider === 'ASAAS';
