import { useId, useState, type ReactNode } from 'react';

/** Campo de senha com botão "olho" para mostrar/ocultar o que foi digitado. */
export function PasswordField({ label, value, onChange, autoComplete, hint, error, invalid }: {
  label: string; value: string; onChange: (v: string) => void; autoComplete: string; hint?: ReactNode; error?: string | null; invalid?: boolean;
}) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const described = [hint ? `${id}-hint` : '', error ? `${id}-err` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id}><span>{label}</span></label>
      <div className="pw-wrap">
        <input id={id} type={visible ? 'text' : 'password'} autoComplete={autoComplete} required value={value}
          onChange={(e) => onChange(e.target.value)} aria-describedby={described} aria-invalid={invalid || !!error || undefined}
          autoCapitalize="none" autoCorrect="off" spellCheck={false} />
        <button type="button" className="pw-eye" onClick={() => setVisible((v) => !v)} aria-pressed={visible}
          aria-label={visible ? 'Ocultar o que foi digitado' : 'Mostrar o que foi digitado'} title={visible ? 'Ocultar' : 'Mostrar'}>
          {visible ? (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M3 3l18 18" /><path d="M10.6 5.1A9.8 9.8 0 0 1 12 5c5 0 9 4.5 10 7-0.4 1-1.3 2.4-2.6 3.7M6.6 6.6C4.4 8 2.9 10.1 2 12c1 2.5 5 7 10 7 1.8 0 3.4-.6 4.8-1.4" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>
          ) : (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M2 12c1-2.5 5-7 10-7s9 4.5 10 7c-1 2.5-5 7-10 7S3 14.5 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
          )}
        </button>
      </div>
      {hint && <small id={`${id}-hint`}>{hint}</small>}
      {error && <small id={`${id}-err`} className="err">{error}</small>}
    </div>
  );
}
