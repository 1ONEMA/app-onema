import { Link, Navigate } from 'react-router-dom';
import { money, pct } from '../../lib/format';
import { useApi } from '../../lib/hooks';
import { Badge, ErrorState, Loading, PageHeader } from '../../ui/ui';

/** Catálogo → cartão PRIME (oferta opcional). Textos da prévia aprovada (PRIME v2.0). */
export function PrimeOfferPage() {
  const offer = useApi<any>('/api/prime/offer');
  const me = useApi<any>('/api/prime/me');
  if (offer.loading || me.loading) return <Loading />;
  if (offer.error || me.error) return <ErrorState error={offer.error || me.error} onRetry={() => { offer.reload(); me.reload(); }} />;
  const sub = me.data.subscription;
  if (sub && ['ACTIVE', 'CANCEL_SCHEDULED', 'PAYMENT_PENDING', 'SUSPENDED', 'ASSINATURA_SOLICITADA'].includes(sub.status)) return <Navigate to="/prime/assinatura" replace />;
  const o = offer.data;
  return (
    <>
      <PageHeader kicker="Oferta opcional" title="ONEMA PRIME"><p>Seus atendimentos organizados, os próximos passos claros e o cuidado compartilhado com quem você autorizar.</p></PageHeader>
      <div className="two">
        <section className="surface">
          <Badge>Oferta opcional</Badge>
          <h2 className="mt">ONEMA PRIME</h2>
          <strong className="value">{money(o.monthlyPriceCents)} <small style={{ fontSize: 14 }}>/ mês</small></strong>
          <p>Organize seus atendimentos, veja seus próximos passos registrados e escolha quem pode acompanhar você.</p>
          <ul className="list">
            <li>Carteira Digital e histórico pessoal</li>
            <li>Um desconto de {pct(o.discountBps)} por ciclo, até {money(o.discountCapCents)}</li>
            <li>Lembretes escolhidos por você</li>
            <li>Responsável principal com permissões</li>
          </ul>
          <p className="small muted">Renovação mensal até cancelar. Serviços de Enfermagem são contratados à parte.</p>
          <div className="row">
            <Link to="/prime/adesao" className="btn green">Conhecer e assinar</Link>
            <Link to="/minha-onema" className="btn secondary">Continuar sem PRIME</Link>
          </div>
        </section>
        <section className="surface">
          <h2>O que não está incluído</h2>
          <p>Visitas, consultas, orientação on-line assistencial, monitoramento profissional, procedimentos, plantão 24 horas, atendimento prioritário garantido, medicamentos, materiais, deslocamentos e atos adicionais de Enfermagem são contratados e precificados separadamente.</p>
          <div className="callout">A não contratação ou o cancelamento do PRIME não restringe a solicitação de serviços, o acesso aos seus próprios registros e documentos, as orientações necessárias nem os alertas essenciais.</div>
          <p className="small"><Link to="/prime/adesao#termos">Ver termos completos (T1) e aviso de privacidade (T2)</Link></p>
        </section>
      </div>
    </>
  );
}
