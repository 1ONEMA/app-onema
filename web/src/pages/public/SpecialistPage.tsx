import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { useApi, useSubmit } from '../../lib/hooks';
import { dateTime, money } from '../../lib/format';
import { Alert, Badge, Button, Empty, ErrorState, Loading } from '../../ui/ui';
import { IconArrowRight, IconAward, IconBook, IconCheck, IconNurse, IconShield, IconStar, IconWallet } from '../../ui/icons';
import { HeroPattern } from './HomePage';

const WHEN: Record<string, string> = { AGORA: 'Agora', HOJE: 'Hoje', PROXIMOS_DIAS: 'Próximos dias', AGENDAR: 'Data agendada' };

/** Área do especialista: apresentação ONEMA ONE (pública) + ofertas, repasses e avaliações (especialista logado). */
export function SpecialistPage() {
  const { has } = useAuth();
  useEffect(() => { document.title = 'Área do especialista · ONEMA SAÚDE'; }, []);
  const isSpecialist = has('ESPECIALISTA');
  return (
    <>
      <section className="hero-big split">
        <HeroPattern />
        <div>
          <div className="kicker">Rede ONEMA ONE</div>
          <h1>Seu cuidado profissional, com liberdade para escolher quando atender.</h1>
          <p>Cadastre-se com CPF, passe pela validação da Central ONEMA e receba ofertas compatíveis com seu perfil e região.</p>
          {isSpecialist
            ? <a href="#ofertas" className="btn green lg">Ver ofertas <IconArrowRight size={20} /></a>
            : <Link to="/cadastro?perfil=especialista" className="btn green lg">Quero ser ONEMA ONE <IconArrowRight size={20} /></Link>}
        </div>
        <aside className="validation-card">
          <span className="need-icon"><IconNurse size={28} /></span>
          <h2>Validação antes da ativação</h2>
          <p>Identidade, COREN, documentos e treinamento são conferidos antes de o perfil ficar disponível.</p>
          <ul>
            <li><IconCheck size={18} /> Sem exigência de CNPJ</li>
            <li><IconCheck size={18} /> Disponibilidade livre</li>
            <li><IconCheck size={18} /> Recusa sem penalidade</li>
          </ul>
        </aside>
      </section>
      <div className="feature-grid">
        <div className="feature"><IconBook /><strong>ONEMA Academy</strong><span>Aulas, atividades, avaliações e certificado da Jornada de Integração.</span></div>
        <div className="feature"><IconWallet /><strong>Repasse integral</strong><span>O valor do seu ato é informado na oferta e não muda com descontos ao paciente.</span></div>
        <div className="feature"><IconStar /><strong>Avaliações</strong><span>Estrelas dos atendimentos, separadas das notas da Academy.</span></div>
        <div className="feature"><IconShield /><strong>POPs oficiais</strong><span>Protocolos padronizados ONEMA (conteúdo em implantação).</span></div>
      </div>
      {isSpecialist ? <SpecialistArea /> : (
        <div className="surface mt">
          <h2>Como funciona</h2>
          <ol className="steps">
            <li><strong>Crie sua conta</strong><span>Com CPF e e-mail. Depois, envie documentos e COREN para a Central.</span></li>
            <li><strong>Validação</strong><span>O credenciamento confere identidade, COREN e documentos.</span></li>
            <li><strong>ONEMA Academy</strong><span>Conclua a Jornada de Integração.</span></li>
            <li><strong>Receba ofertas</strong><span>Aceite os atendimentos que fizer sentido para você.</span></li>
          </ol>
          <p className="small muted">Já tem acesso? <Link to="/entrar?voltar=%2Fespecialista">Entrar</Link></p>
        </div>
      )}
    </>
  );
}

