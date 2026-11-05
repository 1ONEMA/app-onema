/**
 * Repasse ao profissional (Pacote financeiro Asaas MVP v1.0 — conta única ONEMA, sem split/subconta).
 *
 * Fluxo: concluído (paciente assinou) → VALIDADO pela operação (prazo-alvo 48 h) → autorizado pelo Financeiro
 * (PROGRAMADO) → Pix externo pelo Asaas (ENVIADO) → CONFIRMADO pelo webhook/conciliação.
 * Exceções: RECUSADO, FALHA, SALDO_INSUFICIENTE, ENVIO_INCERTO (timeout: consulta antes de qualquer nova tentativa),
 * BLOQUEADO (contestação/chargeback), CANCELADO.
 *
 * Nunca paga: pedido não pago/estornado/contestado, atendimento sem assinatura ou validação, destino não verificado,
 * duplicidade (um repasse por evento, um id de transferência por repasse). Quem valida não autoriza.
 */
import { config } from '../../config.ts';
import { all, one, run, tx } from '../../db/db.ts';
import { audit } from '../../lib/audit.ts';
import { createPixTransfer, findTransferByReference, getPayment, getTransfer, transfersMode } from '../../lib/asaas.ts';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.ts';
import { openField } from '../../lib/security.ts';
import { brl, nowIso, uid } from '../../lib/util.ts';
import { notify } from '../prime/core.ts';

export const PAYOUT_LABEL: Record<string, string> = {
  RESERVADO: 'Reservado (atendimento não concluído)', A_LIQUIDAR: 'Concluído — aguardando validação', VALIDADO: 'Validado — aguardando autorização',
  RECUSADO: 'Validação recusada', PROGRAMADO: 'Repasse programado', ENVIADO: 'Repasse enviado', CONFIRMADO: 'Repasse confirmado',
  FALHA: 'Falha no repasse', SALDO_INSUFICIENTE: 'Saldo insuficiente', ENVIO_INCERTO: 'Envio em verificação', BLOQUEADO: 'Bloqueado (contestação)', CANCELADO: 'Cancelado',
};
const HOUR = 3600_000;
const addHours = (iso: string, h: number) => new Date(new Date(iso).getTime() + h * HOUR).toISOString();
export const maskPixKey = (key: string, type: string) => {
  if (type === 'CPF') return `***.${key.slice(3, 6)}.${key.slice(6, 9)}-**`;
  if (type === 'EMAIL') { const [u, d] = key.split('@'); return `${u.slice(0, 2)}***@${d}`; }
  if (type === 'PHONE') return `(**) *****-${key.slice(-4)}`;
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
};

export async function notifyRole(roles: string[], title: string, body: string) {
  const users = await all<any>(`SELECT DISTINCT r.user_id FROM user_roles r JOIN users u ON u.id = r.user_id WHERE u.status = 'ACTIVE' AND r.role IN (${roles.map(() => '?').join(',')})`, ...roles);
  for (const u of users) await notify(u.user_id, 'ESSENCIAL', title, body);
}

/** Pré-condições assistenciais e financeiras do repasse (verificadas na validação, na autorização e no envio). */
export async function payoutBlockers(p: any) {
  const x = (await one<any>(`SELECT o.status AS order_status, o.contested_at, o.refunded_cents, o.final_price_cents, e.status AS event_status, e.modality, e.started_at, e.patient_signed_at,
      (SELECT status FROM care_evolutions v WHERE v.event_id = e.id) AS evolution,
      (SELECT COUNT(*) FROM financial_occurrences f WHERE f.order_id = o.id AND f.status <> 'ENCERRADA') AS open_occurrences,
      (SELECT COUNT(*) FROM care_refunds r WHERE r.order_id = o.id AND r.status NOT IN ('RECUSADO','FALHA','DEVOLVIDO')) AS open_refunds,
      (SELECT COUNT(*) FROM care_refunds r WHERE r.order_id = o.id AND r.status = 'DEVOLVIDO' AND r.acts_done > 0) AS decided_refunds
    FROM payout_entries p JOIN service_orders o ON o.id = p.order_id JOIN care_events e ON e.id = p.event_id WHERE p.id = ?`, p.id))!;
  const b: string[] = [];
  // Reembolso decidido pelo Financeiro com atos já realizados: os atos feitos continuam devidos à especialista.
  // (só quando foi esse reembolso que levou o pedido a REFUNDED; estorno integral feito fora do app bloqueia).
  const refundedByDecision = x.order_status === 'REFUNDED' && Number(x.decided_refunds) > 0 && Number(x.refunded_cents) >= Number(x.final_price_cents);
  if (x.order_status !== 'PAID' && !refundedByDecision) b.push('Pedido não está pago (ou foi estornado).');
  if (x.contested_at || Number(x.open_occurrences) > 0) b.push('Pedido com contestação ou ocorrência financeira aberta.');
  if (Number(x.open_refunds) > 0) b.push('Pedido com reembolso em andamento.');
  if (x.event_status !== 'CONCLUIDO') b.push('Atendimento não concluído.');
  if (x.modality === 'PRESENCIAL' && !x.started_at) b.push('Visita sem início registrado (código do paciente).');
  if (x.evolution !== 'ASSINADA') b.push('Evolução de enfermagem não assinada.');
  if (!x.patient_signed_at) b.push('Paciente/responsável não assinou o atendimento.');
  if (!p.specialist_id) b.push('Repasse sem profissional vinculado.');
  return b;
}

