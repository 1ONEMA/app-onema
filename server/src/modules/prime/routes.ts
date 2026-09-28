import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.ts';
import { all, one, run, tx } from '../../db/db.ts';
import { audit } from '../../lib/audit.ts';
import { idempotent, parse, requireRoles, requireUser } from '../../lib/context.ts';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.ts';
import { addDays, brl, nowIso, protocol, sha256, uid } from '../../lib/util.ts';
import {
  SANDBOX_METHODS, benefitState, chargeCycle, currentParams, cycleById, cycleUsage, fmtDate, fmtDateTime, latestSubscription,
  latestText, newSubscriptionProtocol, notify, openSubscription, paramsById, quote, receipt, sandboxCharge,
} from './core.ts';

const patient = (req: any) => requireRoles(req, ['PACIENTE']);
const PURPOSES = ['LEMBRETES', 'RESUMO_MENSAL', 'OFERTAS'] as const;
/** Frequências de lembrete: valores provisórios (não definidos na fonte) - pendente de validação RT. */
export const REMINDER_FREQUENCIES = ['SEMANAL', 'QUINZENAL', 'MENSAL'] as const;
const methodSchema = z.enum(Object.keys(SANDBOX_METHODS) as [keyof typeof SANDBOX_METHODS, ...(keyof typeof SANDBOX_METHODS)[]]);

const prefSchema = z.object({
  enabled: z.boolean(),
  channels: z.object({ app: z.boolean(), email: z.boolean(), whatsapp: z.boolean() }),
  frequency: z.enum(REMINDER_FREQUENCIES).nullable().optional(),
});
const prefsSchema = z.object({ LEMBRETES: prefSchema, RESUMO_MENSAL: prefSchema, OFERTAS: prefSchema });

function textMeta(t: any) {
  return t ? { id: t.id, code: t.code, version: t.version, title: t.title, contentHash: t.content_hash, legalReview: t.legal_review, rtApprovedAt: t.rt_approved_at } : null;
}

function providerIdentity() {
  const p = one<any>('SELECT * FROM provider_identity WHERE id = 1');
  return {
    brand: 'ONEMA SAÚDE',
    validated: !!p?.validated,
    legalName: p?.validated ? p.legal_name : null,
    cnpj: p?.validated ? p.cnpj : null,
    address: p?.validated ? p.address : null,
    supportChannel: p?.validated ? p.support_channel : null,
  };
}

function getPrefs(patientId: string) {
  const rows = all<any>('SELECT * FROM communication_preferences WHERE patient_id = ?', patientId);
  const out: any = {};
  for (const p of PURPOSES) {
    const r = rows.find((x) => x.purpose === p);
    out[p] = {
      enabled: !!r?.enabled,
      channels: { app: !!r?.channel_app, email: !!r?.channel_email, whatsapp: !!r?.channel_whatsapp },
      frequency: r?.frequency ?? null,
      updatedAt: r?.updated_at ?? null,
    };
  }
  return out;
}

