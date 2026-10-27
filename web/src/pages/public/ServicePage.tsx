import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi } from '../../lib/hooks';
import { ErrorState, Loading } from '../../ui/ui';
import { openKary } from '../../ui/Kary';
import { IconArrowLeft, IconArrowRight, IconCheck } from '../../ui/icons';
import { UrgentNote } from '../care/RequestFlow';
import { NEED_ICONS, NEED_TEXT } from './HomePage';

const MODALITY: Record<string, string> = { PRESENCIAL: 'Presencial', REMOTO: 'Remoto', MISTO: 'Presencial + remoto' };

/** Orientações por necessidade (informativas; o escopo final é confirmado no orçamento). */
const GUIDANCE: Record<string, string[]> = {
  AVALIACAO: ['Tenha à mão receitas, relatórios e a lista de medicamentos em uso.', 'Se possível, um familiar ou responsável pode acompanhar a avaliação.'],
  CURATIVOS: ['Informe há quanto tempo existe a ferida e se já há orientação médica.', 'Diga se você já tem materiais (gazes, soro, coberturas): isso entra no orçamento.'],
  MEDICAMENTOS: ['A administração só é feita com prescrição médica válida, conferida antes do atendimento.', 'O medicamento não está incluído; tenha-o disponível conforme a receita.'],
  SONDAS: ['Informe o tipo de sonda ou cateter e a data da última troca.', 'Dispositivos e materiais especiais não estão incluídos, salvo quando descritos no orçamento.'],
  POS_ALTA: ['Tenha em mãos o resumo de alta e as orientações do hospital.', 'O acompanhamento organiza os primeiros dias em casa e os próximos passos.'],
  POS_OPERATORIO: ['Informe a cirurgia realizada e as orientações recebidas da equipe médica.', 'Curativos e cuidados seguem a prescrição e o protocolo do procedimento.'],
  CRONICOS: ['Anote medições recentes de glicemia e pressão, se tiver.', 'O acompanhamento não substitui consultas médicas de rotina.'],
  MONITORAMENTO: ['O acompanhamento é planejado e remoto, com registro e continuidade.', 'Você recebe orientação sobre próximos passos e sinais de atenção.'],
};

/** "Saiba mais": escopo do serviço, orientações e próxima ação — sem valores (preço só após cadastro e orçamento). */
export function ServicePage() {
  const { key = '' } = useParams();
  const { data, error, loading, reload } = useApi<any>('/api/care/needs');
  const need = data?.needs.find((n: any) => n.key === key.toUpperCase());
  useEffect(() => { document.title = `${need?.title ?? 'Cuidado'} · ONEMA SAÚDE`; }, [need?.title]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!need) return <div className="flow-card"><h1>Serviço não encontrado</h1><p><Link to="/#catalogo">Voltar ao catálogo</Link></p></div>;
  return (
    <div className="flow service-page">
      <p><Link to="/#catalogo" className="back-link"><IconArrowLeft size={18} /> Catálogo</Link></p>
      <div className="service-head">
        <span className="tile-icon">{NEED_ICONS[need.icon]}</span>
        <div>
          <div className="eyebrow-teal">Cuidados ONEMA SAÚDE</div>
          <h1 className="display-light">{need.title}</h1>
          <p className="lead">{NEED_TEXT[need.key] ?? need.subtitle}</p>
        </div>
      </div>

      <section className="flow-card">
        <h2>O que pode ser solicitado</h2>
        <ul className="service-offers">
          {need.offers.map((o: any) => (
            <li key={o.code}>
              <strong>{o.name}</strong>
              <span className="small muted">{o.summary}</span>
              <span className="offer-tags"><span className="badge blue">{MODALITY[o.modality] ?? o.modality}</span><span className="badge">{o.actsLabel}</span>{o.periodDays && <span className="badge dark">{o.periodDays} dias</span>}</span>
              {o.inclusions?.length > 0 && <ul className="check-list small">{o.inclusions.slice(0, 4).map((x: string) => <li key={x}><IconCheck size={16} />{x}</li>)}</ul>}
            </li>
          ))}
        </ul>
      </section>

      <section className="flow-card mt">
        <h2>Orientações</h2>
        <ul className="check-list">{(GUIDANCE[need.key] ?? []).map((x) => <li key={x}><IconCheck size={18} />{x}</li>)}</ul>
        <p className="small muted">O atendimento acontece após análise da necessidade, das condições do paciente, da disponibilidade profissional e da região. Medicamentos, equipamentos e materiais especiais não estão incluídos, salvo quando descritos no orçamento.</p>
      </section>

      <section className="flow-card mt">
        <h2>Próximo passo</h2>
        <p>Entre ou crie sua conta, conte a necessidade e informe os materiais. O orçamento completo aparece antes de qualquer pagamento.</p>
        <div className="row">
          <Link to={`/solicitar?necessidade=${need.key}`} className="btn green lg">Solicitar este cuidado <IconArrowRight size={18} /></Link>
          <button className="btn outline lg" onClick={openKary}>Tirar dúvidas com a Kary</button>
        </div>
      </section>
      <UrgentNote />
    </div>
  );
}
