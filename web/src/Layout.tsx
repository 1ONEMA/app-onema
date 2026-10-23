import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Link, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { useOnline } from './lib/hooks';
import { get } from './lib/api';
import { applyUpdate, onUpdateAvailable } from './sw-register';
import { Kary } from './ui/Kary';
import { Footer } from './ui/Footer';
import { Logo } from './ui/Brand';
import { Dialog } from './ui/ui';
import { IconBell, IconBook, IconCog, IconDownload, IconHeart, IconHome, IconNurse, IconShield, IconUser, IconWallet } from './ui/icons';

interface NavItem { to: string; label: string; icon: ReactNode; end?: boolean }

const CENTRAL_ROLES = ['OPERADOR_CENTRAL', 'ADMIN_PRIME', 'FINANCEIRO', 'AVALIADOR_RT', 'AUDITOR'] as const;

/** Navegação no modelo do protótipo v5: Plataforma · Solicitar cuidado · Área do especialista · Central RT. */
export function useNav() {
  const { me, has, isAdmin } = useAuth();
  const logged = !!me?.user;
  const top: NavItem[] = [
    { to: '/plataforma', label: 'Plataforma', icon: <IconWallet /> },
    { to: '/solicitar', label: 'Solicitar cuidado', icon: <IconHeart /> },
    { to: '/especialista', label: 'Área do especialista', icon: <IconNurse /> },
  ];
  const mine: NavItem[] = [];
  if (has('PACIENTE')) mine.push({ to: '/carteira', label: 'Carteira', icon: <IconWallet /> }, { to: '/servicos', label: 'Meus pedidos', icon: <IconHeart /> }, { to: '/prime', label: 'PRIME', icon: <IconWallet /> });
  if (has('ESPECIALISTA')) mine.push({ to: '/academy', label: 'Academy', icon: <IconBook />, end: true });
  if (isAdmin) mine.push({ to: '/admin', label: 'Gestão', icon: <IconCog /> });

  let bottom: NavItem[];
  const home: NavItem = { to: '/', label: 'Início', icon: <IconHome />, end: true };
  const central: NavItem = { to: '/central', label: 'Central', icon: <IconShield /> };
  if (!logged) bottom = [home, { to: '/solicitar', label: 'Cuidado', icon: <IconHeart /> }, { to: '/especialista', label: 'Especialista', icon: <IconNurse /> }, central, { to: '/plataforma', label: 'Plataforma', icon: <IconWallet /> }];
  else if (has('PACIENTE')) bottom = [home, { to: '/solicitar', label: 'Cuidados', icon: <IconHeart /> }, { to: '/carteira', label: 'Carteira', icon: <IconWallet /> }, { to: '/servicos', label: 'Pedidos', icon: <IconHome /> }, { to: '/conta', label: 'Perfil', icon: <IconUser /> }];
  else if (has('ESPECIALISTA')) bottom = [home, { to: '/especialista', label: 'Especialista', icon: <IconNurse /> }, { to: '/academy', label: 'Academy', icon: <IconBook />, end: true }, { to: '/avisos', label: 'Avisos', icon: <IconBell /> }, { to: '/conta', label: 'Conta', icon: <IconCog /> }];
  else bottom = [home, central, { to: '/admin', label: 'Gestão', icon: <IconCog /> }, { to: '/avisos', label: 'Avisos', icon: <IconBell /> }, { to: '/conta', label: 'Conta', icon: <IconUser /> }];
  return { top, mine, bottom, showCentral: !logged || has(...CENTRAL_ROLES) };
}

/** Instalação do PWA: usa o prompt nativo quando existe; senão mostra o passo a passo. */
function useInstall() {
  const [prompt, setPrompt] = useState<any>(null);
  const [installed, setInstalled] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches);
  useEffect(() => {
    const onPrompt = (e: Event) => { e.preventDefault(); setPrompt(e); };
    const onInstalled = () => setInstalled(true);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => { window.removeEventListener('beforeinstallprompt', onPrompt); window.removeEventListener('appinstalled', onInstalled); };
  }, []);
  return { prompt, installed, clear: () => setPrompt(null) };
}

