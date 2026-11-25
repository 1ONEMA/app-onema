/**
 * Carteira Digital — plano de cuidados e alertas (homologação, regras fictícias).
 * Paciente: plano liberado + avisos. Enfermeira: plano a partir do atendimento assinado e pendências. RT/Central: fila e regras.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Panel } from '../../ui/Panel';
import './carteira.css';
import { useApi, useLiveApi, useSubmit } from '../../lib/hooks';
import { dateTime } from '../../lib/format';
import { Alert, Badge, Button, Empty, ErrorState, Field, Loading, PageHeader } from '../../ui/ui';
import { useAuth } from '../../lib/auth';

const ANSWER: Record<string, string> = { MELHOROU: 'Melhorou', IGUAL: 'Igual', PIOROU: 'Piorou' };
const fmtDayTime = (iso: string) => { const d = new Date(iso); return `${d.toLocaleDateString('pt-BR')} às ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`; };
const IconCheckInline = () => <span aria-hidden="true">✓</span>;
const PRI: Record<string, string> = { ALTA: 'red', MEDIA: 'orange', BAIXA: 'blue' };
const CAT: Record<string, string> = { LEMBRETE: 'Lembrete', CLINICO: 'Clínico', ADMINISTRATIVO: 'Administrativo', TECNICO: 'Técnico' };

function localInput(d = new Date(Date.now() + 24 * 3600_000)) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Paciente: card "Plano de cuidados" da Carteira (comandos do RT de 20 e 22/11/2026). Mostra somente o último lembrete
 * disponibilizado; histórico e orientações abrem em painel próprio. "Ciente" registra a ciência daquela ocorrência
 * (não é execução, melhora nem agendamento). O paciente ajusta os avisos; a orientação de Enfermagem não muda.
 */
