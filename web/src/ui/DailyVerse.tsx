import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../lib/api';
import { IconBook, IconChevronDown } from './icons';

interface Devotional { date: string; ref: string; verse: string; reflection: string }

/** Data local do aparelho (AAAA-MM-DD): o devocional vira junto com o dia de quem lê. */
const localDate = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const msToMidnight = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1, 0, 0, 5).getTime() - n.getTime(); };

/**
 * "Café com a ONEMA" — devocional diário opcional: versículo, referência e um parágrafo de reflexão.
 * Recolhido por padrão; "Ler mensagem" expande no próprio card e "Recolher mensagem" fecha.
 * Conteúdo vem do servidor (biblioteca anual + publicações da equipe) e troca na virada do dia local.
 */
export function DailyVerse() {
  const [date, setDate] = useState(localDate);
  const [d, setD] = useState<Devotional | null>(null);
  const [open, setOpen] = useState(false);
  const panel = useId();
  const ref = useRef<HTMLElement>(null);
  // Enquanto a leitura aberta está visível, a Kary vira um botão pequeno para não cobrir o texto.
  useEffect(() => {
    const el = ref.current;
    if (!open || !el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => window.dispatchEvent(new CustomEvent('kary:compact', { detail: e.isIntersecting })));
    io.observe(el);
    return () => { io.disconnect(); window.dispatchEvent(new CustomEvent('kary:compact', { detail: false })); };
  }, [open, d]);
  useEffect(() => {
    let alive = true;
    api<Devotional>('GET', `/api/public/cafe?date=${date}`).then((r) => alive && setD(r)).catch(() => alive && setD(null));
    const t = window.setTimeout(() => { setOpen(false); setDate(localDate()); }, msToMidnight());
    return () => { alive = false; window.clearTimeout(t); };
  }, [date]);
  if (!d) return null;
  return (
    <section ref={ref} className="cafe" aria-labelledby="cafe-title">
      <div className="cafe-kicker">Uma pausa para o coração · conteúdo opcional</div>
      <div className="cafe-head">
        <span className="cafe-icon" aria-hidden><IconBook size={22} /></span>
        <div className="cafe-head-text">
          <h2 id="cafe-title" className="cafe-title">Café com a ONEMA</h2>
          <p className="cafe-line">“{d.verse}” — {d.ref}</p>
        </div>
      </div>
      <button className="cafe-toggle" aria-expanded={open} aria-controls={panel} onClick={() => setOpen((o) => !o)}>
        {open ? 'Recolher mensagem' : 'Ler mensagem'} <span className={open ? 'rot' : ''} aria-hidden><IconChevronDown size={16} /></span>
      </button>
      <div id={panel} className="cafe-full" hidden={!open}>
        <h3 className="cafe-ref">{d.ref}</h3>
        <p className="cafe-text">{d.reflection}</p>
        <p className="cafe-sign">A Ele toda honra e toda glória.</p>
      </div>
    </section>
  );
}
