import { PendingPayment } from '../../ui/AsaasPay';
import { EVO_SECTIONS } from './WalletPage';
import { Fragment, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useApi, useSubmit } from '../../lib/hooks';
import { dateTime, label, money } from '../../lib/format';
import { Alert, Badge, Button, Empty, ErrorState, Field, Loading, PageHeader, fieldError } from '../../ui/ui';
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
  const [nps, setNps] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const s = useSubmit<any>();
  if (current) return <span className="stars" role="img" aria-label={`Sua avaliação: ${current} de 5 estrelas`}>{[1, 2, 3, 4, 5].map((i) => <IconStar key={i} size={18} filled={i <= current} />)}</span>;
  return (
    <div className="stack">
      <div className="stars" role="radiogroup" aria-label="Avalie o atendimento">
        {[1, 2, 3, 4, 5].map((i) => (
          <button key={i} role="radio" aria-checked={stars === i} aria-label={`${i} estrela${i > 1 ? 's' : ''}`} onClick={() => setStars(i)} className="star-btn"><IconStar size={22} filled={i <= stars} /></button>
        ))}
      </div>
      <fieldset className="nps">
        <legend className="small">De 0 a 10, quanto você recomendaria a ONEMA a um amigo ou familiar? <span className="muted">(opcional)</span></legend>
        <div className="nps-scale" role="radiogroup" aria-label="Recomendação de 0 a 10">
          {Array.from({ length: 11 }, (_, i) => (
            <button key={i} type="button" role="radio" aria-checked={nps === i} className={nps === i ? 'on' : ''} onClick={() => setNps(i)}>{i}</button>
          ))}
        </div>
      </fieldset>
      <label className="field">
        <span className="small">Comentário (opcional)</span>
        <textarea rows={2} maxLength={400} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Conte como foi o atendimento" />
      </label>
      <div className="row">
        <Button className="sm deep" disabled={!stars} busy={s.busy} onClick={async () => { if (await s.run('POST', `/api/care/events/${eventId}/review`, { stars, comment, ...(nps !== null ? { nps } : {}) })) onDone(); }}>Enviar avaliação</Button>
      </div>
      <Alert error={s.error} />
    </div>
  );
}

/** Assinatura do atendimento pelo paciente/responsável, com a evolução registrada à vista. */
function SignCard({ event: e, onDone }: { event: any; onDone: () => void }) {
  const [name, setName] = useState('');
  const [ok, setOk] = useState(false);
  const s = useSubmit<any>();
  return (
    <div className="sign-card" role="region" aria-label="Assinar atendimento">
      <strong>Confirme o atendimento</strong>
      <p className="small mb0">A especialista registrou a evolução abaixo. Confira e assine para confirmar que o atendimento foi realizado.</p>
      <dl className="kv small">{EVO_SECTIONS.map(([k, l]) => e.evolution?.[k] && <Fragment key={k}><dt>{l}</dt><dd>{e.evolution[k]}</dd></Fragment>)}</dl>
      <label className="field"><span className="small">Seu nome completo</span><input type="text" autoComplete="name" value={name} onChange={(ev) => setName(ev.target.value)} /></label>
      <label className="choice mandatory"><input type="checkbox" checked={ok} onChange={(ev) => setOk(ev.target.checked)} /><span>Confirmo que o atendimento foi realizado.</span></label>
      <Alert error={s.error} />
      <Button className="sm green" busy={s.busy} disabled={!ok || name.trim().length < 3} onClick={async () => { if (await s.run('POST', `/api/care/events/${e.id}/sign`, { name, confirm: ok })) onDone(); }}>Assinar atendimento</Button>
    </div>
  );
}

/** Linha do tempo do atendimento (fatos registrados), para o paciente e para o responsável. */
export function CareTimeline({ items }: { items: any[] }) {
  if (!items?.length) return <p className="small muted">Os próximos passos aparecem aqui assim que acontecerem.</p>;
  return (
    <ol className="timeline">{items.map((t, i) => (
      <li key={i}><strong>{t.title}</strong> <span className="small muted">{dateTime(t.at)}</span>{t.detail && <p className="mb0 small">{t.detail}</p>}</li>
    ))}</ol>
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
  const pendingPay = data.attempts.find((a: any) => a.status === 'PENDING_PAYMENT');
  return (
    <>
      <PageHeader kicker={o?.status === 'PAID' ? 'Comprovante do pedido' : 'Solicitação'} title={q.offer.name} back={{ to: '/servicos', label: 'Meus pedidos' }}>
        {params.get('confirmado') && <div className="success" role="status"><IconCheck size={18} /> Pagamento confirmado (simulação). Seu pedido foi registrado.</div>}
        {pendingPay && r.status !== 'PEDIDO_GERADO' && <PendingPayment url={pendingPay.paymentUrl} onPoll={reload} />}
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
            <dt>Pagamento</dt><dd>{o ? `${label(o.status)} · ${o.provider === 'SANDBOX' ? 'simulado' : o.provider === 'ASAAS' ? 'Asaas' : o.provider} · ${dateTime(o.paidAt ?? o.createdAt)}` : 'Não realizado'}</dd>
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
                  {e.specialist_name && ['ACEITO', 'CONCLUIDO'].includes(e.status) && (
                    <img className="sp-photo" src={`/api/care/events/${e.id}/specialist-photo`} alt={`Foto de ${e.specialist_name}`} width={56} height={56}
                      onError={(ev) => { (ev.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                  )}
                  {e.specialist_coren && <div className="small muted">COREN {e.specialist_coren} · especialista validada pela Central ONEMA</div>}
                  {e.visit_code && (
                    <div className="visit-code" role="status">
                      <span className="small">Código de início da visita</span>
                      <strong className="mono" aria-label={`Código ${e.visit_code.split('').join(' ')}`}>{e.visit_code}</strong>
                      <span className="small muted">Informe este código à especialista quando ela chegar. Não compartilhe por telefone ou mensagem.</span>
                    </div>
                  )}
                  {e.started_at && e.status === 'ACEITO' && <div className="small"><IconCheck size={14} /> Atendimento iniciado em {dateTime(e.started_at)} (código confirmado)</div>}
                  {e.awaiting_signature && <SignCard event={e} onDone={reload} />}
                  {e.patient_signed_at && <div className="small"><IconCheck size={14} /> Atendimento assinado por {e.patient_signature_name} em {dateTime(e.patient_signed_at)}</div>}
                  {e.status === 'CONCLUIDO' && <div className="mt"><Stars eventId={e.id} current={e.my_stars} onDone={reload} /></div>}
                </li>
              ))}
            </ul>
          )}
          <p className="small muted">A Central ONEMA confirma a agenda com um especialista validado. O mesmo enfermeiro não é obrigatório em todos os atendimentos de um pacote.</p>
        </section>
      </div>
      <GuidanceCard request={r} onDone={reload} />
      {o && ['PAID', 'REFUNDED'].includes(o.status) && <RefundCard orderId={o.id} paid={o.status === 'PAID'} onDone={reload} />}
      <section className="surface mt">
        <h2>Linha do tempo do atendimento</h2>
        <CareTimeline items={data.timeline} />
      </section>
    </>
  );
}

