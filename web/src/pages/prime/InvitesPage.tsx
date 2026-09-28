import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { dateTime, label, money } from '../../lib/format';
import { useApi, useSubmit } from '../../lib/hooks';
import { Alert, Badge, Button, Empty, ErrorState, Loading, PageHeader } from '../../ui/ui';

export function InvitesPage() {
  const { data, error, loading, reload } = useApi<any>('/api/prime/share/received');
  const act = useSubmit<any>();
  const [msg, setMsg] = useState<string | null>(null);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  return (
    <>
      <PageHeader kicker="Rede familiar autorizada" title="Convites recebidos"><p>Pessoas que convidaram você para acompanhar parte do cuidado delas.</p></PageHeader>
      <Alert error={act.error} success={msg} />
      <section className="surface">
        {!data.grants.length ? <Empty title="Nenhum convite recebido." /> : (
          <ul className="list">{data.grants.map((g: any) => (
            <li key={g.id}>
              <div className="row between"><strong>{g.patientName}</strong><Badge tone={g.status === 'VERIFIED' ? '' : 'orange'}>{label(g.status)}</Badge></div>
              <p className="small muted mb0">Permissões: {Object.entries(g.scopes).filter(([, v]) => v).map(([k]) => k.toLowerCase()).join(', ') || 'nenhuma'} · convite em {dateTime(g.invitedAt)}</p>
              <div className="row mt">
                {g.status === 'INVITED' && <>
                  <Button className="sm deep" busy={act.busy} onClick={async () => { const r = await act.run('POST', `/api/prime/share/${g.id}/accept`, {}); if (r) { setMsg(r.message); reload(); } }}>Aceitar convite</Button>
                  <Button className="sm ghost" busy={act.busy} onClick={async () => { if (await act.run('POST', `/api/prime/share/${g.id}/decline`, {})) reload(); }}>Recusar</Button></>}
                {g.status === 'VERIFIED' && <Link to={`/apoio/${g.id}`} className="btn sm secondary">Acompanhar</Link>}
              </div>
            </li>))}
          </ul>
        )}
      </section>
    </>
  );
}

export function SupportViewPage() {
  const { grantId } = useParams();
  const grants = useApi<any>('/api/prime/share/received');
  const [scope, setScope] = useState<string | null>(null);
  const view = useApi<any>(scope ? `/api/prime/share/${grantId}/view/${scope}` : null);
  if (grants.loading) return <Loading />;
  const g = grants.data?.grants.find((x: any) => x.id === grantId);
  if (!g) return <ErrorState error={{ message: 'Convite não encontrado.', status: 404 } as any} />;
  const allowed = Object.entries(g.scopes).filter(([, v]) => v).map(([k]) => k);
  return (
    <>
      <PageHeader kicker="Apoio autorizado" title={g.patientName} back={{ to: '/convites', label: 'Convites' }}><p>Você vê apenas o que o titular autorizou. Cada acesso é registrado e visível para o titular.</p></PageHeader>
      <div className="pills">{allowed.map((k) => <button key={k} className={scope === k ? 'active' : ''} onClick={() => setScope(k)}>{{ AGENDA: 'Agenda', DOCUMENTOS: 'Documentos', COBRANCAS: 'Cobranças e recibos' }[k]}</button>)}</div>
      {!scope ? <p className="muted">Escolha uma área acima.</p> : view.loading ? <Loading /> : view.error ? <ErrorState error={view.error} /> : (
        <section className="surface">
          {!view.data.available ? <p className="caution">{view.data.reason}</p> : (
            <>
              <h2>Cobranças PRIME</h2>
              {!view.data.charges.length ? <p className="muted">Nenhuma.</p> : <ul className="list small">{view.data.charges.map((c: any, i: number) => <li key={i}>{dateTime(c.created_at)} · ciclo {c.cycle_no} · {money(c.amount_cents)} — {label(c.status)}</li>)}</ul>}
              <h2 className="mt">Pedidos</h2>
              {!view.data.orders.length ? <p className="muted">Nenhum.</p> : <ul className="list small">{view.data.orders.map((o: any, i: number) => <li key={i}>{dateTime(o.created_at)} · {o.item_name} · {money(o.final_price_cents)} — {label(o.status)}</li>)}</ul>}
            </>
          )}
        </section>
      )}
    </>
  );
}