/**
 * Duas aprovações só valem se forem de pessoas independentes: nenhuma delas pode ter concedido perfil à outra
 * (impede que um administrador crie um "segundo aprovador" para si mesmo).
 */
export async function independentApprovers(a: string | null, b: string) {
  if (!a || a === b) return false;
  return !(await one(`SELECT 1 AS ok FROM user_roles WHERE (user_id = ? AND granted_by = ?) OR (user_id = ? AND granted_by = ?)`, a, b, b, a));
}

export async function currentDestination(specialistId: string) {
  return await one<any>(`SELECT * FROM bank_destinations WHERE specialist_id = ? AND status IN ('PENDENTE_VERIFICACAO','VERIFICADA')`, specialistId);
}

/** Operação valida o atendimento (inicia o prazo-alvo de 48 h). */
export async function validatePayout(id: string, actorId: string, approve: boolean, note: string | null, correlationId: string) {
  return await tx(async () => {
    const p = await one<any>('SELECT * FROM payout_entries WHERE id = ? FOR UPDATE', id);
    if (!p) throw notFound('Repasse não encontrado.');
    if (p.status !== 'A_LIQUIDAR') throw conflict('PAYOUT_NOT_PENDING_VALIDATION', 'Este repasse não está aguardando validação.');
    if (p.specialist_id === actorId) throw forbidden('Você não pode validar o seu próprio repasse.', 'SEGREGATION_OF_DUTIES');
    const now = nowIso();
    if (approve) {
      const blockers = await payoutBlockers(p);
      if (blockers.length) throw unprocessable('PAYOUT_BLOCKED', `Não é possível validar: ${blockers.join(' ')}`, blockers);
      await run(`UPDATE payout_entries SET status = 'VALIDADO', gross_cents = amount_cents, validated_by = ?, validated_at = ?, validation_note = ?, due_at = ?, updated_at = ? WHERE id = ?`,
        actorId, now, note, addHours(now, 48), now, id);
      await notifyRole(['FINANCEIRO'], 'Repasse validado (D+0)', `Repasse de ${brl(p.amount_cents)} validado. Prazo-alvo de envio: 48 h. Autorize em Central › Financeiro.`);
    } else {
      if (!note) throw unprocessable('NOTE_REQUIRED', 'Descreva o motivo da recusa.');
      await run(`UPDATE payout_entries SET status = 'RECUSADO', validated_by = ?, validated_at = ?, validation_note = ?, updated_at = ? WHERE id = ?`, actorId, now, note, now, id);
      if (p.specialist_id) await notify(p.specialist_id, 'ESSENCIAL', 'Repasse em análise', `A Central ONEMA não validou um atendimento para repasse: ${note}. Fale com a Central se precisar.`);
    }
    await audit({ actorId, action: approve ? 'PAYOUT_VALIDATED' : 'PAYOUT_VALIDATION_REJECTED', subjectType: 'payout', subjectId: id, correlationId, meta: { note } });
    return { ok: true };
  });
}

