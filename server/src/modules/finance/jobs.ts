/**
 * Rotina financeira (executada de hora em hora junto com o motor PRIME e sob demanda pelo Financeiro):
 * - conciliação de cobranças de cuidado pendentes (recupera webhook perdido: T16);
 * - conciliação de transferências enviadas/incertas (T06, T07);
 * - alertas D+1 e perto de 48 h dos repasses validados.
 */
import { all, run } from '../../db/db.ts';
import { getPayment } from '../../lib/asaas.ts';
import { config } from '../../config.ts';
import { nowIso } from '../../lib/util.ts';
import { careEvent } from '../payments/asaas-webhook.ts';
import { payoutAlerts, reconcileTransfers } from './payouts.ts';

const PAID = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH']);

export async function reconcileCarePayments(correlationId: string | null) {
  const out = { checked: 0, confirmed: 0 };
  if (config.paymentProvider !== 'ASAAS') return out;
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const before = new Date(Date.now() - 10 * 60_000).toISOString();
  for (const o of await all<any>(`SELECT id, provider_ref FROM service_orders WHERE status = 'PENDING_PAYMENT' AND provider = 'ASAAS' AND provider_ref IS NOT NULL
      AND created_at >= ? AND created_at <= ? ORDER BY created_at LIMIT 30`, since, before)) {
    out.checked++;
    try {
      const p = await getPayment(o.provider_ref);
      if (PAID.has(String(p?.status))) {
        const r = await careEvent(o.id, p, 'CONFIRMED', correlationId);
        if (r === 'PEDIDO_CONFIRMED') out.confirmed++;
      }
    } catch (e: any) { console.warn('[conciliação] pedido', o.id.slice(0, 8), e?.code ?? e?.message); }
  }
  return out;
}

export async function runFinanceJobs(correlationId: string | null = null) {
  const payments = await reconcileCarePayments(correlationId);
  const transfers = await reconcileTransfers(correlationId);
  const alerts = await payoutAlerts();
  await run(`INSERT INTO system_settings (key, value, created_at) VALUES ('finance_last_run', ?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    nowIso(), nowIso());
  return { payments, transfers, alerts };
}
