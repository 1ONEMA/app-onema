import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useApi, useSubmit } from '../../lib/hooks';
import { dateTime, label, money } from '../../lib/format';
import { Alert, Badge, Button, Empty, ErrorState, Loading, PageHeader } from '../../ui/ui';
import { IconArrowRight, IconCheck, IconStar } from '../../ui/icons';

export const REQ_STATUS: Record<string, { label: string; tone: string }> = {
  ORCADO: { label: 'Orçamento emitido', tone: 'blue' },
  ORCAMENTO_PENDENTE: { label: 'Orçamento pendente', tone: 'orange' },
  ACEITO: { label: 'Orçamento aceito · aguardando pagamento', tone: 'orange' },
  PEDIDO_GERADO: { label: 'Pedido confirmado', tone: '' },
  DESISTENCIA: { label: 'Desistência', tone: 'dark' },
};
const EVENT_STATUS: Record<string, { label: string; tone: string }> = {
  AGUARDANDO_PAGAMENTO: { label: 'Aguardando pagamento', tone: 'orange' },
  DISPONIVEL: { label: 'Buscando especialista', tone: 'blue' },
  ACEITO: { label: 'Especialista confirmado', tone: '' },
  CONCLUIDO: { label: 'Concluído', tone: 'dark' },
  CANCELADO: { label: 'Cancelado', tone: 'red' },
};

