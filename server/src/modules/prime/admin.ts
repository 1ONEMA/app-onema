import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.ts';
import { all, one, run, tx } from '../../db/db.ts';
import { audit } from '../../lib/audit.ts';
import { parse, requireRoles } from '../../lib/context.ts';
import { conflict, notFound, unprocessable } from '../../lib/errors.ts';
import { brl, nowIso, uid } from '../../lib/util.ts';
import { currentParams, fmtDate, fmtDateTime, notify, receipt, runBilling } from './core.ts';

const idParam = z.object({ id: z.string().uuid() });

/** Gates HML -> produção (documento PRIME, seção "Gates de passagem"; critério A11). */
export function productionGates() {
  const provider = one<any>('SELECT * FROM provider_identity WHERE id = 1');
  const texts = all<any>(`SELECT code, version, legal_review FROM legal_texts t WHERE created_at = (SELECT MAX(created_at) FROM legal_texts WHERE code = t.code)`);
  const gates = [
    { id: 'G6-FORNECEDOR', label: 'Identificação do fornecedor (razão social, CNPJ, endereço, canal de atendimento) validada', ok: !!provider?.validated },
    { id: 'G6-JURIDICO', label: 'Revisão jurídica final de T1–T3 e Aviso de Privacidade', ok: texts.length >= 3 && texts.every((t) => t.legal_review === 'APROVADO') },
    { id: 'PAGAMENTO', label: 'Provedor de pagamento real integrado e homologado (P-009)', ok: config.paymentProvider !== 'SANDBOX' },
    { id: 'G7-G8', label: 'Aceites finais e decisão formal de produção registrados', ok: false },
  ];
  return { productionReady: gates.every((g) => g.ok), gates };
}

