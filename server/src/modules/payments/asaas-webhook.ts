/**
 * Webhook do Asaas: POST /api/payments/asaas/webhook
 * - Autenticação: cabeçalho `asaas-access-token` igual a ASAAS_WEBHOOK_TOKEN (comparação em tempo constante).
 * - Cada evento (id `evt_...`) é processado uma única vez; o Asaas reenvia enquanto não recebe 200.
 * - O estado do pagamento vem SOMENTE daqui (nunca da página de sucesso do navegador).
 * - Valor pago conferido com o pedido; divergência não libera nada e fica registrada.
 */
import type { FastifyInstance } from 'fastify';
import { config } from '../../config.ts';
import { one, run, tx } from '../../db/db.ts';
import { audit } from '../../lib/audit.ts';
import { forbidden } from '../../lib/errors.ts';
import { safeEqual } from '../../lib/security.ts';
import { addMonths, nowIso, uid } from '../../lib/util.ts';
import { applyPaymentEvent as applyCareEvent } from '../care/core.ts';
import { applyPaymentEvent as applyAcademyEvent } from '../academy/routes.ts';
import { confirmCycle, cycleById, notify, paramsById } from '../prime/core.ts';

const PAID = new Set(['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED']);
// Vencida (OVERDUE) ainda pode ser paga: só pausa o PRIME. Cobrança removida (DELETED) encerra o pedido.
const FAILED = new Set(['PAYMENT_OVERDUE', 'PAYMENT_DELETED']);
const REFUNDED = new Set(['PAYMENT_REFUNDED']);
const cents = (v: unknown) => Math.round(Number(v) * 100);
/** Situação da cobrança no Asaas (PENDING, OVERDUE, RECEIVED...). */
const paymentStatus = (p: any) => String(p?.status ?? '');

/** Processa um evento já autenticado. Devolve o resultado registrado (para auditoria e testes). */
export async function handleAsaasEvent(body: any, correlationId: string | null): Promise<string> {
  const eventId = String(body?.id ?? '');
  const event = String(body?.event ?? '');
  const p = body?.payment ?? null;
  if (!eventId || !event) return 'IGNORADO_SEM_ID';
  return await tx(async () => {
    if (await one('SELECT 1 AS ok FROM asaas_webhook_events WHERE event_id = ?', eventId)) return 'DUPLICADO';
    let outcome = 'IGNORADO';
    if (p && (PAID.has(event) || FAILED.has(event) || REFUNDED.has(event))) {
      const ref = String(p.externalReference ?? '');
      const kind = PAID.has(event) ? 'CONFIRMED' : REFUNDED.has(event) ? 'REFUNDED' : 'DECLINED';
      if (ref.startsWith('care:')) outcome = await careEvent(ref.slice(5), p, kind, correlationId);
      else if (ref.startsWith('academy:')) outcome = await academyEvent(ref.slice(8), p, kind, correlationId);
      else if (p.subscription) outcome = await primeEvent(String(p.subscription), p, kind, correlationId);
      else outcome = 'SEM_REFERENCIA';
    }
    await run('INSERT INTO asaas_webhook_events (event_id, event, payment_id, outcome, received_at) VALUES (?,?,?,?,?)', eventId, event, p?.id ?? null, outcome, nowIso());
    return outcome;
  });
}

async function careEvent(orderId: string, p: any, kind: string, correlationId: string | null) {
  const o = await one<any>('SELECT * FROM service_orders WHERE id = ?', orderId);
  if (!o || o.provider_ref !== String(p.id)) return 'PEDIDO_NAO_ENCONTRADO';
  if (kind === 'DECLINED' && paymentStatus(p) === 'OVERDUE') return 'PEDIDO_VENCIDO_AGUARDANDO';
  if (kind === 'CONFIRMED' && o.status === 'FAILED') {
    // Pago depois de cancelado: não libera sozinho; a Central decide (estorno ou reativação) com o registro.
    await audit({ actorId: null, action: 'PAYMENT_AFTER_CANCEL', subjectType: 'service_order', subjectId: o.id, correlationId, meta: { asaasPayment: String(p.id) } });
    return 'PAGO_APOS_CANCELAMENTO';
  }
  if (kind === 'CONFIRMED' && cents(p.value) !== o.final_price_cents) {
    await audit({ actorId: null, action: 'PAYMENT_VALUE_MISMATCH', subjectType: 'service_order', subjectId: o.id, correlationId, meta: { paid: cents(p.value), expected: o.final_price_cents } });
    return 'VALOR_DIVERGENTE';
  }
  // Mesmo id de efeito para CONFIRMED e RECEIVED: o segundo vira repetição e não altera nada.
  const r = await applyCareEvent({ eventId: `asaas_${p.id}_${kind}`, orderId, type: `PAYMENT_${kind}` as any }, correlationId);
  return r.applied ? `PEDIDO_${kind}` : 'PEDIDO_SEM_MUDANCA';
}

