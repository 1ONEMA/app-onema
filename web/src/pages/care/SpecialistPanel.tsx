import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi, useSubmit } from '../../lib/hooks';
import { money } from '../../lib/format';
import { Alert, Badge, Button, ErrorState, Loading } from '../../ui/ui';

const JOURNEY: Record<string, string> = { NAO_INICIADA: 'Jornada de integração não iniciada', EM_ANDAMENTO: 'Jornada de integração em andamento', CONCLUIDA: 'Jornada de integração concluída' };
const WHEN: Record<string, string> = { AGORA: 'Agora', HOJE: 'Hoje', PROXIMOS_DIAS: 'Próximos dias', AGENDAR: '' };
const TW: Record<string, string> = { MANHA: 'manhã', TARDE: 'tarde', NOITE: 'noite', QUALQUER: 'qualquer horário' };

/** Bipe curto pelo navegador (sem arquivo de áudio). Só toca com a área aberta; não há alarme com o app fechado. */
export function beep() {
  try {
    const Ctx = (window as any).AudioContext ?? (window as any).webkitAudioContext;
    const ctx = new Ctx(); const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = 880; g.gain.value = 0.15; o.connect(g); g.connect(ctx.destination);
    o.start(); o.frequency.setValueAtTime(660, ctx.currentTime + 0.18); o.stop(ctx.currentTime + 0.4);
    setTimeout(() => ctx.close?.(), 600);
  } catch { /* navegador sem áudio */ }
}

/**
 * Painel da especialista ativa e apta: Academy, Meu Financeiro, Habilitações e Oportunidades,
 * com disponibilidade, som e WhatsApp. Atalhos: avaliações e POPs. Abaixo, ofertas e meus atendimentos.
 */
