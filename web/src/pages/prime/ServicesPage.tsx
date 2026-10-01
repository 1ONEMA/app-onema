import { useEffect, useState } from 'react';
import { dateTime, label, money } from '../../lib/format';
import { useApi, useSubmit } from '../../lib/hooks';
import { Alert, Badge, Button, Empty, ErrorState, Loading, PageHeader } from '../../ui/ui';

/** Checkout de serviço/pacote: preço cheio, desconto (máx. R$ 20), preço final, uso restante e motivo. */
export function ServicesPage() {
  const cat = useApi<any>('/api/prime/catalog');
  const orders = useApi<any>('/api/prime/orders');
  const offer = useApi<any>('/api/prime/offer');
  const quote = useSubmit<any>();
  const buy = useSubmit<any>();
  const [q, setQ] = useState<any>(null);
  const [method, setMethod] = useState('');
  const [result, setResult] = useState<any>(null);
  async function pick(code: string) { setResult(null); const r = await quote.run('POST', '/api/prime/orders/quote', { itemCode: code }); if (r) setQ(r); }
  async function confirm() {
    const r = await buy.run('POST', '/api/prime/orders', { itemCode: q.item.code, paymentMethod: method, expectedFinalPriceCents: q.finalPriceCents }, { idempotent: true });
    if (r) { setResult(r); setQ(null); orders.reload(); }
  }
  // Valor mudou desde a consulta: exibe o novo total para nova confirmação (nunca cobra valor diferente do exibido)
  useEffect(() => { if (buy.error?.code === 'PRICE_CHANGED') setQ(buy.error.details.quote); }, [buy.error]);
  if (cat.loading) return <Loading />;
  if (cat.error) return <ErrorState error={cat.error} onRetry={cat.reload} />;
  return (
    <>
      <PageHeader kicker="Catálogo ONEMA SAÚDE" title="Serviços e pacotes"><p>{cat.data.notice}</p></PageHeader>
      <Alert success={result?.paid ? result.message : null} error={result && !result.paid ? { message: result.message } as any : null} />
      <div className="two wide-left">
        <section className="surface">
          <h2>Catálogo</h2>
          {!cat.data.items.length ? <Empty title="Catálogo não publicado.">O catálogo oficial (“Preços Oficiais v3”) ainda não foi cadastrado pela ONEMA.</Empty> : (
            <ul className="list">{cat.data.items.map((i: any) => (
              <li key={i.code} className="row between">
                <div><strong>{i.name}</strong> {i.is_demo ? <span className="demo-flag">FICTÍCIO</span> : null}<br /><span className="small muted">{i.kind === 'PACOTE' ? 'Pacote' : 'Serviço'} · {i.prime_eligible ? 'elegível ao desconto PRIME' : 'sem desconto PRIME'}</span></div>
                <div className="row"><strong>{money(i.price_cents)}</strong><Button className="sm secondary" busy={quote.busy} onClick={() => pick(i.code)}>Selecionar</Button></div>
              </li>))}
            </ul>
          )}
        </section>
        <section className="surface" aria-live="polite">
          <h2>Resumo do pedido</h2>
          <Alert error={quote.error || buy.error} />
          {!q ? <p className="muted">Selecione um item para ver preço e desconto.</p> : (
            <>
              <p><strong>{q.item.name}</strong></p>
              <ul className="list">
                <li className="row between"><span>Preço cheio</span><span>{money(q.fullPriceCents)}</span></li>
                <li className="row between"><span>Desconto PRIME</span><span>− {money(q.discountCents)}</span></li>
                <li className="row between"><strong>Preço final</strong><strong>{money(q.finalPriceCents)}</strong></li>
                <li className="row between"><span>Uso de desconto restante no ciclo</span><span>{q.primeActive ? q.usesRemaining : '—'}</span></li>
              </ul>
              {q.noDiscountReason && <p className="caution small">{q.noDiscountReason}</p>}
              {q.item.kind === 'PACOTE' && <p className="small muted">Em um pacote, o desconto é aplicado uma vez no pedido; os atos que o compõem não geram novos descontos.</p>}
              <select aria-label="Meio de pagamento" value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="">Selecione o meio de pagamento</option>
                {offer.data?.paymentMethods.map((m: any) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
              <Button className="deep mt" busy={buy.busy} disabled={!method} onClick={confirm}>Confirmar e pagar {money(q.finalPriceCents)} (simulação)</Button>
              <p className="small muted">O repasse do profissional não é reduzido pelo benefício. O agendamento do serviço é conduzido pela Central Operacional (integração pendente).</p>
            </>
          )}
        </section>
      </div>
      <section className="surface">
        <h2>Meus pedidos</h2>
        {!orders.data?.orders.length ? <Empty title="Nenhum pedido." /> : (
          <div className="table-wrap" tabIndex={0}><table><thead><tr><th>Data</th><th>Item</th><th>Preço cheio</th><th>Desconto</th><th>Final</th><th>Situação</th></tr></thead>
            <tbody>{orders.data.orders.map((o: any) => <tr key={o.id}><td>{dateTime(o.created_at)}</td><td>{o.item_name}</td><td>{money(o.full_price_cents)}</td><td>{money(o.discount_cents)}</td><td>{money(o.final_price_cents)}</td><td><Badge tone={o.status === 'PAID' ? '' : o.status === 'FAILED' ? 'red' : 'dark'}>{label(o.status)}</Badge></td></tr>)}</tbody></table></div>
        )}
      </section>
    </>
  );
}