export async function primeAdminRoutes(app: FastifyInstance) {
  app.get('/api/admin/prime/overview', async (req) => {
    requireRoles(req, ['ADMIN_PRIME', 'FINANCEIRO', 'AUDITOR']);
    return {
      subscriptionsByStatus: all('SELECT status, COUNT(*) AS total FROM subscriptions GROUP BY status'),
      charges: all('SELECT status, COUNT(*) AS total, SUM(amount_cents) AS amount_cents FROM charges GROUP BY status'),
      orders: all('SELECT status, COUNT(*) AS total, SUM(final_price_cents) AS amount_cents, SUM(discount_cents) AS discount_cents FROM service_orders GROUP BY status'),
      discounts: all('SELECT status, COUNT(*) AS total, SUM(amount_cents) AS amount_cents FROM discount_reservations GROUP BY status'),
      refunds: all('SELECT type, status, COUNT(*) AS total FROM refund_requests GROUP BY type, status'),
      shares: all('SELECT status, COUNT(*) AS total FROM share_grants GROUP BY status'),
      optOut: all(`SELECT purpose, event, COUNT(*) AS total FROM preference_events GROUP BY purpose, event`),
      ...productionGates(),
      paymentProvider: config.paymentProvider,
    };
  });

  // Parâmetros comerciais versionados (RBAC + log)
  app.get('/api/admin/prime/parameters', async (req) => {
    requireRoles(req, ['ADMIN_PRIME', 'FINANCEIRO', 'AUDITOR']);
    return { current: currentParams(), history: all('SELECT * FROM prime_parameters ORDER BY version DESC') };
  });
  app.post('/api/admin/prime/parameters', async (req) => {
    const a = requireRoles(req, ['ADMIN_PRIME']);
    const b = parse(z.object({
      monthlyPriceCents: z.number().int().min(1), discountBps: z.number().int().min(0).max(10000), discountCapCents: z.number().int().min(0),
      usesPerCycle: z.number().int().min(0).max(10), retryMax: z.number().int().min(0).max(10), retryWindowDays: z.number().int().min(1).max(30),
      refundWithdrawalDays: z.number().int().min(7, 'O prazo legal mínimo de arrependimento é de 7 dias.').max(60),
      sourceNote: z.string().trim().min(10, 'Informe a decisão/documento que fundamenta a alteração.').max(1000),
    }), req.body);
    return tx(() => {
      const cur = currentParams();
      const id = uid();
      run(`INSERT INTO prime_parameters (id, version, monthly_price_cents, discount_bps, discount_cap_cents, uses_per_cycle, retry_max, retry_window_days, refund_withdrawal_days, source_note, created_by, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, id, cur.version + 1, b.monthlyPriceCents, b.discountBps, b.discountCapCents, b.usesPerCycle, b.retryMax, b.retryWindowDays,
        b.refundWithdrawalDays, b.sourceNote, a.userId, nowIso());
      audit({ actorId: a.userId, action: 'PRIME_PARAMETERS_CHANGED', subjectType: 'prime_parameters', subjectId: id, before: cur, after: b, correlationId: req.correlationId });
      return { id, version: cur.version + 1, note: 'Novos parâmetros valem para novas adesões. Assinaturas existentes mantêm os parâmetros aceitos (sem alteração retroativa).' };
    });
  });

  // Identificação do fornecedor (A11)
  app.get('/api/admin/prime/provider-identity', async (req) => {
    requireRoles(req, ['ADMIN_PRIME', 'AUDITOR']);
    return { provider: one('SELECT * FROM provider_identity WHERE id = 1') ?? null };
  });
  app.put('/api/admin/prime/provider-identity', async (req) => {
    const a = requireRoles(req, ['ADMIN_PRIME']);
    const b = parse(z.object({
      legalName: z.string().trim().max(200).nullable(), cnpj: z.string().trim().regex(/^\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}$/, 'CNPJ inválido.').nullable().or(z.literal('')),
      address: z.string().trim().max(400).nullable(), supportChannel: z.string().trim().max(200).nullable(), validated: z.boolean(),
    }), req.body);
    if (b.validated && (!b.legalName || !b.cnpj || !b.address || !b.supportChannel)) {
      throw unprocessable('PROVIDER_INCOMPLETE', 'Todos os campos são obrigatórios para marcar a identificação como validada.');
    }
    run(`INSERT INTO provider_identity (id, legal_name, cnpj, address, support_channel, validated, updated_by, updated_at) VALUES (1,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET legal_name = excluded.legal_name, cnpj = excluded.cnpj, address = excluded.address, support_channel = excluded.support_channel,
         validated = excluded.validated, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      b.legalName || null, b.cnpj || null, b.address || null, b.supportChannel || null, b.validated ? 1 : 0, a.userId, nowIso());
    audit({ actorId: a.userId, action: 'PROVIDER_IDENTITY_UPDATED', subjectType: 'provider_identity', subjectId: '1', correlationId: req.correlationId, meta: { validated: b.validated } });
    return { ok: true };
  });

  app.get('/api/admin/prime/legal-texts', async (req) => {
    requireRoles(req, ['ADMIN_PRIME', 'AUDITOR']);
    return { texts: all('SELECT id, code, version, title, content_hash, rt_approved_at, legal_review, created_at FROM legal_texts ORDER BY code, created_at DESC') };
  });
  app.post('/api/admin/prime/legal-texts/:id/legal-review', async (req) => {
    const a = requireRoles(req, ['ADMIN_PRIME']);
    const { id } = parse(idParam, req.params);
    const { status, note } = parse(z.object({ status: z.enum(['PENDENTE', 'APROVADO']), note: z.string().trim().min(10).max(1000) }), req.body);
    const t = one<any>('SELECT * FROM legal_texts WHERE id = ?', id);
    if (!t) throw notFound();
    run('UPDATE legal_texts SET legal_review = ? WHERE id = ?', status, id);
    audit({ actorId: a.userId, action: 'LEGAL_REVIEW_RECORDED', subjectType: 'legal_text', subjectId: id, correlationId: req.correlationId, meta: { status, code: t.code, noteLength: note.length } });
    return { ok: true };
  });

  // Catálogo (não usar constantes no front-end)
  app.get('/api/admin/prime/catalog', async (req) => {
    requireRoles(req, ['ADMIN_PRIME', 'FINANCEIRO', 'AUDITOR']);
    return { items: all('SELECT * FROM catalog_items ORDER BY kind, code') };
  });
  const itemSchema = z.object({
    code: z.string().trim().regex(/^[A-Z0-9_-]{2,40}$/, 'Código: letras maiúsculas, números, _ ou -.'),
    name: z.string().trim().min(3).max(200), kind: z.enum(['SERVICO', 'PACOTE']),
    priceCents: z.number().int().min(1), primeEligible: z.boolean(), active: z.boolean(),
    validFrom: z.string().datetime().nullable(), validTo: z.string().datetime().nullable(),
  });
  app.post('/api/admin/prime/catalog', async (req) => {
    const a = requireRoles(req, ['ADMIN_PRIME']);
    const b = parse(itemSchema, req.body);
    if (one('SELECT 1 FROM catalog_items WHERE code = ?', b.code)) throw conflict('CODE_EXISTS', 'Código já cadastrado.');
    const id = uid(), now = nowIso();
    run(`INSERT INTO catalog_items (id, code, name, kind, price_cents, prime_eligible, active, valid_from, valid_to, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id, b.code, b.name, b.kind, b.priceCents, b.primeEligible ? 1 : 0, b.active ? 1 : 0, b.validFrom, b.validTo, now, now);
    audit({ actorId: a.userId, action: 'CATALOG_ITEM_CREATED', subjectType: 'catalog_item', subjectId: id, after: b, correlationId: req.correlationId });
    return { id };
  });
  app.put('/api/admin/prime/catalog/:id', async (req) => {
    const a = requireRoles(req, ['ADMIN_PRIME']);
    const { id } = parse(idParam, req.params);
    const b = parse(itemSchema, req.body);
    const cur = one<any>('SELECT * FROM catalog_items WHERE id = ?', id);
    if (!cur) throw notFound();
    if (b.code !== cur.code) throw conflict('CODE_IMMUTABLE', 'O código do item não pode ser alterado.');
    run(`UPDATE catalog_items SET name = ?, kind = ?, price_cents = ?, prime_eligible = ?, active = ?, valid_from = ?, valid_to = ?, updated_at = ? WHERE id = ?`,
      b.name, b.kind, b.priceCents, b.primeEligible ? 1 : 0, b.active ? 1 : 0, b.validFrom, b.validTo, nowIso(), id);
    audit({ actorId: a.userId, action: 'CATALOG_ITEM_UPDATED', subjectType: 'catalog_item', subjectId: id, before: cur, after: b, correlationId: req.correlationId });
    return { ok: true };
  });

  // Verificação de responsável pela ONEMA
  app.get('/api/admin/prime/share-grants', async (req) => {
    requireRoles(req, ['OPERADOR_CENTRAL', 'AUDITOR']);
    const { status } = parse(z.object({ status: z.enum(['INVITED', 'ACCEPTED', 'VERIFIED', 'REVOKED', 'EXPIRED', 'REJECTED']).optional() }), req.query);
    return {
      grants: all<any>(`SELECT g.id, g.status, g.invitee_name, g.invitee_email, g.invited_at, g.accepted_at, g.verified_at, g.expires_at,
                        p.name AS patient_name, iu.name AS invitee_account_name,
                        (SELECT group_concat(scope) FROM share_scopes s WHERE s.grant_id = g.id AND s.granted_at IS NOT NULL AND s.revoked_at IS NULL) AS scopes
                        FROM share_grants g JOIN users p ON p.id = g.patient_id LEFT JOIN users iu ON iu.id = g.invitee_user_id
                        ${status ? 'WHERE g.status = ?' : ''} ORDER BY g.invited_at DESC LIMIT 200`, ...(status ? [status] : [])),
    };
  });
  app.post('/api/admin/prime/share-grants/:id/verify', async (req) => {
    const a = requireRoles(req, ['OPERADOR_CENTRAL']);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ approve: z.boolean(), note: z.string().trim().min(10, 'Registre como a autorização foi verificada.').max(1000) }), req.body);
    return tx(() => {
      const g = one<any>('SELECT * FROM share_grants WHERE id = ?', id);
      if (!g) throw notFound();
      if (g.status !== 'ACCEPTED') throw conflict('INVALID_STATE', 'Somente convites aceitos pelo responsável (autenticado) podem ser verificados.');
      if (g.patient_id === a.userId || g.invitee_user_id === a.userId) throw conflict('SEGREGATION_OF_DUTIES', 'Você não pode verificar um convite do qual participa.');
      const now = nowIso();
      run(`UPDATE share_grants SET status = ?, verified_by = ?, verified_at = ?, verification_note = ?, updated_at = ? WHERE id = ?`,
        b.approve ? 'VERIFIED' : 'REJECTED', a.userId, now, b.note, now, id);
      if (!b.approve) run('UPDATE share_scopes SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL', now, id);
      notify(g.patient_id, 'ESSENCIAL', b.approve ? 'Responsável verificado' : 'Convite não verificado',
        b.approve ? `O acesso de ${g.invitee_name} foi verificado e está ativo nos escopos que você concedeu.` : `A ONEMA não conseguiu verificar a autorização de ${g.invitee_name}.`);
      if (g.invitee_user_id) notify(g.invitee_user_id, 'ESSENCIAL', b.approve ? 'Acesso liberado' : 'Acesso não liberado',
        b.approve ? 'Sua autorização foi verificada. Você já pode acessar os conteúdos permitidos pelo titular.' : 'A verificação da autorização não foi concluída.');
      audit({ actorId: a.userId, action: b.approve ? 'SHARE_GRANTED' : 'SHARE_VERIFICATION_REJECTED', subjectType: 'share_grant', subjectId: id, correlationId: req.correlationId });
      return { ok: true };
    });
  });

  // Estornos (FINANCEIRO) - sandbox, vinculados à transação original
  app.get('/api/admin/prime/refunds', async (req) => {
    requireRoles(req, ['FINANCEIRO', 'AUDITOR']);
    return {
      refunds: all(`SELECT r.*, u.name AS patient_name, c.created_at AS charge_date, c.provider_ref FROM refund_requests r JOIN users u ON u.id = r.requested_by
                    LEFT JOIN charges c ON c.id = r.charge_id ORDER BY r.requested_at DESC LIMIT 200`),
      orders: all(`SELECT o.id, o.item_code, o.item_name, o.full_price_cents, o.discount_cents, o.final_price_cents, o.payout_basis_cents, o.status, o.created_at, u.name AS patient_name
                   FROM service_orders o JOIN users u ON u.id = o.patient_id ORDER BY o.created_at DESC LIMIT 200`),
      charges: all(`SELECT c.id, c.amount_cents, c.status, c.attempt_no, c.provider, c.provider_ref, c.created_at, u.name AS patient_name FROM charges c
                    JOIN subscriptions s ON s.id = c.subscription_id JOIN users u ON u.id = s.patient_id ORDER BY c.created_at DESC LIMIT 200`),
    };
  });
  app.post('/api/admin/prime/refunds/:id/decide', async (req) => {
    const a = requireRoles(req, ['FINANCEIRO']);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ approve: z.boolean(), note: z.string().trim().min(5).max(1000) }), req.body);
    return tx(() => {
      const r = one<any>('SELECT * FROM refund_requests WHERE id = ?', id);
      if (!r) throw notFound();
      if (r.status !== 'REFUND_PENDING') throw conflict('INVALID_STATE', 'Solicitação já decidida.');
      const now = nowIso();
      const provider = b.approve ? `SANDBOX: estorno simulado ref sbx_rf_${uid().slice(0, 8)}` : null;
      run(`UPDATE refund_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, provider_result = ? WHERE id = ?`,
        b.approve ? 'REFUNDED' : 'REJECTED', a.userId, now, b.note, provider, id);
      if (b.approve && r.charge_id) {
        run(`UPDATE charges SET status = 'REFUNDED' WHERE id = ?`, r.charge_id);
        run(`UPDATE subscription_cycles SET status = 'REFUNDED' WHERE id = (SELECT cycle_id FROM charges WHERE id = ?)`, r.charge_id);
      }
      if (r.type === 'ARREPENDIMENTO' && r.subscription_id) {
        run(`UPDATE subscriptions SET status = ?, updated_at = ? WHERE id = ?`, b.approve ? 'REFUNDED' : 'CANCELLED', now, r.subscription_id);
      }
      const text = b.approve
        ? `Estorno concluído (simulação) referente ao protocolo ${r.protocol}: ${brl(r.amount_cents)} em ${fmtDateTime(now)}.`
        : `Solicitação ${r.protocol} analisada em ${fmtDate(now)}: não aprovada. Motivo registrado pela equipe financeira. Você pode buscar atendimento pelo canal oficial.`;
      receipt(r.requested_by, b.approve ? 'ESTORNO_CONCLUIDO' : 'ESTORNO', r.protocol, text);
      notify(r.requested_by, 'ESSENCIAL', b.approve ? 'Estorno concluído' : 'Solicitação analisada', text);
      audit({ actorId: a.userId, action: b.approve ? 'REFUNDED' : 'REFUND_REJECTED', subjectType: 'refund', subjectId: id, correlationId: req.correlationId, meta: { chargeId: r.charge_id } });
      return { ok: true };
    });
  });
  app.post('/api/admin/prime/orders/:id/refund', async (req) => {
    const a = requireRoles(req, ['FINANCEIRO']);
    const { id } = parse(idParam, req.params);
    const { note } = parse(z.object({ note: z.string().trim().min(5).max(1000) }), req.body);
    return tx(() => {
      const o = one<any>('SELECT * FROM service_orders WHERE id = ?', id);
      if (!o) throw notFound();
      if (o.status !== 'PAID') throw conflict('INVALID_STATE', 'Somente pedidos pagos podem ser estornados.');
      const now = nowIso(), proto = `EST-${now.slice(0, 10).replace(/-/g, '')}-${id.slice(0, 6).toUpperCase()}`;
      run(`UPDATE service_orders SET status = 'REFUNDED' WHERE id = ?`, id);
      run(`INSERT INTO refund_requests (id, order_id, type, reason, amount_cents, status, protocol, requested_by, requested_at, provider, provider_result, decided_by, decided_at, decision_note)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, uid(), id, 'ESTORNO', 'Estorno de pedido', o.final_price_cents, 'REFUNDED', proto, o.patient_id, now, o.provider,
        `SANDBOX: estorno simulado`, a.userId, now, note);
      const rel = run(`UPDATE discount_reservations SET status = 'RELEASED', release_reason = 'ESTORNO_PEDIDO', updated_at = ? WHERE order_id = ? AND status IN ('RESERVED','USED')`, now, id);
      receipt(o.patient_id, 'ESTORNO_CONCLUIDO', proto, `Estorno concluído (simulação) do pedido "${o.item_name}": ${brl(o.final_price_cents)}.`);
      audit({ actorId: a.userId, action: 'ORDER_REFUNDED', subjectType: 'service_order', subjectId: id, correlationId: req.correlationId, meta: { discountReleased: rel.changes > 0 } });
      return { ok: true, discountReleased: rel.changes > 0 };
    });
  });

  // Motor de ciclos (em produção: agendador externo chamando o CLI `npm run jobs:billing`)
  app.post('/api/admin/prime/billing/run', async (req) => {
    const a = requireRoles(req, ['ADMIN_PRIME']);
    const summary = tx(() => runBilling(nowIso(), req.correlationId));
    audit({ actorId: a.userId, action: 'BILLING_RUN', subjectType: 'system', correlationId: req.correlationId, meta: summary });
    return summary;
  });
}
