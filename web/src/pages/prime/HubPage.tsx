import { Link } from 'react-router-dom';
import { SUB_STATUS, dateTime } from '../../lib/format';
import { useApi } from '../../lib/hooks';
import { Badge, Empty, ErrorState, Loading, PageHeader } from '../../ui/ui';
import { IconCalendar, IconDoc, IconHeart, IconUsers } from '../../ui/icons';
import { useAuth } from '../../lib/auth';

/** Minha ONEMA → continuidade: somente eventos reais; nenhuma inferência clínica (A10). */
export function HubPage() {
  const { me } = useAuth();
  const { data, error, loading, reload } = useApi<any>('/api/prime/hub');
  const received = useApi<any>('/api/prime/share/received');
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const st = data.prime ? SUB_STATUS[data.prime.status] : null;
  const invites = (received.data?.grants ?? []).filter((g: any) => ['INVITED', 'ACCEPTED', 'VERIFIED'].includes(g.status));
  return (
    <>
      <PageHeader kicker="Minha ONEMA" title={`Olá, ${me?.user?.name.split(' ')[0]}`}>
        <p>Aqui estão seus registros e agendamentos, independentemente da assinatura.</p>
        {st ? <Badge tone={st.tone}>{st.label}</Badge> : <Badge tone="dark">Sem PRIME · acesso assistencial preservado</Badge>}
      </PageHeader>
      <div className="grid">
        <div className="tile"><div className="row"><IconDoc /><h3 className="mb0">Carteira Digital</h3></div><p className="small muted mt">{data.integrations.carteiraDigital.reason}</p></div>
        <div className="tile"><div className="row"><IconCalendar /><h3 className="mb0">Próximo agendamento</h3></div><p className="small muted mt">{data.integrations.agenda.reason}</p></div>
        <div className="tile"><div className="row"><IconHeart /><h3 className="mb0">Plano de continuidade</h3></div><p className="small muted mt">{data.integrations.continuidade.reason}</p></div>
        <Link to={data.prime && data.prime.status !== 'CANCELLED' && data.prime.status !== 'REFUNDED' ? '/prime/assinatura' : '/prime'} className="tile link">
          <div className="row"><IconUsers /><h3 className="mb0">ONEMA PRIME</h3></div>
          <p className="small muted mt">{data.prime?.benefitActive ? 'Benefícios e economia do ciclo, avisos e responsável.' : 'Assinatura opcional de organização do cuidado.'}</p>
        </Link>
      </div>
      {invites.length > 0 && <div className="callout mt">Você tem {invites.length} convite(s) para apoiar um paciente. <Link to="/convites">Ver convites</Link></div>}
      <section className="surface mt">
        <h2>Linha do tempo</h2>
        <p className="small muted">Mostra apenas eventos efetivamente registrados na sua conta. “Próximos passos” só aparecem quando houver anotação profissional validada.</p>
        {!data.timeline.length ? <Empty title="Nenhum evento registrado ainda." /> : (
          <ul className="timeline">{data.timeline.map((t: any, i: number) => <li key={i}><strong>{t.title}</strong> <span className="small muted">{dateTime(t.at)}</span><p className="mb0 small">{t.detail}</p></li>)}</ul>
        )}
      </section>
      <p className="small"><Link to="/convites">Convites recebidos para apoiar outra pessoa</Link></p>
    </>
  );
}