export function SpecialistPanel({ offers, onOffersChange }: { offers: any; onOffersChange: () => void }) {
  const { data, error, loading, reload } = useApi<any>('/api/care/specialist/panel');
  const save = useSubmit<any>();
  const [alerts, setAlerts] = useState(false);
  const seen = useRef<Set<string> | null>(null);
  // Som: toca uma vez por oferta nova enquanto o painel está aberto; evita repetir entre abas.
  useEffect(() => {
    if (!offers?.offers || !data?.preferences) return;
    const ids = offers.offers.map((o: any) => o.id);
    if (seen.current === null) { seen.current = new Set(ids); return; }
    const fresh = ids.filter((x: string) => !seen.current!.has(x));
    fresh.forEach((x: string) => seen.current!.add(x));
    if (!fresh.length || !data.preferences.soundAlerts || !data.preferences.available) return;
    try { const k = `onema.alerta.${fresh.sort().join(',')}`; if (localStorage.getItem(k)) return; localStorage.setItem(k, '1'); } catch { /* sem armazenamento */ }
    beep();
  }, [offers?.offers, data?.preferences]);
  // Busca ofertas novas a cada 30 s com o painel aberto.
  useEffect(() => { const t = window.setInterval(onOffersChange, 30_000); return () => window.clearInterval(t); }, [onOffersChange]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const p = data.preferences;
  async function setPref(patch: any) { if (await save.run('PUT', '/api/care/specialist/preferences', patch)) { reload(); onOffersChange(); } }
  const first = offers?.offers?.[0];
  return (
    <section className="sp-panel" aria-label="Painel da especialista">
      <div className="row between"><h1 className="display-light mb0">Meu painel</h1>
        <Badge tone={data.status === 'ATIVO_APTO' ? '' : 'orange'}>{data.status === 'ATIVO_APTO' ? 'Ativo e apto' : data.status === 'INAPTO' ? 'Credenciamento não aprovado' : 'Em habilitação'}</Badge></div>
      <div className="sp-cards">
        <article className="sp-card">
          <div className="sp-tag">1 · ONEMA ACADEMY</div>
          <h2>Sua formação</h2>
          <p className="small muted">{JOURNEY[data.academy.journeyState] ?? data.academy.journeyState}{data.academy.certificates ? ` · ${data.academy.certificates} certificado(s)` : ''}</p>
          <Link className="btn deep block" to="/academy">Consultar jornada</Link>
        </article>
        <article className="sp-card">
          <div className="sp-tag">2 · MEU FINANCEIRO</div>
          <h2>Recebíveis e repasses</h2>
          <p className="small muted">A receber: <strong>{money(data.finance.toReceiveCents)}</strong>{data.finance.reservedCents ? ` · reservado em atendimentos aceitos: ${money(data.finance.reservedCents)}` : ''} · {data.finance.pix ? `Pix ${data.finance.pix.masked}${data.finance.pix.verified ? '' : ' (em conferência)'}` : 'cadastre sua chave Pix'}</p>
          <p className="small muted">Repasse integral: o valor do seu ato é o informado na oferta e não muda com descontos ao paciente.</p>
          <Link className="btn deep block" to="/especialista/repasses">Acessar Meu Financeiro</Link>
        </article>
        <article className="sp-card">
          <div className="sp-tag">3 · HABILITAÇÕES</div>
          <h2>Serviços e regiões</h2>
          <p className="small muted">{data.habilitations.services.slice(0, 4).join(' · ')}{data.habilitations.services.length > 4 ? ` · +${data.habilitations.services.length - 4}` : ''}</p>
          <p className="small muted">{data.habilitations.regions ?? 'Regiões a definir na candidatura'}</p>
          <details><summary className="btn deep block">Consultar habilitações</summary>
            <ul className="small">{data.habilitations.services.map((x: string) => <li key={x}>{x}</li>)}</ul>
            <p className="small muted">Para alterar serviços ou regiões, fale com a Central ONEMA (a mudança passa pela validação do credenciamento).</p>
          </details>
        </article>
        <article className="sp-card">
          <div className="sp-tag">4 · OPORTUNIDADES</div>
          <div className="row between"><h2 className="mb0">{p.available ? 'Disponível' : 'Indisponível'}</h2>
            <Button className="sm deep" busy={save.busy} onClick={() => setPref({ available: !p.available })}>{p.available ? 'Ficar indisponível' : 'Ficar disponível agora'}</Button></div>
          <p className="small muted">{p.available ? 'Você pode receber novas ofertas compatíveis com seu perfil.' : 'Novas ofertas e seus alertas estão pausados. Seus atendimentos aceitos continuam.'}</p>
          {p.available && (first ? (
            <p className="small"><strong>{offers.offers.length} oferta(s) ativa(s)</strong> · {first.label} · {first.region ?? 'região a confirmar'} · {WHEN[first.when_pref] ?? ''}{first.when_date ? ` ${first.when_date.split('-').reverse().join('/')}` : ''}{first.time_window ? `, ${TW[first.time_window]}` : ''} · repasse {money(first.unit_payout_cents)}</p>
          ) : <p className="small muted">Sem ofertas ativas. As oportunidades compatíveis com seu perfil aparecem aqui.</p>)}
          {p.available && first && <a className="btn deep block" href="#ofertas">Ver oferta</a>}
          <button type="button" className="linklike small mt" aria-expanded={alerts} onClick={() => setAlerts(!alerts)}>Configurar alertas: som e WhatsApp</button>
          {alerts && (
            <div className="sp-alerts">
              <label className="choice"><input type="checkbox" checked={p.soundAlerts} onChange={(e) => setPref({ soundAlerts: e.target.checked })} /><span>Som no painel ({p.soundAlerts ? 'ativado' : 'desativado'})</span></label>
              <label className="choice"><input type="checkbox" checked={p.whatsappAlerts} onChange={(e) => setPref({ whatsappAlerts: e.target.checked })} /><span>Aviso pelo WhatsApp ({p.whatsappAlerts ? 'ativado' : 'desativado'}){!data.whatsappAvailable && <span className="small muted"> · o envio começa quando o canal oficial do WhatsApp da ONEMA for ativado</span>}</span></label>
              <Button className="sm secondary" onClick={beep}>Ouvir alerta</Button>
              <p className="small muted mb0">Mantenha esta área aberta para ouvir os alertas. Não há alarme com o app fechado.</p>
            </div>
          )}
        </article>
      </div>
      <Alert error={save.error} />
      <p className="small sp-links">Atalhos: <Link to="/especialista/avaliacoes">Avaliações dos atendimentos{data.rating.average ? ` (${data.rating.average} ★)` : ''}</Link> · <Link to="/pops">Biblioteca de POPs</Link> · <Link to="/especialista/telenfermagem">Telenfermagem</Link> · <a href="#atendimentos">Meus atendimentos</a></p>
    </section>
  );
}

export function SpecialistReviewsPage() {
  const { data, error, loading, reload } = useApi<any>('/api/care/specialist/reviews');
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const avg = data.reviews.length ? data.reviews.reduce((s: number, r: any) => s + r.stars, 0) / data.reviews.length : null;
  return (
    <div className="flow">
      <div className="eyebrow-teal">Rede ONEMA ONE</div>
      <h1 className="display-light">Avaliações dos atendimentos</h1>
      <p className="lead">{avg ? `Média ${avg.toFixed(1).replace('.', ',')} ★ em ${data.reviews.length} avaliação(ões).` : 'Você ainda não recebeu avaliações.'} Estas estrelas são dos pacientes e ficam separadas das notas da ONEMA Academy.</p>
      <ul className="list">{data.reviews.map((r: any, i: number) => (
        <li key={i}><div className="row between"><strong>{r.label}</strong><span aria-label={`${r.stars} de 5`}>{'★'.repeat(r.stars)}{'☆'.repeat(5 - r.stars)}</span></div>
          {r.comment && <p className="small mb0">“{r.comment}”</p>}<div className="small muted">{new Date(r.created_at).toLocaleDateString('pt-BR')}</div></li>
      ))}</ul>
      <p><Link to="/especialista">Voltar ao painel</Link></p>
    </div>
  );
}
