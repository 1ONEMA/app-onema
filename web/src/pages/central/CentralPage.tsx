import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth';
import { useApi, useSubmit } from '../../lib/hooks';
import { dateTime, label, money } from '../../lib/format';
import { Alert, Badge, Button, Dialog, ErrorState, Field, Loading, PageHeader } from '../../ui/ui';
import { REQ_STATUS } from '../care/OrdersPages';

const pctBps = (bps: number) => `${(bps / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
const PRICING_ROLES = ['ADMIN_PRIME', 'FINANCEIRO', 'AVALIADOR_RT', 'AUDITOR'] as const;

/** Central Operacional / RT: operação, precificação versionada, conciliação e autoteste. */
export function CentralPage() {
  const { has } = useAuth();
  const finance = has(...PRICING_ROLES);
  const tabs = [['op', 'Operação'], ...(finance ? [['precos', 'Precificação'], ['conciliacao', 'Conciliação'], ['autoteste', 'Autoteste P01–P04']] : [])] as [string, string][];
  const [tab, setTab] = useState(() => new URLSearchParams(location.search).get('aba') ?? 'op');
  useEffect(() => { const u = new URL(location.href); u.searchParams.set('aba', tab); history.replaceState(null, '', u); }, [tab]);
  return (
    <>
      <PageHeader kicker="Central Operacional ONEMA" title="Central RT">
        <p>Solicitações, pedidos, atendimentos, preços e conciliação. Repasses e margens são visíveis somente a RT, Financeiro, Administrador PRIME e Auditor.</p>
      </PageHeader>
      <div className="pills" role="tablist">
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'op' && <Operations finance={finance} />}
      {tab === 'precos' && finance && <Pricing canEdit={has('ADMIN_PRIME', 'FINANCEIRO')} />}
      {tab === 'conciliacao' && finance && <Reconciliation canRefund={has('ADMIN_PRIME', 'FINANCEIRO')} />}
      {tab === 'autoteste' && finance && <SelfCheck />}
    </>
  );
}

function Operations({ finance }: { finance: boolean }) {
  const { data, error, loading, reload } = useApi<any>('/api/admin/care/overview');
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const c = data.counts;
  return (
    <>
      <div className="stats">
        <div className="stat"><strong>{c.open_requests}</strong><span>Orçamentos em aberto</span></div>
        <div className="stat"><strong>{c.pending_quotes}</strong><span>Orçamentos pendentes</span></div>
        <div className="stat"><strong>{c.paid_orders}</strong><span>Pedidos pagos</span></div>
        <div className="stat"><strong>{c.open_events}</strong><span>Atendimentos sem especialista</span></div>
        <div className="stat"><strong>{c.scheduled_events}</strong><span>Atendimentos aceitos</span></div>
      </div>
      <section className="surface mt">
        <h2>Pedidos</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Data</th><th>Paciente</th><th>Item</th><th>Status</th><th className="right">Base</th><th className="right">Desconto</th><th className="right">Total</th>{finance && <th className="right">Repasse</th>}<th>Atos</th></tr></thead>
          <tbody>{data.orders.map((o: any) => (
            <tr key={o.id}><td className="nowrap">{dateTime(o.created_at)}</td><td>{o.patient_name}</td><td>{o.item_code} v{o.version_no ?? 1}<div className="small muted">{o.item_name}</div></td>
              <td><Badge tone={o.status === 'PAID' ? '' : o.status === 'FAILED' ? 'red' : 'dark'}>{label(o.status)}</Badge></td>
              <td className="right">{money(o.full_price_cents)}</td><td className="right">{money(o.discount_cents)}</td><td className="right"><strong>{money(o.final_price_cents)}</strong></td>
              {finance && <td className="right">{money(o.payout_total_cents)}</td>}<td>{o.events_done}/{o.events}</td></tr>
          ))}</tbody>
        </table></div>
        {!data.orders.length && <p className="muted">Nenhum pedido ainda.</p>}
      </section>
      <div className="two">
        <section className="surface">
          <h2>Solicitações</h2>
          <ul className="list">{data.requests.slice(0, 30).map((r: any) => (
            <li key={r.id}><div className="row between"><strong>{r.item_code}</strong><Badge tone={REQ_STATUS[r.status].tone}>{REQ_STATUS[r.status].label}</Badge></div>
              <div className="small muted">{r.protocol} · {r.requester_name} · {r.location} · orçamento v{r.quote_version}{r.accepted_version ? ` (aceito v${r.accepted_version})` : ''}{r.materials_supply_requested ? ' · cotação de materiais' : ''}</div></li>
          ))}</ul>
        </section>
        <section className="surface">
          <h2>Atendimentos</h2>
          <ul className="list">{data.events.slice(0, 30).map((e: any) => (
            <li key={e.id}><div className="row between"><strong>{e.label}</strong><Badge tone={e.status === 'DISPONIVEL' ? 'orange' : e.status === 'CANCELADO' ? 'red' : ''}>{e.status.replace('_', ' ').toLowerCase()}</Badge></div>
              <div className="small muted">{e.item_code} · {e.modality.toLowerCase()} · {e.region ?? '—'}{e.specialist_name ? ` · ${e.specialist_name}` : ''}{finance && e.unit_payout_cents != null ? ` · repasse ${money(e.unit_payout_cents)}` : ''}</div></li>
          ))}</ul>
          <h3 className="mt">Avaliações por especialista</h3>
          {!data.ratings.length ? <p className="small muted">Sem avaliações ainda.</p> : <ul className="list">{data.ratings.map((r: any) => <li key={r.name}>{r.name}: <strong>{r.avg} ★</strong> <span className="small muted">({r.n} avaliações)</span></li>)}</ul>}
          {data.growth && (
            <>
              <h3 className="mt">Recomendação e indicação</h3>
              <ul className="list">
                <li>NPS: <strong>{data.growth.nps ?? '—'}</strong> <span className="small muted">({data.growth.npsResponses} respostas · promotores 9–10 menos detratores 0–6)</span></li>
                <li>Cadastros por indicação de pacientes: <strong>{data.growth.referredSignups}</strong></li>
              </ul>
            </>
          )}
        </section>
      </div>
    </>
  );
}

function Pricing({ canEdit }: { canEdit: boolean }) {
  const { data, error, loading, reload } = useApi<any>('/api/admin/care/catalog');
  const [edit, setEdit] = useState<any>(null);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  return (
    <section className="surface">
      <div className="row between"><h2 className="mb0">Tabela comercial vigente</h2><span className="small muted">PRIME: {pctBps(data.prime.discountBps)} até {money(data.prime.capCents)} · {data.prime.usesPerCycle} uso por ciclo · mensalidade {money(data.prime.monthlyPriceCents)}</span></div>
      <p className="small muted">Valores em versões imutáveis com motivo, vigência e autor. Pedidos já contratados guardam a própria cópia. Contribuição gerencial: {pctBps(data.reportParams.rateBps)} sobre o recebido + {money(data.reportParams.opCostPerActCents)} por ato; aviso abaixo de {pctBps(data.reportParams.warnBelowBps)} (não bloqueia).</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Código</th><th>Registro</th><th className="right">Preço</th><th className="right">Repasse</th><th>Atos / composição</th><th className="right">Com PRIME</th><th className="right">Margem (cheio / PRIME)</th><th>Versão</th>{canEdit && <th />}</tr></thead>
        <tbody>{data.items.map((it: any) => {
          const c = it.current;
          return (
            <tr key={it.code}>
              <td className="nowrap"><strong>{it.code}</strong>{it.canonicalCode !== it.code && <div className="small muted">{it.canonicalCode}</div>}</td>
              <td>{it.name}<div className="small muted">{it.kind === 'PACOTE' ? 'Pacote' : 'Serviço'}{c.primeEligible ? ' · elegível PRIME' : ''}</div></td>
              <td className="right">{money(c.priceCents)}</td><td className="right">{money(c.payoutTotalCents)}</td>
              <td>{c.actsTotal}<div className="small muted">{c.components.map((x: any) => `${x.qty}× ${x.label} (${money(x.unit)})`).join(' + ')}</div></td>
              <td className="right">{money(c.primeTotalCents)}<div className="small muted">− {money(c.primeDiscountCents)}</div></td>
              <td className="right">{pctBps(c.contributionFull.marginBps)} / <span className={c.contributionPrime.warn ? 'err' : ''}>{pctBps(c.contributionPrime.marginBps)}</span></td>
              <td className="nowrap">v{c.versionNo}<div className="small muted">desde {dateTime(c.validFrom)}</div>{it.versions.length > 1 && <details className="small"><summary>histórico</summary>{it.versions.map((v: any) => <div key={v.versionNo}>v{v.versionNo} · {money(v.priceCents)} · {v.state.toLowerCase()} · {v.createdBy} · {v.reason}</div>)}</details>}</td>
              {canEdit && <td><Button className="sm secondary" onClick={() => setEdit(it)}>Nova versão</Button></td>}
            </tr>
          );
        })}</tbody>
      </table></div>
      {edit && <VersionDialog item={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </section>
  );
}

function VersionDialog({ item, onClose, onSaved }: { item: any; onClose: () => void; onSaved: () => void }) {
  const c = item.current;
  const [price, setPrice] = useState((c.priceCents / 100).toFixed(2));
  const [eligible, setEligible] = useState(c.primeEligible);
  const [comps, setComps] = useState(c.components.map((x: any) => ({ ...x, unitReais: (x.unit / 100).toFixed(2) })));
  const [validFrom, setValidFrom] = useState(() => new Date(Date.now() + 60_000).toISOString().slice(0, 16));
  const [reason, setReason] = useState('');
  const s = useSubmit<any>();
  const canonical = item.canonicalCode !== item.code;
  const toCents = (v: string) => Math.round(Number(v.replace(',', '.')) * 100);
  const payout = comps.reduce((t: number, x: any) => t + x.qty * toCents(x.unitReais), 0);
  async function save() {
    const body = {
      priceCents: toCents(price), primeEligible: eligible, actsLabel: c.actsLabel, periodDays: c.periodDays, recurring: c.recurring,
      inclusions: c.inclusions, exclusions: c.exclusions, validFrom: new Date(validFrom).toISOString(), reason,
      components: comps.map((x: any) => ({ act: x.act, label: x.label, modality: x.modality, qty: Number(x.qty), unit: toCents(x.unitReais), unitLabels: x.unitLabels })),
    };
    const url = canonical ? `/api/admin/care/canonical/${item.canonicalCode}/versions` : `/api/admin/care/catalog/${item.code}/versions`;
    if (await s.run('POST', url, body)) onSaved();
  }
  return (
    <Dialog open title={`Nova versão · ${item.code}`} onClose={onClose}>
      {canonical && <div className="callout">Oferta canônica {item.canonicalCode}: a nova versão vale para as duas visões (CAT-08 e PAC-05), sem duplicar cobrança ou repasse.</div>}
      <Field label="Preço público (R$)"><input type="text" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
      <label className="choice"><input type="checkbox" checked={eligible} onChange={(e) => setEligible(e.target.checked)} /> Elegível ao desconto PRIME</label>
      <h3>Composição profissional</h3>
      {comps.map((x: any, i: number) => (
        <div key={i} className="form-grid">
          <Field label={`${x.label} — quantidade`}><input type="number" min={1} value={x.qty} onChange={(e) => setComps(comps.map((y: any, j: number) => j === i ? { ...y, qty: Number(e.target.value) } : y))} /></Field>
          <Field label="Repasse unitário (R$)"><input type="text" inputMode="decimal" value={x.unitReais} onChange={(e) => setComps(comps.map((y: any, j: number) => j === i ? { ...y, unitReais: e.target.value } : y))} /></Field>
        </div>
      ))}
      <p className="small">Repasse total (soma da composição): <strong>{money(payout)}</strong></p>
      <Field label="Início da vigência"><input type="datetime-local" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} /></Field>
      <Field label="Motivo da alteração" hint="Fica na trilha de auditoria."><textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <Alert error={s.error} />
      <div className="row"><Button className="deep" busy={s.busy} onClick={save}>Registrar versão</Button><Button className="ghost" onClick={onClose}>Cancelar</Button></div>
    </Dialog>
  );
}

function Reconciliation({ canRefund }: { canRefund: boolean }) {
  const { data, error, loading, reload } = useApi<any>('/api/admin/care/reconciliation');
  const s = useSubmit<any>();
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const t = data.totals;
  async function refund(id: string) {
    const reason = window.prompt('Motivo do estorno (simulação):');
    if (reason && await s.run('POST', `/api/admin/care/orders/${id}/refund`, { reason })) reload();
  }
  return (
    <>
      <div className="stats">
        <div className="stat"><strong>{money(t.servicesReceivedCents)}</strong><span>Serviços recebidos</span></div>
        <div className="stat"><strong>{money(t.discountsCents)}</strong><span>Descontos PRIME</span></div>
        <div className="stat"><strong>{money(t.payoutsCents)}</strong><span>Repasses reservados</span></div>
        <div className="stat"><strong>{money(t.refundsCents)}</strong><span>Estornos</span></div>
        <div className="stat"><strong>{money(t.primeSubscriptionCents)}</strong><span>Mensalidades PRIME ({t.primeSubscriptionCharges})</span></div>
      </div>
      <p className="small muted mt">{data.formula} {data.fiscal.note}</p>
      <Alert error={s.error} />
      <div className="table-wrap"><table>
        <thead><tr><th>Pedido</th><th>Status</th><th className="right">Recebido</th><th className="right">Desconto</th><th className="right">Repasse</th><th className="right">Contribuição</th><th>Conferências</th>{canRefund && <th />}</tr></thead>
        <tbody>{data.rows.map((r: any) => {
          const ok = Object.values(r.checks).every(Boolean);
          return (
            <tr key={r.id}><td>{r.item} v{r.version}<div className="small muted">{r.patient} · {r.id.slice(0, 8)}</div></td><td>{label(r.status)}<div className="small muted">desconto {r.discountStatus ? label(r.discountStatus) : '—'}</div></td>
              <td className="right">{money(r.receivedCents)}</td><td className="right">{money(r.discountCents)}</td><td className="right">{money(r.payoutActiveCents)}<div className="small muted">de {money(r.payoutTotalCents)}</div></td>
              <td className="right">{r.contribution ? <>{money(r.contribution.contributionCents)}<div className={`small ${r.contribution.warn ? 'err' : 'muted'}`}>{pctBps(r.contribution.marginBps)}</div></> : '—'}</td>
              <td><Badge tone={ok ? '' : 'red'}>{ok ? 'OK' : 'Divergência'}</Badge><div className="small muted">{r.events} eventos · {r.payoutRows} repasses · {r.providerEvents} eventos do provedor{r.ignoredEvents ? ` (${r.ignoredEvents} ignorados)` : ''}</div></td>
              {canRefund && <td>{r.status === 'PAID' && <Button className="sm ghost" busy={s.busy} onClick={() => refund(r.id)}>Estornar</Button>}</td>}
            </tr>
          );
        })}</tbody>
      </table></div>
    </>
  );
}

function SelfCheck() {
  const { data, error, loading, reload } = useApi<any>('/api/admin/care/selfcheck');
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  return (
    <section className="surface">
      <div className="row between"><h2 className="mb0">Autoteste da configuração vigente</h2><Button className="sm secondary" onClick={reload}>Executar novamente</Button></div>
      <p className="small muted">Fonte: {data.source}. Executado em {dateTime(data.checkedAt)}. Os casos P05–P15 (concorrência, webhook, estorno, perfis, versões, conciliação e reversão) são cobertos pelos testes automatizados.</p>
      <ul className="list">{data.results.map((r: any) => (
        <li key={r.id}><div className="row"><Badge tone={r.pass ? '' : 'red'}>{r.pass ? 'PASS' : 'FAIL'}</Badge><strong>{r.id}</strong> {r.title}</div>
          <ul className="small muted">{r.details.map((d: string) => <li key={d}>{d}</li>)}</ul></li>
      ))}</ul>
    </section>
  );
}
