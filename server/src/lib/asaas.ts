/**
 * Cliente da API v3 do Asaas (somente no servidor; a chave nunca vai ao navegador).
 * Ambiente pelo prefixo da chave: `$aact_hmlg_` = sandbox do Asaas; demais = produção.
 * O paciente paga na página hospedada do Asaas (invoiceUrl): dados de cartão não passam pela ONEMA.
 */
import { config } from '../config.ts';
import { AppError, unprocessable } from './errors.ts';
import { one, run } from '../db/db.ts';

export const asaasBaseUrl = () =>
  config.asaasApiKey.startsWith('$aact_hmlg_') ? 'https://api-sandbox.asaas.com/v3' : 'https://api.asaas.com/v3';

type Transport = (method: string, url: string, headers: Record<string, string>, body?: string) => Promise<{ status: number; json: any }>;
const httpTransport: Transport = async (method, url, headers, body) => {
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(8000) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json };
};
let transport: Transport = httpTransport;
/** Testes automatizados substituem o transporte por um Asaas simulado. */
export const setAsaasTransport = (t: Transport | null) => { transport = t ?? httpTransport; };

export async function asaas<T = any>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  let r: { status: number; json: any };
  try {
    r = await transport(method, `${asaasBaseUrl()}${path}`, {
      'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'ONEMA-SAUDE/1.0', access_token: config.asaasApiKey,
    }, body === undefined ? undefined : JSON.stringify(body));
  } catch {
    throw new AppError(502, 'PAYMENT_PROVIDER_UNAVAILABLE', 'O serviço de pagamento não respondeu. Nada foi cobrado. Tente novamente em instantes.');
  }
  if (r.status >= 200 && r.status < 300) return r.json as T;
  const detail = Array.isArray(r.json?.errors) ? r.json.errors.map((e: any) => String(e.description ?? '')).filter(Boolean).join(' ') : '';
  console.error(`[asaas] ${method} ${path.split('?')[0]} → ${r.status}`, detail.slice(0, 300));
  if (r.status === 401) throw new AppError(502, 'PAYMENT_PROVIDER_AUTH', 'Pagamento indisponível no momento (configuração do provedor). Nada foi cobrado.');
  throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', detail ? `O serviço de pagamento recusou a operação: ${detail}` : 'O serviço de pagamento recusou a operação. Nada foi cobrado.');
}

/** Data de hoje em São Paulo (AAAA-MM-DD), usada como vencimento das cobranças. */
export const todaySP = (plusDays = 0) => new Date(Date.now() + plusDays * 86400000).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const reais = (cents: number) => Math.round(cents) / 100;

/**
 * Cliente Asaas do usuário. O CPF é repassado ao Asaas uma única vez, na primeira cobrança,
 * e não é guardado pela ONEMA (minimização, LGPD): guardamos só o id do cliente no Asaas.
 */
export async function ensureCustomer(userId: string, cpf?: string | null): Promise<string> {
  const u = (await one<any>('SELECT id, name, email, asaas_customer_id FROM users WHERE id = ?', userId))!;
  if (u.asaas_customer_id) return u.asaas_customer_id;
  if (!cpf) throw unprocessable('CPF_REQUIRED', 'Informe o CPF de quem vai pagar. Ele é exigido pelo serviço de pagamento para emitir a cobrança.');
  const found = await asaas<any>('GET', `/customers?cpfCnpj=${cpf}&externalReference=${encodeURIComponent(userId)}`);
  const c = found?.data?.[0] ?? await asaas<any>('POST', '/customers', {
    name: u.name, cpfCnpj: cpf, email: u.email, externalReference: userId, notificationDisabled: false,
  });
  await run('UPDATE users SET asaas_customer_id = ? WHERE id = ?', c.id, userId);
  return c.id;
}

export async function createPayment(p: { customer: string; valueCents: number; description: string; externalReference: string; billingType?: string }) {
  const r = await asaas<any>('POST', '/payments', {
    // Vencimento em 2 dias: dá tempo para boleto/Pix; cartão é cobrado na hora.
    customer: p.customer, billingType: p.billingType ?? 'UNDEFINED', value: reais(p.valueCents), dueDate: todaySP(2),
    description: p.description.slice(0, 500), externalReference: p.externalReference,
  });
  return { id: String(r.id), invoiceUrl: String(r.invoiceUrl ?? '') };
}
export const cancelPayment = (id: string) => asaas('DELETE', `/payments/${encodeURIComponent(id)}`);
export const refundPayment = (id: string, description: string) => asaas('POST', `/payments/${encodeURIComponent(id)}/refund`, { description: description.slice(0, 200) });

/** Assinatura mensal (PRIME). Cartão: o Asaas guarda o cartão no 1º pagamento e renova sozinho; Pix/boleto: link a cada mês. */
export async function createSubscription(p: { customer: string; valueCents: number; billingType: 'CREDIT_CARD' | 'UNDEFINED'; description: string; externalReference: string }) {
  const r = await asaas<any>('POST', '/subscriptions', {
    customer: p.customer, billingType: p.billingType, value: reais(p.valueCents), nextDueDate: todaySP(), cycle: 'MONTHLY',
    description: p.description.slice(0, 500), externalReference: p.externalReference,
  });
  const pays = await asaas<any>('GET', `/subscriptions/${encodeURIComponent(r.id)}/payments`);
  const first = pays?.data?.[0];
  return { id: String(r.id), firstPayment: first ? { id: String(first.id), invoiceUrl: String(first.invoiceUrl ?? '') } : null };
}
export const cancelSubscription = (id: string) => asaas('DELETE', `/subscriptions/${encodeURIComponent(id)}`);
