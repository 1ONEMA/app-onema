import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { useApi } from '../../lib/hooks';
import { dateTime } from '../../lib/format';
import { Badge, Empty, ErrorState, Loading } from '../../ui/ui';
import { IconCalendar, IconCheck, IconDoc, IconStar } from '../../ui/icons';
import { REQ_STATUS } from './OrdersPages';

const WHEN: Record<string, string> = { AGORA: 'Agora', HOJE: 'Hoje', PROXIMOS_DIAS: 'Nos próximos dias', AGENDAR: 'Data agendada' };

/** Carteira Digital ONEMA — visão do titular com os registros reais da plataforma. */
export function WalletPage() {
  const { me } = useAuth();
  const { data, error, loading, reload } = useApi<any>('/api/care/wallet');
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const first = me?.user?.name.split(' ')[0];
  return (
    <>
      <section className="wallet-head">
        <div>
          <div className="eyebrow-teal">Carteira Digital ONEMA</div>
          <h1 className="display-light">Olá, {first}!</h1>
          <p className="muted">Seus atendimentos, próximos passos e comprovantes em um só lugar.</p>
        </div>
        <Link to="/solicitar" className="btn green">Solicitar cuidado</Link>
      </section>
      <div className="two">
        <section className="surface">
          <h2><IconCalendar /> Próximos passos</h2>
          {!data.upcoming.length && !data.pendingRequests.length ? <Empty title="Nenhum próximo passo agora." /> : (
            <ul className="list">
              {data.pendingRequests.map((r: any) => (
                <li key={r.id}><div className="row between"><Link to={`/solicitar?id=${r.id}`}><strong>{r.itemName}</strong></Link><Badge tone={REQ_STATUS[r.status].tone}>{REQ_STATUS[r.status].label}</Badge></div>
                  <div className="small muted">{r.protocol} · {dateTime(r.createdAt)}</div></li>
              ))}
              {data.upcoming.map((e: any) => (
                <li key={e.id}><div className="row between"><Link to={`/solicitacoes/${e.request_id}`}><strong>{e.label}</strong></Link>
                  <Badge tone={e.status === 'ACEITO' ? '' : 'blue'}>{e.status === 'ACEITO' ? 'Especialista confirmado' : 'Buscando especialista'}</Badge></div>
                  <div className="small muted">{e.item_name} · {e.modality === 'REMOTO' ? 'remoto' : 'presencial'} · {WHEN[e.when_pref] ?? ''}{e.when_date ? ` ${e.when_date.split('-').reverse().join('/')}` : ''}{e.specialist_name ? ` · ${e.specialist_name}` : ''}</div></li>
              ))}
            </ul>
          )}
        </section>
        <section className="surface">
          <h2><IconCheck /> Atendimentos realizados</h2>
          {!data.done.length ? <Empty title="Nenhum atendimento concluído ainda." /> : (
            <ul className="list">{data.done.map((e: any) => (
              <li key={e.id}><div className="row between"><strong>{e.label}</strong>
                {e.my_stars ? <span className="stars" aria-label={`Sua avaliação: ${e.my_stars} de 5`}>{[1, 2, 3, 4, 5].map((i) => <IconStar key={i} size={15} filled={i <= e.my_stars} />)}</span>
                  : <Link className="small" to={`/solicitacoes/${e.request_id}`}>Avaliar</Link>}</div>
                <div className="small muted">{e.item_name} · {e.specialist_name} · {dateTime(e.completed_at)}</div></li>
            ))}</ul>
          )}
        </section>
      </div>
      <section className="surface">
        <h2><IconDoc /> Documentos e comprovantes</h2>
        <p className="pending-box">{data.clinicalDocuments.reason}</p>
        {!data.receipts.length ? <p className="muted mt">Nenhum comprovante ainda.</p> : (
          <ul className="list mt">{data.receipts.map((r: any) => (
            <li key={r.id}><strong>{r.kind === 'PEDIDO' ? 'Comprovante de pedido' : r.kind}</strong> <span className="small muted">· {r.protocol ?? ''} · {dateTime(r.created_at)}</span><p className="small mb0">{r.text}</p></li>
          ))}</ul>
        )}
      </section>
    </>
  );
}
