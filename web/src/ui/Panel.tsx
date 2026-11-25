import { type ReactNode, useEffect, useRef } from 'react';
import './panel.css';

/**
 * Painel próprio (ajustes do RT, 22/11/2026): no celular ocupa a tela inteira com voltar/fechar; no desktop é um painel
 * lateral. Ao fechar, o foco volta ao botão de origem (a Carteira continua no mesmo ponto).
 */
export function Panel({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('panel-open');
    return () => { document.removeEventListener('keydown', onKey); document.body.classList.remove('panel-open'); prev?.focus(); };
  }, [open]);
  if (!open) return null;
  return (
    <div className="panel-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="side-panel" role="dialog" aria-modal="true" aria-labelledby="panel-title" tabIndex={-1} ref={ref}>
        <div className="side-panel-head">
          <button type="button" className="btn ghost sm" onClick={onClose} aria-label="Voltar">← Voltar</button>
          <h2 id="panel-title" className="mb0">{title}</h2>
          <button type="button" className="btn ghost sm" onClick={onClose} aria-label="Fechar">✕</button>
        </div>
        <div className="side-panel-body">{children}</div>
      </div>
    </div>
  );
}