/**
 * Financeiro autoriza (segregação: não pode ser quem validou). Acima do limite exige segunda aprovação de outra pessoa.
 * Autorizado → PROGRAMADO e, no modo Asaas, a transferência é solicitada em seguida.
 */
export async function authorizePayout(id: string, actorId: string, correlationId: string) {
  const ready = await tx(async () => {
    const p = await one<any>('SELECT * FROM payout_entries WHERE id = ? FOR UPDATE', id);
    if (!p) throw notFound('Repasse não encontrado.');
    if (p.status !== 'VALIDADO') throw conflict('PAYOUT_NOT_VALIDATED', 'Somente repasses validados podem ser autorizados.');
    if (p.validated_by === actorId) throw forbidden('Quem validou o atendimento não pode autorizar o pagamento (segregação de funções).', 'SEGREGATION_OF_DUTIES');
    if (p.specialist_id === actorId) throw forbidden('Você não pode autorizar o seu próprio repasse.', 'SEGREGATION_OF_DUTIES');
    const blockers = await payoutBlockers(p);
    const dest = p.specialist_id ? await currentDestination(p.specialist_id) : null;
    const now = nowIso();
    if (!dest || dest.status !== 'VERIFICADA') blockers.push('Chave Pix da especialista não verificada.');
    else if (dest.available_from > now) blockers.push(`Chave Pix alterada recentemente: liberada a partir de ${new Date(dest.available_from).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.`);
    if (blockers.length) throw unprocessable('PAYOUT_BLOCKED', `Não é possível autorizar: ${blockers.join(' ')}`, blockers);
    const needsTwo = p.amount_cents > config.payoutDualApprovalCents;
    if (needsTwo && !p.authorized_by) {
      await run('UPDATE payout_entries SET authorized_by = ?, authorized_at = ?, updated_at = ? WHERE id = ?', actorId, now, now, id);
      await audit({ actorId, action: 'PAYOUT_FIRST_APPROVAL', subjectType: 'payout', subjectId: id, correlationId });
      return { pending: 'SEGUNDA_APROVACAO' as const };
    }
    if (needsTwo && p.authorized_by === actorId) throw forbidden('A segunda aprovação precisa ser de outra pessoa.', 'SEGREGATION_OF_DUTIES');
    if (needsTwo && !(await independentApprovers(p.authorized_by, actorId))) throw forbidden('A segunda aprovação não pode ser de quem concedeu (ou recebeu de você) o perfil da primeira.', 'SEGREGATION_OF_DUTIES');
    if (needsTwo && p.validated_by === actorId) throw forbidden('Quem validou o atendimento não pode aprovar o pagamento.', 'SEGREGATION_OF_DUTIES');
    await run(`UPDATE payout_entries SET status = 'PROGRAMADO', authorized_by = COALESCE(authorized_by, ?), authorized_at = COALESCE(authorized_at, ?), second_approver_id = ?,
        bank_destination_id = ?, updated_at = ? WHERE id = ?`,
      actorId, now, needsTwo ? actorId : null, dest!.id, now, id);
    await audit({ actorId, action: 'PAYOUT_AUTHORIZED', subjectType: 'payout', subjectId: id, correlationId, meta: { mode: transfersMode(), dualApproval: needsTwo } });
    return { pending: null };
  });
  if (ready.pending) return { status: 'VALIDADO', pending: ready.pending };
  if (transfersMode() === 'ASAAS') return { status: await sendTransfer(id, correlationId) };
  return { status: 'PROGRAMADO', manual: true };
}

/**
 * Envia o Pix. O registro "solicitado" é gravado ANTES da chamada; se a resposta não vier (timeout/queda),
 * o repasse fica ENVIO_INCERTO e só a conciliação (consulta pelo id interno) decide — nunca um reenvio cego.
 */