function SpecialistArea() {
  const summary = useApi<any>('/api/care/specialist/summary');
  const offers = useApi<any>(summary.data?.eligible ? '/api/care/specialist/offers' : null);
  const act = useSubmit<any>();
  async function run(url: string) { if (await act.run('POST', url, {})) { offers.reload(); summary.reload(); } }
  if (summary.loading && !summary.data) return <Loading />;
  if (summary.error) return <ErrorState error={summary.error} onRetry={summary.reload} />;
  const s = summary.data;
  const sum = (st: string) => s.payouts.find((p: any) => p.status === st)?.total ?? 0;
  return (
    <section id="ofertas" className="mt">
      <div className="stats">
        <div className="stat"><strong>{s.rating.average ?? '—'}{s.rating.average ? ' ★' : ''}</strong><span>{s.rating.count} avaliação(ões) de pacientes</span></div>
        <div className="stat"><strong>{money(sum('RESERVADO'))}</strong><span>Repasses de atendimentos aceitos</span></div>
        <div className="stat"><strong>{money(sum('A_LIQUIDAR'))}</strong><span>Repasses a liquidar</span></div>
        <Link to="/academy" className="stat"><strong><IconAward /></strong><span>ONEMA Academy · notas e certificados</span></Link>
      </div>
      <p className="small muted">{s.note}</p>
      {!s.eligible ? (
        <div className="caution mt">Seu perfil ainda não foi validado pela Central ONEMA. Conclua a ONEMA Academy e o credenciamento para receber ofertas.</div>
      ) : offers.error ? <ErrorState error={offers.error} onRetry={offers.reload} /> : !offers.data ? <Loading /> : (
        <div className="two mt">
          <div className="surface">
            <h2>Ofertas disponíveis</h2>
            <p className="small muted">{offers.data.rule}</p>
            <Alert error={act.error} />
            {!offers.data.offers.length ? <Empty title="Nenhuma oferta no momento." /> : (
              <ul className="list">{offers.data.offers.map((o: any) => (
                <li key={o.id}>
                  <div className="row between"><strong>{o.label}</strong><strong className="green-text">{money(o.unit_payout_cents)}</strong></div>
                  <div className="small muted">{o.item_code} · {o.item_name} · {o.modality === 'REMOTO' ? 'remoto' : 'presencial'} · {o.region ?? 'região a confirmar'} · {WHEN[o.when_pref] ?? ''}{o.when_date ? ` ${o.when_date.split('-').reverse().join('/')}` : ''}</div>
                  <div className="small muted">Materiais: {o.materials === 'SIM' ? 'paciente possui' : o.materials === 'NAO' ? 'paciente não possui' : 'a confirmar'}</div>
                  <Button className="sm deep mt" busy={act.busy} onClick={() => run(`/api/care/specialist/events/${o.id}/accept`)}>Aceitar atendimento</Button>
                </li>
              ))}</ul>
            )}
          </div>
          <div className="surface">
            <h2>Meus atendimentos</h2>
            {!offers.data.mine.length ? <Empty title="Você ainda não aceitou atendimentos." /> : (
              <ul className="list">{offers.data.mine.map((m: any) => (
                <li key={m.id}>
                  <div className="row between"><strong>{m.label}</strong><span>{money(m.unit_payout_cents)}</span></div>
                  <div className="small muted">{m.item_code} · aceito em {dateTime(m.accepted_at)}{m.completed_at ? ` · concluído em ${dateTime(m.completed_at)}` : ''}</div>
                  <div className="row mt">
                    <Badge tone={m.status === 'CONCLUIDO' ? 'dark' : m.status === 'CANCELADO' ? 'red' : ''}>{m.status === 'CONCLUIDO' ? 'Concluído' : m.status === 'CANCELADO' ? 'Cancelado' : 'Agendado'}</Badge>
                    {m.payout_status && <Badge tone="blue">Repasse {m.payout_status === 'A_LIQUIDAR' ? 'a liquidar' : m.payout_status === 'CANCELADO' ? 'cancelado' : 'reservado'}</Badge>}
                    {m.stars && <span className="stars" aria-label={`${m.stars} estrelas`}>{[1, 2, 3, 4, 5].map((i) => <IconStar key={i} size={16} filled={i <= m.stars} />)}</span>}
                    {m.status === 'ACEITO' && <Button className="sm green" busy={act.busy} onClick={() => run(`/api/care/specialist/events/${m.id}/complete`)}>Registrar conclusão</Button>}
                  </div>
                </li>
              ))}</ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
