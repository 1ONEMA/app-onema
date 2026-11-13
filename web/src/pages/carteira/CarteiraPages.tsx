/**
 * Carteira Digital — plano de cuidados e alertas (homologação, regras fictícias).
 * Paciente: plano liberado + avisos. Enfermeira: plano a partir do atendimento assinado e pendências. RT/Central: fila e regras.
 */
import { useState } from 'react';
import { useApi, useSubmit } from '../../lib/hooks';
import { dateTime } from '../../lib/format';
import { Alert, Badge, Button, Empty, ErrorState, Field, Loading, PageHeader } from '../../ui/ui';
import { useAuth } from '../../lib/auth';

const PRI: Record<string, string> = { ALTA: 'red', MEDIA: 'orange', BAIXA: 'blue' };
const CAT: Record<string, string> = { LEMBRETE: 'Lembrete', CLINICO: 'Clínico', ADMINISTRATIVO: 'Administrativo', TECNICO: 'Técnico' };

function localInput(d = new Date(Date.now() + 24 * 3600_000)) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Paciente: plano de cuidados e avisos (dentro da Carteira). */
export function PatientPlanSection() {
  const { data, error, loading, reload } = useApi<any>('/api/carteira/plan');
  const act = useSubmit<any>();
  const [answer, setAnswer] = useState<Record<string, string>>({});
  if (loading && !data) return <Loading lines={2} />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const active = data.items.filter((i: any) => i.status === 'ATIVO');
  const done = data.items.filter((i: any) => i.status !== 'ATIVO').slice(0, 10);
  const openAlerts = data.alerts.filter((a: any) => a.status === 'PENDENTE');
  return (
    <section className="surface" aria-label="Plano de cuidados">
      <h2>Plano de cuidados</h2>
      <p className="small muted">Tarefas e orientações registradas pela sua enfermeira depois do atendimento. {data.notice}</p>
      <Alert error={act.error} />
      {openAlerts.length > 0 && (
        <ul className="list">{openAlerts.map((a: any) => (
          <li key={a.id} className="row between"><span><Badge tone="blue">Aviso</Badge> {a.message} <span className="small muted">· {dateTime(a.createdAt)}</span></span>
            <Button className="sm secondary" busy={act.busy} onClick={async () => { if (await act.run('POST', `/api/carteira/alerts/${a.id}/transition`, { to: 'RECONHECIDO', rev: a.rev })) reload(); }}>Ciente</Button></li>
        ))}</ul>
      )}
      {!active.length ? <p className="muted">Nenhuma tarefa pendente no plano.</p> : (
        <ul className="list">{active.map((i: any) => (
          <li key={i.id}>
            <div className="row between"><strong>{i.title}</strong><span className="small">até {dateTime(i.dueAt)}{i.recurrenceDays ? ` · a cada ${i.recurrenceDays} dia(s)` : ''}</span></div>
            <div className="small">{i.instructions}</div>
            <div className="small muted">{i.author} · {i.label}</div>
            {i.askFollowup && (
              <div className="row small mt" role="radiogroup" aria-label={`Como você está? ${i.title}`}>
                {[['MELHOROU', 'Melhorou'], ['IGUAL', 'Igual'], ['PIOROU', 'Piorou']].map(([k, l]) => (
                  <label key={k} className="choice"><input type="radio" name={`ans-${i.id}`} checked={answer[i.id] === k} onChange={() => setAnswer({ ...answer, [i.id]: k })} /><span>{l}</span></label>
                ))}
              </div>
            )}
            <Button className="sm deep mt" busy={act.busy} disabled={i.askFollowup && !answer[i.id]}
              onClick={async () => { if (await act.run('POST', `/api/carteira/plan/${i.id}/done`, answer[i.id] ? { answer: answer[i.id] } : {})) reload(); }}>Marcar como feito</Button>
          </li>
        ))}</ul>
      )}
      {done.length > 0 && <details className="mt"><summary>Concluídas</summary><ul className="small">{done.map((i: any) => <li key={i.id}>{i.title} · {i.status === 'CONCLUIDO' ? `feito em ${dateTime(i.completedAt)}` : 'cancelada'}</li>)}</ul></details>}
    </section>
  );
}

/** Enfermeira: plano de cuidados a partir do atendimento com evolução assinada. */
export function CarePlanEditor({ eventId }: { eventId: string }) {
  const { data, reload } = useApi<any>(`/api/carteira/events/${eventId}/plan`);
  const save = useSubmit<any>();
  const [f, setF] = useState({ title: '', instructions: '', dueAt: localInput(), recurrenceDays: '', askFollowup: false });
  const [ok, setOk] = useState<string | null>(null);
  async function add() {
    const r = await save.run('POST', `/api/carteira/events/${eventId}/plan`, { items: [{ title: f.title, instructions: f.instructions, dueAt: new Date(f.dueAt).toISOString(),
      recurrenceDays: f.recurrenceDays ? Number(f.recurrenceDays) : null, askFollowup: f.askFollowup }] });
    if (r) { setOk('Tarefa incluída no plano do paciente.'); setF({ ...f, title: '', instructions: '' }); reload(); }
  }
  return (
    <section className="flow-card mt" aria-label="Plano de cuidados">
      <h2>Plano de cuidados</h2>
      <p className="small muted">Tarefas de continuidade para o paciente, com base na evolução registrada por você. O paciente recebe lembretes sem informação clínica e confirma na Carteira.</p>
      {data?.items?.length > 0 && <ul className="list small">{data.items.map((i: any) => <li key={i.id}><strong>{i.title}</strong> · {dateTime(i.dueAt)} · {i.status}</li>)}</ul>}
      <div className="form-grid">
        <Field label="Tarefa"><input value={f.title} maxLength={120} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Ex.: Troca do curativo" /></Field>
        <Field label="Quando"><input type="datetime-local" value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} /></Field>
        <Field label="Repetir a cada (dias, opcional)"><input type="number" min={1} max={90} value={f.recurrenceDays} onChange={(e) => setF({ ...f, recurrenceDays: e.target.value })} /></Field>
      </div>
      <Field label="Orientação ao paciente"><textarea rows={2} value={f.instructions} maxLength={2000} onChange={(e) => setF({ ...f, instructions: e.target.value })} /></Field>
      <label className="choice"><input type="checkbox" checked={f.askFollowup} onChange={(e) => setF({ ...f, askFollowup: e.target.checked })} /><span>Perguntar ao paciente como ele está ao concluir</span></label>
      <Alert error={save.error} success={ok} />
      <Button className="sm deep" busy={save.busy} onClick={add}>Incluir no plano</Button>
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
