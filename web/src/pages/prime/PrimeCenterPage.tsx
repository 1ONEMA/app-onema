import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { SUB_STATUS, date, dateTime, label, money, pct } from '../../lib/format';
import { useApi, useSubmit } from '../../lib/hooks';
import { Alert, Badge, Button, Dialog, Empty, ErrorState, Field, LegalText, Loading, PageHeader } from '../../ui/ui';

/** PRIME → minha assinatura: status, ciclo, recibos, extrato, termos, cancelar e arrepender-se. */
export function PrimeCenterPage() {
  const { data, error, loading, reload } = useApi<any>('/api/prime/me');
  const offer = useApi<any>('/api/prime/offer');
  const pay = useSubmit<any>();
  const cancel = useSubmit<any>();
  const refund = useSubmit<any>();
  const [dialog, setDialog] = useState<'cancel' | 'refund' | 'terms' | null>(null);
  const [method, setMethod] = useState('');
  const [refundType, setRefundType] = useState<'ARREPENDIMENTO' | 'ESTORNO'>('ARREPENDIMENTO');
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [terms, setTerms] = useState<any>(null);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const s = data.subscription;
  if (!s) return (
    <><PageHeader kicker="ONEMA PRIME" title="Central PRIME" />
      <div className="surface"><Empty title="Você não possui assinatura PRIME." action={<Link to="/prime" className="btn deep">Conhecer o PRIME</Link>}>Seus registros e serviços continuam disponíveis sem assinatura.</Empty></div></>
  );
  const st = SUB_STATUS[s.status] ?? { label: s.status, tone: 'dark' };
  const pending = ['ASSINATURA_SOLICITADA', 'PAYMENT_PENDING', 'SUSPENDED'].includes(s.status);
  const canCancel = ['ACTIVE', 'PAYMENT_PENDING', 'SUSPENDED', 'ASSINATURA_SOLICITADA'].includes(s.status);
  const withinWithdrawal = new Date(s.withdrawalDeadline) > new Date();
  const hasConfirmed = s.charges.some((c: any) => c.status === 'CONFIRMED');
  const openRefund = data.refunds.some((r: any) => r.status === 'REFUND_PENDING');

  async function doPay() { const r = await pay.run('POST', '/api/prime/subscriptions/current/pay', { paymentMethod: method }, { idempotent: true }); if (r) { setDone(r.paid ? 'Pagamento confirmado. Benefícios do ciclo ativos.' : r.message); reload(); } }
  async function doCancel() { const r = await cancel.run('POST', '/api/prime/subscriptions/current/cancel', {}, { idempotent: true }); if (r) { setDialog(null); setDone(r.text); reload(); } }
  async function doRefund() { const r = await refund.run('POST', '/api/prime/refund-requests', { type: refundType, reason: reason || undefined }, { idempotent: true }); if (r) { setDialog(null); setDone(r.text); reload(); } }
  async function openTerms(id: string) { setTerms(null); setDialog('terms'); try { setTerms(await api('GET', `/api/prime/texts/by-id/${id}`)); } catch (e: any) { setTerms({ error: e.message }); } }

  return (
    <>
      <PageHeader kicker="ONEMA PRIME" title="Minha assinatura">
        <div className="row"><Badge tone={st.tone}>{st.label}</Badge><span className="small" style={{ color: '#DCE8FF' }}>Protocolo {s.protocol}</span></div>
      </PageHeader>
      <Alert success={done} />
      {s.benefit.reason && !s.benefit.active && <div className="caution">{s.benefit.reason}</div>}
      <div className="grid">
        <div className="tile"><span className="eyebrow">Mensalidade</span><span className="value">{money(s.monthlyPriceCents)}</span><span className="small muted">renovação mensal até cancelar</span></div>
        <div className="tile"><span className="eyebrow">Ciclo atual</span><span className="value" style={{ fontSize: 20 }}>{s.cycle?.startsAt ? `${date(s.cycle.startsAt)} a ${date(s.cycle.endsAt)}` : '—'}</span><span className="small muted">Ciclo {s.cycle?.no} · {label(s.cycle?.status)}</span></div>
        <div className="tile"><span className="eyebrow">Próxima cobrança prevista</span><span className="value" style={{ fontSize: 20 }}>{s.nextChargeAt ? date(s.nextChargeAt) : 'Sem renovação'}</span><span className="small muted">{s.paymentMethodLabel}</span></div>
        <div className="tile"><span className="eyebrow">Desconto neste ciclo</span><span className="value">{s.benefit.usesRemaining}/{s.benefit.usesPerCycle}</span><span className="small muted">uso disponível · {pct(s.benefit.discountBps)} até {money(s.benefit.discountCapCents)}</span></div>
      </div>

      <div className="two mt">
        <section className="surface">
          <h2>Extrato do benefício</h2>
          <ul className="list">
            <li className="row between"><span>Economia neste ciclo</span><strong>{money(s.benefit.savingsThisCycleCents)}</strong></li>
            <li className="row between"><span>Economia desde a adesão</span><strong>{money(s.benefit.totalSavingsCents)}</strong></li>
          </ul>
          <p className="small muted">O desconto não equivale a crédito em dinheiro e não é abatido da mensalidade. Mostramos a economia real, inclusive quando é zero.</p>
          <Link to="/servicos" className="btn secondary">Contratar serviço ou pacote</Link>
          {pending && (
            <div className="mt">
              <h3>Regularizar pagamento</h3>
              <select value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Meio de pagamento">
                <option value="">Selecione o meio de pagamento</option>
                {offer.data?.paymentMethods.map((m: any) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
              <Alert error={pay.error} />
              <Button className="deep mt" busy={pay.busy} disabled={!method} onClick={doPay}>Pagar ciclo pendente (simulação)</Button>
              <p className="small muted">Regularizar a assinatura não cria um segundo uso de desconto no mesmo ciclo.</p>
            </div>
          )}
        </section>
        <section className="surface">
          <h2>Gerenciar</h2>
          <ul className="list">
            <li><Link to="/prime/preferencias">Preferências de avisos</Link></li>
            <li><Link to="/prime/responsavel">Responsável principal</Link></li>
            <li><button className="btn ghost sm" onClick={() => openTerms(s.terms.id)}>Termos aceitos (v{s.terms.version})</button>{' '}
              <button className="btn ghost sm" onClick={() => openTerms(s.privacy.id)}>Aviso de privacidade (v{s.privacy.version})</button></li>
          </ul>
          {canCancel && <Button className="danger mt" onClick={() => setDialog('cancel')}>Cancelar assinatura</Button>}
          {hasConfirmed && !openRefund && ['ACTIVE', 'CANCEL_SCHEDULED', 'CANCELLED', 'SUSPENDED', 'PAYMENT_PENDING'].includes(s.status) && (
            <Button className="ghost mt" onClick={() => { setRefundType(withinWithdrawal ? 'ARREPENDIMENTO' : 'ESTORNO'); setDialog('refund'); }}>
              {withinWithdrawal ? 'Exercer direito de arrependimento' : 'Solicitar estorno'}
            </Button>
          )}
          {withinWithdrawal && <p className="small muted">Prazo de arrependimento até {dateTime(s.withdrawalDeadline)}.</p>}
          <p className="small muted mt">Seus registros e documentos assistenciais continuam acessíveis independentemente do PRIME.</p>
        </section>
      </div>

      <section className="surface">
        <h2>Cobranças e recibos</h2>
        {!s.charges.length ? <Empty title="Nenhuma cobrança registrada." /> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Data</th><th>Ciclo</th><th>Valor</th><th>Situação</th><th className="hide-mobile">Provedor</th></tr></thead>
            <tbody>{s.charges.map((c: any) => <tr key={c.id}><td>{dateTime(c.created_at)}</td><td>{c.cycle_no} (tentativa {c.attempt_no})</td><td>{money(c.amount_cents)}</td><td><Badge tone={c.status === 'CONFIRMED' ? '' : c.status === 'FAILED' ? 'red' : 'dark'}>{label(c.status)}</Badge></td><td className="hide-mobile">{c.provider}</td></tr>)}</tbody>
          </table></div>
        )}
      </section>
      <section className="surface">
        <h2>Termos e comprovantes</h2>
        {!data.receipts.length ? <Empty title="Nenhum comprovante." /> : (
          <ul className="timeline">{data.receipts.map((r: any) => <li key={r.id}><strong>{r.protocol ?? r.kind}</strong> <span className="small muted">{dateTime(r.created_at)}</span><p className="mb0">{r.text}</p></li>)}</ul>
        )}
        {data.refunds.length > 0 && (
          <><h3 className="mt">Solicitações de arrependimento/estorno</h3>
            <ul className="list">{data.refunds.map((r: any) => <li key={r.id} className="row between"><span>{r.protocol} · {r.type === 'ARREPENDIMENTO' ? 'Arrependimento' : 'Estorno'} · {money(r.amount_cents)}</span><Badge tone={r.status === 'REFUNDED' ? '' : r.status === 'REJECTED' ? 'red' : 'orange'}>{label(r.status)}</Badge></li>)}</ul></>
        )}
      </section>

      <Dialog open={dialog === 'cancel'} title="Cancelar ONEMA PRIME" onClose={() => setDialog(null)}>
        <p>Cancelar interrompe futuras renovações. Benefícios do ciclo já pago ficam disponíveis até seu fim{s.cycle?.endsAt ? ` (${date(s.cycle.endsAt)})` : ''}, ressalvados os direitos legais e estornos.</p>
        <p>Seus registros assistenciais continuam acessíveis após o cancelamento.</p>
        <Alert error={cancel.error} />
        <div className="row"><Button className="danger" busy={cancel.busy} onClick={doCancel}>Confirmar cancelamento</Button><Button className="ghost" onClick={() => setDialog(null)}>Voltar</Button></div>
      </Dialog>
      <Dialog open={dialog === 'refund'} title={refundType === 'ARREPENDIMENTO' ? 'Direito de arrependimento' : 'Solicitar estorno'} onClose={() => setDialog(null)}>
        {refundType === 'ARREPENDIMENTO'
          ? <p>A solicitação é registrada com protocolo, encerra a assinatura e o estorno referente à cobrança original segue os direitos legais e o meio de pagamento.</p>
          : <><p>O prazo de arrependimento terminou. Descreva o motivo para análise da equipe financeira.</p>
            <Field label="Motivo"><textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} /></Field></>}
        <Alert error={refund.error} />
        <div className="row"><Button className="deep" busy={refund.busy} onClick={doRefund}>Registrar solicitação</Button><Button className="ghost" onClick={() => setDialog(null)}>Voltar</Button></div>
      </Dialog>
      <Dialog open={dialog === 'terms'} title={terms?.title ?? 'Termos'} onClose={() => setDialog(null)}>
        {!terms ? <Loading lines={2} /> : terms.error ? <p className="danger">{terms.error}</p> : <><p className="small muted">Versão aceita: {terms.version} · hash {terms.contentHash?.slice(0, 16)}…</p><LegalText body={terms.body} /></>}
      </Dialog>
    </>
  );
}
