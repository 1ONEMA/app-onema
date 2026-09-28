import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth';
import { dateTime, label, money } from '../../lib/format';
import { useApi, useSubmit } from '../../lib/hooks';
import { Alert, Badge, Button, Dialog, ErrorState, Field, Loading, PageHeader } from '../../ui/ui';

export function FinancePage() {
  const { has } = useAuth();
  const academy = useApi<any>('/api/admin/academy/payment-orders');
  const prime = useApi<any>(has('FINANCEIRO', 'AUDITOR') ? '/api/admin/prime/refunds' : null);
  const decide = useSubmit<any>();
  const refundOrder = useSubmit<any>();
  const [dlg, setDlg] = useState<any>(null);
  const [note, setNote] = useState('');
  const canAct = has('FINANCEIRO');
  return (
    <>
      <PageHeader kicker="Financeiro" title="Pagamentos, cobranças e estornos"><p>Todos os valores deste ambiente são simulados (sandbox). A equipe financeira não acessa respostas, notas ou conteúdo clínico.</p></PageHeader>
      {prime.data && (
        <>
          <section className="surface">
            <h2>Solicitações de arrependimento e estorno (PRIME)</h2>
            <Alert error={decide.error} />
            {!prime.data.refunds.length ? <p className="muted">Nenhuma solicitação.</p> : (
              <div className="table-wrap"><table><thead><tr><th>Protocolo</th><th>Paciente</th><th>Tipo</th><th>Valor</th><th>Cobrança original</th><th>Situação</th><th /></tr></thead>
                <tbody>{prime.data.refunds.map((r: any) => <tr key={r.id}><td className="mono">{r.protocol}</td><td>{r.patient_name}</td><td>{r.type}</td><td>{money(r.amount_cents)}</td><td className="small">{dateTime(r.charge_date)}<br /><span className="mono">{r.provider_ref ?? r.order_id}</span></td>
                  <td><Badge tone={r.status === 'REFUNDED' ? '' : r.status === 'REJECTED' ? 'red' : 'orange'}>{label(r.status)}</Badge>{r.reason && <div className="small muted">{r.reason}</div>}</td>
                  <td>{canAct && r.status === 'REFUND_PENDING' && <Button className="sm secondary" onClick={() => { setDlg({ kind: 'refund', r }); setNote(''); }}>Decidir</Button>}</td></tr>)}</tbody></table></div>
            )}
          </section>
          <section className="surface">
            <h2>Pedidos de serviços/pacotes</h2>
            <Alert error={refundOrder.error} />
            <div className="table-wrap"><table><thead><tr><th>Data</th><th>Paciente</th><th>Item</th><th>Cheio</th><th>Desconto</th><th>Final</th><th>Base de repasse</th><th>Situação</th><th /></tr></thead>
              <tbody>{prime.data.orders.map((o: any) => <tr key={o.id}><td>{dateTime(o.created_at)}</td><td>{o.patient_name}</td><td>{o.item_name}</td><td>{money(o.full_price_cents)}</td><td>{money(o.discount_cents)}</td><td>{money(o.final_price_cents)}</td><td>{money(o.payout_basis_cents)}</td><td>{label(o.status)}</td>
                <td>{canAct && o.status === 'PAID' && <Button className="sm ghost" onClick={() => { setDlg({ kind: 'order', o }); setNote(''); }}>Estornar</Button>}</td></tr>)}</tbody></table></div>
          </section>
          <section className="surface">
            <h2>Cobranças PRIME</h2>
            <div className="table-wrap"><table><thead><tr><th>Data</th><th>Paciente</th><th>Valor</th><th>Tentativa</th><th>Situação</th><th>Referência</th></tr></thead>
              <tbody>{prime.data.charges.map((c: any) => <tr key={c.id}><td>{dateTime(c.created_at)}</td><td>{c.patient_name}</td><td>{money(c.amount_cents)}</td><td>{c.attempt_no}</td><td>{label(c.status)}</td><td className="mono">{c.provider}:{c.provider_ref}</td></tr>)}</tbody></table></div>
          </section>
        </>
      )}
      <section className="surface">
        <h2>Pedidos da taxa Academy</h2>
        {academy.loading ? <Loading lines={2} /> : academy.error ? <ErrorState error={academy.error} /> : (
          <div className="table-wrap"><table><thead><tr><th>Data</th><th>Especialista</th><th>Valor</th><th>Situação</th><th>Provedor</th></tr></thead>
            <tbody>{academy.data.orders.map((o: any) => <tr key={o.id}><td>{dateTime(o.created_at)}</td><td>{o.partner_name}</td><td>{money(o.amount_cents)}</td><td>{label(o.status)}</td><td>{o.provider}</td></tr>)}</tbody></table></div>
        )}
      </section>
      <Dialog open={!!dlg} title={dlg?.kind === 'order' ? 'Estornar pedido' : `Solicitação ${dlg?.r?.protocol}`} onClose={() => setDlg(null)}>
        <Field label="Registro da decisão"><textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        {dlg?.kind === 'order' ? (
          <Button className="danger" busy={refundOrder.busy} onClick={async () => { if (await refundOrder.run('POST', `/api/admin/prime/orders/${dlg.o.id}/refund`, { note })) { setDlg(null); prime.reload(); } }}>Estornar (simulação)</Button>
        ) : (
          <div className="row">
            <Button className="deep" busy={decide.busy} onClick={async () => { if (await decide.run('POST', `/api/admin/prime/refunds/${dlg.r.id}/decide`, { approve: true, note })) { setDlg(null); prime.reload(); } }}>Aprovar estorno (simulação)</Button>
            <Button className="ghost" busy={decide.busy} onClick={async () => { if (await decide.run('POST', `/api/admin/prime/refunds/${dlg.r.id}/decide`, { approve: false, note })) { setDlg(null); prime.reload(); } }}>Não aprovar</Button>
          </div>
        )}
      </Dialog>
    </>
  );
}