export async function sendTransfer(id: string, correlationId: string | null): Promise<string> {
  const claim = await tx(async () => {
    const p = await one<any>('SELECT * FROM payout_entries WHERE id = ? FOR UPDATE', id);
    if (!p || !['PROGRAMADO', 'SALDO_INSUFICIENTE', 'FALHA'].includes(p.status)) return null;
    if (p.transfer_id && p.status !== 'FALHA') return null;
    const blockers = await payoutBlockers(p);
    const dest = await one<any>(`SELECT * FROM bank_destinations WHERE id = ? AND status = 'VERIFICADA'`, p.bank_destination_id);
    if (!dest || dest.available_from > nowIso()) blockers.push('Destino bancário não verificado ou em período de bloqueio.');
    if (blockers.length) {
      await run(`UPDATE payout_entries SET status = 'FALHA', failure_reason = ?, updated_at = ? WHERE id = ?`, blockers.join(' '), nowIso(), id);
      return null;
    }
    const now = nowIso();
    await run(`UPDATE payout_entries SET status = 'ENVIO_INCERTO', transfer_requested_at = ?, attempts = attempts + 1, failure_reason = NULL, updated_at = ? WHERE id = ?`, now, now, id);
    return { p, dest };
  });
  if (!claim) return (await one<any>('SELECT status FROM payout_entries WHERE id = ?', id))!.status;
  const { p, dest } = claim;
  try {
    const t = await createPixTransfer({
      valueCents: p.amount_cents - (p.withholding_cents ?? 0), pixKey: openField(dest.pix_key_sealed), pixKeyType: dest.pix_key_type,
      description: `ONEMA repasse payout:${p.id}`, externalReference: `payout:${p.id}`,
    });
    await run(`UPDATE payout_entries SET status = 'ENVIADO', transfer_id = ?, sent_at = ?, updated_at = ? WHERE id = ?`, String(t.id), nowIso(), nowIso(), id);
    await audit({ actorId: null, action: 'PAYOUT_TRANSFER_REQUESTED', subjectType: 'payout', subjectId: id, correlationId, meta: { transfer: String(t.id) } });
    return await applyTransferStatus(t, correlationId) ?? 'ENVIADO';
  } catch (e: any) {
    const now = nowIso();
    if (e instanceof AppError && e.code === 'INSUFFICIENT_BALANCE') {
      await run(`UPDATE payout_entries SET status = 'SALDO_INSUFICIENTE', failure_reason = ?, updated_at = ? WHERE id = ?`, 'Saldo insuficiente na conta Asaas.', now, id);
      await notifyRole(['FINANCEIRO', 'ADMIN_PRIME'], 'Repasse bloqueado: saldo insuficiente', `Repasse de ${brl(p.amount_cents)} não foi enviado por saldo insuficiente. Recompor saldo e reenviar em Central › Financeiro.`);
      await audit({ actorId: null, action: 'PAYOUT_INSUFFICIENT_BALANCE', subjectType: 'payout', subjectId: id, correlationId });
      return 'SALDO_INSUFICIENTE';
    }
    if (e instanceof AppError && e.code === 'PAYMENT_PROVIDER_ERROR') {
      // Recusa explícita do Asaas: nada foi criado.
      await run(`UPDATE payout_entries SET status = 'FALHA', failure_reason = ?, updated_at = ? WHERE id = ?`, e.message.slice(0, 300), now, id);
      await notifyRole(['FINANCEIRO'], 'Falha no repasse', `O Asaas recusou o repasse de ${brl(p.amount_cents)}: ${e.message.slice(0, 200)}`);
      await audit({ actorId: null, action: 'PAYOUT_TRANSFER_FAILED', subjectType: 'payout', subjectId: id, correlationId });
      return 'FALHA';
    }
    // Sem resposta: permanece ENVIO_INCERTO até a conciliação consultar o Asaas.
    await run(`UPDATE payout_entries SET failure_reason = ?, updated_at = ? WHERE id = ?`, 'Sem resposta do Asaas: consultar antes de nova tentativa.', now, id);
    await notifyRole(['FINANCEIRO'], 'Repasse em verificação', `O envio de um repasse de ${brl(p.amount_cents)} ficou sem resposta do Asaas. A conciliação vai consultar antes de qualquer nova tentativa.`);
    await audit({ actorId: null, action: 'PAYOUT_TRANSFER_UNCERTAIN', subjectType: 'payout', subjectId: id, correlationId });
    return 'ENVIO_INCERTO';
  }
}

const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100);