export function Layout({ children, wide }: { children: ReactNode; wide?: boolean }) {
  const { me, status } = useAuth();
  const { top, mine, bottom, showCentral } = useNav();
  const online = useOnline();
  const loc = useLocation();
  const install = useInstall();
  const [howTo, setHowTo] = useState(false);
  const [update, setUpdate] = useState<ServiceWorkerRegistration | null>(null);
  const [unread, setUnread] = useState(0);
  useEffect(() => onUpdateAvailable(setUpdate) as any, []);
  useEffect(() => {
    if (!me?.user) return;
    get<any>('/api/notifications').then((r) => setUnread(r.items.filter((n: any) => !n.read_at).length)).catch(() => {});
  }, [me?.user, loc.pathname]);
  useEffect(() => {
    // Âncoras (/#catalogo, /#sobre): rola até a seção depois que a página renderiza.
    if (loc.hash) {
      const id = decodeURIComponent(loc.hash.slice(1));
      const t = setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
      return () => clearTimeout(t);
    }
    window.scrollTo(0, 0);
  }, [loc.pathname, loc.hash]);

  async function onInstall() {
    if (install.prompt) { install.prompt.prompt(); await install.prompt.userChoice.catch(() => null); install.clear(); }
    else setHowTo(true);
  }

  return (
    <>
      <a href="#conteudo" className="skip-link">Pular para o conteúdo</a>
      {!online && <div className="offline-banner" role="status">Você está sem conexão. Os dados de saúde não ficam salvos no aparelho; reconecte-se para continuar.</div>}
      {update && (
        <div className="update-banner" role="status">
          Nova versão do aplicativo disponível.
          <button className="btn sm deep" onClick={() => applyUpdate(update)}>Atualizar agora</button>
        </div>
      )}
      <div className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand" aria-label="ONEMA SAÚDE — início"><Logo height={44} /></Link>
          <nav className="topnav" aria-label="Navegação principal">
            {top.map((n) => <NavLink key={n.to} to={n.to} end={n.end}>{n.label}</NavLink>)}
            {mine.map((n) => <NavLink key={n.to} to={n.to} end={n.end}>{n.label}</NavLink>)}
            {showCentral && <NavLink to="/central" className="nav-central"><span className="nav-shield" aria-hidden><IconShield size={16} /></span>Central RT</NavLink>}
          </nav>
          <div className="top-actions">
            {!install.installed && <button className="btn-install" onClick={onInstall} aria-label="Instalar o app"><IconDownload size={17} /> <span>Instalar</span></button>}
            {me?.user ? (
              <>
                <NavLink to="/avisos" className="icon-btn" aria-label={`Avisos${unread ? `: ${unread} não lidos` : ''}`}>
                  <IconBell />{unread > 0 && <span className="dot">{unread}</span>}
                </NavLink>
                <NavLink to="/conta" className="icon-btn" aria-label={`Minha conta (${me.user.name})`}><IconUser /></NavLink>
              </>
            ) : <Link to="/entrar" className="btn sm deep">Entrar</Link>}
          </div>
        </div>
      </div>
      <main id="conteudo" className={`page ${wide ? 'wide' : ''}`} tabIndex={-1}>
        {status && status.environment !== 'production' && (
          <div className="proto-banner">
            <p><strong>Versão de homologação · {status.environment === 'homologacao' ? 'HML' : 'teste'}.</strong> Atendimento, integrações e pagamentos simulados. Use apenas dados fictícios.</p>
            <Link to="/central" className="proto-rt"><span className="nav-shield" aria-hidden><IconShield size={16} /></span>Acesso interno RT</Link>
          </div>
        )}
        {children}
      </main>
      <Footer />
      <nav className="bottomnav" aria-label="Navegação principal (celular)">
        {bottom.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end}><span className="bn-icon">{n.icon}</span><span>{n.label}</span></NavLink>
        ))}
      </nav>
      <Kary />
      <Dialog open={howTo} title="Instalar o app ONEMA" onClose={() => setHowTo(false)}>
        <p><strong>Android (Chrome):</strong> abra o menu ⋮ e toque em “Instalar app” ou “Adicionar à tela inicial”.</p>
        <p><strong>iPhone (Safari):</strong> toque em Compartilhar e depois em “Adicionar à Tela de Início”.</p>
        <p><strong>Computador (Chrome/Edge):</strong> clique no ícone de instalação na barra de endereço.</p>
        <button className="btn deep" onClick={() => setHowTo(false)}>Entendi</button>
      </Dialog>
    </>
  );
}