/**
 * Reembolso pelo titular: antes do início é integral e automático; com parte do pacote realizada,
 * o Financeiro calcula o saldo. Mostra a diferença entre "devolução solicitada" e "dinheiro devolvido".
 */
function RefundCard({ orderId, paid, onDone }: { orderId: string; paid: boolean; onDone: () => void }) {
  const { data, reload } = useApi<any>(`/api/care/orders/${orderId}/refunds`);
  const send = useSubmit<any>();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const list = data?.refunds ?? [];
  const active = list.find((r: any) => !['RECUSADO', 'FALHA', 'DEVOLVIDO'].includes(r.status));
  if (!list.length && !paid) return null;
  async function submit() {
    const r = await send.run('POST', `/api/care/orders/${orderId}/refund-request`, { reason });
    if (r) { setOpen(false); reload(); onDone(); }
  }
  return (
    <section className="surface mt">
      <h2>Cancelamento e reembolso</h2>
      {list.map((r: any) => (
        <div key={r.id} className={r.status === 'DEVOLVIDO' ? 'success' : r.status === 'RECUSADO' || r.status === 'FALHA' ? 'caution' : 'caution'} role="status">
          <strong>{r.statusLabel}</strong> · protocolo {r.protocol} · {r.amountCents != null ? money(r.amountCents) : 'valor em análise'}
          {r.status === 'DEVOLUCAO_SOLICITADA' && <p className="small mb0">A devolução foi pedida ao meio de pagamento. Avisaremos quando o dinheiro for devolvido (cartão: conforme a fatura; Pix: na conta de origem).</p>}
          {r.decisionNote && r.status === 'RECUSADO' && <p className="small mb0">{r.decisionNote}</p>}
          <details className="small"><summary>Como o valor foi calculado</summary><ul>{r.calcMemo.map((m: string, i: number) => <li key={i}>{m}</li>)}</ul></details>
        </div>
      ))}
      {paid && !active && (open ? (
        <div className="mt">
          <Field label="Motivo do cancelamento" error={fieldError(send.error, 'reason')}><textarea rows={2} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></Field>
          <p className="small muted">Antes do início do atendimento o reembolso é integral, sem multa. Se parte do pacote já foi realizada, o Financeiro ONEMA calcula o saldo e você recebe a memória de cálculo.</p>
          <Alert error={send.error && !Array.isArray(send.error.details) ? send.error : null} />
          <div className="row"><Button className="deep" busy={send.busy} onClick={submit}>Confirmar pedido de reembolso</Button><button type="button" className="btn secondary" onClick={() => setOpen(false)}>Voltar</button></div>
        </div>
      ) : <p className="mt mb0"><button type="button" className="linklike" onClick={() => setOpen(true)}>Cancelar e pedir reembolso</button></p>)}
    </section>
  );
}

/** Orientação de materiais: pedida, enviada (lista e links) e confirmada pelo paciente — estados separados. */
function GuidanceCard({ request: r, onDone }: { request: any; onDone: () => void }) {
  const send = useSubmit<any>();
  const g = r.guidance;
  if (!g || g.status === 'NAO_APLICAVEL') return null;
  return (
    <section className="surface mt">
      <h2>Materiais para o atendimento</h2>
      {g.status === 'SOLICITADA' && <p className="mb0">Você pediu orientação sobre materiais. Um enfermeiro da ONEMA vai enviar a lista e links para compra aqui no app, antes da visita.</p>}
      {g.text && <><p className="small muted mb0">Orientação enviada em {dateTime(g.at)}:</p><p className="pre-wrap">{g.text}</p></>}
      {g.status === 'ENVIADA' && <Button className="sm green" busy={send.busy} onClick={async () => { if (await send.run('POST', `/api/care/requests/${r.id}/materials-confirmed`, {})) onDone(); }}>Já providenciei os materiais</Button>}
      {g.status === 'MATERIAIS_CONFIRMADOS' && <p className="small success mb0"><IconCheck size={14} /> Você confirmou que providenciou os materiais em {dateTime(g.materialsConfirmedAt)}.</p>}
      <Alert error={send.error} />
    </section>
  );
}