/** Grava preferências e eventos OPT_IN/OPT_OUT por finalidade x canal (A07/A08). */
function savePrefs(patientId: string, prefs: z.infer<typeof prefsSchema>, source: string) {
  const t3 = latestText('T3');
  const before = getPrefs(patientId);
  const now = nowIso();
  for (const p of PURPOSES) {
    const v = prefs[p];
    if (v.channels.whatsapp && !config.whatsappEnabled) {
      throw unprocessable('WHATSAPP_DISABLED', 'O WhatsApp oficial ainda não está habilitado. Nenhuma mensagem será enviada por esse canal.');
    }
    if (p !== 'LEMBRETES' && v.frequency) throw badRequest('VALIDATION', 'Frequência só se aplica a lembretes.');
    const freq = p === 'LEMBRETES' ? (v.enabled ? v.frequency ?? 'MENSAL' : v.frequency ?? null) : p === 'RESUMO_MENSAL' ? 'MENSAL' : null;
    run(`INSERT INTO communication_preferences (patient_id, purpose, enabled, channel_app, channel_email, channel_whatsapp, frequency, text_version, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(patient_id, purpose) DO UPDATE SET enabled = excluded.enabled, channel_app = excluded.channel_app,
         channel_email = excluded.channel_email, channel_whatsapp = excluded.channel_whatsapp, frequency = excluded.frequency,
         text_version = excluded.text_version, updated_at = excluded.updated_at`,
      patientId, p, v.enabled ? 1 : 0, v.channels.app ? 1 : 0, v.channels.email ? 1 : 0, v.channels.whatsapp ? 1 : 0, freq, t3?.version ?? null, now);
    const b = before[p];
    const log = (event: string, channel: string | null, detail?: unknown) =>
      run(`INSERT INTO preference_events (id, patient_id, event, purpose, channel, detail_json, source, text_version, occurred_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        uid(), patientId, event, p, channel, detail ? JSON.stringify(detail) : null, source, t3?.version ?? null, now);
    if (b.enabled !== v.enabled) log(v.enabled ? 'OPT_IN' : 'OPT_OUT', null);
    for (const ch of ['app', 'email', 'whatsapp'] as const) {
      if (b.channels[ch] !== v.channels[ch]) log(v.channels[ch] ? 'OPT_IN' : 'OPT_OUT', ch.toUpperCase());
    }
    if (p === 'LEMBRETES' && b.frequency !== freq && (b.enabled || v.enabled)) log('CHANGE', null, { frequency: freq });
  }
}

function subscriptionView(patientId: string) {
  const sub = openSubscription(patientId) ?? latestSubscription(patientId);
  if (!sub) return null;
  const params = paramsById(sub.parameters_id);
  const cycle = cycleById(sub.current_cycle_id);
  const benefit = benefitState(sub);
  const usage = cycleUsage(cycle?.id);
  const savings = cycle ? one<any>(`SELECT COALESCE(SUM(amount_cents),0) AS s FROM discount_reservations WHERE cycle_id = ? AND status = 'USED'`, cycle.id)!.s : 0;
  const totalSavings = one<any>(`SELECT COALESCE(SUM(amount_cents),0) AS s FROM discount_reservations WHERE subscription_id = ? AND status = 'USED'`, sub.id)!.s;
  return {
    id: sub.id, status: sub.status, protocol: sub.protocol, acceptedAt: sub.accepted_at, activatedAt: sub.activated_at,
    cancelRequestedAt: sub.cancel_requested_at, cancelProtocol: sub.cancel_protocol, endedAt: sub.ended_at,
    paymentMethod: sub.payment_method, paymentMethodLabel: (SANDBOX_METHODS as any)[sub.payment_method] ?? sub.payment_method,
    monthlyPriceCents: params.monthly_price_cents,
    cycle: cycle ? { no: cycle.cycle_no, startsAt: cycle.starts_at, endsAt: cycle.ends_at, status: cycle.status } : null,
    nextChargeAt: sub.status === 'ACTIVE' && cycle?.status === 'PAID' ? cycle.ends_at : null,
    benefit: {
      active: benefit.active, reason: benefit.reason,
      usesPerCycle: params.uses_per_cycle, usesRemaining: benefit.active ? Math.max(0, params.uses_per_cycle - usage.used - usage.reserved) : 0,
      discountBps: params.discount_bps, discountCapCents: params.discount_cap_cents,
      savingsThisCycleCents: savings, totalSavingsCents: totalSavings,
    },
    withdrawalDeadline: addDays(sub.accepted_at, params.refund_withdrawal_days),
    charges: all<any>(`SELECT c.id, c.amount_cents, c.status, c.attempt_no, c.provider, c.created_at, c.settled_at, c.failure_reason, cy.cycle_no
                       FROM charges c JOIN subscription_cycles cy ON cy.id = c.cycle_id WHERE c.subscription_id = ? ORDER BY c.created_at DESC`, sub.id),
    terms: textMeta(one('SELECT * FROM legal_texts WHERE id = ?', sub.terms_text_id)),
    privacy: textMeta(one('SELECT * FROM legal_texts WHERE id = ?', sub.privacy_text_id)),
  };
}

function grantView(g: any) {
  const scopes = all<any>('SELECT * FROM share_scopes WHERE grant_id = ?', g.id);
  const active = (s: string) => { const r = scopes.find((x) => x.scope === s); return !!r && !!r.granted_at && !r.revoked_at; };
  return {
    id: g.id, inviteeName: g.invitee_name, inviteeEmail: g.invitee_email, status: g.status,
    invitedAt: g.invited_at, expiresAt: g.expires_at, acceptedAt: g.accepted_at, verifiedAt: g.verified_at, revokedAt: g.revoked_at,
    scopes: { AGENDA: active('AGENDA'), DOCUMENTOS: active('DOCUMENTOS'), COBRANCAS: active('COBRANCAS') },
    scopeHistory: scopes,
  };
}

export async function primeRoutes(app: FastifyInstance) {
  // Oferta e textos integrais (T1, T2, T3)
  app.get('/api/prime/offer', async (req) => {
    patient(req);
    const p = currentParams();
    return {
      monthlyPriceCents: p.monthly_price_cents, discountBps: p.discount_bps, discountCapCents: p.discount_cap_cents,
      usesPerCycle: p.uses_per_cycle, parametersVersion: p.version,
      terms: textMeta(latestText('T1')), privacy: textMeta(latestText('T2')), choices: textMeta(latestText('T3')),
      paymentMethods: Object.entries(SANDBOX_METHODS).map(([id, label]) => ({ id, label })),
      paymentProvider: config.paymentProvider,
      whatsappEnabled: config.whatsappEnabled,
      reminderFrequencies: REMINDER_FREQUENCIES,
      provider: providerIdentity(),
    };
  });

  app.get('/api/prime/texts/:code', async (req) => {
    requireUser(req);
    const { code } = parse(z.object({ code: z.enum(['T1', 'T2', 'T3']) }), req.params);
    const t = latestText(code);
    if (!t) throw notFound('Texto não encontrado.');
    return { ...textMeta(t), body: t.body };
  });

  app.get('/api/prime/texts/by-id/:id', async (req) => {
    const a = patient(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    // Somente textos que o próprio paciente aceitou (comprovante da versão aceita)
    const ok = one('SELECT 1 FROM subscriptions WHERE patient_id = ? AND (terms_text_id = ? OR privacy_text_id = ?)', a.userId, id, id);
    if (!ok) throw notFound();
    const t = one<any>('SELECT * FROM legal_texts WHERE id = ?', id)!;
    return { ...textMeta(t), body: t.body };
  });

  // Minha assinatura / extrato
  app.get('/api/prime/me', async (req) => {
    const a = patient(req);
    return {
      subscription: subscriptionView(a.userId),
      receipts: all('SELECT id, kind, protocol, text, created_at FROM prime_receipts WHERE patient_id = ? ORDER BY created_at DESC LIMIT 100', a.userId),
      refunds: all(`SELECT id, type, status, protocol, amount_cents, requested_at, decided_at, provider_result FROM refund_requests WHERE requested_by = ? ORDER BY requested_at DESC`, a.userId),
      provider: providerIdentity(),
    };
  });

  // Adesão: aceite obrigatório separado das escolhas opcionais (nenhuma pré-marcada)
  app.post('/api/prime/subscriptions', async (req, reply) => {
    const a = patient(req);
    const body = parse(z.object({
      acceptTerms: z.literal(true, { message: 'É necessário aceitar os Termos ONEMA PRIME para continuar.' }),
      termsTextId: z.string().uuid(),
      privacyTextId: z.string().uuid(),
      paymentMethod: methodSchema,
      preferences: prefsSchema,
    }), req.body);
    return idempotent(req, reply, 'prime-subscribe', () => {
      if (openSubscription(a.userId)) throw conflict('ALREADY_SUBSCRIBED', 'Você já possui uma assinatura PRIME em andamento.');
      const t1 = latestText('T1'), t2 = latestText('T2');
      if (!t1 || !t2 || body.termsTextId !== t1.id || body.privacyTextId !== t2.id) {
        throw conflict('TERMS_OUTDATED', 'Os termos foram atualizados. Revise a versão vigente antes de confirmar.');
      }
      const params = currentParams();
      const now = nowIso();
      const id = uid(), cycleId = uid(), proto = newSubscriptionProtocol();
      const acceptance = {
        acceptedAt: now, source: 'PWA', termsVersion: t1.version, termsHash: t1.content_hash, privacyVersion: t2.version, privacyHash: t2.content_hash,
        mandatoryCheckboxText: 'T3 · Checkbox obrigatório da assinatura', parametersVersion: params.version,
        userAgentHash: sha256(String(req.headers['user-agent'] ?? '')).slice(0, 16), ipHash: sha256(req.ip).slice(0, 16),
      };
      run(`INSERT INTO subscriptions (id, patient_id, status, parameters_id, terms_text_id, privacy_text_id, acceptance_json, payment_method, protocol, accepted_at, created_at, updated_at, current_cycle_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, a.userId, 'ASSINATURA_SOLICITADA', params.id, t1.id, t2.id, JSON.stringify(acceptance), body.paymentMethod, proto, now, now, now, cycleId);
      run(`INSERT INTO subscription_cycles (id, subscription_id, cycle_no, status, created_at) VALUES (?,?,?,?,?)`, cycleId, id, 1, 'PENDING', now);
      savePrefs(a.userId, body.preferences, 'ADESAO_PRIME');
      audit({ actorId: a.userId, action: 'ASSINATURA_SOLICITADA', subjectType: 'subscription', subjectId: id, after: acceptance, correlationId: req.correlationId });
      const sub = one<any>('SELECT * FROM subscriptions WHERE id = ?', id);
      const r = chargeCycle(sub, body.paymentMethod, a.userId, req.correlationId);
      return { status: 201, body: { paid: r.ok, subscription: subscriptionView(a.userId),
        message: r.ok ? null : 'Não foi possível confirmar o pagamento; nenhum benefício foi consumido. Tente novamente.' } };
    });
  });

  // Pagamento/regularização do ciclo pendente
  app.post('/api/prime/subscriptions/current/pay', async (req, reply) => {
    const a = patient(req);
    const { paymentMethod } = parse(z.object({ paymentMethod: methodSchema }), req.body);
    return idempotent(req, reply, 'prime-pay', () => {
      const sub = openSubscription(a.userId);
      if (!sub) throw notFound('Nenhuma assinatura em andamento.');
      if (!['ASSINATURA_SOLICITADA', 'PAYMENT_PENDING', 'SUSPENDED'].includes(sub.status)) throw conflict('NOTHING_TO_CHARGE', 'Não há cobrança pendente.');
      const r = chargeCycle(sub, paymentMethod, a.userId, req.correlationId);
      return { status: 200, body: { paid: r.ok, subscription: subscriptionView(a.userId),
        message: r.ok ? null : 'Não foi possível confirmar o pagamento; nenhum benefício foi consumido. Tente novamente.' } };
    });
  });

  // Cancelamento digital direto, sem pesquisa de retenção (T1 §6)
  app.post('/api/prime/subscriptions/current/cancel', async (req, reply) => {
    const a = patient(req);
    return idempotent(req, reply, 'prime-cancel', () => {
      const sub = openSubscription(a.userId);
      if (!sub) throw notFound('Nenhuma assinatura em andamento.');
      if (sub.status === 'CANCEL_SCHEDULED') throw conflict('ALREADY_CANCELLED', 'O cancelamento já foi solicitado.');
      const now = nowIso();
      const proto = protocol('CANC');
      const cycle = cycleById(sub.current_cycle_id);
      const paidCycle = cycle?.status === 'PAID' && cycle.ends_at > now;
      const newStatus = paidCycle ? 'CANCEL_SCHEDULED' : 'CANCELLED';
      run(`UPDATE subscriptions SET status = ?, cancel_requested_at = ?, cancel_protocol = ?, ended_at = ?, updated_at = ? WHERE id = ?`,
        newStatus, now, proto, paidCycle ? null : now, now, sub.id);
      const until = paidCycle ? fmtDate(cycle!.ends_at) : fmtDate(now);
      const text = `Recebemos seu cancelamento do ONEMA PRIME em ${fmtDateTime(now)}. Protocolo: ${proto}. Não haverá renovação após o ciclo atual. ` +
        `Benefícios comerciais disponíveis até ${until}, ressalvados os direitos legais e eventuais estornos. Seus registros e documentos assistenciais continuam acessíveis.`;
      receipt(a.userId, 'CANCELAMENTO', proto, text);
      notify(a.userId, 'ESSENCIAL', 'Cancelamento registrado', text);
      audit({ actorId: a.userId, action: newStatus === 'CANCEL_SCHEDULED' ? 'CANCEL_SCHEDULED' : 'CANCELLED', subjectType: 'subscription', subjectId: sub.id, correlationId: req.correlationId });
      return { status: 200, body: { protocol: proto, text, subscription: subscriptionView(a.userId) } };
    });
  });

  // Arrependimento (7 dias) e estorno, vinculados à cobrança original (T1 §7; A09)
  app.post('/api/prime/refund-requests', async (req, reply) => {
    const a = patient(req);
    const body = parse(z.object({
      type: z.enum(['ARREPENDIMENTO', 'ESTORNO']),
      reason: z.string().trim().max(1000).optional(),
    }), req.body);
    return idempotent(req, reply, 'prime-refund', () => {
      const sub = latestSubscription(a.userId);
      if (!sub) throw notFound('Nenhuma assinatura encontrada.');
      const params = paramsById(sub.parameters_id);
      const charge = one<any>(`SELECT * FROM charges WHERE subscription_id = ? AND status = 'CONFIRMED' ORDER BY created_at ${body.type === 'ARREPENDIMENTO' ? 'ASC' : 'DESC'} LIMIT 1`, sub.id);
      if (!charge) throw unprocessable('NO_CONFIRMED_CHARGE', 'Não há cobrança confirmada para estornar.');
      if (one(`SELECT 1 FROM refund_requests WHERE charge_id = ? AND status IN ('REFUND_PENDING','REFUNDED')`, charge.id)) {
        throw conflict('REFUND_EXISTS', 'Já existe uma solicitação para esta cobrança.');
      }
      const now = nowIso();
      if (body.type === 'ARREPENDIMENTO') {
        if (now > addDays(sub.accepted_at, params.refund_withdrawal_days)) {
          throw unprocessable('WITHDRAWAL_EXPIRED', `O prazo de arrependimento de ${params.refund_withdrawal_days} dias terminou. Você pode solicitar análise de estorno.`);
        }
      } else if (!body.reason || body.reason.length < 5) {
        throw badRequest('VALIDATION', 'Descreva o motivo do pedido de estorno.');
      }
      const proto = protocol('EST');
      const id = uid();
      run(`INSERT INTO refund_requests (id, subscription_id, charge_id, type, reason, amount_cents, status, protocol, requested_by, requested_at, provider)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, sub.id, charge.id, body.type, body.reason ?? null, charge.amount_cents, 'REFUND_PENDING', proto, a.userId, now, charge.provider);
      if (body.type === 'ARREPENDIMENTO') {
        run(`UPDATE subscriptions SET status = 'REFUND_PENDING', cancel_requested_at = COALESCE(cancel_requested_at, ?), cancel_protocol = COALESCE(cancel_protocol, ?), ended_at = ?, updated_at = ? WHERE id = ?`,
          now, proto, now, now, sub.id);
        // Reserva de desconto ainda não consumida é liberada de forma auditável
        run(`UPDATE discount_reservations SET status = 'RELEASED', release_reason = 'ARREPENDIMENTO', updated_at = ? WHERE subscription_id = ? AND status = 'RESERVED'`, now, sub.id);
      }
      const text = `Solicitação de ${body.type === 'ARREPENDIMENTO' ? 'arrependimento' : 'estorno'} registrada em ${fmtDateTime(now)}. Protocolo: ${proto}. ` +
        `Cobrança original: ${brl(charge.amount_cents)} de ${fmtDate(charge.created_at)}. Acompanhe o andamento na Central PRIME. Seus registros assistenciais continuam acessíveis.`;
      receipt(a.userId, body.type, proto, text);
      notify(a.userId, 'ESSENCIAL', 'Solicitação registrada', text);
      audit({ actorId: a.userId, action: 'REFUND_PENDING', subjectType: 'refund', subjectId: id, correlationId: req.correlationId, meta: { type: body.type, chargeId: charge.id } });
      return { status: 201, body: { protocol: proto, text } };
    });
  });

  // Preferências (finalidade x canal x frequência)
  app.get('/api/prime/preferences', async (req) => {
    const a = patient(req);
    return {
      preferences: getPrefs(a.userId),
      whatsappEnabled: config.whatsappEnabled,
      reminderFrequencies: REMINDER_FREQUENCIES,
      events: all('SELECT event, purpose, channel, source, occurred_at FROM preference_events WHERE patient_id = ? ORDER BY occurred_at DESC LIMIT 50', a.userId),
      dispatchConfigured: false,
    };
  });
  app.put('/api/prime/preferences', async (req) => {
    const a = patient(req);
    const body = parse(prefsSchema, req.body);
    tx(() => {
      savePrefs(a.userId, body, 'PREFERENCIAS');
      audit({ actorId: a.userId, action: 'PREFERENCES_UPDATED', subjectType: 'user', subjectId: a.userId, correlationId: req.correlationId });
    });
    return { preferences: getPrefs(a.userId) };
  });

  // Catálogo e checkout com desconto (reserva/consumo único por ciclo)
  app.get('/api/prime/catalog', async (req) => {
    patient(req);
    const now = nowIso();
    return {
      items: all<any>(`SELECT code, name, kind, price_cents, prime_eligible, is_demo FROM catalog_items WHERE active = 1
                       AND (valid_from IS NULL OR valid_from <= ?) AND (valid_to IS NULL OR valid_to >= ?) ORDER BY kind, price_cents`, now, now),
      notice: 'Serviços e pacotes são contratados e precificados separadamente. Nenhum ato assistencial está incluído na mensalidade PRIME.',
    };
  });
  app.post('/api/prime/orders/quote', async (req) => {
    const a = patient(req);
    const { itemCode } = parse(z.object({ itemCode: z.string().min(1).max(60) }), req.body);
    const { _internal, ...q } = quote(a.userId, itemCode);
    return q;
  });
  app.post('/api/prime/orders', async (req, reply) => {
    const a = patient(req);
    const body = parse(z.object({
      itemCode: z.string().min(1).max(60), paymentMethod: methodSchema,
      expectedFinalPriceCents: z.number().int().min(0),
    }), req.body);
    return idempotent(req, reply, 'prime-order', () => {
      const q = quote(a.userId, body.itemCode);
      const { item, sub, cycle } = q._internal;
      if (q.finalPriceCents !== body.expectedFinalPriceCents) {
        const { _internal, ...fresh } = q;
        throw conflict('PRICE_CHANGED', q.noDiscountReason
          ? `O valor mudou desde a sua consulta: ${q.noDiscountReason}. Confira o novo total antes de pagar.`
          : 'O valor mudou desde a sua consulta. Confira o novo total antes de pagar.', { quote: fresh });
      }
      const now = nowIso();
      const orderId = uid();
      run(`INSERT INTO service_orders (id, patient_id, catalog_item_id, item_code, item_name, item_kind, full_price_cents, discount_cents, final_price_cents,
           payout_basis_cents, no_discount_reason, status, provider, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        orderId, a.userId, item.id, item.code, item.name, item.kind, q.fullPriceCents, q.discountCents, q.finalPriceCents,
        q.fullPriceCents, q.noDiscountReason, 'PENDING_PAYMENT', config.paymentProvider, now);
      let reservationId: string | null = null;
      if (q.discountCents > 0) {
        reservationId = uid();
        try {
          run(`INSERT INTO discount_reservations (id, subscription_id, cycle_id, order_id, amount_cents, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
            reservationId, sub.id, cycle.id, orderId, q.discountCents, 'RESERVED', now, now);
        } catch {
          throw conflict('DISCOUNT_ALREADY_USED', 'O desconto PRIME já foi usado neste ciclo');
        }
        audit({ actorId: a.userId, action: 'DESCONTO_RESERVADO', subjectType: 'service_order', subjectId: orderId, correlationId: req.correlationId, meta: { cycleId: cycle.id } });
      }
      const pay = sandboxCharge(body.paymentMethod);
      if (pay.ok) {
        run(`UPDATE service_orders SET status = 'PAID', provider_ref = ?, paid_at = ? WHERE id = ?`, pay.ref, now, orderId);
        if (reservationId) {
          run(`UPDATE discount_reservations SET status = 'USED', updated_at = ? WHERE id = ?`, now, reservationId);
          audit({ actorId: a.userId, action: 'DESCONTO_USADO', subjectType: 'service_order', subjectId: orderId, correlationId: req.correlationId });
        }
        audit({ actorId: a.userId, action: 'ORDER_PAID', subjectType: 'service_order', subjectId: orderId, correlationId: req.correlationId, meta: { item: item.code } });
      } else {
        run(`UPDATE service_orders SET status = 'FAILED', provider_ref = ? WHERE id = ?`, pay.ref, orderId);
        if (reservationId) {
          run(`UPDATE discount_reservations SET status = 'RELEASED', release_reason = 'PAGAMENTO_NAO_CONFIRMADO', updated_at = ? WHERE id = ?`, now, reservationId);
          audit({ actorId: a.userId, action: 'DESCONTO_LIBERADO', subjectType: 'service_order', subjectId: orderId, correlationId: req.correlationId });
        }
        audit({ actorId: a.userId, action: 'ORDER_PAYMENT_FAILED', subjectType: 'service_order', subjectId: orderId, correlationId: req.correlationId });
      }
      const order = one<any>('SELECT * FROM service_orders WHERE id = ?', orderId);
      return {
        status: 201, body: {
          order, paid: pay.ok,
          message: pay.ok ? 'Pedido registrado e pagamento confirmado (simulação).' : 'Não foi possível confirmar o pagamento; nenhum benefício foi consumido. Tente novamente.',
        },
      };
    });
  });
  app.get('/api/prime/orders', async (req) => {
    const a = patient(req);
    return { orders: all('SELECT * FROM service_orders WHERE patient_id = ? ORDER BY created_at DESC LIMIT 100', a.userId) };
  });

  // ---- Responsável principal (titular) ----
  app.get('/api/prime/share', async (req) => {
    const a = patient(req);
    const grants = all<any>('SELECT * FROM share_grants WHERE patient_id = ? ORDER BY invited_at DESC', a.userId);
    const sub = openSubscription(a.userId);
    return {
      primeActive: benefitState(sub).active,
      grants: grants.map(grantView),
      accessLog: all(`SELECT l.scope, l.result, l.accessed_at, u.name AS accessor FROM share_access_log l JOIN share_grants g ON g.id = l.grant_id
                      JOIN users u ON u.id = l.accessor_id WHERE g.patient_id = ? ORDER BY l.accessed_at DESC LIMIT 100`, a.userId),
      inviteText: latestText('T3') ? 'Quero convidar esta pessoa para me apoiar na ONEMA. Entendo que a ela será mostrado somente o que eu marcar: minha agenda; meus documentos clínicos; minhas cobranças e recibos. Poderei alterar ou retirar essas permissões. O acesso começa apenas depois que o convite e a autorização forem verificados pela ONEMA.' : null,
    };
  });

  const scopesSchema = z.object({ AGENDA: z.boolean(), DOCUMENTOS: z.boolean(), COBRANCAS: z.boolean() });
  function applyScopes(grantId: string, scopes: z.infer<typeof scopesSchema>, now: string) {
    for (const s of ['AGENDA', 'DOCUMENTOS', 'COBRANCAS'] as const) {
      const cur = one<any>('SELECT * FROM share_scopes WHERE grant_id = ? AND scope = ?', grantId, s);
      const active = !!cur && !!cur.granted_at && !cur.revoked_at;
      if (scopes[s] && !active) {
        run(`INSERT INTO share_scopes (grant_id, scope, granted_at, revoked_at) VALUES (?,?,?,NULL)
             ON CONFLICT(grant_id, scope) DO UPDATE SET granted_at = excluded.granted_at, revoked_at = NULL`, grantId, s, now);
      } else if (!scopes[s] && active) {
        run('UPDATE share_scopes SET revoked_at = ? WHERE grant_id = ? AND scope = ?', now, grantId, s);
      }
    }
  }

  app.post('/api/prime/share/invites', async (req, reply) => {
    const a = patient(req);
    const body = parse(z.object({
      name: z.string().trim().min(3).max(120),
      email: z.string().trim().toLowerCase().email('Informe um e-mail válido.'),
      scopes: scopesSchema,
      acknowledge: z.literal(true, { message: 'Confirme a declaração do convite.' }),
    }), req.body);
    return idempotent(req, reply, 'share-invite', () => {
      if (!benefitState(openSubscription(a.userId)).active) {
        throw forbidden('O convite a um responsável principal é um recurso do ONEMA PRIME ativo.', 'PRIME_REQUIRED');
      }
      if (body.email === a.email.toLowerCase()) throw badRequest('VALIDATION', 'Você não pode convidar a si mesmo.');
      if (!body.scopes.AGENDA && !body.scopes.DOCUMENTOS && !body.scopes.COBRANCAS) throw badRequest('VALIDATION', 'Selecione ao menos uma permissão.');
      if (one(`SELECT 1 FROM share_grants WHERE patient_id = ? AND status IN ('INVITED','ACCEPTED','VERIFIED')`, a.userId)) {
        throw conflict('PRINCIPAL_EXISTS', 'No lançamento é permitido um único responsável principal. Revogue o atual para convidar outra pessoa.');
      }
      const id = uid(), now = nowIso();
      const invitee = one<any>('SELECT id FROM users WHERE email = ?', body.email);
      run(`INSERT INTO share_grants (id, patient_id, invitee_email, invitee_name, invitee_user_id, status, text_version, invited_at, expires_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`, id, a.userId, body.email, body.name, null, 'INVITED', latestText('T3')?.version ?? 'T3', now, addDays(now, config.shareInviteTtlDays), now);
      applyScopes(id, body.scopes, now);
      if (invitee) notify(invitee.id, 'ESSENCIAL', 'Convite para apoiar um paciente', `${a.name} convidou você para ser responsável principal na ONEMA. Veja em "Convites recebidos".`);
      run(`INSERT INTO outbox_messages (id, channel, purpose, recipient_user_id, recipient_address, template, payload_json, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        uid(), 'EMAIL', 'ESSENCIAL', invitee?.id ?? null, body.email, 'SHARE_INVITE', JSON.stringify({ grantId: id }), 'NAO_ENVIADO_SEM_PROVEDOR', now);
      audit({ actorId: a.userId, action: 'SHARE_INVITED', subjectType: 'share_grant', subjectId: id, correlationId: req.correlationId, meta: { scopes: body.scopes } });
      return { status: 201, body: { grant: grantView(one('SELECT * FROM share_grants WHERE id = ?', id)) } };
    });
  });

  app.put('/api/prime/share/:id/scopes', async (req) => {
    const a = patient(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const scopes = parse(scopesSchema, req.body);
    return tx(() => {
      const g = one<any>('SELECT * FROM share_grants WHERE id = ? AND patient_id = ?', id, a.userId);
      if (!g) throw notFound();
      if (!['INVITED', 'ACCEPTED', 'VERIFIED'].includes(g.status)) throw conflict('GRANT_CLOSED', 'Este convite não está mais ativo.');
      const before = grantView(g).scopes;
      const now = nowIso();
      applyScopes(id, scopes, now);
      for (const s of ['AGENDA', 'DOCUMENTOS', 'COBRANCAS'] as const) {
        if (before[s] && !scopes[s]) {
          const person = g.invitee_name;
          const label = { AGENDA: 'agenda', DOCUMENTOS: 'documentos clínicos', COBRANCAS: 'cobranças e recibos' }[s];
          const text = `A permissão concedida a ${person} para ${label} foi revogada em ${fmtDateTime(now)}. A pessoa não poderá fazer novos acessos a esse conteúdo por sua autorização. ` +
            'O histórico de acessos realizados e os registros legalmente necessários permanecem guardados conforme o Aviso de Privacidade.';
          receipt(a.userId, 'REVOGACAO', null, text);
          audit({ actorId: a.userId, action: 'SHARE_REVOKED', subjectType: 'share_grant', subjectId: id, correlationId: req.correlationId, meta: { scope: s } });
        } else if (!before[s] && scopes[s]) {
          audit({ actorId: a.userId, action: 'SHARE_GRANTED', subjectType: 'share_grant', subjectId: id, correlationId: req.correlationId, meta: { scope: s } });
        }
      }
      run('UPDATE share_grants SET updated_at = ? WHERE id = ?', now, id);
      return { grant: grantView(one('SELECT * FROM share_grants WHERE id = ?', id)) };
    });
  });

  app.post('/api/prime/share/:id/revoke', async (req) => {
    const a = patient(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    return tx(() => {
      const g = one<any>('SELECT * FROM share_grants WHERE id = ? AND patient_id = ?', id, a.userId);
      if (!g) throw notFound();
      if (!['INVITED', 'ACCEPTED', 'VERIFIED'].includes(g.status)) throw conflict('GRANT_CLOSED', 'Este convite já está encerrado.');
      const now = nowIso();
      run(`UPDATE share_grants SET status = 'REVOKED', revoked_at = ?, updated_at = ? WHERE id = ?`, now, now, id);
      run('UPDATE share_scopes SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL', now, id);
      const text = `A permissão concedida a ${g.invitee_name} para agenda, documentos clínicos e cobranças foi revogada em ${fmtDateTime(now)}. ` +
        'A pessoa não poderá fazer novos acessos a esse conteúdo por sua autorização. O histórico de acessos realizados e os registros legalmente necessários permanecem guardados conforme o Aviso de Privacidade.';
      receipt(a.userId, 'REVOGACAO', null, text);
      if (g.invitee_user_id) notify(g.invitee_user_id, 'ESSENCIAL', 'Permissão revogada', `O acesso concedido por ${a.name} foi revogado.`);
      audit({ actorId: a.userId, action: 'SHARE_REVOKED', subjectType: 'share_grant', subjectId: id, correlationId: req.correlationId, meta: { scope: 'ALL' } });
      return { text };
    });
  });

  // ---- Convidado (responsável) ----
  app.get('/api/prime/share/received', async (req) => {
    const a = requireUser(req);
    const rows = all<any>(`SELECT g.*, u.name AS patient_name FROM share_grants g JOIN users u ON u.id = g.patient_id
                           WHERE (g.invitee_user_id = ? OR (g.invitee_user_id IS NULL AND g.invitee_email = ?)) ORDER BY g.invited_at DESC`, a.userId, a.email);
    return { grants: rows.map((g) => ({ ...grantView(g), patientName: g.patient_name })) };
  });

  app.post('/api/prime/share/:id/accept', async (req) => {
    const a = requireUser(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    return tx(() => {
      const g = one<any>('SELECT * FROM share_grants WHERE id = ?', id);
      if (!g || (g.invitee_email.toLowerCase() !== a.email.toLowerCase())) throw notFound('Convite não encontrado.');
      if (g.status !== 'INVITED') throw conflict('INVALID_STATE', 'Este convite não está disponível para aceite.');
      if (g.expires_at <= nowIso()) throw conflict('INVITE_EXPIRED', 'Este convite expirou. Peça ao titular um novo convite.');
      const now = nowIso();
      run(`UPDATE share_grants SET status = 'ACCEPTED', invitee_user_id = ?, accepted_at = ?, updated_at = ? WHERE id = ?`, a.userId, now, now, id);
      notify(g.patient_id, 'ESSENCIAL', 'Convite aceito', `${g.invitee_name} aceitou o convite. O acesso começa após a verificação da ONEMA.`);
      audit({ actorId: a.userId, action: 'SHARE_ACCEPTED', subjectType: 'share_grant', subjectId: id, correlationId: req.correlationId });
      return { ok: true, message: 'Convite aceito. O acesso começa apenas depois da verificação da autorização pela ONEMA.' };
    });
  });

  app.post('/api/prime/share/:id/decline', async (req) => {
    const a = requireUser(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const g = one<any>('SELECT * FROM share_grants WHERE id = ?', id);
    if (!g || g.invitee_email.toLowerCase() !== a.email.toLowerCase()) throw notFound('Convite não encontrado.');
    if (!['INVITED', 'ACCEPTED'].includes(g.status)) throw conflict('INVALID_STATE', 'Convite indisponível.');
    const now = nowIso();
    run(`UPDATE share_grants SET status = 'REJECTED', updated_at = ? WHERE id = ?`, now, id);
    run('UPDATE share_scopes SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL', now, id);
    audit({ actorId: a.userId, action: 'SHARE_DECLINED', subjectType: 'share_grant', subjectId: id, correlationId: req.correlationId });
    return { ok: true };
  });

  // Acesso do responsável: somente escopo concedido, verificado e não revogado (A06). Todo acesso é registrado.
  app.get('/api/prime/share/:id/view/:scope', async (req) => {
    const a = requireUser(req);
    const { id, scope } = parse(z.object({ id: z.string().uuid(), scope: z.enum(['AGENDA', 'DOCUMENTOS', 'COBRANCAS']) }), req.params);
    const g = one<any>('SELECT * FROM share_grants WHERE id = ?', id);
    if (!g || g.invitee_user_id !== a.userId) throw notFound();
    const s = one<any>('SELECT * FROM share_scopes WHERE grant_id = ? AND scope = ?', id, scope);
    const allowed = g.status === 'VERIFIED' && !!s?.granted_at && !s.revoked_at;
    run(`INSERT INTO share_access_log (id, grant_id, accessor_id, scope, result, accessed_at) VALUES (?,?,?,?,?,?)`, uid(), id, a.userId, scope, allowed ? 'PERMITIDO' : 'NEGADO', nowIso());
    if (!allowed) {
      if (g.status === 'ACCEPTED') throw forbidden('Seu acesso ainda não foi verificado pela ONEMA.', 'SHARE_NOT_VERIFIED');
      throw forbidden('Você não tem permissão para este conteúdo.', 'SHARE_SCOPE_DENIED');
    }
    const patientName = one<any>('SELECT name FROM users WHERE id = ?', g.patient_id)!.name;
    if (scope === 'COBRANCAS') {
      const sub = latestSubscription(g.patient_id);
      return {
        patientName, scope, available: true,
        charges: sub ? all(`SELECT c.amount_cents, c.status, c.created_at, cy.cycle_no FROM charges c JOIN subscription_cycles cy ON cy.id = c.cycle_id WHERE c.subscription_id = ? ORDER BY c.created_at DESC`, sub.id) : [],
        orders: all(`SELECT item_name, final_price_cents, status, created_at FROM service_orders WHERE patient_id = ? ORDER BY created_at DESC LIMIT 50`, g.patient_id),
      };
    }
    return {
      patientName, scope, available: false,
      reason: scope === 'AGENDA'
        ? 'A agenda de atendimentos é mantida pela Central Operacional/motor ONEMA. A integração com este aplicativo ainda não foi disponibilizada.'
        : 'Os documentos clínicos pertencem à Carteira Digital/prontuário. A integração com este aplicativo ainda não foi disponibilizada.',
    };
  });

  // ---- Minha ONEMA: somente eventos reais registrados ----
  app.get('/api/prime/hub', async (req) => {
    const a = patient(req);
    const sub = openSubscription(a.userId) ?? latestSubscription(a.userId);
    const timeline = [
      ...all<any>('SELECT created_at AS at, kind, protocol, text FROM prime_receipts WHERE patient_id = ?', a.userId).map((r) => ({ at: r.at, type: r.kind, title: labelKind(r.kind), detail: r.text })),
      ...all<any>('SELECT created_at AS at, item_name, status, final_price_cents FROM service_orders WHERE patient_id = ?', a.userId)
        .map((o) => ({ at: o.at, type: 'PEDIDO', title: `Pedido: ${o.item_name}`, detail: `${brl(o.final_price_cents)} · ${o.status === 'PAID' ? 'pago' : o.status === 'FAILED' ? 'pagamento não confirmado' : o.status.toLowerCase()}` })),
    ].sort((x, y) => (x.at < y.at ? 1 : -1)).slice(0, 50);
    return {
      prime: sub ? { status: sub.status, benefitActive: benefitState(sub).active } : null,
      integrations: {
        carteiraDigital: { available: false, reason: 'Integração com a Carteira Digital pendente (sistema existente não disponibilizado para esta entrega).' },
        agenda: { available: false, reason: 'Integração com a agenda da Central Operacional pendente.' },
        continuidade: { available: false, reason: 'O plano de continuidade só exibe tarefas registradas e assinadas pelo profissional. A fonte desses registros ainda não está integrada.' },
      },
      timeline,
    };
  });
}

function labelKind(k: string) {
  return ({ CONTRATACAO: 'ONEMA PRIME ativado', RENOVACAO: 'Renovação confirmada', CANCELAMENTO: 'Cancelamento registrado', ARREPENDIMENTO: 'Arrependimento solicitado',
    ESTORNO: 'Estorno solicitado', REVOGACAO: 'Permissão revogada', ESTORNO_CONCLUIDO: 'Estorno concluído' } as Record<string, string>)[k] ?? k;
}