export function SharesAdminPage() {
  const { has } = useAuth();
  const [status, setStatus] = useState('ACCEPTED');
  const { data, error, loading, reload } = useApi<any>(`/api/admin/prime/share-grants${status ? `?status=${status}` : ''}`);
  const verify = useSubmit<any>();
  const [sel, setSel] = useState<any>(null);
  const [note, setNote] = useState('');
  return (
    <>
      <PageHeader kicker="Central Operacional" title="Verificação de responsáveis"><p>O acesso do responsável só começa após o aceite autenticado e a verificação da autorização. Representação legal exige verificação documental.</p></PageHeader>
      <div className="pills">{[['ACCEPTED', 'Aguardando verificação'], ['VERIFIED', 'Verificados'], ['INVITED', 'Convites'], ['', 'Todos']].map(([k, l]) => <button key={k} className={status === k ? 'active' : ''} onClick={() => setStatus(k)}>{l}</button>)}</div>
      {loading ? <Loading /> : error ? <ErrorState error={error} onRetry={reload} /> : (
        <section className="surface">
          {!data.grants.length ? <p className="muted">Nada nesta lista.</p> : (
            <div className="table-wrap"><table><thead><tr><th>Titular</th><th>Responsável</th><th>Escopos</th><th>Estado</th><th /></tr></thead>
              <tbody>{data.grants.map((g: any) => <tr key={g.id}><td>{g.patient_name}</td><td>{g.invitee_name}<br /><span className="small muted">{g.invitee_email}{g.invitee_account_name && ` · conta: ${g.invitee_account_name}`}</span></td><td>{g.scopes ?? '—'}</td><td>{label(g.status)}<div className="small muted">{dateTime(g.accepted_at ?? g.invited_at)}</div></td>
                <td>{g.status === 'ACCEPTED' && has('OPERADOR_CENTRAL') && <Button className="sm secondary" onClick={() => { setSel(g); setNote(''); }}>Verificar</Button>}</td></tr>)}</tbody></table></div>
          )}
        </section>
      )}
      <Dialog open={!!sel} title="Verificar autorização" onClose={() => setSel(null)}>
        <p>{sel?.patient_name} → {sel?.invitee_name}</p>
        <Field label="Como a autorização foi verificada"><textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <Alert error={verify.error} />
        <div className="row">
          <Button className="deep" busy={verify.busy} onClick={async () => { if (await verify.run('POST', `/api/admin/prime/share-grants/${sel.id}/verify`, { approve: true, note })) { setSel(null); reload(); } }}>Verificar e liberar</Button>
          <Button className="ghost" busy={verify.busy} onClick={async () => { if (await verify.run('POST', `/api/admin/prime/share-grants/${sel.id}/verify`, { approve: false, note })) { setSel(null); reload(); } }}>Não verificar</Button>
        </div>
      </Dialog>
    </>
  );
}