/** Aplica o status de uma transferência do Asaas (webhook ou conciliação). Idempotente; devolve o novo status. */
export async function applyTransferStatus(t: any, correlationId: string | null): Promise<string | null> {
  if (!t?.id) return null;
  return await tx(async () => {
    let p = await one<any>('SELECT * FROM payout_entries WHERE transfer_id = ? FOR UPDATE', String(t.id));
    const ref = String(t.externalReference ?? '');
    if (!p && ref.startsWith('payout:')) p = await one<any>(`SELECT * FROM payout_entries WHERE id = ? AND status = 'ENVIO_INCERTO' FOR UPDATE`, ref.slice(7));
    if (!p) return null;
    const now = nowIso();
    const st = String(t.status ?? '');
    const fee = t.transferFee != null ? cents(t.transferFee) : null;
    const receipt = typeof t.transactionReceiptUrl === 'string' && /^https:\/\//.test(t.transactionReceiptUrl) ? t.transactionReceiptUrl : null;
    if (st === 'DONE') {
      if (p.status === 'CONFIRMADO') return 'CONFIRMADO';
      await run(`UPDATE payout_entries SET status = 'CONFIRMADO', transfer_id = ?, transfer_status = ?, transfer_fee_cents = ?, transfer_receipt_url = ?, confirmed_at = ?, sent_at = COALESCE(sent_at, ?), updated_at = ? WHERE id = ?`,
        String(t.id), st, fee, receipt, now, now, now, p.id);
      await checkHolder(p, t, correlationId);
      if (p.specialist_id) await notify(p.specialist_id, 'ESSENCIAL', 'Repasse confirmado', `Seu repasse de ${brl(p.amount_cents - (p.withholding_cents ?? 0))} foi enviado por Pix e confirmado. O comprovante está em Meus repasses.`);
      await audit({ actorId: null, action: 'PAYOUT_CONFIRMED', subjectType: 'payout', subjectId: p.id, correlationId, meta: { transfer: String(t.id), fee } });
      return 'CONFIRMADO';
    }
    if (st === 'FAILED' || st === 'CANCELLED') {
      if (p.status === 'CONFIRMADO') return 'CONFIRMADO';
      await run(`UPDATE payout_entries SET status = 'FALHA', transfer_id = ?, transfer_status = ?, failure_reason = ?, updated_at = ? WHERE id = ?`,
        String(t.id), st, String(t.failReason ?? (st === 'CANCELLED' ? 'Transferência cancelada.' : 'Transferência falhou.')).slice(0, 300), now, p.id);
      await notifyRole(['FINANCEIRO'], 'Falha no repasse', `Uma transferência de ${brl(p.amount_cents)} retornou ${st}. Verifique em Central › Financeiro.`);
      await audit({ actorId: null, action: 'PAYOUT_TRANSFER_FAILED', subjectType: 'payout', subjectId: p.id, correlationId, meta: { transfer: String(t.id), status: st } });
      return 'FALHA';
    }
    // PENDING, BANK_PROCESSING, BLOCKED: enviado, aguardando o banco.
    if (['ENVIO_INCERTO', 'PROGRAMADO', 'ENVIADO'].includes(p.status)) {
      await run(`UPDATE payout_entries SET status = 'ENVIADO', transfer_id = ?, transfer_status = ?, transfer_fee_cents = COALESCE(?, transfer_fee_cents), sent_at = COALESCE(sent_at, ?), updated_at = ? WHERE id = ?`,
        String(t.id), st, fee, now, now, p.id);
    }
    return 'ENVIADO';
  });
}

/** Titular do Pix (quando o Asaas informa) precisa ser o CPF da especialista credenciada. */
async function checkHolder(p: any, t: any, correlationId: string | null) {
  const doc = String(t?.bankAccount?.cpfCnpj ?? '').replace(/\D/g, '');
  if (!doc || !p.specialist_id) return;
  const app = await one<any>(`SELECT cpf FROM specialist_applications WHERE user_id = ? AND status = 'APROVADA'`, p.specialist_id);
  if (!app || openField(app.cpf) === doc) return;
  const now = nowIso();
  await run(`UPDATE bank_destinations SET status = 'RECUSADA', decision_note = ?, updated_at = ? WHERE id = ?`, 'Titular da chave diferente do CPF da especialista.', now, p.bank_destination_id);
  await run(`INSERT INTO financial_occurrences (id, order_id, payout_id, kind, status, recovery_cents, detail, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT DO NOTHING`, uid(), p.order_id, p.id, 'TITULAR_DIVERGENTE', 'ABERTA', 0, 'Pix confirmado para titular diferente do CPF credenciado. Chave bloqueada para novos repasses.', now, now);
  await notifyRole(['FINANCEIRO', 'ADMIN_PRIME'], 'Titular da chave Pix divergente', 'Um repasse foi para uma chave cujo titular não é a especialista credenciada. A chave foi bloqueada; verifique a ocorrência.');
  await audit({ actorId: null, action: 'PAYOUT_HOLDER_MISMATCH', subjectType: 'payout', subjectId: p.id, correlationId });
}

