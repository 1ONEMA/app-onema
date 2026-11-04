/**
 * Rotas financeiras com segregação de funções (Pacote Asaas v1.0, doc. 04):
 * operação valida o atendimento (OPERADOR_CENTRAL/AVALIADOR_RT), Financeiro autoriza e verifica chaves,
 * ADMIN_PRIME dá a aprovação adicional (troca de chave, reprocessamento), AUDITOR só lê.
 * Especialista vê somente os próprios repasses; paciente vê somente o próprio reembolso.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, one, run, tx } from '../../db/db.ts';
import { audit } from '../../lib/audit.ts';
import { transfersMode } from '../../lib/asaas.ts';
import { parse, requireRoles } from '../../lib/context.ts';
import { validCpf } from '../../lib/cpf.ts';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.ts';
import { lookupHash, rateLimit, sealField, verifyPassword } from '../../lib/security.ts';
import { nowIso, uid } from '../../lib/util.ts';
import { config } from '../../config.ts';
import { openField } from '../../lib/security.ts';
import { notify } from '../prime/core.ts';
import {
  PAYOUT_LABEL, authorizePayout, currentDestination, maskPixKey, notifyRole, payoutBlockers, resolveOccurrence,
  resolveUncertain, sendTransfer, validatePayout,
} from './payouts.ts';
import { REFUND_LABEL, decideRefund, refundView, requestRefund } from './refunds.ts';
import { runFinanceJobs } from './jobs.ts';

const VIEW = ['FINANCEIRO', 'OPERADOR_CENTRAL', 'ADMIN_PRIME', 'AUDITOR', 'AVALIADOR_RT'] as const;
const idParam = z.object({ id: z.string().uuid() });
const note = z.string().trim().min(5, 'Escreva uma justificativa (mínimo 5 caracteres).').max(500);

const PIX_KEY = z.discriminatedUnion('pixKeyType', [
  z.object({ pixKeyType: z.literal('CPF'), pixKey: z.string().trim().refine(validCpf, 'CPF inválido.').transform((v) => v.replace(/\D/g, '')) }),
  z.object({ pixKeyType: z.literal('EMAIL'), pixKey: z.string().trim().toLowerCase().email('E-mail inválido.').max(77) }),
  z.object({ pixKeyType: z.literal('PHONE'), pixKey: z.string().trim().transform((v) => v.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '')).refine((v) => /^\d{10,11}$/.test(v), 'Celular inválido (DDD + número).') }),
  z.object({ pixKeyType: z.literal('EVP'), pixKey: z.string().trim().toLowerCase().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'Chave aleatória inválida.') }),
]);

function destinationView(d: any) {
  if (!d) return null;
  return { id: d.id, pixKeyType: d.pix_key_type, maskedKey: d.masked_key, holderName: d.holder_name, holderCheck: d.holder_check, status: d.status,
    isChange: !!d.is_change, availableFrom: d.available_from, verifiedAt: d.verified_at, decisionNote: d.decision_note, createdAt: d.created_at };
}

export async function financeRoutes(app: FastifyInstance) {
  // ---------------- Especialista ----------------
  app.get('/api/specialist/payouts', async (req) => {
    const a = requireRoles(req, ['ESPECIALISTA']);
    const rows = await all<any>(`SELECT p.id, p.status, p.amount_cents, p.withholding_cents, p.due_at, p.validated_at, p.sent_at, p.confirmed_at, p.transfer_receipt_url, p.failure_reason,
        e.label, e.completed_at FROM payout_entries p JOIN care_events e ON e.id = p.event_id WHERE p.specialist_id = ? ORDER BY e.completed_at DESC NULLS LAST, p.created_at DESC LIMIT 200`, a.userId);
    return {
      destination: destinationView(await currentDestination(a.userId)),
      payouts: rows.map((p) => ({ id: p.id, label: p.label, completedAt: p.completed_at, status: p.status, statusLabel: PAYOUT_LABEL[p.status],
        grossCents: p.amount_cents, withholdingCents: p.withholding_cents ?? 0, netCents: p.amount_cents - (p.withholding_cents ?? 0),
        dueAt: p.due_at, sentAt: p.sent_at, confirmedAt: p.confirmed_at, receiptUrl: p.transfer_receipt_url,
        note: ['FALHA', 'SALDO_INSUFICIENTE', 'ENVIO_INCERTO', 'BLOQUEADO'].includes(p.status) ? 'A Central ONEMA está tratando este repasse.' : null })),
      rule: 'Repasse por Pix após o atendimento concluído, assinado pelo paciente e validado pela Central. Meta interna: até 48 h após a validação (não é garantia bancária).',
    };
  });

  /** Cadastro/troca da chave Pix: exige a senha atual; troca bloqueia repasses por 24 h e precisa de dupla aprovação. */
  app.put('/api/specialist/bank-destination', async (req) => {
    const a = requireRoles(req, ['ESPECIALISTA']);
    const raw = req.body as any;
    const { password, holderName } = parse(z.object({ password: z.string().min(1, 'Digite sua senha para confirmar.').max(200), holderName: z.string().trim().min(5).max(120) }), raw);
    const key = parse(PIX_KEY, raw);
    if (!await rateLimit(`bank-dest:${a.userId}`, 5, 24 * 3600_000)) throw new AppError(429, 'RATE_LIMIT', 'Muitas alterações de chave Pix hoje. Fale com a Central ONEMA.');
    const u = (await one<any>('SELECT password_hash FROM users WHERE id = ?', a.userId))!;
    if (!verifyPassword(password, u.password_hash)) {
      await audit({ actorId: a.userId, action: 'BANK_DESTINATION_WRONG_PASSWORD', subjectType: 'user', subjectId: a.userId, correlationId: req.correlationId });
      throw badRequest('WRONG_PASSWORD', 'Senha incorreta.');
    }
    const appl = await one<any>(`SELECT cpf, full_name FROM specialist_applications WHERE user_id = ? AND status = 'APROVADA'`, a.userId);
    if (!appl) throw forbidden('Cadastre a chave Pix depois que a sua candidatura for aprovada.', 'APPLICATION_NOT_APPROVED');
    const cpf = openField(appl.cpf);
    const holderCheck = key.pixKeyType === 'CPF' ? (key.pixKey === cpf ? 'CPF_CONFERE' : 'CPF_DIFERENTE') : 'CONFERIR_TITULAR';
    if (holderCheck === 'CPF_DIFERENTE') throw badRequest('PIX_KEY_NOT_OWNER', 'A chave Pix do tipo CPF precisa ser o seu próprio CPF (o mesmo da candidatura).');
    return await tx(async () => {
      const now = nowIso();
      const cur = await currentDestination(a.userId);
      const hash = lookupHash('pix', key.pixKey);
      if (cur && cur.pix_key_hash === hash) throw conflict('SAME_PIX_KEY', 'Esta já é a sua chave Pix cadastrada.');
      const isChange = !!(await one(`SELECT 1 AS ok FROM bank_destinations WHERE specialist_id = ? AND status IN ('VERIFICADA','SUBSTITUIDA')`, a.userId));
      if (cur) await run(`UPDATE bank_destinations SET status = 'SUBSTITUIDA', updated_at = ? WHERE id = ?`, now, cur.id);
      // Primeiro cadastro com o próprio CPF: verificado na hora. Demais casos: conferência do Financeiro.
      const autoVerified = !isChange && holderCheck === 'CPF_CONFERE';
      const id = uid();
      await run(`INSERT INTO bank_destinations (id, specialist_id, pix_key_sealed, pix_key_hash, pix_key_type, masked_key, holder_name, holder_check, status, is_change, available_from, verified_at, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, a.userId, sealField(key.pixKey), hash, key.pixKeyType, maskPixKey(key.pixKey, key.pixKeyType), holderName, holderCheck,
        autoVerified ? 'VERIFICADA' : 'PENDENTE_VERIFICACAO', isChange ? 1 : 0, isChange ? new Date(Date.now() + config.bankChangeHoldHours * 3600_000).toISOString() : now, autoVerified ? now : null, now, now);
      await audit({ actorId: a.userId, action: isChange ? 'BANK_DESTINATION_CHANGED' : 'BANK_DESTINATION_CREATED', subjectType: 'bank_destination', subjectId: id, correlationId: req.correlationId,
        meta: { type: key.pixKeyType, holderCheck } });
      await notify(a.userId, 'ESSENCIAL', isChange ? 'Chave Pix alterada' : 'Chave Pix cadastrada',
        isChange ? `Sua chave Pix de repasse foi alterada para ${maskPixKey(key.pixKey, key.pixKeyType)}. Por segurança, novos repasses ficam bloqueados por ${config.bankChangeHoldHours} h e a Central confere a titularidade. Se não foi você, fale com a Central ONEMA imediatamente.`
          : `Chave Pix ${maskPixKey(key.pixKey, key.pixKeyType)} cadastrada para seus repasses.`);
      if (!autoVerified) await notifyRole(['FINANCEIRO'], 'Chave Pix para conferir', `Uma especialista ${isChange ? 'trocou' : 'cadastrou'} a chave Pix. Confira a titularidade em Central › Financeiro.`);
      return { destination: destinationView(await one('SELECT * FROM bank_destinations WHERE id = ?', id)) };
    });
  });

  // ---------------- Paciente: reembolso ----------------
  app.post('/api/care/orders/:id/refund-request', async (req) => {
    const a = requireRoles(req, ['PACIENTE']);
    const { id } = parse(idParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(5, 'Conte o motivo em poucas palavras.').max(500) }), req.body);
    if (!await rateLimit(`refund-req:${a.userId}`, 10, 3600_000)) throw new AppError(429, 'RATE_LIMIT', 'Muitas solicitações. Aguarde um pouco.');
    return await requestRefund(id, a.userId, reason, { correlationId: req.correlationId });
  });
  app.get('/api/care/orders/:id/refunds', async (req) => {
    const a = requireRoles(req, ['PACIENTE']);
    const { id } = parse(idParam, req.params);
    if (!(await one('SELECT 1 AS ok FROM service_orders WHERE id = ? AND patient_id = ?', id, a.userId))) throw notFound('Pedido não encontrado.');
    const rows = await all<any>('SELECT id FROM care_refunds WHERE order_id = ? ORDER BY created_at DESC', id);
    return { refunds: await Promise.all(rows.map(async (r) => (await refundView(r.id)).refund)) };
  });

  // ---------------- Central / Financeiro ----------------
  app.get('/api/admin/finance/overview', async (req) => {
    const a = requireRoles(req, [...VIEW]);
    const payouts = await all<any>(`SELECT p.*, e.label, e.completed_at, e.patient_signed_at, u.name AS specialist_name, o.item_code,
        (SELECT masked_key FROM bank_destinations b WHERE b.specialist_id = p.specialist_id AND b.status IN ('PENDENTE_VERIFICACAO','VERIFICADA')) AS dest_masked,
        (SELECT status FROM bank_destinations b WHERE b.specialist_id = p.specialist_id AND b.status IN ('PENDENTE_VERIFICACAO','VERIFICADA')) AS dest_status
      FROM payout_entries p JOIN care_events e ON e.id = p.event_id JOIN service_orders o ON o.id = p.order_id LEFT JOIN users u ON u.id = p.specialist_id
      WHERE p.status <> 'RESERVADO' ORDER BY CASE WHEN p.status IN ('CONFIRMADO','CANCELADO') THEN 1 ELSE 0 END, p.updated_at DESC LIMIT 300`);
    const destinations = await all<any>(`SELECT b.*, u.name AS specialist_name FROM bank_destinations b JOIN users u ON u.id = b.specialist_id WHERE b.status = 'PENDENTE_VERIFICACAO' ORDER BY b.created_at`);
    const refunds = await all<any>(`SELECT r.id, r.protocol, r.status, r.reason, r.paid_cents, r.suggested_cents, r.amount_cents, r.acts_total, r.acts_done, r.calc_memo, r.created_at, o.item_code, o.item_name
      FROM care_refunds r JOIN service_orders o ON o.id = r.order_id ORDER BY CASE WHEN r.status IN ('DEVOLVIDO','RECUSADO') THEN 1 ELSE 0 END, r.created_at DESC LIMIT 100`);
    const occurrences = await all<any>(`SELECT f.*, o.item_code FROM financial_occurrences f LEFT JOIN service_orders o ON o.id = f.order_id ORDER BY CASE WHEN f.status = 'ENCERRADA' THEN 1 ELSE 0 END, f.created_at DESC LIMIT 100`);
    return {
      me: a.userId, roles: a.roles, mode: transfersMode(), dualApprovalCents: config.payoutDualApprovalCents,
      payouts: await Promise.all(payouts.map(async (p) => ({
        id: p.id, label: p.label, itemCode: p.item_code, specialist: p.specialist_name, amountCents: p.amount_cents, status: p.status, statusLabel: PAYOUT_LABEL[p.status],
        completedAt: p.completed_at, patientSignedAt: p.patient_signed_at, validatedAt: p.validated_at, validatedBy: p.validated_by, dueAt: p.due_at,
        authorizedBy: p.authorized_by, authorizedAt: p.authorized_at, secondApprover: p.second_approver_id, reprocessRequestedBy: p.reprocess_requested_by,
        transferId: p.transfer_id, transferStatus: p.transfer_status, feeCents: p.transfer_fee_cents, receiptUrl: p.transfer_receipt_url, failureReason: p.failure_reason,
        blockedReason: p.blocked_reason, attempts: p.attempts, destination: p.dest_masked ? `${p.dest_masked} (${p.dest_status === 'VERIFICADA' ? 'verificada' : 'a conferir'})` : null,
        blockers: ['A_LIQUIDAR', 'VALIDADO'].includes(p.status) ? await payoutBlockers(p) : [],
      }))),
      destinations: destinations.map((d) => ({ ...destinationView(d), specialist: d.specialist_name, verifiedBy: d.verified_by })),
      refunds: refunds.map((r) => ({ ...r, status_label: REFUND_LABEL[r.status], calc_memo: r.calc_memo.split('\n') })),
      occurrences,
    };
  });

  app.post('/api/admin/finance/payouts/:id/validate', async (req) => {
    const a = requireRoles(req, ['OPERADOR_CENTRAL', 'AVALIADOR_RT']);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ approve: z.boolean(), note: z.string().trim().max(500).optional() }), req.body);
    return await validatePayout(id, a.userId, b.approve, b.note || null, req.correlationId);
  });

  app.post('/api/admin/finance/payouts/:id/authorize', async (req) => {
    const a = requireRoles(req, ['FINANCEIRO', 'ADMIN_PRIME']);
    const { id } = parse(idParam, req.params);
    // ADMIN_PRIME só participa como segunda aprovação (acima do limite); a primeira autorização é do Financeiro.
    const p = await one<any>('SELECT authorized_by, amount_cents FROM payout_entries WHERE id = ?', id);
    if (!a.roles.includes('FINANCEIRO') && !(p?.authorized_by && p.amount_cents > config.payoutDualApprovalCents)) throw forbidden('A autorização do pagamento é do Financeiro.', 'FORBIDDEN');
    return await authorizePayout(id, a.userId, req.correlationId);
  });

  /** Modo manual (transferências Asaas desligadas): o Financeiro paga fora e registra o comprovante. */
  app.post('/api/admin/finance/payouts/:id/manual-paid', async (req) => {
    const a = requireRoles(req, ['FINANCEIRO']);
    const { id } = parse(idParam, req.params);
    const { reference } = parse(z.object({ reference: z.string().trim().min(6, 'Informe o identificador do Pix (E2E) ou do comprovante.').max(120) }), req.body);
    if (transfersMode() === 'ASAAS') throw conflict('TRANSFERS_AUTOMATIC', 'Com transferências Asaas ativas, o envio é feito pelo sistema.');
    return await tx(async () => {
      const p = await one<any>('SELECT * FROM payout_entries WHERE id = ? FOR UPDATE', id);
      if (!p) throw notFound('Repasse não encontrado.');
      if (p.status !== 'PROGRAMADO') throw conflict('PAYOUT_NOT_SCHEDULED', 'Somente repasses autorizados (programados) podem ser registrados como pagos.');
      const now = nowIso();
      await run(`UPDATE payout_entries SET status = 'CONFIRMADO', transfer_id = ?, transfer_status = 'MANUAL', sent_at = ?, confirmed_at = ?, updated_at = ? WHERE id = ?`, `MANUAL-${reference}`, now, now, now, id);
      if (p.specialist_id) await notify(p.specialist_id, 'ESSENCIAL', 'Repasse enviado', 'Seu repasse foi enviado por Pix pela ONEMA. Confira em Meus repasses.');
      await audit({ actorId: a.userId, action: 'PAYOUT_MANUAL_PAID', subjectType: 'payout', subjectId: id, correlationId: req.correlationId });
      return { ok: true };
    });
  });

  /**
   * Nova tentativa. Saldo insuficiente: o Financeiro reenvia após recompor o saldo.
   * Falha/envio incerto: só depois da consulta ao Asaas e com aprovação adicional (pedido do Financeiro + ADMIN_PRIME).
   */
  app.post('/api/admin/finance/payouts/:id/retry', async (req) => {
    const a = requireRoles(req, ['FINANCEIRO', 'ADMIN_PRIME']);
    const { id } = parse(idParam, req.params);
    const p = await one<any>('SELECT * FROM payout_entries WHERE id = ?', id);
    if (!p) throw notFound('Repasse não encontrado.');
    if (transfersMode() !== 'ASAAS') throw conflict('TRANSFERS_MANUAL', 'Transferências pelo Asaas estão desligadas: registre o pagamento manual.');
    if (p.status === 'ENVIO_INCERTO') return { status: await resolveUncertain(p, req.correlationId) };
    if (p.status === 'SALDO_INSUFICIENTE') {
      if (!a.roles.includes('FINANCEIRO')) throw forbidden('Reenvio é do Financeiro.');
      await audit({ actorId: a.userId, action: 'PAYOUT_RETRY', subjectType: 'payout', subjectId: id, correlationId: req.correlationId });
      return { status: await sendTransfer(id, req.correlationId) };
    }
    if (p.status !== 'FALHA') throw conflict('PAYOUT_NOT_RETRIABLE', 'Este repasse não está em falha.');
    if (!p.reprocess_requested_by) {
      if (!a.roles.includes('FINANCEIRO')) throw forbidden('O pedido de reprocessamento é do Financeiro.');
      await run('UPDATE payout_entries SET reprocess_requested_by = ?, updated_at = ? WHERE id = ?', a.userId, nowIso(), id);
      await notifyRole(['ADMIN_PRIME'], 'Reprocessamento de repasse', 'O Financeiro pediu para reprocessar um repasse em falha. Aprove em Central › Financeiro.');
      await audit({ actorId: a.userId, action: 'PAYOUT_REPROCESS_REQUESTED', subjectType: 'payout', subjectId: id, correlationId: req.correlationId });
      return { status: 'FALHA', pending: 'APROVACAO_ADMIN' };
    }
    if (!a.roles.includes('ADMIN_PRIME') || p.reprocess_requested_by === a.userId) throw forbidden('A aprovação do reprocessamento precisa ser de um administrador diferente de quem pediu.', 'SEGREGATION_OF_DUTIES');
    await run('UPDATE payout_entries SET reprocess_requested_by = NULL, updated_at = ? WHERE id = ?', nowIso(), id);
    await audit({ actorId: a.userId, action: 'PAYOUT_REPROCESS_APPROVED', subjectType: 'payout', subjectId: id, correlationId: req.correlationId });
    return { status: await sendTransfer(id, req.correlationId) };
  });

  /** Conferência da chave Pix. Troca de chave exige segunda aprovação de outra pessoa (FINANCEIRO ou ADMIN_PRIME). */
  app.post('/api/admin/finance/bank-destinations/:id/verify', async (req) => {
    const a = requireRoles(req, ['FINANCEIRO', 'ADMIN_PRIME']);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ approve: z.boolean(), note }), req.body);
    return await tx(async () => {
      const d = await one<any>('SELECT * FROM bank_destinations WHERE id = ? FOR UPDATE', id);
      if (!d || d.status !== 'PENDENTE_VERIFICACAO') throw conflict('DESTINATION_NOT_PENDING', 'Esta chave não está aguardando conferência.');
      if (d.specialist_id === a.userId) throw forbidden('Você não pode conferir a sua própria chave.', 'SEGREGATION_OF_DUTIES');
      const now = nowIso();
      if (!b.approve) {
        await run(`UPDATE bank_destinations SET status = 'RECUSADA', verified_by = ?, decision_note = ?, verified_at = ?, updated_at = ? WHERE id = ?`, a.userId, b.note, now, now, id);
        await notify(d.specialist_id, 'ESSENCIAL', 'Chave Pix não confirmada', `A Central não confirmou sua chave Pix: ${b.note}. Cadastre uma chave em seu nome (de preferência o seu CPF).`);
      } else if (!d.verified_by) {
        if (!a.roles.includes('FINANCEIRO')) throw forbidden('A primeira conferência é do Financeiro.');
        if (d.is_change) {
          await run('UPDATE bank_destinations SET verified_by = ?, decision_note = ?, updated_at = ? WHERE id = ?', a.userId, b.note, now, id);
          await notifyRole(['ADMIN_PRIME'], 'Troca de chave Pix: segunda aprovação', 'Uma troca de chave Pix foi conferida pelo Financeiro e aguarda a sua aprovação.');
          await audit({ actorId: a.userId, action: 'BANK_DESTINATION_FIRST_APPROVAL', subjectType: 'bank_destination', subjectId: id, correlationId: req.correlationId });
          return { status: 'PENDENTE_VERIFICACAO', pending: 'SEGUNDA_APROVACAO' };
        }
        await run(`UPDATE bank_destinations SET status = 'VERIFICADA', verified_by = ?, decision_note = ?, verified_at = ?, updated_at = ? WHERE id = ?`, a.userId, b.note, now, now, id);
      } else {
        if (d.verified_by === a.userId) throw forbidden('A segunda aprovação precisa ser de outra pessoa.', 'SEGREGATION_OF_DUTIES');
        await run(`UPDATE bank_destinations SET status = 'VERIFICADA', second_approver_id = ?, verified_at = ?, decision_note = ?, updated_at = ? WHERE id = ?`, a.userId, now, `${d.decision_note ?? ''} | ${b.note}`.slice(0, 500), now, id);
      }
      await audit({ actorId: a.userId, action: b.approve ? 'BANK_DESTINATION_VERIFIED' : 'BANK_DESTINATION_REJECTED', subjectType: 'bank_destination', subjectId: id, correlationId: req.correlationId });
      return { status: (await one<any>('SELECT status FROM bank_destinations WHERE id = ?', id))!.status };
    });
  });

  app.post('/api/admin/finance/refunds/:id/decide', async (req) => {
    const a = requireRoles(req, ['FINANCEIRO']);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ approve: z.boolean(), amountCents: z.number().int().min(1).optional(), note }), req.body);
    return await decideRefund(id, a.userId, b, req.correlationId);
  });

  app.post('/api/admin/finance/occurrences/:id/resolve', async (req) => {
    const a = requireRoles(req, ['FINANCEIRO', 'ADMIN_PRIME']);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ outcome: z.enum(['REVERTIDA', 'PERDIDA', 'RESOLVIDA']), note }), req.body);
    return await resolveOccurrence(id, a.userId, b.outcome, b.note, req.correlationId);
  });

  app.post('/api/admin/finance/reconcile', async (req) => {
    const a = requireRoles(req, ['FINANCEIRO', 'ADMIN_PRIME']);
    const r = await runFinanceJobs(req.correlationId);
    await audit({ actorId: a.userId, action: 'FINANCE_RECONCILE_MANUAL', subjectType: 'system', correlationId: req.correlationId, meta: r });
    return r;
  });
}