export function PatientPlanSection() {
  const { data, error, loading, reload } = useLiveApi<any>('/api/carteira/plan', 5000);
  const act = useSubmit<any>();
  const [answer, setAnswer] = useState('');
  const [panel, setPanel] = useState<null | 'history' | 'all' | { adjust: string }>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (loading && !data) return <Loading lines={2} />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  const l = data.latest;
  const st = l?.series;
  async function ack() {
    setMsg(null);
    const r = await act.run('POST', `/api/carteira/plan/${l.id}/ack`, answer ? { answer } : {}, { idempotent: true });
    if (r) setAnswer('');
    reload();
  }
  async function schedule(action: 'JA_AGENDEI' | 'PRECISO_AJUDA') {
    const r = await act.run('POST', `/api/carteira/plan/${l.id}/schedule-report`, { action }, { idempotent: true });
    if (r) setMsg(r.message);
    reload();
  }
  return (
    <section className="surface plan-card" aria-label="Plano de cuidados">
      <h2>Plano de cuidados</h2>
      <p className="small muted">Acesse suas orientações e lembretes. Suas orientações continuam disponíveis; você escolhe como receber os avisos.</p>
      {!l ? <p className="muted">Nenhum lembrete disponível.</p> : (
        <div className="last-reminder">
          <span className="chip-label">Último lembrete</span>
          <h3 className="h4">{l.title}</h3>
          <p className="small muted mb0">Disponibilizado em {dayTime(l.releasedAt && l.releasedAt > l.dueAt ? l.dueAt : l.dueAt)}</p>
          {l.status === 'ATIVO' && l.kind !== 'AGENDAR' && (<>
            {l.askFollowup && (
              <div className="row small mt" role="radiogroup" aria-label={`Como você está? ${l.title}`}>
                {[['MELHOROU', 'Melhorou'], ['IGUAL', 'Igual'], ['PIOROU', 'Piorou']].map(([k, t]) => (
                  <label key={k} className="choice"><input type="radio" name="ans-latest" checked={answer === k} onChange={() => setAnswer(k)} /><span>{t}</span></label>
                ))}
              </div>
            )}
            <Button className="deep wide mt" busy={act.busy} disabled={l.askFollowup && !answer} onClick={ack}>{act.busy ? 'Confirmando…' : 'Ciente'}</Button>
          </>)}
          {l.status === 'ATIVO' && l.kind === 'AGENDAR' && (
            <div className="row mt">
              <Button className="deep" busy={act.busy} onClick={() => schedule('JA_AGENDEI')}>Já agendei</Button>
              <Button className="secondary" busy={act.busy} onClick={() => schedule('PRECISO_AJUDA')}>Preciso de ajuda para agendar</Button>
            </div>
          )}
          {l.status !== 'ATIVO' && <div className="status-pill mt">{l.ackedAt ? `Ciente em ${dayTime(l.ackedAt)}` : l.occurrenceText}</div>}
          {l.status !== 'ATIVO' && l.ackedAt && l.occurrenceText !== 'Ciente registrado' && <p className="small muted mb0">{l.occurrenceText}</p>}
          {st && <p className="small mt mb0">{st.nextAt ? `Próximo aviso: ${dayTime(st.nextAt)}` : st.flag.text}</p>}
          {st && st.flag.code !== 'ATIVO' && st.nextAt && <p className="small muted mb0">{st.flag.text}</p>}
          {st && <button type="button" className="btn secondary wide mt" onClick={() => setPanel({ adjust: st.seriesId })}>Ajustar lembretes</button>}
          <Alert error={act.error} success={msg} />
        </div>
      )}
      {data.pendingActions > 1 && <p className="small mt mb0">Você tem {data.pendingActions} lembretes aguardando ciência (veja em "Ver todas as orientações").</p>}
      <div className="stack mt">
        <button type="button" className="btn secondary wide link-btn" onClick={() => setPanel('history')}>Ver histórico de lembretes ›</button>
        <button type="button" className="btn ghost wide link-btn" onClick={() => setPanel('all')}>Ver todas as orientações ›</button>
      </div>
      <p className="small muted mt mb0">{data.notice}</p>
      <Panel open={panel === 'history'} title="Histórico de lembretes" onClose={() => setPanel(null)}><ReminderHistory series={data.series} /></Panel>
      <Panel open={panel === 'all'} title="Orientações do plano" onClose={() => setPanel(null)}>
        <AllOrientations data={data} onAdjust={(id) => setPanel({ adjust: id })} onChange={reload} />
      </Panel>
      {panel && typeof panel === 'object' && (
        <Panel open title="Ajustar lembretes" onClose={() => setPanel(null)}>
          <AdjustReminders state={data.series.find((x: any) => x.seriesId === panel.adjust)} onDone={() => { setPanel(null); reload(); }} />
        </Panel>
      )}
    </section>
  );
}

const dayTime = (iso: string) => { const d = new Date(iso); return `${d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })} às ${d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })}`; };

