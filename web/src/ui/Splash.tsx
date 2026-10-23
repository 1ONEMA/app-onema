import { useEffect, useState } from 'react';
import { S_BOTTOM, S_TOP } from './Brand';

const KEY = 'onema.splash.visto';
const seen = () => { try { return sessionStorage.getItem(KEY) === '1'; } catch { return false; } };
/** Decidido uma vez por carregamento da página (testes automatizados — navigator.webdriver — não exibem a abertura). */
const INITIAL = typeof window !== 'undefined' && !seen() && !navigator.webdriver;
let finished = false;
const markSeen = () => { try { sessionStorage.setItem(KEY, '1'); } catch { /* sem armazenamento */ } };

/**
 * Abertura do app (modelo do vídeo do cliente): o "S" é desenhado em linhas finas,
 * ganha contorno duplo, preenche com azul e verde e vira o ícone oficial. Uma vez por sessão;
 * toque para pular; versão curta quando o sistema pede menos movimento.
 */
export function Splash() {
  const [show, setShow] = useState(INITIAL);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (!show) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const total = reduce ? 700 : 3600;
    const t1 = setTimeout(() => setLeaving(true), total);
    const t2 = setTimeout(() => { finished = true; markSeen(); setShow(false); }, total + 450);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [show]);
  if (!show || finished) return null;
  const skip = () => { setLeaving(true); setTimeout(() => { finished = true; markSeen(); setShow(false); }, 300); };
  return (
    <div className={`splash ${leaving ? 'leaving' : ''}`} onClick={skip} role="presentation">
      <svg className="splash-mark" viewBox="0 0 200 200" aria-hidden>
        <defs>
          <linearGradient id="spBg" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stopColor="#0A1A9E" /><stop offset="1" stopColor="#020A3D" /></linearGradient>
          <linearGradient id="spBlue" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#4A93FF" /><stop offset="1" stopColor="#0A6CFF" /></linearGradient>
        </defs>
        <rect className="sp-tile" x="14" y="14" width="172" height="172" rx="40" fill="url(#spBg)" />
        <g className="sp-thin">
          <path d={S_TOP} pathLength={1} stroke="#2F7BFF" />
          <path d={S_BOTTOM} pathLength={1} stroke="#14B8A6" />
        </g>
        {/* Contorno duplo: traço largo colorido com miolo na cor do fundo. */}
        <g className="sp-double">
          <path d={S_TOP} pathLength={1} stroke="#2F7BFF" className="o" />
          <path d={S_BOTTOM} pathLength={1} stroke="#14B8A6" className="o b" />
          <path d={S_TOP} pathLength={1} stroke="#00307E" className="i" />
          <path d={S_BOTTOM} pathLength={1} stroke="#00307E" className="i b" />
        </g>
        <g className="sp-fill">
          <path d={S_TOP} pathLength={1} stroke="url(#spBlue)" />
          <path d={S_BOTTOM} pathLength={1} stroke="#00C2A8" />
        </g>
      </svg>
      <div className="splash-name" aria-hidden><span>ONEMA</span> <b>SAÚDE</b></div>
      <span className="sr-only">ONEMA SAÚDE</span>
    </div>
  );
}
