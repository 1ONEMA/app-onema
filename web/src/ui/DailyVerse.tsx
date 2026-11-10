import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../lib/api';
import { IconBook, IconChevronDown } from './icons';

interface Devotional { date: string; ref: string; verse: string; reflection: string; paragraphs?: string[] }

/** Data editorial em America/Sao_Paulo (AAAA-MM-DD), independente do fuso do aparelho. */
const spDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
/** Milissegundos até a próxima meia-noite de São Paulo (verificação a cada minuto perto da virada). */
const msToSpMidnight = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map((x) => [x.type, Number(x.value)]));
  const left = ((23 - p.hour) * 3600 + (59 - p.minute) * 60 + (60 - p.second)) * 1000 + 2000;
  return Math.min(Math.max(left, 1000), 3600_000);
};

/**
 * "Café com a ONEMA" — devocional diário opcional: versículo, referência e reflexão (lotes com dois parágrafos).
 * Recolhido por padrão; "Ler mensagem" expande no próprio card e "Recolher mensagem" fecha.
 * Conteúdo vem do servidor (biblioteca anual + publicações da equipe) e troca na virada do dia local.
 */
export function DailyVerse() {
  const [date, setDate] = useState(spDate);
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
    // Recalcula na virada do dia em São Paulo e quando o app volta a ficar visível.
    const check = () => { const now = spDate(); if (now !== date) { setOpen(false); setDate(now); } };
    let t = 0;
    const arm = () => { t = window.setTimeout(() => { check(); arm(); }, msToSpMidnight()); };
    arm();
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => { alive = false; window.clearTimeout(t); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible); };
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
        {(d.paragraphs?.length ? d.paragraphs : [d.reflection]).map((p, i) => <p key={i} className="cafe-text">{p}</p>)}
        <p className="cafe-sign">A Ele toda honra e toda glória.</p>
      </div>
    </section>
  );
}
