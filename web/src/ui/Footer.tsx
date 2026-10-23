import { Link } from 'react-router-dom';
import { openKary } from './Kary';
import { Logo } from './Brand';

/** Rodapé institucional (modelo do site de referência do cliente). */
export function Footer() {
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div className="footer-brand">
          <div className="footer-logo"><Logo height={58} /></div>
          <p>Cuidado coordenado. Tecnologia que acompanha. Enfermeiros especialistas.</p>
        </div>
        <nav aria-label="Navegação do rodapé">
          <h2>Navegação</h2>
          <Link to="/">Início</Link>
          <Link to="/#sobre">Sobre nós</Link>
          <Link to="/#catalogo">Catálogo</Link>
          <Link to="/plataforma">Tecnologia</Link>
          <Link to="/prime">ONEMA PRIME</Link>
          <Link to="/especialista">Rede ONEMA ONE</Link>
        </nav>
        <nav aria-label="Institucional">
          <h2>Institucional</h2>
          <Link to="/institucional/privacidade">Política de Privacidade</Link>
          <Link to="/institucional/termos">Termos de Uso</Link>
          <Link to="/institucional/lgpd">LGPD</Link>
          <Link to="/plataforma#aplicativo">Aplicativo ONEMA</Link>
        </nav>
        <div>
          <h2>Fale com a ONEMA</h2>
          <a href="mailto:atendimento@onemasaude.com.br" className="footer-contact">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3.5 6.5l8.5 6 8.5-6" /></svg>
            atendimento@onemasaude.com.br
          </a>
          <button type="button" className="footer-contact linklike-light" onClick={openKary}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><path d="M4 5h16v11H9l-5 4z" /></svg>
            Enviar mensagem
          </button>
          <p>São Paulo — SP</p>
          <p>© {new Date().getFullYear()} ONEMA SAÚDE. Todos os direitos reservados.</p>
        </div>
      </div>
    </footer>
  );
}
