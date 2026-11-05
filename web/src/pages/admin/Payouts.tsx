import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import { useApi, useSubmit } from '../../lib/hooks';
import { dateTime, money } from '../../lib/format';
import { Alert, Badge, Button, Empty, ErrorState, Loading, PageHeader } from '../../ui/ui';

const TONE: Record<string, string> = {
  A_LIQUIDAR: 'orange', VALIDADO: 'blue', PROGRAMADO: 'blue', ENVIADO: 'blue', CONFIRMADO: '', FALHA: 'red', SALDO_INSUFICIENTE: 'red',
  ENVIO_INCERTO: 'orange', BLOQUEADO: 'red', RECUSADO: 'red', CANCELADO: 'dark',
};

/**
 * Central › Repasses e reembolsos. Segregação: a operação valida o atendimento, o Financeiro autoriza e confere chaves Pix,
 * o Administrador PRIME dá a aprovação adicional; o Auditor só lê.
 */
export function PayoutsPage() {
  const { has } = useAuth();
  const { data, error, loading, reload } = useApi<any>('/api/admin/finance/overview');
  const act = useSubmit<any>();
  const [msg, setMsg] = useState<string | null>(null);
  const [tab, setTab] = useState<'repasses' | 'chaves' | 'reembolsos' | 'ocorrencias'>('repasses');
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const canValidate = has('OPERADOR_CENTRAL', 'AVALIADOR_RT');
  const isFin = has('FINANCEIRO');
  const isAdm = has('ADMIN_PRIME');

  async function go(url: string, body: unknown = {}, done = 'Feito.') {
    setMsg(null);
    const r = await act.run('POST', url, body);
    if (r) { setMsg(r.pending === 'SEGUNDA_APROVACAO' ? 'Primeira aprovação registrada: falta a segunda aprovação de outra pessoa.' : r.pending === 'APROVACAO_ADMIN' ? 'Pedido de reprocessamento enviado ao Administrador PRIME.' : r.status ? `${done} Situação: ${r.status}.` : done); reload(); }
  }
  const ask = (q: string) => { const v = window.prompt(q); return v && v.trim().length >= 5 ? v.trim() : null; };

  const open = data.payouts.filter((p: any) => !['CONFIRMADO', 'CANCELADO'].includes(p.status));
  const closed = data.payouts.filter((p: any) => ['CONFIRMADO', 'CANCELADO'].includes(p.status));
  return (
    <>
      <PageHeader kicker="Central ONEMA" title="Repasses e reembolsos">
        <p>Repasse por Pix após atendimento concluído, assinado pelo paciente e validado. Meta interna: até 48 h após a validação.
          Modo atual: <strong>{data.mode === 'ASAAS' ? 'transferência pelo Asaas' : 'manual (Financeiro paga e registra o comprovante)'}</strong>.
          Repasses acima de {money(data.dualApprovalCents)} exigem segunda aprovação.</p>
      </PageHeader>
      <nav className="pills" aria-label="Seções">
        {(['repasses', 'chaves', 'reembolsos', 'ocorrencias'] as const).map((t) => (
          <button key={t} type="button" className={tab === t ? 'active' : ''} aria-pressed={tab === t} onClick={() => setTab(t)}>
            {{ repasses: `Repasses (${open.length})`, chaves: `Chaves Pix (${data.destinations.length})`, reembolsos: 'Reembolsos', ocorrencias: 'Ocorrências' }[t]}
          </button>
        ))}
      </nav>
      <Alert error={act.error} success={msg} />
      {(isFin || isAdm) && <p><Button className="sm secondary" busy={act.busy} onClick={() => go('/api/admin/finance/reconcile', {}, 'Conciliação executada.')}>Conciliar agora com o Asaas</Button></p>}

      {tab === 'repasses' && (
        <section className="surface">
          {!open.length ? <Empty title="Nenhum repasse pendente." /> : (
            <ul className="list">{open.map((p: any) => (
              <li key={p.id}>
                <div className="row between"><strong>{p.label} · {p.specialist ?? '—'}</strong><Badge tone={TONE[p.status] ?? ''}>{p.statusLabel}</Badge></div>
                <div className="small muted">{p.itemCode} · {money(p.amountCents)} · concluído {dateTime(p.completedAt)} · assinado pelo paciente {dateTime(p.patientSignedAt)}
                  {p.dueAt && <> · prazo-alvo <strong>{dateTime(p.dueAt)}</strong></>} · chave: {p.destination ?? 'não cadastrada'}</div>
                {p.blockers.length > 0 && <div className="caution small mt">Pendências: {p.blockers.join(' ')}</div>}
                {(p.failureReason || p.blockedReason) && <div className="danger small mt">{p.failureReason ?? p.blockedReason}</div>}
                {p.authorizedBy && p.status === 'VALIDADO' && <div className="small">Primeira aprovação registrada — aguardando a segunda.</div>}
                <div className="row mt">
                  {p.status === 'A_LIQUIDAR' && canValidate && <>
                    <Button className="sm deep" busy={act.busy} onClick={() => go(`/api/admin/finance/payouts/${p.id}/validate`, { approve: true }, 'Atendimento validado.')}>Validar atendimento</Button>
                    <Button className="sm secondary" busy={act.busy} onClick={() => { const n = ask('Motivo da recusa:'); if (n) go(`/api/admin/finance/payouts/${p.id}/validate`, { approve: false, note: n }, 'Validação recusada.'); }}>Recusar</Button>
                  </>}
                  {p.status === 'VALIDADO' && (isFin || (isAdm && p.authorizedBy)) && <Button className="sm green" busy={act.busy} onClick={() => go(`/api/admin/finance/payouts/${p.id}/authorize`, {}, 'Pagamento autorizado.')}>{p.authorizedBy ? 'Segunda aprovação' : 'Autorizar pagamento'}</Button>}
                  {p.status === 'PROGRAMADO' && data.mode === 'MANUAL' && isFin && <Button className="sm green" busy={act.busy} onClick={() => { const r = window.prompt('Identificador do Pix (E2E) ou do comprovante:'); if (r && r.trim().length >= 6) go(`/api/admin/finance/payouts/${p.id}/manual-paid`, { reference: r.trim() }, 'Pagamento registrado.'); }}>Registrar Pix enviado</Button>}
                  {['SALDO_INSUFICIENTE', 'ENVIO_INCERTO'].includes(p.status) && (isFin || isAdm) && <Button className="sm secondary" busy={act.busy} onClick={() => go(`/api/admin/finance/payouts/${p.id}/retry`, {}, p.status === 'ENVIO_INCERTO' ? 'Consulta feita.' : 'Reenvio solicitado.')}>{p.status === 'ENVIO_INCERTO' ? 'Consultar no Asaas' : 'Reenviar'}</Button>}
                  {p.status === 'FALHA' && ((isFin && !p.reprocessRequestedBy) || (isAdm && p.reprocessRequestedBy)) && <Button className="sm secondary" busy={act.busy} onClick={() => go(`/api/admin/finance/payouts/${p.id}/retry`)}>{p.reprocessRequestedBy ? 'Aprovar reprocessamento' : 'Pedir reprocessamento'}</Button>}
                </div>
              </li>
            ))}</ul>
          )}
          {closed.length > 0 && <details className="mt"><summary>Concluídos e cancelados ({closed.length})</summary>
            <ul className="list">{closed.map((p: any) => (
              <li key={p.id} className="small"><strong>{p.label}</strong> · {p.specialist ?? '—'} · {money(p.amountCents)} · <Badge tone={TONE[p.status]}>{p.statusLabel}</Badge>
                {p.feeCents != null && <> · tarifa {money(p.feeCents)}</>}{p.receiptUrl && <> · <a href={p.receiptUrl} target="_blank" rel="noopener noreferrer">comprovante</a></>}</li>
            ))}</ul></details>}
        </section>
      )}

      {tab === 'chaves' && (
        <section className="surface">
          <p className="small muted">Confira se o titular da chave é a própria especialista (CPF da candidatura). Troca de chave: bloqueio de 24 h e duas aprovações de pessoas diferentes.</p>
          {!data.destinations.length ? <Empty title="Nenhuma chave aguardando conferência." /> : (
            <ul className="list">{data.destinations.map((d: any) => (
              <li key={d.id}><div className="row between"><strong>{d.specialist}</strong><Badge tone="orange">{d.isChange ? 'Troca de chave' : 'Primeiro cadastro'}</Badge></div>
                <div className="small muted">{d.pixKeyType} {d.maskedKey} · titular informado: {d.holderName} · {d.holderCheck === 'CPF_CONFERE' ? 'CPF confere com a candidatura' : 'titularidade a conferir'} · liberada a partir de {dateTime(d.availableFrom)}</div>
                {d.verifiedBy && <div className="small">Primeira aprovação registrada — falta a segunda (outra pessoa).</div>}
                {(isFin || (isAdm && d.verifiedBy)) && <div className="row mt">
                  <Button className="sm deep" busy={act.busy} onClick={() => { const n = ask('Como a titularidade foi conferida?'); if (n) go(`/api/admin/finance/bank-destinations/${d.id}/verify`, { approve: true, note: n }, 'Chave conferida.'); }}>{d.verifiedBy ? 'Segunda aprovação' : 'Confirmar titularidade'}</Button>
                  <Button className="sm secondary" busy={act.busy} onClick={() => { const n = ask('Motivo:'); if (n) go(`/api/admin/finance/bank-destinations/${d.id}/verify`, { approve: false, note: n }, 'Chave recusada.'); }}>Recusar</Button>
                </div>}
              </li>
            ))}</ul>
          )}
        </section>
      )}

      {tab === 'reembolsos' && (
        <section className="surface">
          <p className="small muted">Solicitação recebida → análise → valor definido → devolução solicitada ao Asaas → dinheiro devolvido. Tarifas absorvidas pela ONEMA.</p>
          {!data.refunds.length ? <Empty title="Nenhum reembolso." /> : (
            <ul className="list">{data.refunds.map((r: any) => (
              <li key={r.id}><div className="row between"><strong>{r.protocol} · {r.item_code} — {r.item_name}</strong><Badge tone={r.status === 'DEVOLVIDO' ? '' : r.status === 'RECUSADO' || r.status === 'FALHA' ? 'red' : 'orange'}>{r.status_label}</Badge></div>
                <div className="small muted">Motivo: {r.reason} · pago {money(r.paid_cents)} · atos {r.acts_done}/{r.acts_total} realizados · {dateTime(r.created_at)}</div>
                <details><summary className="small">Memória de cálculo</summary><ul className="small">{r.calc_memo.map((m: string, i: number) => <li key={i}>{m}</li>)}</ul></details>
                {r.status === 'EM_ANALISE' && isFin && <div className="row mt">
                  <Button className="sm deep" busy={act.busy} onClick={() => {
                    const v = window.prompt(`Valor a devolver em reais (sugerido ${money(r.suggested_cents)}):`, (r.suggested_cents / 100).toFixed(2).replace('.', ','));
                    if (!v) return; const cents = Math.round(Number(v.replace(/\./g, '').replace(',', '.')) * 100);
                    const n = ask('Justificativa do valor:'); if (n && cents > 0) go(`/api/admin/finance/refunds/${r.id}/decide`, { approve: true, amountCents: cents, note: n }, 'Valor definido e devolução solicitada.');
                  }}>Definir valor e devolver</Button>
                  <Button className="sm secondary" busy={act.busy} onClick={() => { const n = ask('Motivo da recusa:'); if (n) go(`/api/admin/finance/refunds/${r.id}/decide`, { approve: false, note: n }, 'Reembolso recusado.'); }}>Recusar</Button>
                </div>}
              </li>
            ))}</ul>
          )}
        </section>
      )}

      {tab === 'ocorrencias' && (
        <section className="surface">
          {!data.occurrences.length ? <Empty title="Nenhuma ocorrência financeira." /> : (
            <ul className="list">{data.occurrences.map((f: any) => (
              <li key={f.id}><div className="row between"><strong>{f.kind === 'CHARGEBACK' ? 'Contestação (chargeback)' : f.kind === 'TITULAR_DIVERGENTE' ? 'Titular da chave divergente' : f.kind} · {f.item_code ?? ''}</strong>
                <Badge tone={f.status === 'ENCERRADA' ? 'dark' : 'red'}>{f.status === 'EM_RECUPERACAO' ? 'Em recuperação' : f.status === 'ABERTA' ? 'Aberta' : 'Encerrada'}</Badge></div>
                <div className="small muted">{f.detail} · {dateTime(f.created_at)}{f.recovery_cents > 0 && <> · a recuperar {money(f.recovery_cents)}</>}</div>
                {f.resolution && <div className="small">Resolução: {f.resolution}</div>}
                {f.status !== 'ENCERRADA' && (isFin || isAdm) && <div className="row mt">
                  {f.kind === 'CHARGEBACK' && <Button className="sm deep" busy={act.busy} onClick={() => { const n = ask('Como foi revertida?'); if (n) go(`/api/admin/finance/occurrences/${f.id}/resolve`, { outcome: 'REVERTIDA', note: n }, 'Ocorrência encerrada.'); }}>Contestação revertida</Button>}
                  <Button className="sm secondary" busy={act.busy} onClick={() => { const n = ask('Resolução:'); if (n) go(`/api/admin/finance/occurrences/${f.id}/resolve`, { outcome: f.kind === 'CHARGEBACK' ? 'PERDIDA' : 'RESOLVIDA', note: n }, 'Ocorrência encerrada.'); }}>{f.kind === 'CHARGEBACK' ? 'Contestação perdida' : 'Encerrar'}</Button>
                </div>}
              </li>
            ))}</ul>
          )}
        </section>
      )}
    </>
  );
}