/** ENVIO_INCERTO: consulta o Asaas pelo id interno; só libera nova tentativa quando confirma que nada foi criado. */
export async function resolveUncertain(p: any, correlationId: string | null) {
  const since = new Date(new Date(p.transfer_requested_at ?? p.updated_at).getTime() - 86400000).toISOString().slice(0, 10);
  const found = await findTransferByReference(`payout:${p.id}`, since).catch(() => undefined);
  if (found === undefined) return 'SEM_RESPOSTA';
  if (found) return (await applyTransferStatus(found, correlationId)) ?? 'ENVIADO';
  // Nada no Asaas após 15 min: volta a FALHA (nova tentativa exige autorização de reprocessamento).
  if (Date.now() - new Date(p.transfer_requested_at ?? 0).getTime() > 15 * 60_000) {
    await run(`UPDATE payout_entries SET status = 'FALHA', failure_reason = ?, updated_at = ? WHERE id = ? AND status = 'ENVIO_INCERTO'`,
      'Consulta ao Asaas: transferência não foi criada. Reprocessar exige aprovação.', nowIso(), p.id);
    return 'FALHA';
  }
  return 'AGUARDANDO';
}

/** Ocorrência de chargeback: bloqueia repasses ainda não enviados e registra recuperação dos já pagos. */
export async function openChargeback(orderId: string, event: string, correlationId: string | null) {
  const now = nowIso();
  await run('UPDATE service_orders SET contested_at = COALESCE(contested_at, ?) WHERE id = ?', now, orderId);
  const pending = await all<any>(`SELECT id, status FROM payout_entries WHERE order_id = ? AND status IN ('RESERVADO','A_LIQUIDAR','VALIDADO','PROGRAMADO','FALHA','SALDO_INSUFICIENTE')`, orderId);
  for (const p of pending) await run(`UPDATE payout_entries SET status = 'BLOQUEADO', blocked_from = ?, blocked_reason = ?, updated_at = ? WHERE id = ?`, p.status, `Contestação (${event})`, now, p.id);
  const paid = (await one<any>(`SELECT COALESCE(SUM(amount_cents),0) AS s FROM payout_entries WHERE order_id = ? AND status IN ('ENVIADO','CONFIRMADO','ENVIO_INCERTO')`, orderId))!.s;
  const open = await one<any>(`SELECT id FROM financial_occurrences WHERE order_id = ? AND kind = 'CHARGEBACK' AND status <> 'ENCERRADA'`, orderId);
  if (!open) {
    await run(`INSERT INTO financial_occurrences (id, order_id, kind, status, recovery_cents, detail, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
      uid(), orderId, 'CHARGEBACK', Number(paid) > 0 ? 'EM_RECUPERACAO' : 'ABERTA', Number(paid),
      `Contestação do pagamento (${event}). ${pending.length} repasse(s) bloqueado(s).${Number(paid) > 0 ? ` Repasse já enviado: ${brl(Number(paid))} — iniciar recuperação.` : ''}`, now, now);
    await notifyRole(['FINANCEIRO', 'ADMIN_PRIME'], 'Contestação de pagamento (chargeback)', `Um pedido foi contestado no cartão. Repasses pendentes foram bloqueados${Number(paid) > 0 ? ` e há ${brl(Number(paid))} já repassado a recuperar` : ''}.`);
  }
  await audit({ actorId: null, action: 'CHARGEBACK_OPENED', subjectType: 'service_order', subjectId: orderId, correlationId, meta: { event, blocked: pending.length, paidCents: Number(paid) } });
  return 'CHARGEBACK_REGISTRADO';
}

/** Encerra ocorrência; contestação revertida a favor da ONEMA devolve os repasses ao estado anterior. */
export async function resolveOccurrence(id: string, actorId: string, outcome: 'REVERTIDA' | 'PERDIDA' | 'RESOLVIDA', note: string, correlationId: string) {
  return await tx(async () => {
    const f = await one<any>('SELECT * FROM financial_occurrences WHERE id = ? FOR UPDATE', id);
    if (!f) throw notFound('Ocorrência não encontrada.');
    if (f.status === 'ENCERRADA') throw conflict('OCCURRENCE_CLOSED', 'Ocorrência já encerrada.');
    const now = nowIso();
    await run(`UPDATE financial_occurrences SET status = 'ENCERRADA', resolution = ?, resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ?`, `${outcome}: ${note}`, actorId, now, now, id);
    if (f.kind === 'CHARGEBACK' && f.order_id) {
      if (outcome === 'REVERTIDA') {
        // Só reabre os repasses se o Asaas confirmar que o pagamento voltou ao normal.
        const o = await one<any>('SELECT provider, provider_ref FROM service_orders WHERE id = ?', f.order_id);
        if (o?.provider === 'ASAAS' && o.provider_ref) {
          const pay = await getPayment(o.provider_ref);
          if (!['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(String(pay?.status))) throw conflict('CHARGEBACK_NOT_REVERSED', `No Asaas o pagamento ainda está como ${String(pay?.status ?? 'desconhecido')}: a contestação não foi revertida.`);
        }
        await run('UPDATE service_orders SET contested_at = NULL WHERE id = ?', f.order_id);
        await run(`UPDATE payout_entries SET status = blocked_from, blocked_from = NULL, blocked_reason = NULL, updated_at = ? WHERE order_id = ? AND status = 'BLOQUEADO' AND blocked_from IS NOT NULL`, now, f.order_id);
      } else {
        await run(`UPDATE payout_entries SET status = 'CANCELADO', updated_at = ? WHERE order_id = ? AND status = 'BLOQUEADO'`, now, f.order_id);
      }
    }
    await audit({ actorId, action: 'OCCURRENCE_RESOLVED', subjectType: 'financial_occurrence', subjectId: id, correlationId, meta: { outcome } });
    return { ok: true };
  });
}

/** Alertas D+0 (na validação), D+1 e perto de 48 h para repasses validados ainda não enviados. */
export async function payoutAlerts(now = nowIso()) {
  const rows = await all<any>(`SELECT id, amount_cents, validated_at, due_at, status, alerts_sent FROM payout_entries
    WHERE status IN ('VALIDADO','PROGRAMADO','FALHA','SALDO_INSUFICIENTE','ENVIO_INCERTO') AND due_at IS NOT NULL`);
  let sent = 0;
  for (const p of rows) {
    const elapsed = (new Date(now).getTime() - new Date(p.validated_at).getTime()) / HOUR;
    const tag = elapsed >= 40 ? 'H40' : elapsed >= 24 ? 'D1' : null;
    if (!tag || String(p.alerts_sent).split(',').includes(tag)) continue;
    await notifyRole(['FINANCEIRO', 'ADMIN_PRIME'], tag === 'H40' ? 'Repasse perto do prazo de 48 h' : 'Repasse pendente (D+1)',
      `Repasse de ${brl(p.amount_cents)} (${PAYOUT_LABEL[p.status]}) com prazo-alvo em ${new Date(p.due_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.`);
    await run('UPDATE payout_entries SET alerts_sent = ? WHERE id = ?', [p.alerts_sent, tag].filter(Boolean).join(','), p.id);
    sent++;
  }
  return sent;
}

/** Conciliação de repasses: consulta transferências enviadas e envios incertos. */
export async function reconcileTransfers(correlationId: string | null = null) {
  const out = { checked: 0, updated: 0 };
  if (transfersMode() !== 'ASAAS') return out;
  for (const p of await all<any>(`SELECT * FROM payout_entries WHERE status IN ('ENVIADO','ENVIO_INCERTO') ORDER BY updated_at LIMIT 50`)) {
    out.checked++;
    try {
      const before = p.status;
      const after = p.status === 'ENVIADO' && p.transfer_id ? await applyTransferStatus(await getTransfer(p.transfer_id), correlationId) : await resolveUncertain(p, correlationId);
      if (after && after !== before) out.updated++;
    } catch (e: any) { console.warn('[conciliação] repasse', p.id.slice(0, 8), e?.code ?? e?.message); }
  }
  return out;
}
