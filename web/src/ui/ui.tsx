import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ApiError } from '../lib/api';

export function Button({ busy, children, className = '', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button {...rest} className={`btn ${className}`} disabled={rest.disabled || busy} aria-busy={busy || undefined}>
      {busy && <span className="spinner" aria-hidden />}{children}
    </button>
  );
}

export const Badge = ({ tone = '', children }: { tone?: string; children: ReactNode }) => <span className={`badge ${tone}`}>{children}</span>;

export function Loading({ label = 'Carregando…', lines = 3 }: { label?: string; lines?: number }) {
  return (
    <div role="status" aria-live="polite" className="surface">
      <span className="sr-only">{label}</span>
      {Array.from({ length: lines }).map((_, i) => <div key={i} className="skeleton" style={{ width: `${90 - i * 15}%` }} />)}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: ApiError | null; onRetry?: () => void }) {
  if (!error) return null;
  const offline = error.isNetwork;
  return (
    <div className="surface state" role="alert">
      <h3>{offline ? 'Sem conexão' : error.status === 403 ? 'Acesso não permitido' : error.status === 404 ? 'Não encontrado' : 'Não foi possível carregar'}</h3>
      <p>{error.message}</p>
      {error.correlationId && <p className="small muted">Código de suporte: <span className="mono">{error.correlationId}</span></p>}
      {onRetry && <button className="btn secondary" onClick={onRetry}>Tentar novamente</button>}
    </div>
  );
}

export function Alert({ error, success, children }: { error?: ApiError | null; success?: string | null; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error || success) ref.current?.focus(); }, [error, success]);
  if (error) {
    const details = Array.isArray(error.details) ? error.details : null;
    return (
      <div ref={ref} tabIndex={-1} className="danger" role="alert">
        <strong>{error.message}</strong>
        {details && <ul className="small mb0">{details.map((d: any, i: number) => <li key={i}>{typeof d === 'string' ? d : d.message}</li>)}</ul>}
        {error.correlationId && <div className="small">Código de suporte: <span className="mono">{error.correlationId}</span></div>}
      </div>
    );
  }
  if (success) return <div ref={ref} tabIndex={-1} className="success" role="status">{success}</div>;
  return children ? <div className="callout">{children}</div> : null;
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state">
      <h3>{title}</h3>
      {children && <div>{children}</div>}
      {action && <div className="mt">{action}</div>}
    </div>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
      {error && <small className="err">{error}</small>}
    </label>
  );
}

export function fieldError(error: ApiError | null, path: string) {
  if (!error || !Array.isArray(error.details)) return null;
  return error.details.find((d: any) => d?.path === path)?.message ?? null;
}

export function PageHeader({ kicker, title, children, back }: { kicker?: string; title: string; children?: ReactNode; back?: { to: string; label: string } }) {
  useEffect(() => { document.title = `${title} · ONEMA SAÚDE`; }, [title]);
  return (
    <header className="hero">
      {back && <Link to={back.to} className="small" style={{ color: '#CFE0FF' }}>← {back.label}</Link>}
      {kicker && <div className="kicker">{kicker}</div>}
      <h1>{title}</h1>
      {children}
    </header>
  );
}

export function Pending({ children }: { children: ReactNode }) {
  return <div className="pending-box"><strong>Pendente de definição da ONEMA SAÚDE.</strong> {children}</div>;
}

export function Progress({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <div className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)}>
        <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}

export function Dialog({ open, title, children, onClose }: { open: boolean; title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus(); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title" tabIndex={-1} ref={ref}>
        <div className="row between"><h2 id="dlg-title" className="mb0">{title}</h2><button className="btn ghost sm" onClick={onClose} aria-label="Fechar">✕</button></div>
        <div className="mt">{children}</div>
      </div>
    </div>
  );
}

/** Renderiza texto legal estruturado ({title, sections:[{heading, paragraphs}]}) sem alterar o conteúdo. */
export function LegalText({ body }: { body: string }) {
  let doc: any;
  try { doc = JSON.parse(body); } catch { return <p>{body}</p>; }
  return (
    <div className="contract">
      {doc.sections.map((s: any, i: number) => (
        <article key={i}>
          {s.heading && <h3>{s.heading}</h3>}
          {s.paragraphs.map((p: string, j: number) => <p key={j}>{p}</p>)}
        </article>
      ))}
      {doc.source && <p className="small muted">Fonte: {doc.source}</p>}
    </div>
  );
}
