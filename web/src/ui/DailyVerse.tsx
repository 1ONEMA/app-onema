import { useState } from 'react';
import { dailyVerse, dayIndex } from '../content/verses';
import { IconBook, IconChevronDown } from './icons';

const HIDE_KEY = 'onema.cafe.oculto';
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string | null) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* armazenamento indisponível */ } };

/** "Café com a ONEMA": versículo do dia (opcional). O usuário pode ocultar por hoje ou sempre. */
export function DailyVerse() {
  const today = String(dayIndex());
  const [hidden, setHidden] = useState(() => { const h = read(HIDE_KEY); return h === 'sempre' || h === today; });
  const [open, setOpen] = useState(false);
  if (hidden) {
    return read(HIDE_KEY) === 'sempre'
      ? <p className="cafe-restore"><button className="linklike" onClick={() => { write(HIDE_KEY, null); setHidden(false); }}>Mostrar o Café com a ONEMA</button></p>
      : null;
  }
  const v = dailyVerse();
  const short = v.text.length > 52 ? `${v.text.slice(0, v.text.lastIndexOf(' ', 48))}…` : v.text;
  return (
    <section className="cafe" aria-labelledby="cafe-title">
      <span className="cafe-icon" aria-hidden><IconBook size={26} /></span>
      <div className="cafe-body">
        <div className="cafe-kicker">Uma pausa para o coração · conteúdo opcional</div>
        <h2 id="cafe-title" className="cafe-title">Café com a ONEMA</h2>
        {!open && <p className="cafe-line">“{short}” · {v.ref}</p>}
        {open && (
          <div className="cafe-full">
            <blockquote>“{v.text}”<cite>{v.ref}</cite></blockquote>
            <p>{v.reflection}</p>
            <p className="cafe-sign">A Ele toda honra e toda glória.</p>
            <div className="row">
              <button className="linklike small" onClick={() => { write(HIDE_KEY, today); setHidden(true); }}>Ocultar por hoje</button>
              <button className="linklike small" onClick={() => { write(HIDE_KEY, 'sempre'); setHidden(true); }}>Não mostrar mais</button>
            </div>
          </div>
        )}
        <button className="cafe-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Fechar mensagem' : 'Ler mensagem'} <span className={open ? 'rot' : ''}><IconChevronDown size={18} /></span>
        </button>
      </div>
    </section>
  );
}