const reais = (c: number) => (c / 100).toFixed(2).replace('.', ',');
const cents = (s: string) => Math.round(Number(String(s).replace(/\./g, '').replace(',', '.')) * 100);

export function PrimeAdminPage() {
  const { has } = useAuth();
  const admin = has('ADMIN_PRIME');
  const ov = useApi<any>('/api/admin/prime/overview');
  const params = useApi<any>('/api/admin/prime/parameters');
  const cat = useApi<any>('/api/admin/prime/catalog');
  const texts = useApi<any>(has('ADMIN_PRIME', 'AUDITOR') ? '/api/admin/prime/legal-texts' : null);
  const prov = useApi<any>(has('ADMIN_PRIME', 'AUDITOR') ? '/api/admin/prime/provider-identity' : null);
  const saveP = useSubmit<any>(); const saveProv = useSubmit<any>(); const saveItem = useSubmit<any>(); const review = useSubmit<any>(); const billing = useSubmit<any>();
  const [p, setP] = useState<any>(null);
  const [pv, setPv] = useState<any>(null);
  const [item, setItem] = useState<any>(null);
  const [ok, setOk] = useState<string | null>(null);
  useEffect(() => { if (params.data) { const c = params.data.current; setP({ monthly: reais(c.monthly_price_cents), bps: c.discount_bps, cap: reais(c.discount_cap_cents), uses: c.uses_per_cycle, retryMax: c.retry_max, retryDays: c.retry_window_days, withdrawal: c.refund_withdrawal_days, note: '' }); } }, [params.data]);
  useEffect(() => { if (prov.data) { const x = prov.data.provider ?? {}; setPv({ legalName: x.legal_name ?? '', cnpj: x.cnpj ?? '', address: x.address ?? '', supportChannel: x.support_channel ?? '', validated: !!x.validated }); } }, [prov.data]);
  if (ov.loading) return <Loading />;
  if (ov.error) return <ErrorState error={ov.error} onRetry={ov.reload} />;
  return (
    <>
      <PageHeader kicker="ONEMA PRIME" title="Administração PRIME"><p>Parâmetros comerciais versionados, catálogo, fornecedor, textos e gates de produção. Toda alteração exige perfil e fica registrada.</p></PageHeader>
      <Alert success={ok} />
      <section className="surface">
        <div className="row between"><h2 className="mb0">Gates HML → produção</h2><Badge tone={ov.data.productionReady ? '' : 'red'}>{ov.data.productionReady ? 'Liberável' : 'Produção bloqueada'}</Badge></div>
        <ul className="list mt">{ov.data.gates.map((g: any) => <li key={g.id} className="row between"><span><strong>{g.id}</strong> · {g.label}</span><Badge tone={g.ok ? '' : 'orange'}>{g.ok ? 'Atendido' : 'Pendente'}</Badge></li>)}</ul>
      </section>
      <div className="two">
        <section className="surface"><h2>Assinaturas</h2><ul className="list small">{ov.data.subscriptionsByStatus.map((r: any) => <li key={r.status} className="row between"><span>{r.status}</span><strong>{r.total}</strong></li>)}{!ov.data.subscriptionsByStatus.length && <li className="muted">Nenhuma.</li>}</ul></section>
        <section className="surface"><h2>Descontos e preferências</h2><ul className="list small">{ov.data.discounts.map((r: any) => <li key={r.status} className="row between"><span>Desconto {r.status}</span><strong>{r.total} · {money(r.amount_cents)}</strong></li>)}{ov.data.optOut.map((r: any, i: number) => <li key={i} className="row between"><span>{r.purpose} {r.event}</span><strong>{r.total}</strong></li>)}</ul></section>
      </div>
      {p && (
        <section className="surface">
          <h2>Parâmetros comerciais · v{params.data.current.version}</h2>
          <p className="small muted">Fonte vigente: {params.data.current.source_note}</p>
          <div className="grid">
            <Field label="Mensalidade (R$)"><input type="text" disabled={!admin} value={p.monthly} onChange={(e) => setP({ ...p, monthly: e.target.value })} /></Field>
            <Field label="Desconto (pontos-base; 500 = 5%)"><input type="number" disabled={!admin} value={p.bps} onChange={(e) => setP({ ...p, bps: e.target.value })} /></Field>
            <Field label="Teto por pedido (R$)"><input type="text" disabled={!admin} value={p.cap} onChange={(e) => setP({ ...p, cap: e.target.value })} /></Field>
            <Field label="Usos por ciclo"><input type="number" disabled={!admin} value={p.uses} onChange={(e) => setP({ ...p, uses: e.target.value })} /></Field>
            <Field label="Novas tentativas de cobrança"><input type="number" disabled={!admin} value={p.retryMax} onChange={(e) => setP({ ...p, retryMax: e.target.value })} /></Field>
            <Field label="Janela de tentativas (dias)"><input type="number" disabled={!admin} value={p.retryDays} onChange={(e) => setP({ ...p, retryDays: e.target.value })} /></Field>
            <Field label="Prazo de arrependimento (dias)"><input type="number" disabled={!admin} value={p.withdrawal} onChange={(e) => setP({ ...p, withdrawal: e.target.value })} /></Field>
          </div>
          {admin && <><Field label="Fundamento da alteração (decisão/documento)"><input type="text" value={p.note} onChange={(e) => setP({ ...p, note: e.target.value })} /></Field>
            <Alert error={saveP.error} />
            <Button className="deep" busy={saveP.busy} onClick={async () => { const r = await saveP.run('POST', '/api/admin/prime/parameters', { monthlyPriceCents: cents(p.monthly), discountBps: Number(p.bps), discountCapCents: cents(p.cap), usesPerCycle: Number(p.uses), retryMax: Number(p.retryMax), retryWindowDays: Number(p.retryDays), refundWithdrawalDays: Number(p.withdrawal), sourceNote: p.note }); if (r) { setOk(r.note); params.reload(); } }}>Criar nova versão</Button></>}
        </section>
      )}
      {pv && (
        <section className="surface">
          <h2>Identificação do fornecedor</h2>
          <p className="small muted">Exibida em “Termos &gt; Identificação do fornecedor”. Não publicar valores fictícios nem razão social apenas proposta (critério A11).</p>
          <div className="grid">
            <Field label="Razão social"><input type="text" disabled={!admin} value={pv.legalName} onChange={(e) => setPv({ ...pv, legalName: e.target.value })} /></Field>
            <Field label="CNPJ"><input type="text" disabled={!admin} value={pv.cnpj} onChange={(e) => setPv({ ...pv, cnpj: e.target.value })} /></Field>
            <Field label="Endereço"><input type="text" disabled={!admin} value={pv.address} onChange={(e) => setPv({ ...pv, address: e.target.value })} /></Field>
            <Field label="Canal de atendimento"><input type="text" disabled={!admin} value={pv.supportChannel} onChange={(e) => setPv({ ...pv, supportChannel: e.target.value })} /></Field>
          </div>
          <label className="choice"><input type="checkbox" disabled={!admin} checked={pv.validated} onChange={(e) => setPv({ ...pv, validated: e.target.checked })} /><span>Dados validados pelo cadastro jurídico</span></label>
          <Alert error={saveProv.error} />
          {admin && <Button className="deep" busy={saveProv.busy} onClick={async () => { if (await saveProv.run('PUT', '/api/admin/prime/provider-identity', { ...pv, cnpj: pv.cnpj || null, legalName: pv.legalName || null, address: pv.address || null, supportChannel: pv.supportChannel || null })) { setOk('Identificação salva.'); prov.reload(); ov.reload(); } }}>Salvar</Button>}
        </section>
      )}
      {texts.data && (
        <section className="surface">
          <h2>Textos oficiais</h2>
          <Alert error={review.error} />
          <div className="table-wrap"><table><thead><tr><th>Texto</th><th>Versão</th><th>Aprovação RT</th><th>Revisão jurídica</th><th /></tr></thead>
            <tbody>{texts.data.texts.map((t: any) => <tr key={t.id}><td>{t.title}</td><td>{t.version}</td><td>{t.rt_approved_at ?? '—'}</td><td><Badge tone={t.legal_review === 'APROVADO' ? '' : 'orange'}>{t.legal_review === 'APROVADO' ? 'Aprovada' : 'Pendente'}</Badge></td>
              <td>{admin && t.legal_review !== 'APROVADO' && <Button className="sm ghost" busy={review.busy} onClick={async () => { const note = prompt('Registre a referência do parecer jurídico (mín. 10 caracteres):'); if (note && await review.run('POST', `/api/admin/prime/legal-texts/${t.id}/legal-review`, { status: 'APROVADO', note })) { texts.reload(); ov.reload(); } }}>Registrar parecer</Button>}</td></tr>)}</tbody></table></div>
        </section>
      )}
      <section className="surface">
        <div className="row between"><h2 className="mb0">Catálogo</h2>{admin && <Button className="sm secondary" onClick={() => setItem({ id: null, code: '', name: '', kind: 'SERVICO', price: '', primeEligible: true, active: true })}>Novo item</Button>}</div>
        <p className="small muted">O catálogo oficial “Preços Oficiais v3” não foi fornecido; itens marcados como FICTÍCIO existem apenas na base de demonstração.</p>
        {cat.data && <div className="table-wrap"><table><thead><tr><th>Código</th><th>Nome</th><th>Tipo</th><th>Preço</th><th>PRIME</th><th>Ativo</th><th /></tr></thead>
          <tbody>{cat.data.items.map((i: any) => <tr key={i.id}><td className="mono">{i.code}</td><td>{i.name} {i.is_demo ? <span className="demo-flag">FICTÍCIO</span> : null}</td><td>{i.kind}</td><td>{money(i.price_cents)}</td><td>{i.prime_eligible ? 'Elegível' : 'Não'}</td><td>{i.active ? 'Sim' : 'Não'}</td>
            <td>{admin && <Button className="sm ghost" onClick={() => setItem({ id: i.id, code: i.code, name: i.name, kind: i.kind, price: reais(i.price_cents), primeEligible: !!i.prime_eligible, active: !!i.active })}>Editar</Button>}</td></tr>)}</tbody></table></div>}
      </section>
      {admin && (
        <section className="surface">
          <h2>Motor de ciclos</h2>
          <p className="small muted">Renovações, novas tentativas, suspensões e encerramentos. Em produção, executar por agendador (`npm run jobs:billing`).</p>
          <Alert error={billing.error} />
          <Button className="secondary" busy={billing.busy} onClick={async () => { const r = await billing.run('POST', '/api/admin/prime/billing/run', {}); if (r) { setOk(`Ciclos processados: ${JSON.stringify(r)}`); ov.reload(); } }}>Executar agora</Button>
        </section>
      )}
      <Dialog open={!!item} title={item?.id ? 'Editar item' : 'Novo item'} onClose={() => setItem(null)}>
        {item && <>
          <Field label="Código"><input type="text" disabled={!!item.id} value={item.code} onChange={(e) => setItem({ ...item, code: e.target.value.toUpperCase() })} /></Field>
          <Field label="Nome"><input type="text" value={item.name} onChange={(e) => setItem({ ...item, name: e.target.value })} /></Field>
          <Field label="Tipo"><select value={item.kind} onChange={(e) => setItem({ ...item, kind: e.target.value })}><option value="SERVICO">Serviço</option><option value="PACOTE">Pacote</option></select></Field>
          <Field label="Preço (R$)"><input type="text" value={item.price} onChange={(e) => setItem({ ...item, price: e.target.value })} /></Field>
          <label className="choice"><input type="checkbox" checked={item.primeEligible} onChange={(e) => setItem({ ...item, primeEligible: e.target.checked })} /><span>Elegível ao desconto PRIME</span></label>
          <label className="choice"><input type="checkbox" checked={item.active} onChange={(e) => setItem({ ...item, active: e.target.checked })} /><span>Ativo</span></label>
          <Alert error={saveItem.error} />
          <Button className="deep" busy={saveItem.busy} onClick={async () => {
            const body = { code: item.code, name: item.name, kind: item.kind, priceCents: cents(item.price), primeEligible: item.primeEligible, active: item.active, validFrom: null, validTo: null };
            if (await saveItem.run(item.id ? 'PUT' : 'POST', item.id ? `/api/admin/prime/catalog/${item.id}` : '/api/admin/prime/catalog', body)) { setItem(null); cat.reload(); }
          }}>Salvar</Button>
        </>}
      </Dialog>
    </>
  );
}
