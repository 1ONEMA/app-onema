import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, get } from '../lib/api';
import { IconSend, IconSpark } from './icons';

interface Msg { role: 'user' | 'assistant'; text: string; links?: { label: string; to: string }[]; kind?: string; baseVersion?: string; escalation?: { label: string } }

/** Kary — assistente da plataforma (botão flutuante + painel). Conversa não é gravada no servidor. */
export function Kary() {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<any>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open && !info) get('/api/kary/info').then(setInfo).catch(() => setInfo({ disclaimer: 'A Kary orienta sobre a plataforma. Em urgência, ligue 192.', suggestions: [] })); }, [open, info]);
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }); }, [msgs, busy]);
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  async function send(message: string) {
    const m = message.trim();
    if (!m || busy) return;
    const history = msgs.map(({ role, text }) => ({ role, text }));
    setMsgs((x) => [...x, { role: 'user', text: m }]);
    setText('');
    setBusy(true);
    try {
      const r = await api<any>('POST', '/api/kary/chat', { message: m, history });
      setMsgs((x) => [...x, { role: 'assistant', text: r.text, links: r.links, kind: r.kind, baseVersion: r.baseVersion, escalation: r.escalation }]);
    } catch (e: any) {
      setMsgs((x) => [...x, { role: 'assistant', text: e?.message ?? 'Não consegui responder agora. Tente novamente.' }]);
    } finally { setBusy(false); }
  }

  return (
    <>
      {!open && (
        <button className="kary-fab" onClick={() => setOpen(true)} aria-label="Falar com a Kary, assistente ONEMA">
          <IconSpark size={22} /><span>Kary</span>
        </button>
      )}
      {open && (
        <div className="kary-panel" role="dialog" aria-modal="false" aria-labelledby="kary-title">
          <header className="kary-head">
            <span className="kary-avatar" aria-hidden><IconSpark size={20} /></span>
            <div><strong id="kary-title">Kary</strong><span>Assistente ONEMA</span></div>
            <button className="kary-close" onClick={() => setOpen(false)} aria-label="Fechar a Kary">✕</button>
          </header>
          <div className="kary-list" ref={listRef} aria-live="polite">
            <div className="kary-msg assistant">
              Olá! Sou a Kary. Posso ajudar com solicitações, valores, ONEMA PRIME, Academy e área do especialista.
              <small>{info?.disclaimer}</small>
            </div>
            {msgs.map((m, i) => (
              <div key={i} className={`kary-msg ${m.role} ${m.kind === 'URGENCIA' ? 'urgent' : ''}`}>
                {m.text}
                {m.links?.length ? (
                  <div className="kary-links">
                    {m.links.map((l) => l.to.startsWith('tel:')
                      ? <a key={l.to} href={l.to} className="btn sm danger">{l.label}</a>
                      : <Link key={l.to} to={l.to} className="btn sm secondary" onClick={() => setOpen(false)}>{l.label}</Link>)}
                  </div>
                ) : null}
                {m.escalation && ['ACADEMY', 'ESCALONAMENTO', 'FORA_DO_ESCOPO'].includes(m.kind ?? '') && (
                  <small>Escalonamento: {m.escalation.label} · {m.baseVersion}</small>
                )}
              </div>
            ))}
            {busy && <div className="kary-msg assistant typing" aria-label="Kary está digitando"><span /><span /><span /></div>}
          </div>
          {!msgs.length && info?.suggestions?.length > 0 && (
            <div className="kary-suggest">{info.suggestions.map((s: string) => <button key={s} onClick={() => send(s)}>{s}</button>)}</div>
          )}
          <form className="kary-form" onSubmit={(e) => { e.preventDefault(); send(text); }}>
            <label className="sr-only" htmlFor="kary-input">Mensagem para a Kary</label>
            <input id="kary-input" ref={inputRef} type="text" value={text} maxLength={500} onChange={(e) => setText(e.target.value)} placeholder="Escreva sua dúvida" autoComplete="off" />
            <button className="btn" disabled={busy || !text.trim()} aria-label="Enviar"><IconSend size={18} /></button>
          </form>
        </div>
      )}
    </>
  );
}
