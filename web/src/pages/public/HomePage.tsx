import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { useApi } from '../../lib/hooks';
import { DailyVerse } from '../../ui/DailyVerse';
import { openKary } from '../../ui/Kary';
import { AppIcon } from '../../ui/Brand';
import {
  IconArrowRight, IconBell, IconCalendar, IconChat, IconDoc, IconHeart, IconHospital, IconHome, IconNurse, IconPill, IconShield, IconTube, IconWallet,
} from '../../ui/icons';

export const NEED_ICONS: Record<string, ReactNode> = {
  chat: <IconChat size={30} />, shield: <IconShield size={30} />, pill: <IconPill size={30} />, tube: <IconTube size={30} />,
  hospital: <IconHome size={30} />, nurse: <IconNurse size={30} />, heart: <IconHeart size={30} />, doc: <IconDoc size={30} />,
};

/** Textos do catálogo no modelo do site de referência do cliente. */
export const NEED_TEXT: Record<string, string> = {
  AVALIACAO: 'Uma avaliação profissional para compreender necessidades, riscos e próximos passos do cuidado.',
  CURATIVOS: 'Avaliação e cuidado profissional da ferida, com orientação para favorecer uma evolução segura.',
  MEDICAMENTOS: 'Administração segura do medicamento prescrito, realizada por profissional habilitado.',
  SONDAS: 'Avaliação e assistência de enfermagem para dispositivos que exigem técnica, segurança e orientação adequada.',
  POS_ALTA: 'Apoio profissional para organizar a transição do hospital para casa e acompanhar os próximos passos.',
  POS_OPERATORIO: 'Acompanhamento de enfermagem para uma recuperação mais organizada, orientada e segura.',
  CRONICOS: 'Monitoramento e orientação para o cuidado contínuo de diabetes e hipertensão.',
  MONITORAMENTO: 'Acompanhamento planejado e remoto, com registro e continuidade do cuidado.',
};

/** Grafismo de semicírculos do manual, ao fundo dos blocos azuis. */
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

/** Celular ilustrativo da Carteira Digital (dados fictícios, marcado como exemplo). */
function PhoneMock() {
  return (
    <div className="phone" aria-label="Exemplo ilustrativo da Carteira Digital ONEMA no celular" role="img">
      <div className="phone-screen">
        <div className="phone-status"><span>9:41</span><span className="phone-notch" /><span>●●●</span></div>
        <div className="phone-hello">
          <span className="phone-avatar" aria-hidden>O</span>
          <div><strong>Olá, Odete!</strong><small>Bem-vinda à sua Carteira Digital ONEMA.</small></div>
          <span className="phone-bell" aria-hidden><IconBell size={20} /><i>2</i></span>
        </div>
        <div className="phone-score">
          <div><small>ONEMA Life Score™</small><strong>82<span>/100</span></strong><small>Seu cuidado está sendo acompanhado.</small></div>
          <span className="phone-ring" aria-hidden><IconHeart size={22} /></span>
        </div>
        <div className="phone-list">
          <div className="row between"><strong>Próximos passos <i>2</i></strong><small>Ver todos ›</small></div>
          <div className="phone-item"><span className="pi red"><IconCalendar size={18} /></span><div><b>Reavaliação de enfermagem</b><em className="tag red">Amanhã</em></div></div>
          <div className="phone-item"><span className="pi amber"><IconDoc size={18} /></span><div><b>Atualizar acompanhamento</b><em className="tag amber">Pendente</em></div></div>
          <div className="phone-item"><span className="pi violet"><IconWallet size={18} /></span><div><b>Próximo cuidado</b><small>24 AGO · 14:00</small></div></div>
        </div>
        <div className="phone-tabs"><span><IconHome size={18} />Início</span><span><IconHeart size={18} />Cuidados</span><span className="on"><IconWallet size={18} />Carteira</span><span><IconNurse size={18} />Perfil</span></div>
      </div>
      <span className="phone-label">Exemplo ilustrativo</span>
    </div>
  );
}