/** Meus pedidos: solicitações, orçamentos e pedidos do titular. */
export function MyOrdersPage() {
  const { data, error, loading, reload } = useApi<any>('/api/care/requests');
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  return (
    <>
      <PageHeader kicker="Minha ONEMA" title="Meus pedidos">
        <p>Solicitações, orçamentos, pagamentos e andamento dos atendimentos.</p>
        <Link to="/solicitar" className="btn green">Nova solicitação <IconArrowRight size={18} /></Link>
      </PageHeader>
      {!data.requests.length ? (
        <div className="surface"><Empty title="Você ainda não fez solicitações." action={<Link to="/solicitar" className="btn deep">Solicitar cuidado</Link>} /></div>
      ) : (
        <div className="stack">
          {data.requests.map((r: any) => {
            const st = REQ_STATUS[r.status];
            return (
              <Link key={r.id} to={r.status === 'PEDIDO_GERADO' || r.status === 'DESISTENCIA' ? `/solicitacoes/${r.id}` : `/solicitar?id=${r.id}`} className="tile link order-tile">
                <div>
                  <div className="row"><strong>{r.quote.offer.name}</strong><Badge tone={st.tone}>{st.label}</Badge></div>
                  <div className="small muted">{r.protocol} · {r.quote.offer.code} v{r.quote.offer.versionNo} · {dateTime(r.createdAt)} · {r.location}</div>
                </div>
                <div className="right">
                  <strong className="nowrap">{r.order ? money(r.order.totalCents) : r.quote.pending ? 'Pendente' : money(r.quote.totalCents)}</strong>
                  <div className="small muted">{r.status === 'PEDIDO_GERADO' ? 'Ver comprovante' : r.status === 'DESISTENCIA' ? 'Detalhes' : 'Continuar'}</div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}

function Stars({ eventId, current, onDone }: { eventId: string; current: number | null; onDone: () => void }) {
  const [stars, setStars] = useState(current ?? 0);
  const s = useSubmit<any>();
  if (current) return <span className="stars" role="img" aria-label={`Sua avaliação: ${current} de 5 estrelas`}>{[1, 2, 3, 4, 5].map((i) => <IconStar key={i} size={18} filled={i <= current} />)}</span>;
  return (
    <div className="row">
      <div className="stars" role="radiogroup" aria-label="Avalie o atendimento">
        {[1, 2, 3, 4, 5].map((i) => (
          <button key={i} role="radio" aria-checked={stars === i} aria-label={`${i} estrela${i > 1 ? 's' : ''}`} onClick={() => setStars(i)} className="star-btn"><IconStar size={22} filled={i <= stars} /></button>
        ))}
      </div>
      <Button className="sm deep" disabled={!stars} busy={s.busy} onClick={async () => { if (await s.run('POST', `/api/care/events/${eventId}/review`, { stars })) onDone(); }}>Enviar avaliação</Button>
      <Alert error={s.error} />
    </div>
  );
}

/** Comprovante e andamento: pedido, versão, valores, desconto, ciclo, pagamento e próximos passos. */
export function RequestDetailPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const { data, error, loading, reload } = useApi<any>(`/api/care/requests/${id}`);
  useEffect(() => { document.title = 'Comprovante · ONEMA SAÚDE'; }, []);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const r = data.request, o = r.order, q = r.quote;
  return (
    <>
      <PageHeader kicker={o?.status === 'PAID' ? 'Comprovante do pedido' : 'Solicitação'} title={q.offer.name} back={{ to: '/servicos', label: 'Meus pedidos' }}>
        {params.get('confirmado') && <div className="success" role="status"><IconCheck size={18} /> Pagamento confirmado (simulação). Seu pedido foi registrado.</div>}
        <Badge tone={REQ_STATUS[r.status].tone}>{REQ_STATUS[r.status].label}</Badge>
      </PageHeader>
      <div className="two">
        <section className="surface">
          <h2>Valores</h2>
          <dl className="kv">
            <dt>Pedido</dt><dd className="mono">{o ? o.id.slice(0, 8).toUpperCase() : '—'}</dd>
            <dt>Orçamento</dt><dd>{r.protocol} · versão {r.quoteVersion}</dd>
            <dt>Registro comercial</dt><dd>{o?.itemCode ?? q.offer.code} · versão {o?.versionNo ?? q.offer.versionNo}</dd>
            <dt>Preço base</dt><dd>{money(o?.basePriceCents ?? q.basePriceCents)}</dd>
            <dt>Desconto PRIME</dt><dd>{money(o?.discountCents ?? q.discountCents)}{o?.cycleId ? ' · uso do ciclo vigente' : ''}</dd>
            <dt>Total</dt><dd><strong>{money(o?.totalCents ?? q.totalCents)}</strong></dd>
            <dt>Pagamento</dt><dd>{o ? `${label(o.status)} · ${o.provider === 'SANDBOX' ? 'simulado' : o.provider} · ${dateTime(o.paidAt ?? o.createdAt)}` : 'Não realizado'}</dd>
            {o?.billingPeriod && <><dt>Mês de referência</dt><dd>{o.billingPeriod.split('-').reverse().join('/')}</dd></>}
          </dl>
          {data.attempts.length > 1 && <p className="small muted">Tentativas de pagamento: {data.attempts.map((a: any) => label(a.status)).join(', ')}.</p>}
          {r.status !== 'PEDIDO_GERADO' && r.status !== 'DESISTENCIA' && <Link className="btn deep" to={`/solicitar?id=${r.id}`}>Continuar solicitação</Link>}
        </section>
        <section className="surface">
          <h2>Próximos passos</h2>
          {!data.events.length ? <p className="muted">Os atendimentos aparecem aqui após a confirmação do pagamento.</p> : (
            <ul className="list">
              {data.events.map((e: any) => (
                <li key={e.id}>
                  <div className="row between">
                    <span><strong>{e.label}</strong> <span className="small muted">· {e.modality === 'REMOTO' ? 'remoto' : 'presencial'}</span></span>
                    <Badge tone={EVENT_STATUS[e.status].tone}>{EVENT_STATUS[e.status].label}</Badge>
                  </div>
                  {e.specialist_name && <div className="small muted">Especialista: {e.specialist_name}{Number(e.specialist_reviews) > 0 ? ` · ${Number(e.specialist_rating).toFixed(1).replace('.', ',')} ★ (${e.specialist_reviews} ${Number(e.specialist_reviews) > 1 ? 'avaliações' : 'avaliação'})` : ''}{e.completed_at ? ` · concluído em ${dateTime(e.completed_at)}` : ''}</div>}
                  {e.status === 'CONCLUIDO' && <div className="mt"><Stars eventId={e.id} current={e.my_stars} onDone={reload} /></div>}
                </li>
              ))}
            </ul>
          )}
          <p className="small muted">A Central ONEMA confirma a agenda com um especialista validado. O mesmo enfermeiro não é obrigatório em todos os atendimentos de um pacote.</p>
        </section>
      </div>
    </>
  );
}