/** Histórico em painel próprio: filtros por orientação e período, 10 por página ("Carregar mais"). */
function ReminderHistory({ series }: { series: any[] }) {
  const [seriesId, setSeriesId] = useState('');
  const [days, setDays] = useState(30);
  const [pages, setPages] = useState<any[][]>([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  async function load(page: number, reset = false) {
    setBusy(true);
    try {
      const q = new URLSearchParams({ days: String(days), page: String(page) }); if (seriesId) q.set('seriesId', seriesId);
      const r = await api<any>('GET', `/api/carteira/reminders/history?${q}`);
      setPages((p) => (reset ? [r.items] : [...p, r.items])); setMore(r.hasMore);
    } finally { setBusy(false); }
  }
  useEffect(() => { void load(1, true); }, [seriesId, days]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = pages.flat();
  return (<>
    <div className="row">
      <label className="field"><span className="small">Orientação</span>
        <select value={seriesId} onChange={(e) => setSeriesId(e.target.value)}><option value="">Todas</option>{series.map((x) => <option key={x.seriesId} value={x.seriesId}>{x.title}</option>)}</select></label>
      <label className="field"><span className="small">Período</span>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={30}>Últimos 30 dias</option><option value={90}>Últimos 90 dias</option><option value={365}>Último ano</option></select></label>
    </div>
    {!items.length && !busy ? <p className="muted">Nenhum lembrete neste período.</p> : (
      <ul className="list history-list">{items.map((i) => (
        <li key={i.id}><div className="small muted">{i.atText}</div><strong>{i.title}</strong><div className="small">{i.text}</div></li>
      ))}</ul>
    )}
    {more && <Button className="secondary wide" busy={busy} onClick={() => load(pages.length + 1)}>Carregar mais</Button>}
  </>);
}

/** Todas as orientações do plano vigente (separadas do histórico de avisos), com o estado dos avisos de cada uma. */
function AllOrientations({ data, onAdjust, onChange }: { data: any; onAdjust: (seriesId: string) => void; onChange: () => void }) {
  const act = useSubmit<any>();
  const [msg, setMsg] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Record<string, string>>({});
  const openBySeries = new Map<string, any>();
  for (const i of data.items) if (i.status === 'ATIVO' && i.releasedAt) openBySeries.set(i.seriesId, i);
  return (<>
    {!data.series.length ? <p className="muted">Nenhuma orientação no plano.</p> : (
      <ul className="list">{data.series.map((x: any) => {
        const open = openBySeries.get(x.seriesId);
        return (
          <li key={x.seriesId}>
            <div className="row between"><strong>{x.title}</strong><Badge tone={['DESATIVADO', 'PAUSADO', 'SUSPENSO'].includes(x.flag.code) ? 'orange' : ['ENCERRADO', 'ENCERRADA'].includes(x.flag.code) ? 'dark' : ''}>{x.kindLabel}</Badge></div>
            <p className="small mb0 pre-wrap">{x.instructions}</p>
            {x.careFrequency && <p className="small muted mb0">Frequência do cuidado: {x.careFrequency}</p>}
            <p className="small mb0"><strong>{x.flag.text}</strong>{x.nextAt ? ` · próximo aviso: ${dayTime(x.nextAt)}` : ''}</p>
            {x.reviewOpen && <p className="small muted mb0">Pedido de revisão registrado em {dayTime(x.reviewOpen.at)}.</p>}
            {open && x.kind !== 'AGENDAR' && (
              <div className="mt">
                {open.askFollowup && <div className="row small" role="radiogroup" aria-label={`Como você está? ${x.title}`}>
                  {[['MELHOROU', 'Melhorou'], ['IGUAL', 'Igual'], ['PIOROU', 'Piorou']].map(([k, t]) => (
                    <label key={k} className="choice"><input type="radio" name={`ans-${open.id}`} checked={answer[open.id] === k} onChange={() => setAnswer({ ...answer, [open.id]: k })} /><span>{t}</span></label>))}
                </div>}
                <Button className="sm deep" busy={act.busy} disabled={open.askFollowup && !answer[open.id]}
                  onClick={async () => { await act.run('POST', `/api/carteira/plan/${open.id}/ack`, answer[open.id] ? { answer: answer[open.id] } : {}, { idempotent: true }); onChange(); }}>Ciente</Button>
              </div>
            )}
            <div className="row mt">
              {['ATIVO', 'ESPACADO', 'PAUSADO', 'DESATIVADO', 'SUSPENSO'].includes(x.flag.code) && <button type="button" className="btn sm secondary" onClick={() => onAdjust(x.seriesId)}>Ajustar lembretes</button>}
              {['ATIVO', 'ESPACADO'].includes(x.flag.code) && <button type="button" className="btn sm ghost" onClick={() => onAdjust(x.seriesId)}>Já estou seguindo</button>}
              {!x.reviewOpen && !['ENCERRADA'].includes(x.flag.code) && <Button className="sm ghost" busy={act.busy}
                onClick={async () => { const r = await act.run('POST', `/api/carteira/series/${x.seriesId}/review-request`, {}, { idempotent: true }); if (r) setMsg(r.message); onChange(); }}>Acredito que não preciso mais</Button>}
            </div>
          </li>
        );
      })}</ul>
    )}
    <Alert error={act.error} success={msg} />
  </>);
}

/** "Ajustar lembretes": altera os avisos, não a orientação. Campos condicionais por opção. */
function AdjustReminders({ state, onDone }: { state: any; onDone: () => void }) {
  const save = useSubmit<any>();
  const cur = state?.pref?.mode ?? 'ATIVO';
  const [opt, setOpt] = useState<'MANTER' | 'ESPACADO' | 'PAUSADO' | 'DESATIVADO' | 'ATIVO'>(cur === 'ATIVO' ? 'MANTER' : 'ATIVO');
  const [interval, setInterval] = useState<number>(state?.spacingOptions?.[0] ?? 5);
  const [until, setUntil] = useState('');
  const [confirmOff, setConfirmOff] = useState(false);
  if (!state) return null;
  const horario = state.kind === 'HORARIO';
  async function submit() {
    if (opt === 'MANTER') { onDone(); return; }
    const body: any = { mode: opt };
    if (opt === 'ESPACADO') body.intervalDays = interval;
    if (opt === 'PAUSADO') body.pausedUntil = until;
    if (await save.run('PUT', `/api/carteira/series/${state.seriesId}/prefs`, body, { idempotent: true })) onDone();
  }
  return (<>
    <h3 className="h4">{state.title}</h3>
    <p className="small muted">Você está alterando os avisos, não a orientação de Enfermagem.</p>
    <p className="small"><strong>{state.flag.text}</strong></p>
    <fieldset className="radio-list">
      <legend className="sr-only">Opções de aviso</legend>
      {cur === 'ATIVO' ? <label className="choice"><input type="radio" checked={opt === 'MANTER'} onChange={() => setOpt('MANTER')} /><span>Manter frequência atual</span></label>
        : <label className="choice"><input type="radio" checked={opt === 'ATIVO'} onChange={() => setOpt('ATIVO')} /><span>{cur === 'DESATIVADO' ? 'Reativar avisos' : 'Reativar agora (frequência original)'}</span></label>}
      {!horario && state.spacingOptions.length > 0 && <label className="choice"><input type="radio" checked={opt === 'ESPACADO'} onChange={() => setOpt('ESPACADO')} /><span>Receber com menos frequência</span></label>}
      {state.originalIntervalDays && <label className="choice"><input type="radio" checked={opt === 'PAUSADO'} onChange={() => setOpt('PAUSADO')} /><span>Pausar até uma data</span></label>}
      {cur !== 'DESATIVADO' && <label className="choice"><input type="radio" checked={opt === 'DESATIVADO'} onChange={() => setOpt('DESATIVADO')} /><span>Desativar avisos desta orientação</span></label>}
    </fieldset>
    {horario && <p className="small muted">Este cuidado tem horário específico: os avisos não podem ser espaçados. Você pode desativá-los; a orientação continua valendo e a Enfermagem verá sua preferência.</p>}
    {opt === 'ESPACADO' && (
      <Field label="Frequência dos avisos">
        <select value={interval} onChange={(e) => setInterval(Number(e.target.value))}>{state.spacingOptions.map((d: number) => <option key={d} value={d}>A cada {d} dias</option>)}</select>
      </Field>
    )}
    {opt === 'PAUSADO' && <Field label="Retomar os avisos em"><input type="date" value={until} min={new Date(Date.now() + 86400_000).toLocaleDateString('en-CA')} onChange={(e) => setUntil(e.target.value)} /></Field>}
    {opt === 'DESATIVADO' && <label className="choice mandatory"><input type="checkbox" checked={confirmOff} onChange={(e) => setConfirmOff(e.target.checked)} /><span>Entendi: não vou mais receber avisos desta orientação. A orientação continua valendo e posso reativar quando quiser.</span></label>}
    <Alert error={save.error} />
    <div className="row mt">
      <Button className="deep" busy={save.busy} disabled={(opt === 'PAUSADO' && !until) || (opt === 'DESATIVADO' && !confirmOff)} onClick={submit}>Salvar preferências</Button>
      <button type="button" className="btn secondary" onClick={onDone}>Cancelar</button>
    </div>
  </>);
}

/** Enfermeira: orientação e programação de avisos a partir do atendimento com evolução assinada. */
export function CarePlanEditor({ eventId }: { eventId: string }) {
  const { data, reload } = useApi<any>(`/api/carteira/events/${eventId}/plan`);
  const save = useSubmit<any>();
  const [f, setF] = useState({ title: '', instructions: '', kind: 'GERAL', careFrequency: '', dueAt: localInput(), recurrenceDays: '', until: '', untilKind: 'ENCERRAMENTO', askFollowup: false });
  const [ok, setOk] = useState<string | null>(null);
  async function add() {
    setOk(null);
    const r = await save.run('POST', `/api/carteira/events/${eventId}/plan`, { items: [{ title: f.title, instructions: f.instructions, kind: f.kind, careFrequency: f.careFrequency || undefined,
      dueAt: new Date(f.dueAt).toISOString(), recurrenceDays: f.recurrenceDays ? Number(f.recurrenceDays) : null, askFollowup: f.kind !== 'AGENDAR' && f.askFollowup,
      remindersUntil: f.until ? new Date(`${f.until}T23:59:00-03:00`).toISOString() : undefined, untilKind: f.untilKind }] });
    if (r) { setOk(r.message); setF({ ...f, title: '', instructions: '', careFrequency: '' }); reload(); }
  }
  return (
    <section className="flow-card mt" aria-label="Plano de cuidados">
      <h2>Orientação e programação de avisos</h2>
      <p className="small muted">Orientações de continuidade para o paciente, com base na evolução registrada por você. Os avisos não têm informação clínica; o paciente registra ciência e pode espaçar, pausar ou desativar os avisos (a orientação continua valendo).</p>
      {data?.series?.length > 0 && <ul className="list small">{data.series.map((x: any) => (
        <li key={x.seriesId}><strong>{x.title}</strong> · {x.kindLabel} · {x.flag.text}{x.pref.updatedAt ? ` (alterado em ${dateTime(x.pref.updatedAt)})` : ''}{x.reviewOpen ? ' · pedido de revisão aberto' : ''}</li>
      ))}</ul>}
      <div className="form-grid">
        <Field label="Título da orientação"><input value={f.title} maxLength={120} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Ex.: Caminhada e Exercícios" /></Field>
        <Field label="Tipo"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          <option value="GERAL">Orientação geral</option><option value="AGENDAR">Ação de agendar</option><option value="HORARIO">Horário específico</option></select></Field>
        <Field label="Frequência do cuidado"><input value={f.careFrequency} maxLength={200} onChange={(e) => setF({ ...f, careFrequency: e.target.value })} placeholder="Ex.: diariamente, pela manhã" /></Field>
        <Field label="Início e horário dos avisos"><input type="datetime-local" value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} /></Field>
        <Field label="Frequência inicial dos avisos (dias)"><input type="number" min={1} max={90} value={f.recurrenceDays} onChange={(e) => setF({ ...f, recurrenceDays: e.target.value })} placeholder="Vazio = aviso único" /></Field>
        <Field label="Encerrar ou revisar em (obrigatório)"><input type="date" value={f.until} onChange={(e) => setF({ ...f, until: e.target.value })} /></Field>
        <Field label="Na data"><select value={f.untilKind} onChange={(e) => setF({ ...f, untilKind: e.target.value })}><option value="ENCERRAMENTO">Encerrar os avisos</option><option value="REVISAO">Revisar a programação</option></select></Field>
      </div>
      <Field label="Orientação ao paciente"><textarea rows={2} value={f.instructions} maxLength={2000} onChange={(e) => setF({ ...f, instructions: e.target.value })} /></Field>
      {f.kind !== 'AGENDAR' && <label className="choice"><input type="checkbox" checked={f.askFollowup} onChange={(e) => setF({ ...f, askFollowup: e.target.checked })} /><span>Perguntar ao paciente como ele está (Melhorou / Igual / Piorou)</span></label>}
      <Alert error={save.error} success={ok} />
      <Button className="sm deep" busy={save.busy} disabled={!f.until} onClick={add}>Salvar programação</Button>
    </section>
  );
}

function AlertActions({ a, onDone }: { a: any; onDone: () => void }) {
  const act = useSubmit<any>();
  const [note, setNote] = useState('');
  const go = async (to: string) => { if (await act.run('POST', `/api/carteira/alerts/${a.id}/transition`, { to, rev: a.rev, note: note || undefined })) { setNote(''); onDone(); } };
  return (
    <div className="mt">
      <div className="row">
        {a.status === 'PENDENTE' && <Button className="sm secondary" busy={act.busy} onClick={() => go('RECONHECIDO')}>Reconhecer</Button>}
        {['PENDENTE', 'RECONHECIDO'].includes(a.status) && <Button className="sm secondary" busy={act.busy} onClick={() => go('EM_TRATAMENTO')}>Em tratamento</Button>}
      </div>
      <Field label="Providência / justificativa"><input value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} /></Field>
      <div className="row"><Button className="sm deep" busy={act.busy} onClick={() => go('RESOLVIDO')}>Resolver</Button><button type="button" className="btn sm secondary" onClick={() => go('ENCERRADO')}>Encerrar</button></div>
      <Alert error={act.error} />
    </div>
  );
}

/** Enfermeira: pendências atribuídas. */
export function SpecialistAlertsSection() {
  const { data, error, loading, reload } = useApi<any>('/api/carteira/specialist/alerts');
  if (loading && !data) return null;
  if (error || !data.alerts.length) return null;
  return (
    <section className="flow-card mt" aria-label="Pendências da Carteira">
      <h2>Pendências da Carteira <Badge tone="orange">{data.alerts.length}</Badge></h2>
      <ul className="list">{data.alerts.map((a: any) => (
        <li key={a.id}><div className="row between"><strong>{a.title}</strong><span><Badge tone={PRI[a.priority]}>{a.priority}</Badge> <Badge tone="dark">{a.statusLabel}</Badge></span></div>
          <div className="small">{a.message}</div><div className="small muted">{a.patientName} · {dateTime(a.createdAt)}{a.actionDueAt ? ` · agir até ${dateTime(a.actionDueAt)}` : ''}</div>
          <AlertActions a={a} onDone={reload} /></li>
      ))}</ul>
    </section>
  );
}

/** RT / Central: fila priorizada, atribuição, auditoria e matriz de regras. */
const REVIEW_KIND: Record<string, string> = { PEDIDO_PACIENTE: 'Paciente acredita que não precisa mais', PARAMETRIZACAO: 'Programação sem término/revisão (parametrizar)',
  REVISAO_PROGRAMADA: 'Data de revisão da programação atingida', AJUDA_AGENDAR: 'Paciente pediu ajuda para agendar' };

/** Pendências do plano de cuidados: pedidos de revisão, ajuda para agendar e programações a parametrizar (RT/Central). */
function PlanReviewsSection() {
  const { data, reload } = useApi<any>('/api/admin/carteira/reviews');
  const act = useSubmit<any>();
  const [sel, setSel] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [until, setUntil] = useState('');
  const [kind, setKind] = useState('ENCERRAMENTO');
  if (!data?.reviews?.length) return null;
  return (
    <section className="surface mt">
      <h2>Pendências do plano de cuidados ({data.reviews.length})</h2>
      <p className="small muted">Não encerram orientações automaticamente. Programações sem término não enviam novos avisos até a parametrização (sem prazo inventado).</p>
      <ul className="list">{data.reviews.map((r: any) => (
        <li key={r.id}>
          <div className="row between"><strong>{r.title}</strong><Badge tone="orange">{REVIEW_KIND[r.kind] ?? r.kind}</Badge></div>
          <div className="small muted">{r.patientName} · {dateTime(r.createdAt)} · avisos: {r.state.flag.text}</div>
          {r.note && <div className="small">{r.note}</div>}
          {sel === r.id ? (
            <div className="mt">
              {['PARAMETRIZACAO', 'REVISAO_PROGRAMADA'].includes(r.kind) ? (
                <div className="row">
                  <label className="field"><span className="small">Encerrar ou revisar em</span><input type="date" value={until} onChange={(e) => setUntil(e.target.value)} /></label>
                  <label className="field"><span className="small">Na data</span><select value={kind} onChange={(e) => setKind(e.target.value)}><option value="ENCERRAMENTO">Encerrar</option><option value="REVISAO">Revisar</option></select></label>
                  <Button className="sm deep" busy={act.busy} disabled={!until} onClick={async () => { if (await act.run('PUT', `/api/carteira/series/${r.seriesId}/schedule`, { remindersUntil: new Date(`${until}T23:59:00-03:00`).toISOString(), untilKind: kind })) { setSel(null); reload(); } }}>Salvar programação</Button>
                </div>
              ) : (
                <div className="row">
                  <label className="field"><span className="small">Providência</span><input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></label>
                  <Button className="sm deep" busy={act.busy} onClick={async () => { if (await act.run('POST', `/api/admin/carteira/reviews/${r.id}/resolve`, { resolution: note })) { setSel(null); setNote(''); reload(); } }}>Resolver</Button>
                </div>
              )}
              <Alert error={act.error} />
            </div>
          ) : <button type="button" className="btn sm secondary mt" onClick={() => setSel(r.id)}>Tratar</button>}
        </li>
      ))}</ul>
    </section>
  );
}

export function AdminCarteiraPage() {
  const { has } = useAuth();
  const [filter, setFilter] = useState<'ABERTOS' | 'TODOS'>('ABERTOS');
  const { data, error, loading, reload } = useApi<any>(`/api/admin/carteira/alerts?status=${filter}`);
  const rules = useApi<any>('/api/admin/carteira/rules');
  const act = useSubmit<any>();
  const [sel, setSel] = useState<string | null>(null);
  const [trail, setTrail] = useState<any[] | null>(null);
  const [assign, setAssign] = useState('');
  const [ruleNote, setRuleNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const refresh = () => { reload(); rules.reload(); };
  return (
    <>
      <PageHeader kicker="RT · Central" title="Alertas da Carteira" />
      <div className="callout caution small"><strong>Homologação.</strong> Regras fictícias, sem limiares clínicos reais. Alertas clínicos só disparam com regra completa e aprovada pelo RT; o app não substitui atendimento de urgência.</div>
      <div className="stats mt"><div><strong>{data.alerts.filter((a: any) => a.status === 'PENDENTE').length}</strong><span>pendentes</span></div><div><strong>{data.overdue}</strong><span>com prazo de ação vencido</span></div>
        <div><strong>{data.alerts.filter((a: any) => a.escalationLevel > 0).length}</strong><span>escalonados</span></div></div>
      <div className="row mt">
        <nav className="pills" aria-label="Filtro">{(['ABERTOS', 'TODOS'] as const).map((q) => <button key={q} type="button" className={filter === q ? 'active' : ''} onClick={() => setFilter(q)}>{q === 'ABERTOS' ? 'Abertos' : 'Todos'}</button>)}</nav>
        <Button className="sm secondary" busy={act.busy} onClick={async () => { const r = await act.run('POST', '/api/admin/carteira/run'); if (r) { setMsg(`Motor executado: ${r.reminders} lembrete(s), ${r.overdue} atraso(s), ${r.escalated} escalonamento(s).`); refresh(); } }}>Executar motor agora</Button>
      </div>
      <Alert error={act.error} success={msg} />
      <PlanReviewsSection />
      {!data.alerts.length ? <Empty title="Nenhum alerta nesta fila." /> : (
        <ul className="list">{data.alerts.map((a: any) => (
          <li key={a.id}>
            <div className="row between"><button type="button" className="linklike" onClick={() => { setSel(sel === a.id ? null : a.id); setTrail(null); }}><strong>{a.title}</strong></button>
              <span><Badge tone={PRI[a.priority]}>{a.priority}</Badge> <Badge tone="blue">{CAT[a.category]}</Badge> <Badge tone="dark">{a.statusLabel}</Badge></span></div>
            <div className="small muted">{a.rule} · para {a.recipient}{a.escalationLevel ? ' (escalonado)' : ''} · {a.patientName ?? 'sem paciente'} · {a.assignedTo ? `com ${a.assignedTo}` : 'na fila'} · {dateTime(a.createdAt)}</div>
            {sel === a.id && (
              <div className="mt">
                <div className="small">{a.message}</div>
                {a.resolutionNote && <div className="small">Providência: {a.resolutionNote}</div>}
                {['PENDENTE', 'RECONHECIDO', 'EM_TRATAMENTO'].includes(a.status) && (<>
                  <div className="row mt"><input type="email" placeholder="e-mail do responsável (vazio = fila)" value={assign} onChange={(e) => setAssign(e.target.value)} />
                    <Button className="sm secondary" busy={act.busy} onClick={async () => { if (await act.run('POST', `/api/admin/carteira/alerts/${a.id}/assign`, { email: assign.trim() || null, rev: a.rev })) { setAssign(''); reload(); } }}>Atribuir</Button></div>
                  <AlertActions a={a} onDone={reload} />
                </>)}
                <button type="button" className="linklike small mt" onClick={async () => { const r = await act.run('GET', `/api/carteira/alerts/${a.id}/events`); if (r) setTrail(r.events); }}>Ver trilha</button>
                {trail && <ul className="small">{trail.map((t, i) => <li key={i}>{dateTime(t.created_at)} · {t.action}{t.channel ? ` (${t.channel})` : ''} · {t.actor ?? 'Sistema'}{t.note ? ` — ${t.note}` : ''}</li>)}</ul>}
              </div>
            )}
          </li>
        ))}</ul>
      )}
      <h2 className="mt">Matriz de regras</h2>
      {rules.data && (
        <ul className="list">{rules.data.rules.map((r: any) => (
          <li key={`${r.code}@${r.version}`}>
            <div className="row between"><strong>{r.code} v{r.version} · {r.title}</strong><span><Badge tone="blue">{CAT[r.category]}</Badge> <Badge tone={r.status === 'APROVADA' ? '' : 'orange'}>{r.status}</Badge>{r.fictitious && <> <Badge tone="dark">Fictícia</Badge></>}</span></div>
            <div className="small">Gatilho: {r.trigger} · Destinatário: {r.recipient} · Prioridade: {r.priority} · Dono: {r.ownerRole}{r.substituteRole ? ` (substituto ${r.substituteRole})` : ''}</div>
            <div className="small muted">Prazos: ciência {r.ackHours ?? '—'} h, ação {r.actionHours ?? '—'} h · Escalonamento: {r.escalateTo ?? '—'} · Canais: {r.channels.join(', ')} · Deduplicação: {r.dedupe}</div>
            {r.gaps.length > 0 && <div className="small caution">Falta para ativar: {r.gaps.join(', ')}.</div>}
            {has('AVALIADOR_RT') && (
              <div className="row mt"><input placeholder="Justificativa" value={ruleNote} onChange={(e) => setRuleNote(e.target.value)} />
                {r.status !== 'APROVADA' ? <Button className="sm deep" busy={act.busy} onClick={async () => { if (await act.run('POST', `/api/admin/carteira/rules/${r.code}/${r.version}/status`, { status: 'APROVADA', note: ruleNote })) { setRuleNote(''); refresh(); } }}>Aprovar regra</Button>
                  : <Button className="sm secondary" busy={act.busy} onClick={async () => { if (await act.run('POST', `/api/admin/carteira/rules/${r.code}/${r.version}/status`, { status: 'SUSPENSA', note: ruleNote })) { setRuleNote(''); refresh(); } }}>Suspender</Button>}</div>
            )}
          </li>
        ))}</ul>
      )}
    </>
  );
}