export function HomePage() {
  const { me, has, isAdmin } = useAuth();
  const { data } = useApi<any>('/api/care/needs');
  useEffect(() => { document.title = 'ONEMA SAÚDE · Sua saúde organizada sempre com você'; }, []);
  const area = !me?.user ? null
    : has('PACIENTE') ? { to: '/carteira', label: 'Minha Carteira Digital' }
    : has('ESPECIALISTA') ? { to: '/especialista', label: 'Área do especialista' }
    : isAdmin ? { to: '/central', label: 'Central RT' } : null;
  return (
    <div className="home">
      <section className="hero-big">
        <HeroPattern />
        <div className="kicker">Atendimento domiciliar em São Paulo</div>
        <h1>Enfermagem especializada.<br />Cuidado onde você está.</h1>
        <p>Atendimento domiciliar com profissionais habilitados, acompanhamento assistencial e uma experiência digital pensada para sua tranquilidade.</p>
        <div className="row">
          <Link to="/solicitar" className="btn green lg">Solicitar atendimento <IconArrowRight size={20} /></Link>
          {area && <Link to={area.to} className="btn ghost-light lg">{area.label}</Link>}
        </div>
        <div className="hero-icons" aria-hidden><IconNurse size={56} /><IconHospital size={56} /></div>
      </section>

      <DailyVerse />

      <section className="section" id="catalogo">
        <div className="section-head">
          <div>
            <div className="eyebrow-teal">Catálogo</div>
            <h2 className="display-light">Cuidados ONEMA SAÚDE</h2>
            <p className="lead">Serviços organizados em jornadas claras, com orientação, acompanhamento e continuidade.</p>
          </div>
          <button className="link-teal" onClick={openKary}>Precisa de orientação? →</button>
        </div>
        <div className="note-bar">Receba seu orçamento após informar a necessidade de cuidado e os materiais. Você consulta o valor completo antes do pagamento.</div>
        <div className="catalog-grid">
          {(data?.needs ?? []).map((n: any) => (
            <article key={n.key} className="catalog-card">
              <span className="tile-icon">{NEED_ICONS[n.icon]}</span>
              <div>
                <h3>{n.title}</h3>
                <p>{NEED_TEXT[n.key] ?? n.subtitle}</p>
                <Link to={`/cuidados/${n.key.toLowerCase()}`} className="cta" aria-label={`Saiba mais sobre ${n.title}`}>Saiba mais →</Link>
              </div>
            </article>
          ))}
        </div>
        <div className="info-box">
          <h3>Informações importantes</h3>
          <p>Os serviços são realizados após análise da necessidade, das condições do paciente, da disponibilidade profissional e da região de atendimento.</p>
          <p>Procedimentos que dependam de prescrição somente poderão ser realizados após conferência de documento válido.</p>
          <p>Medicamentos, equipamentos, materiais especiais, exames, consultas médicas e atendimentos adicionais não estão incluídos, salvo quando descritos expressamente na contratação.</p>
          <p>A ONEMA SAÚDE não substitui serviços de urgência e emergência. Em situações de emergência, ligue <a href="tel:192">SAMU 192</a> ou procure o serviço de emergência de sua região.</p>
        </div>
      </section>

      <section className="section wallet-band">
        <div className="wallet-copy">
          <div className="eyebrow-teal">Carteira Digital ONEMA</div>
          <h2 className="display-light">Sua saúde organizada.<br /><span className="teal">Sempre com você.</span></h2>
          <p className="lead">Um espaço seguro para reunir as informações da sua jornada de cuidado, acompanhar sua evolução e saber quais são os próximos passos.</p>
          <div className="row">
            <Link to="/carteira" className="btn green lg">Conheça sua Carteira Digital</Link>
            <Link to="/#como-funciona" className="btn outline lg">Entenda como funciona</Link>
          </div>
        </div>
        <PhoneMock />
      </section>

      <section className="section">
        <div className="feature-cards">
          {[
            [<IconDoc size={24} />, 'Organização', 'Todas as informações do seu cuidado reunidas em um só lugar.'],
            [<IconBell size={24} />, 'Alertas', 'Avisos importantes sobre reavaliações, cuidados e próximos passos.'],
            [<IconCalendar size={24} />, 'Continuidade', 'Plano de cuidado e linha do tempo para acompanhar sua evolução.'],
            [<IconShield size={24} />, 'Segurança', 'Seus dados protegidos com tecnologia e privacidade em cada etapa.'],
          ].map(([icon, title, text]) => (
            <div key={title as string} className="feature-card"><span className="tile-icon sm">{icon}</span><div><h3>{title}</h3><p>{text}</p></div></div>
          ))}
        </div>
        <p className="tagline-pill">Tecnologia que organiza. Enfermagem que cuida. Cuidado que continua com você.</p>
      </section>

      <section className="lifescore">
        <div className="lifescore-copy">
          <div className="eyebrow-teal light">ONEMA Life Score™</div>
          <h2>Sua evolução acompanhada.</h2>
          <p>A tecnologia ONEMA organiza informações do cuidado, acompanha evolução e facilita a continuidade assistencial sem substituir a avaliação clínica do profissional.</p>
          <ul className="checks">
            <li>Meu Cuidado ONEMA</li><li>Care Plan e próxima ação</li><li>Pendências e timeline</li><li>Acompanhamento longitudinal</li>
          </ul>
          <p className="small">O ONEMA Life Score™ é um indicador longitudinal de apoio à jornada e não representa diagnóstico médico automático. Uso clínico somente após as etapas de validação e liberação da ONEMA.</p>
        </div>
        <div className="ls-card" role="img" aria-label="Exemplo ilustrativo do painel ONEMA Life Score">
          <div className="ls-top"><AppIcon size={34} /><div><strong>ONEMA LIFE SCORE™</strong><small>Visão longitudinal do cuidado</small></div><em>Exemplo ilustrativo</em></div>
          <div className="ls-body">
            <div className="ls-dial"><svg viewBox="0 0 120 120" aria-hidden><circle cx="60" cy="60" r="50" className="ls-track" /><circle cx="60" cy="60" r="50" className="ls-value" pathLength={100} strokeDasharray="82 100" /></svg>
              <div><strong>82</strong><small>/100</small><em>Acompanhamento ativo</em></div></div>
            <div className="ls-right">
              <b>Evolução do cuidado</b>
              <ol className="ls-steps"><li className="ok">Avaliação</li><li className="ok">Care Plan</li><li className="now">Acompanhamento</li><li>Desfecho</li></ol>
              <div className="ls-next"><small>Próxima ação</small><strong>Enfermagem · hoje, 15:30</strong><small>Orientações e pendências organizadas</small></div>
            </div>
          </div>
          <div className="ls-foot"><div><small>Care Plan</small><b>Atualizado</b></div><div><small>Pendências</small><b>1 acompanhamento</b></div><div><small>Continuidade</small><b>Em andamento</b></div></div>
        </div>
      </section>

      <section className="section center" id="como-funciona">
        <div className="eyebrow-teal">Como funciona</div>
        <h2 className="display-light">Uma jornada simples. Um cuidado coordenado.</h2>
        <ol className="journey">
          {[
            [<IconChat size={32} />, 'Você solicita', 'Paciente ou responsável informa a necessidade.'],
            [<IconDoc size={32} />, 'A ONEMA organiza', 'A demanda é estruturada e direcionada.'],
            [<IconNurse size={32} />, 'O especialista cuida', 'O cuidado acontece de forma segura.'],
            [<IconWallet size={32} />, 'A jornada continua', 'Plano de cuidado e próximos passos organizados.'],
          ].map(([icon, title, text]) => (
            <li key={title as string}><span className="tile-icon lg">{icon}</span><h3>{title}</h3><p>{text}</p></li>
          ))}
        </ol>
      </section>

      <section className="section security-band" id="seguranca">
        <div className="eyebrow-teal">Segurança</div>
        <h2 className="display-light">Mais segurança em cada etapa do seu atendimento.</h2>
        <p className="lead">Você sabe quem vai cuidar de você e confirma o início da visita pelo app. Tudo fica registrado.</p>
        <div className="security-grid">
          {[
            [<IconNurse size={26} />, 'Profissional identificado', 'Nome e COREN da especialista aparecem no seu pedido. Toda especialista passa pela validação de identidade, COREN e documentos e pela ONEMA Academy.'],
            [<IconShield size={26} />, 'Código de início da visita', 'Seu app mostra um código de 6 números. A especialista só inicia o atendimento depois de digitar o código que você informar pessoalmente.'],
            [<IconCalendar size={26} />, 'Início registrado', 'O horário de início fica registrado no seu pedido. Com a autorização da especialista, também a localização aproximada.'],
            [<IconDoc size={26} />, 'Evolução assinada', 'Ao final, a especialista registra e assina a evolução de enfermagem, que fica guardada na sua Carteira Digital.'],
            [<IconWallet size={26} />, 'Pagamento protegido', 'Você paga na página segura do Asaas, por Pix, boleto ou cartão. Os dados do cartão não passam pela ONEMA.'],
          ].map(([icon, title, text]) => (
            <div key={title as string} className="feature-card"><span className="tile-icon sm">{icon}</span><div><h3>{title}</h3><p>{text}</p></div></div>
          ))}
        </div>
      </section>

      <section className="section moments">
        <div className="eyebrow-teal">Com você em cada momento</div>
        <h2 className="display-light">Do primeiro atendimento ao cuidado que continua.</h2>
        <ol className="moments-list">
          <li><span className="tile-icon sm"><IconNurse size={24} /></span><div><h3>Primeira contratação</h3><p>Orçamento claro antes de pagar, especialista validada e um atendimento feito para conquistar sua confiança.</p></div></li>
          <li><span className="tile-icon sm"><IconHeart size={24} /></span><div><h3>Continuidade do cuidado</h3><p>Orientações, retornos e acompanhamento quando indicados, com tudo registrado na sua Carteira Digital.</p></div></li>
          <li><span className="tile-icon sm"><IconChat size={24} /></span><div><h3>Relacionamento e indicação</h3><p>Gostou do cuidado? Indique a ONEMA para quem você ama, com o seu link de indicação.</p></div></li>
        </ol>
      </section>

      <section className="section" id="sobre">
        <div className="eyebrow-teal">Sobre nós</div>
        <h2 className="display-light">Cuidado além do atendimento pontual.</h2>
        <p className="lead wide">A ONEMA SAÚDE nasceu para tornar o cuidado fora do hospital mais organizado, seguro e contínuo. Combinamos enfermagem especializada, coordenação assistencial e tecnologia para conectar cada necessidade à próxima ação adequada.</p>
        <p className="lead wide">Nosso foco não termina na visita. A ONEMA estrutura a jornada, acompanha necessidades, registra evolução e ajuda paciente e família a compreenderem os próximos passos.</p>
        <div className="pill-cards">
          <span><IconHeart size={20} />Cuidado</span><span><IconChat size={20} />Coordenação</span><span><IconDoc size={20} />Tecnologia</span><span><IconCalendar size={20} />Continuidade</span>
        </div>
      </section>

      <section className="prime-band">
        <div className="prime-copy">
          <div className="row prime-brand"><AppIcon size={60} /><span className="eyebrow-teal light">Benefícios e conveniência</span></div>
          <h2>ONEMA <span className="teal">PRIME</span></h2>
          <p className="prime-lead">Mais facilidade para organizar sua rotina e acessar vantagens em serviços elegíveis da ONEMA SAÚDE.</p>
          <p className="small">Uma assinatura opcional de relacionamento, com agenda, lembretes, ofertas e uma visão clara dos seus benefícios.</p>
          <p className="small">Valores e condições aparecem depois do seu cadastro, antes de qualquer contratação.</p>
          <p className="small">Renovação automática somente mediante contratação expressa.</p>
          <Link to="/prime" className="btn white lg">Conhecer a ONEMA PRIME <IconArrowRight size={18} /></Link>
        </div>
        <figure className="prime-photo">
          <img src="/img/recepcao-onema.jpg" alt="Recepção ONEMA SAÚDE" />
          <figcaption>ONEMA SAÚDE</figcaption>
        </figure>
      </section>
    </div>
  );
}
