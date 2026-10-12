import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { useApi } from '../../lib/hooks';
import { money } from '../../lib/format';
import { DailyVerse } from '../../ui/DailyVerse';
import { IconArrowRight, IconBook, IconChat, IconCheck, IconDoc, IconHeart, IconHospital, IconNurse, IconPill, IconShield, IconTube, IconWallet } from '../../ui/icons';

export const NEED_ICONS: Record<string, ReactNode> = {
  chat: <IconChat size={26} />, shield: <IconShield size={26} />, pill: <IconPill size={26} />, tube: <IconTube size={26} />,
  hospital: <IconHospital size={26} />, nurse: <IconNurse size={26} />, heart: <IconHeart size={26} />, doc: <IconDoc size={26} />,
};

/** Grafismo de semicírculos do manual, usado ao fundo dos cartões azuis. */
export function HeroPattern() {
  return (
    <svg className="hero-pattern" viewBox="0 0 400 300" aria-hidden preserveAspectRatio="xMaxYMid slice">
      <g fill="rgba(255,255,255,.035)">
        <path d="M40 0a60 60 0 0 1 0 120z" /><circle cx="140" cy="60" r="44" /><path d="M200 120a60 60 0 0 1 120 0z" />
        <path d="M320 0a60 60 0 0 0 0 120z" /><circle cx="60" cy="210" r="44" /><path d="M140 180h60v60a60 60 0 0 1-60-60z" />
        <path d="M260 300a60 60 0 0 1 120 0z" /><circle cx="360" cy="200" r="30" />
      </g>
    </svg>
  );
}

export function HomePage() {
  const { me, has, isAdmin } = useAuth();
  const { data } = useApi<any>('/api/care/needs');
  useEffect(() => { document.title = 'ONEMA SAÚDE · Sua saúde não precisa esperar'; }, []);
  const area = !me?.user ? null
    : has('PACIENTE') ? { to: '/minha-onema', label: 'Ir para Minha ONEMA' }
    : has('ESPECIALISTA') ? { to: '/especialista', label: 'Ir para a Área do especialista' }
    : isAdmin ? { to: '/central', label: 'Ir para a Central' } : null;
  return (
    <>
      <DailyVerse />
      <section className="hero-big">
        <HeroPattern />
        <div className="kicker">Cuidado de enfermagem em São Paulo</div>
        <h1>Sua saúde não<br />precisa esperar.</h1>
        <p>Conte o que precisa. A ONEMA organiza a solicitação e encontra um especialista validado para você.</p>
        <div className="row">
          <Link to="/solicitar" className="btn green lg">Preciso de cuidado <IconArrowRight size={20} /></Link>
          {area && <Link to={area.to} className="btn ghost-light">{area.label}</Link>}
        </div>
        <div className="hero-icons" aria-hidden><IconNurse size={56} /><IconHospital size={56} /></div>
      </section>

      <section className="section">
        <div className="eyebrow-blue">Primeiro, escolha uma necessidade</div>
        <h2 className="display">Como podemos cuidar de você?</h2>
        <div className="need-grid">
          {(data?.needs ?? []).map((n: any) => {
            const min = n.offers.length ? Math.min(...n.offers.map((o: any) => o.priceCents)) : null;
            return (
              <Link key={n.key} to={`/solicitar?necessidade=${n.key}`} className="need-card">
                <span className="need-icon">{NEED_ICONS[n.icon]}</span>
                <span className="need-text"><strong>{n.title}</strong><span>{n.subtitle}</span>{min != null && <em>a partir de {money(min)}</em>}</span>
                <IconArrowRight size={20} />
              </Link>
            );
          })}
        </div>
      </section>

      <section className="section how">
        <h2>Como funciona</h2>
        <ol className="steps">
          <li><strong>Escolha o cuidado</strong><span>Necessidade, atendimento e materiais disponíveis.</span></li>
          <li><strong>Veja os valores na hora</strong><span>Preço aprovado e desconto PRIME, antes de qualquer dado de pagamento.</span></li>
          <li><strong>Revise o orçamento</strong><span>Escopo, logística, inclusões e exclusões. Edite ou desista quando quiser.</span></li>
          <li><strong>Confirme e acompanhe</strong><span>Um especialista validado aceita o atendimento e você acompanha tudo pelo app.</span></li>
        </ol>
      </section>

      <div className="two">
        <Link to="/prime" className="promo green">
          <span className="promo-icon"><IconWallet size={26} /></span>
          <div>
            <div className="eyebrow-dark">ONEMA PRIME · opcional</div>
            <h3>Organize o cuidado e economize</h3>
            <p>{data?.prime ? `${money(data.prime.monthlyPriceCents)}/mês, adesão separada. ${data.prime.discountBps / 100}% em um pedido por ciclo, até ${money(data.prime.capCents)}.` : 'Assinatura mensal opcional.'}</p>
          </div>
        </Link>
        <Link to="/especialista" className="promo">
          <span className="promo-icon"><IconNurse size={26} /></span>
          <div>
            <div className="eyebrow-dark">Rede ONEMA ONE</div>
            <h3>É enfermeiro? Atenda com liberdade</h3>
            <p>Cadastro com CPF, validação pela Central e formação na ONEMA Academy.</p>
          </div>
        </Link>
      </div>

      <section className="section trust">
        <div><IconCheck /><span>Especialistas com COREN e treinamento validados</span></div>
        <div><IconShield /><span>Seus dados protegidos (LGPD)</span></div>
        <div><IconBook /><span>Protocolos e formação ONEMA Academy</span></div>
      </section>

      <div className="urgent-note" role="note">
        <span className="nav-shield" aria-hidden><IconShield size={18} /></span>
        <p><strong>Este app não atende urgências.</strong> Em risco imediato, dor intensa, falta de ar ou perda de consciência, ligue <a href="tel:192">SAMU 192</a>.</p>
      </div>
    </>
  );
}
