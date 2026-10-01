import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Link, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { useOnline } from './lib/hooks';
import { get } from './lib/api';
import { applyUpdate, onUpdateAvailable } from './sw-register';
import { IconAward, IconBell, IconBook, IconCog, IconHeart, IconHome, IconShield, IconUser, IconWallet } from './ui/icons';

interface NavItem { to: string; label: string; icon: ReactNode; end?: boolean }

export function useNav(): NavItem[] {
  const { has, isAdmin } = useAuth();
  const items: NavItem[] = [];
  if (has('PACIENTE')) {
    items.push({ to: '/minha-onema', label: 'Minha ONEMA', icon: <IconHome /> });
    items.push({ to: '/prime', label: 'PRIME', icon: <IconHeart /> });
    items.push({ to: '/servicos', label: 'Serviços', icon: <IconWallet /> });
  }
  if (has('ESPECIALISTA')) {
    items.push({ to: '/academy', label: 'Academy', icon: <IconBook />, end: true });
    items.push({ to: '/academy/certificados', label: 'Certificados', icon: <IconAward /> });
  }
  if (isAdmin) items.push({ to: '/admin', label: 'Gestão', icon: <IconShield /> });
  items.push({ to: '/avisos', label: 'Avisos', icon: <IconBell /> });
  items.push({ to: '/conta', label: 'Conta', icon: <IconUser /> });
  return items;
}

export function Layout({ children }: { children: ReactNode }) {
  const { me, status } = useAuth();
  const nav = useNav();
  const online = useOnline();
  const loc = useLocation();
  const [update, setUpdate] = useState<ServiceWorkerRegistration | null>(null);
  const [unread, setUnread] = useState(0);
  useEffect(() => onUpdateAvailable(setUpdate) as any, []);
  useEffect(() => {
    if (!me?.user) return;
    get<any>('/api/notifications').then((r) => setUnread(r.items.filter((n: any) => !n.read_at).length)).catch(() => {});
  }, [me?.user, loc.pathname]);
  useEffect(() => { window.scrollTo(0, 0); }, [loc.pathname]);

  const primary = nav.filter((n) => n.to !== '/conta');
  return (
    <>
      <a href="#conteudo" className="skip-link">Pular para o conteúdo</a>
      {status && status.environment !== 'production' && (
        <div className="env-banner" title="Pagamentos simulados, sem cobrança real. Use apenas dados fictícios.">Versão de testes · pagamentos simulados</div>
      )}
      {!online && <div className="offline-banner" role="status">Você está sem conexão. Os dados de saúde não ficam salvos no aparelho; reconecte-se para continuar.</div>}
      {update && (
        <div className="update-banner" role="status">
          Nova versão do aplicativo disponível.
          <button className="btn sm deep" onClick={() => applyUpdate(update)}>Atualizar agora</button>
        </div>
      )}
      <div className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand" aria-label="ONEMA SAÚDE — início"><img src="/icons/logo-onema-saude.png" alt="ONEMA SAÚDE" /></Link>
          <nav className="topnav" aria-label="Navegação principal">
            {primary.map((n) => <NavLink key={n.to} to={n.to} end={n.end}>{n.label}</NavLink>)}
          </nav>
          <div className="top-actions">
            {me?.user && <div className="user-chip"><strong>{me.user.name}</strong>{me.user.email}</div>}
            <NavLink to="/avisos" className="icon-btn" aria-label={`Avisos${unread ? `: ${unread} não lidos` : ''}`}>
              <IconBell />{unread > 0 && <span className="dot">{unread}</span>}
            </NavLink>
            <NavLink to="/conta" className="icon-btn" aria-label="Minha conta"><IconCog /></NavLink>
          </div>
        </div>
      </div>
      <main id="conteudo" className="page" tabIndex={-1}>{children}</main>
      <nav className="bottomnav" aria-label="Navegação principal (celular)">
        {nav.filter((n) => n.to !== '/avisos').slice(0, 5).map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end}>{n.icon}<span>{n.label}</span></NavLink>
        ))}
      </nav>
    </>
  );
}