async function academyEvent(orderId: string, p: any, kind: string, correlationId: string | null) {
  const o = await one<any>('SELECT * FROM academy_payment_orders WHERE id = ?', orderId);
  if (!o || o.provider_ref !== String(p.id)) return 'ACADEMY_NAO_ENCONTRADO';
  if (kind === 'DECLINED' && paymentStatus(p) === 'OVERDUE') return 'ACADEMY_VENCIDO_AGUARDANDO';
  if (kind === 'CONFIRMED' && cents(p.value) !== o.amount_cents) {
    await audit({ actorId: null, action: 'PAYMENT_VALUE_MISMATCH', subjectType: 'academy_order', subjectId: o.id, correlationId, meta: { paid: cents(p.value), expected: o.amount_cents } });
    return 'VALOR_DIVERGENTE';
  }
  const r: any = await applyAcademyEvent({ eventId: `asaas_${p.id}_${kind}`, orderId, type: `PAYMENT_${kind}` }, correlationId);
  return r.duplicate || r.ignored ? 'ACADEMY_SEM_MUDANCA' : `ACADEMY_${kind}`;
}

async function primeEvent(asaasSubId: string, p: any, kind: string, correlationId: string | null) {
  const sub = await one<any>('SELECT * FROM subscriptions WHERE provider_ref = ?', asaasSubId);
  if (!sub) return 'PRIME_NAO_ENCONTRADO';
  const params = await paramsById(sub.parameters_id);
  const now = nowIso();
  let charge = await one<any>('SELECT * FROM charges WHERE provider_ref = ?', String(p.id));
  if (kind === 'REFUNDED') {
    if (charge && charge.status !== 'REFUNDED') await run(`UPDATE charges SET status = 'REFUNDED' WHERE id = ?`, charge.id);
    return charge ? 'PRIME_ESTORNADO' : 'PRIME_SEM_COBRANCA';
  }
  let cycle = await cycleById(sub.current_cycle_id);
  if (kind === 'CONFIRMED') {
    if (cents(p.value) !== params.monthly_price_cents) {
      await audit({ actorId: null, action: 'PAYMENT_VALUE_MISMATCH', subjectType: 'subscription', subjectId: sub.id, correlationId, meta: { paid: cents(p.value), expected: params.monthly_price_cents } });
      return 'VALOR_DIVERGENTE';
    }
    if (charge?.status === 'CONFIRMED') return 'PRIME_SEM_MUDANCA';
    // Renovação paga antes de o motor abrir o próximo ciclo: abre o ciclo seguinte agora.
    if (cycle?.status === 'PAID' && ['ACTIVE', 'CANCEL_SCHEDULED'].includes(sub.status) && !charge) {
      if (sub.status === 'CANCEL_SCHEDULED') return 'PRIME_CANCELADA';
      const next = uid();
      await run(`INSERT INTO subscription_cycles (id, subscription_id, cycle_no, starts_at, ends_at, status, created_at) VALUES (?,?,?,?,?,?,?)`,
        next, sub.id, cycle.cycle_no + 1, cycle.ends_at, addMonths(cycle.ends_at, 1), 'PENDING', now);
      await run('UPDATE subscriptions SET current_cycle_id = ?, updated_at = ? WHERE id = ?', next, now, sub.id);
      cycle = await cycleById(next);
    }
    if (!cycle || cycle.status === 'PAID') return 'PRIME_SEM_MUDANCA';
    charge ??= await one<any>(`SELECT * FROM charges WHERE cycle_id = ? AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1`, cycle.id);
    if (charge) await run(`UPDATE charges SET status = 'CONFIRMED', provider_ref = ?, settled_at = ? WHERE id = ?`, String(p.id), now, charge.id);
    else {
      const n = (await one<any>('SELECT COUNT(*)+1 AS n FROM charges WHERE cycle_id = ?', cycle.id))!.n;
      await run(`INSERT INTO charges (id, subscription_id, cycle_id, amount_cents, attempt_no, status, provider, provider_ref, created_at, settled_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        uid(), sub.id, cycle.id, params.monthly_price_cents, n, 'CONFIRMED', 'ASAAS', String(p.id), now, now);
    }
    await confirmCycle(await one<any>('SELECT * FROM subscriptions WHERE id = ?', sub.id), cycle, params, null, correlationId);
    return 'PRIME_PAGO';
  }
  // Vencida ou removida: benefício fica pendente; o Asaas segue tentando/avisando conforme a configuração da conta.
  if (charge && charge.status === 'PENDING') await run(`UPDATE charges SET status = 'FAILED', failure_reason = ?, settled_at = ? WHERE id = ?`, 'Cobrança vencida ou cancelada no Asaas', now, charge.id);
  if (['ACTIVE', 'ASSINATURA_SOLICITADA'].includes(sub.status) && cycle?.status !== 'PAID') {
    await run(`UPDATE subscriptions SET status = 'PAYMENT_PENDING', updated_at = ? WHERE id = ?`, now, sub.id);
    await notify(sub.patient_id, 'ESSENCIAL', 'Pagamento do PRIME pendente',
      'A cobrança do ONEMA PRIME não foi paga no vencimento. Os benefícios ficam pausados até a regularização em "PRIME > Minha assinatura".');
  }
  return 'PRIME_PENDENTE';
}

export async function asaasWebhookRoutes(app: FastifyInstance) {
  app.post('/api/payments/asaas/webhook', { config: { public: true } }, async (req) => {
    const token = String(req.headers['asaas-access-token'] ?? '');
    if (!config.asaasWebhookToken || !safeEqual(token, config.asaasWebhookToken)) {
      await audit({ actorId: null, action: 'ASAAS_WEBHOOK_REJECTED', subjectType: 'webhook', correlationId: req.correlationId });
      throw forbidden('Token do webhook inválido.', 'INVALID_WEBHOOK_TOKEN');
    }
    const outcome = await handleAsaasEvent(req.body, req.correlationId);
    return { received: true, outcome };
  });
}
