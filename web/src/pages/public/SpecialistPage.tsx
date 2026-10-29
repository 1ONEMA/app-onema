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
  const { has, me } = useAuth();
  const logged = !!me?.user;
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
            : <Link to={logged ? '/especialista/candidatura' : '/cadastro?perfil=especialista'} className="btn green lg">{logged ? 'Minha candidatura' : 'Quero ser ONEMA ONE'} <IconArrowRight size={20} /></Link>}
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
          <p className="small muted">Fluxo completo da entrada na rede ONEMA ONE até o primeiro atendimento.</p>
          <ol className="steps steps-detailed">
            <li><strong>Crie sua conta</strong><span>Cadastro com nome, e-mail e senha. Sem exigência de CNPJ.</span></li>
            <li><strong>Preencha a candidatura</strong><span>CPF, número e UF do COREN, telefone, regiões e áreas em que deseja atender.</span></li>
            <li><strong>Envie os documentos</strong><span>Documento de identidade e carteira do COREN (PDF ou foto), em ambiente privado.</span></li>
            <li><strong>Análise da Central ONEMA</strong><span>O credenciamento confere identidade, COREN ativo e documentos. Se faltar algo, você recebe o pedido de ajuste.</span></li>
            <li><strong>Acesso à ONEMA Academy</strong><span>Com a candidatura aprovada, a Jornada de Integração é liberada no seu perfil.</span></li>
            <li><strong>Jornada de Integração</strong><span>Quatro cursos com aulas, atividades e materiais oficiais ONEMA.</span></li>
            <li><strong>Avaliações</strong><span>Avaliações de cada curso, com nota mínima e histórico de tentativas.</span></li>
            <li><strong>Certificado</strong><span>Concluída a jornada, o certificado é emitido com código de verificação.</span></li>
            <li><strong>Credenciamento final</strong><span>Decisão humana do credenciamento, com base na Academy e nos demais requisitos.</span></li>
            <li><strong>Receba ofertas</strong><span>Ofertas compatíveis com seu perfil e região, com o repasse informado. Você aceita ou recusa sem penalidade.</span></li>
            <li><strong>Atenda e acompanhe</strong><span>Registre o atendimento, receba o repasse integral e acompanhe as avaliações dos pacientes.</span></li>
          </ol>
          <div className="row mt"><Link to={logged ? '/especialista/candidatura' : '/cadastro?perfil=especialista'} className="btn green">{logged ? 'Minha candidatura' : 'Quero ser ONEMA ONE'} <IconArrowRight size={18} /></Link></div>
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
        <div className="caution mt">{s.credentialing === 'INAPTO'
          ? 'O credenciamento final não foi aprovado. Fale com a Central ONEMA para entender os próximos passos.'
          : <>Seu perfil ainda não recebe ofertas. Conclua a Jornada de Integração na <Link to="/academy">ONEMA Academy</Link>; depois, o credenciamento faz a decisão final e as ofertas são liberadas.</>}</div>
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
                    {m.stars && <span className="stars" role="img" aria-label={`${m.stars} estrelas`}>{[1, 2, 3, 4, 5].map((i) => <IconStar key={i} size={16} filled={i <= m.stars} />)}</span>}
                    {m.status === 'ACEITO' && <span className="small muted">{m.started_at ? 'Iniciado' : m.modality === 'PRESENCIAL' ? 'Aguardando início' : 'Remoto'}{m.evolution_status === 'ASSINADA' ? ' · evolução assinada' : ''}</span>}
                    {m.status === 'ACEITO' && <Link className="btn sm green" to={`/especialista/atendimentos/${m.id}`}>Abrir atendimento</Link>}
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
