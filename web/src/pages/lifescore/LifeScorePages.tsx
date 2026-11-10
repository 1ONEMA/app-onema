import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type ApiError } from '../../lib/api';
import { useApi, useSubmit } from '../../lib/hooks';
import { dateTime } from '../../lib/format';
import { Alert, Badge, Button, Empty, ErrorState, Field, Loading, PageHeader, fieldError } from '../../ui/ui';

const CODES = ['L0', 'L1', 'L2', 'L3', 'L4'] as const;
const OTHER: Record<string, string> = { ND: 'Não avaliado', QI: 'Qualidade inadequada', RECUSA: 'Recusado', DESCONHECIDO: 'Desconhecido', NA: 'Não se aplica' };
const SAFETY: Record<string, { label: string; tone: string }> = {
  IMMEDIATE: { label: 'Necessidade imediata registrada pela enfermeira', tone: 'red' }, PRIORITY: { label: 'Prioridade registrada pela enfermeira', tone: 'orange' },
  UNDETERMINED: { label: 'Dados insuficientes para verificar os gatilhos', tone: 'dark' }, NO_ITEM_TRIGGER_IDENTIFIED: { label: 'Nenhum gatilho nos itens (não significa ausência de risco)', tone: 'dark' },
};
const PLAN_STATUS: Record<string, string> = { VIGENTE: 'Previsto', AGENDADO: 'Atendimento solicitado', RECUSADO: 'Você recusou o acompanhamento', SUBSTITUIDO: 'Substituído por avaliação mais recente', ENCERRADO_SEM_RESPOSTA: 'Encerrado', CANCELADO: 'Cancelado' };
const fmtScore = (s: any) => (s == null ? '—' : Number(s).toFixed(2).replace('.', ','));
const fmtDate = (d?: string | null) => (d ? d.split('-').reverse().join('/') : '—');
const addDays = (n: number) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

/** Especialista: 24 itens confirmados, prévia, interpretação, resumo ao paciente e plano; preocupação de segurança à parte. */
export function SpecialistLifeScorePage() {
  const { id } = useParams();
  const base = `/api/care/specialist/events/${id}/lifescore`;
  const st = useApi<any>(base);
  const mdl = useApi<any>('/api/lifescore/model');
  const save = useSubmit<any>(); const prev = useSubmit<any>(); const fin = useSubmit<any>(); const safe = useSubmit<any>();
  const [resp, setResp] = useState<Record<string, { code: string; rationale?: string; naReason?: string }>>({});
  const [rev, setRev] = useState(0);
  const [interp, setInterp] = useState(''); const [summary, setSummary] = useState('');
  const [plan, setPlan] = useState<{ kind: string; date?: string; justification?: string }>({ kind: '' });
  const [preview, setPreview] = useState<any>(null);
  const [confirm, setConfirm] = useState(false);
  const [closeReason, setCloseReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [sf, setSf] = useState({ level: 'PRIORITY', reason: '' });
  useEffect(() => { document.title = 'Life Score · ONEMA SAÚDE'; }, []);
  useEffect(() => {
    const d = st.data?.draft;
    if (d) { setResp(d.responses ?? {}); setRev(d.revision); setInterp(d.interpretation ?? ''); setSummary(d.patientSummary ?? ''); setPlan({ kind: d.plan?.kind ?? '', date: d.plan?.date ?? undefined, justification: d.plan?.justification ?? undefined }); }
  }, [st.data?.draft?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = mdl.data ? mdl.data.domains.reduce((s: number, d: any) => s + d.items.length, 0) : 24;
  const answered = useMemo(() => Object.values(resp).filter((r) => r.code && r.code !== 'ND').length, [resp]);
  if ((st.loading && !st.data) || (mdl.loading && !mdl.data)) return <Loading />;
  if (st.error) return <ErrorState error={st.error} onRetry={st.reload} />;
  if (mdl.error) return <ErrorState error={mdl.error} onRetry={mdl.reload} />;
  const s = st.data, m = mdl.data;
  const set = (item: string, patch: any) => { setResp((r) => ({ ...r, [item]: { ...(r[item] ?? { code: 'ND' }), ...patch } })); setPreview(null); };

  async function doSave(quiet = false) {
    const r = await save.run('PUT', base, { revision: rev, responses: resp, interpretation: interp || undefined, patientSummary: summary || undefined,
      plan: plan.kind ? { kind: plan.kind, date: plan.date ?? null, justification: plan.justification ?? null } : undefined });
    if (r) { setRev(r.revision); if (!quiet) setNotice('Rascunho salvo. Nada foi publicado.'); }
    return r;
  }
  async function doPreview() { setNotice(null); if (await doSave(true)) { const r = await prev.run('POST', `${base}/preview`, {}); if (r) setPreview(r.preview); } }
  async function doFinalize(withoutScore = false) {
    setNotice(null);
    const saved = await doSave(true); if (!saved) return;
    const body: any = { confirm, revision: saved.revision };
    if (withoutScore) body.closeWithoutScore = closeReason;
    else Object.assign(body, { interpretation: interp, patientSummary: summary, plan: plan.kind === 'RETORNO' ? { kind: 'RETORNO', date: plan.date } : plan.kind === 'DEFINIR_DEPOIS' ? { kind: 'DEFINIR_DEPOIS', justification: plan.justification } : plan.kind ? { kind: plan.kind } : undefined });
    const r = await fin.run('POST', `${base}/finalize`, body);
    if (r) { setNotice(r.status === 'PUBLICADA' ? 'Avaliação publicada. O paciente já vê o resultado em Meu acompanhamento.' : 'Avaliação encerrada sem score.'); setPreview(null); setConfirm(false); st.reload(); }
  }
  async function doSafety() { const r = await safe.run('POST', `/api/care/specialist/events/${id}/safety-events`, sf); if (r) { setSf({ ...sf, reason: '' }); st.reload(); } }

  return (
    <div className="flow">
      <PageHeader kicker="Atendimento" title="Life Score" back={{ to: `/especialista/atendimentos/${id}`, label: 'Voltar ao atendimento' }}>
        <p className="small">{m.disclaimer} Modelo {m.modelId}. {s.environment === 'HOMOLOGACAO' ? 'Paciente fictício: ambiente de homologação.' : s.releaseActive ? 'Liberação operacional ativa.' : 'Registros reais calculam só depois da liberação operacional do RT.'}</p>
      </PageHeader>
      {s.calcSuspended && <div className="caution" role="status">O Life Score está suspenso pelo RT. O atendimento, a evolução e o registro de preocupação de segurança seguem normalmente.</div>}

      <section className="flow-card">
        <h2>Preocupação de segurança</h2>
        <p className="small muted">Registre a qualquer momento. Fica salva mesmo sem completar o formulário e avisa a Central. Não espere o score para agir.</p>
        {s.safetyEvents.map((x: any) => <div key={x.id} className={x.level === 'IMMEDIATE' ? 'danger small' : 'caution small'}>{x.level === 'IMMEDIATE' ? 'Imediata' : 'Prioritária'} · {dateTime(x.occurred_at)} · {x.reason}</div>)}
        <div className="form-grid">
          <Field label="Nível"><select value={sf.level} onChange={(e) => setSf({ ...sf, level: e.target.value })}><option value="PRIORITY">Prioridade</option><option value="IMMEDIATE">Ação imediata</option></select></Field>
          <Field label="O que preocupa" error={fieldError(safe.error, 'reason')}><input type="text" value={sf.reason} maxLength={1000} onChange={(e) => setSf({ ...sf, reason: e.target.value })} /></Field>
        </div>
        <Alert error={safe.error && !Array.isArray(safe.error.details) ? safe.error : null} />
        <Button className="sm secondary" busy={safe.busy} disabled={sf.reason.trim().length < 5} onClick={doSafety}>Registrar preocupação</Button>
      </section>

      {s.published && !s.draft && (
        <div className="success mt" role="status">Avaliação deste atendimento {s.published.status === 'PUBLICADA' ? `publicada: ${fmtScore(s.published.score_display)}` : 'encerrada sem score'} em {dateTime(s.published.published_at)}.
          {s.published.status === 'PUBLICADA' && <> <button type="button" className="linklike" onClick={async () => { const reason = window.prompt('Motivo da retificação (fica no histórico):'); if (reason) { try { await api('POST', `/api/lifescore/assessments/${s.published.id}/rectify`, { reason }); st.reload(); } catch (e) { setNotice((e as ApiError).message); } } }}>Retificar</button></>}</div>
      )}

      {s.evolution && (
        <details className="flow-card mt"><summary><strong>Evolução deste atendimento (fonte de consulta)</strong></summary>
          <p className="small muted">Use como origem dos dados. As respostas abaixo são confirmadas por você; nada é preenchido automaticamente.</p>
          <dl className="kv small">{Object.entries<any>(s.evolution.content).filter(([k, v]) => k !== 'pendencias' && v).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl>
        </details>
      )}

      {s.history.length > 0 && (
        <details className="flow-card mt"><summary><strong>Histórico publicado deste paciente ({s.history.length})</strong></summary>
          <ul className="list small">{s.history.map((h: any) => <li key={h.id}>{dateTime(h.publishedAt)} · {fmtScore(h.score)} · {h.specialist}{h.status === 'RETIFICADA' ? ' · retificada' : ''}</li>)}</ul>
        </details>
      )}

      {!s.calcSuspended && ['ACEITO', 'CONCLUIDO'].includes(s.eventStatus) && (s.draft || !s.published) && (
        <>
          <section className="flow-card mt">
            <h2>Itens da avaliação <span className="small muted">({answered}/{total} respondidos)</span></h2>
            <p className="small muted">Para cada item, leia as descrições e escolha o nível que corresponde ao que você avaliou. Use “Não avaliado” quando não foi possível avaliar; “Não se aplica” só onde o modelo permite, com justificativa.</p>
            {m.domains.map((d: any) => (
              <fieldset key={d.code} className="ls-domain">
                <legend><strong>{d.code} · {d.name}</strong> <span className="small muted">mínimo {d.min} itens aplicáveis</span></legend>
                {d.items.map((it: any) => {
                  const r = resp[it.id] ?? { code: 'ND' };
                  return (
                    <div key={it.id} className="ls-item">
                      <div><strong>{it.id} · {it.name}</strong><div className="small">{it.question}</div></div>
                      <div className="ls-anchors" role="radiogroup" aria-label={it.name}>
                        {CODES.map((c) => (
                          <label key={c} className={`ls-anchor ${r.code === c ? 'on' : ''}`}>
                            <input type="radio" name={it.id} checked={r.code === c} onChange={() => set(it.id, { code: c })} />
                            <span><strong>{c}</strong> {it.anchors[c].description}</span>
                          </label>
                        ))}
                      </div>
                      <div className="row small">
                        <select aria-label={`Outra situação para ${it.id}`} value={CODES.includes(r.code as any) ? '' : r.code} onChange={(e) => set(it.id, { code: e.target.value || 'ND' })}>
                          <option value="">Outra situação…</option>
                          {Object.entries(OTHER).filter(([k]) => k !== 'NA' || it.allowNa).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                        </select>
                        <input type="text" placeholder="Fundamento (opcional)" value={r.rationale ?? ''} maxLength={500} onChange={(e) => set(it.id, { rationale: e.target.value })} />
                      </div>
                      {r.code === 'NA' && <Field label={`Justificativa do "não se aplica"${it.naCondition ? ` (${it.naCondition})` : ''}`}><input type="text" value={r.naReason ?? ''} maxLength={300} onChange={(e) => set(it.id, { naReason: e.target.value })} /></Field>}
                    </div>
                  );
                })}
              </fieldset>
            ))}
            <Alert error={save.error && !Array.isArray(save.error.details) ? save.error : null} success={notice} />
            <div className="row"><Button className="secondary" busy={save.busy} onClick={() => doSave()}>Salvar rascunho</Button><Button className="deep" busy={prev.busy || save.busy} onClick={doPreview}>Ver prévia</Button></div>
          </section>

          {preview && (
            <section className="flow-card mt" aria-live="polite">
              <h2>Prévia (não publicada)</h2>
              {preview.safety.level && SAFETY[preview.safety.level] && <div className={preview.safety.level === 'IMMEDIATE' ? 'danger' : preview.safety.level === 'PRIORITY' ? 'caution' : 'small muted'}>{SAFETY[preview.safety.level].label}</div>}
              {preview.calculable ? (
                <>
                  <p className="ls-score">{fmtScore(preview.score)}</p>
                  <ul className="list small">{preview.domains.map((d: any) => <li key={d.code}>{d.code} · {d.name}: {fmtScore(d.score)}</li>)}</ul>
                </>
              ) : (
                <><p><strong>Não calculável.</strong> Revise:</p><ul className="small">{preview.issues.slice(0, 30).map((i: any, k: number) => <li key={k}>{i.label}{i.item_id ? ` (${i.item_id})` : i.domain ? ` (${i.domain})` : ''}</li>)}</ul></>
              )}
              <p className="small muted">{preview.disclaimer}</p>
            </section>
          )}

          <section className="flow-card mt">
            <h2>Interpretação, resumo e plano</h2>
            <Field label="Sua interpretação profissional (Central/RT e histórico)" error={fieldError(fin.error, 'interpretation')}><textarea rows={3} value={interp} maxLength={2000} onChange={(e) => setInterp(e.target.value)} /></Field>
            <Field label="Resumo para o paciente (revise: é o que ele vai ler)" hint="Linguagem simples, sem números de risco nem promessas." error={fieldError(fin.error, 'patientSummary')}><textarea rows={3} value={summary} maxLength={1500} onChange={(e) => setSummary(e.target.value)} /></Field>
            <fieldset className="checks-grid">
              <legend className="field-legend">Plano de acompanhamento (sua decisão; a nota não escolhe)</legend>
              {[['RETORNO', 'Retorno com data prevista'], ['SEM_RETORNO', 'Sem retorno programado'], ['DEFINIR_DEPOIS', 'Definir depois (com justificativa)']].map(([k, l]) => (
                <label key={k} className="choice"><input type="radio" name="plan" checked={plan.kind === k} onChange={() => setPlan({ kind: k })} /><span>{l}</span></label>
              ))}
            </fieldset>
            {plan.kind === 'RETORNO' && (
              <div className="row">
                {[30, 60, 90].map((n) => <button key={n} type="button" className="btn sm secondary" onClick={() => setPlan({ kind: 'RETORNO', date: addDays(n) })}>{n} dias</button>)}
                <input type="date" aria-label="Data prevista" value={plan.date ?? ''} onChange={(e) => setPlan({ kind: 'RETORNO', date: e.target.value })} />
              </div>
            )}
            {plan.kind === 'DEFINIR_DEPOIS' && <Field label="Justificativa"><input type="text" value={plan.justification ?? ''} maxLength={500} onChange={(e) => setPlan({ ...plan, justification: e.target.value })} /></Field>}
            <label className="choice mandatory mt"><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /><span>Confirmo que revisei as respostas, a interpretação, o resumo e o plano.</span></label>
            <Alert error={fin.error && !Array.isArray(fin.error.details) ? fin.error : null} />
            {Array.isArray(fin.error?.details) && fin.error!.code === 'NOT_CALCULABLE' && <ul className="small">{fin.error!.details.slice(0, 20).map((i: any, k: number) => <li key={k}>{i.label}{i.item_id ? ` (${i.item_id})` : ''}</li>)}</ul>}
            <Button className="green" busy={fin.busy} disabled={!confirm} onClick={() => doFinalize(false)}>Finalizar e publicar</Button>
            <details className="mt"><summary className="small">Encerrar sem score (dados insuficientes)</summary>
              <Field label="Justificativa"><input type="text" value={closeReason} maxLength={500} onChange={(e) => setCloseReason(e.target.value)} /></Field>
              <Button className="sm secondary" busy={fin.busy} disabled={!confirm || closeReason.trim().length < 10} onClick={() => doFinalize(true)}>Encerrar sem score</Button>
            </details>
          </section>
        </>
      )}
    </div>
  );
}

/** Paciente: "Meu acompanhamento" (card na Carteira). */
export function MyFollowupCard() {
  const { data } = useApi<any>('/api/lifescore/me');
  if (!data) return null;
  const l = data.latest;
  return (
    <section className="surface lifescore">
      <h2>Meu acompanhamento</h2>
      {!l ? <p className="mb0 muted">{data.emptyText}</p> : (
        <>
          <p className="mb0"><strong className="ls-score sm">{fmtScore(l.score)}</strong> <span className="small muted">Life Score · avaliação de {dateTime(l.publishedAt)} · {l.specialist}</span></p>
          {l.summary && <p className="mb0">{l.summary}</p>}
          <p className="small muted mb0">{data.disclaimer}</p>
        </>
      )}
      <p className="mb0 mt"><Link to="/acompanhamento">Ver detalhes e histórico</Link></p>
    </section>
  );
}

export function MyFollowupPage() {
  const { data, error, loading, reload } = useApi<any>('/api/lifescore/me');
  const act = useSubmit<any>();
  useEffect(() => { document.title = 'Meu acompanhamento · ONEMA SAÚDE'; }, []);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const l = data.latest;
  async function plan(action: string) { if (await act.run('POST', `/api/lifescore/me/${l.id}/plan`, { action })) reload(); }
  return (
    <div className="flow">
      <PageHeader kicker="Carteira Digital ONEMA" title="Meu acompanhamento" back={{ to: '/carteira', label: 'Carteira' }}>
        <p className="small">{data.disclaimer}</p>
      </PageHeader>
      {!l ? <Empty title={data.emptyText}><Link className="btn green" to="/solicitar">Solicitar atendimento</Link></Empty> : (
        <>
          <section className="flow-card">
            <h2>Avaliação mais recente</h2>
            <p className="ls-score">{fmtScore(l.score)}</p>
            <p className="small muted">Avaliação de {dateTime(l.publishedAt)} por {l.specialist}. O índice resume os itens da avaliação de enfermagem; não é percentual de saúde.</p>
            {l.summary && <p>{l.summary}</p>}
            <h3>Por domínio</h3>
            <ul className="list">{l.domains.map((d: any) => <li key={d.code}><div className="row between"><strong>{d.name}</strong><span>{fmtScore(d.score)}</span></div><div className="small muted">{d.plain}</div></li>)}</ul>
            {l.comparison && <p className="small">{l.comparison.comparable ? `Diferença em relação à avaliação anterior equivalente: ${l.comparison.delta > 0 ? '+' : ''}${fmtScore(l.comparison.delta)}. ` : ''}{l.comparison.note}</p>}
          </section>
          <section className="flow-card mt">
            <h2>Próximo passo</h2>
            {l.plan.kind === 'RETORNO' ? <p>Retorno previsto para <strong>{fmtDate(l.plan.date)}</strong> · {PLAN_STATUS[l.plan.status] ?? l.plan.status}. A data é uma previsão de acompanhamento, não um horário reservado.</p>
              : l.plan.kind === 'DEFINIR_DEPOIS' ? <p>A enfermeira vai definir o próximo passo: {l.plan.justification}</p> : <p>Sem retorno programado.</p>}
            <div className="row"><Link className="btn green" to="/solicitar">Solicitar atendimento</Link></div>
            <p className="small muted mt">{data.primeNote}</p>
            {data.primeActive && l.plan.kind === 'RETORNO' && l.plan.status === 'VIGENTE' && (
              <div className="row small">
                {!l.plan.remindersOptOut && <button type="button" className="linklike" onClick={() => plan('RECUSAR_LEMBRETES')}>Não quero lembretes deste retorno</button>}
                <button type="button" className="linklike" onClick={() => plan('RECUSAR_ACOMPANHAMENTO')}>Não quero este acompanhamento</button>
              </div>
            )}
            <Alert error={act.error} />
          </section>
          <section className="flow-card mt">
            <h2>Histórico</h2>
            <ul className="list">{data.history.map((h: any) => (
              <li key={h.id}><div className="row between"><span>{dateTime(h.publishedAt)} · {h.specialist}</span><span>{fmtScore(h.score)}{h.status === 'RETIFICADA' && <Badge tone="dark"> retificada</Badge>}</span></div>
                {h.comparison && !h.comparison.comparable && <div className="small muted">{h.comparison.note}</div>}</li>
            ))}</ul>
          </section>
        </>
      )}
    </div>
  );
}

/** Central/RT: estados, filtros, preocupações, lembretes, suspensão e liberação. */
export function LifeScoreAdminPage() {
  const [f, setF] = useState({ status: '', q: '', from: '', to: '' });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as any).toString();
  const { data, error, loading, reload } = useApi<any>(`/api/admin/lifescore${qs ? `?${qs}` : ''}`);
  const act = useSubmit<any>();
  const [detail, setDetail] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const rt = data.clinical;
  async function go(url: string, body: any, ok: string) { setMsg(null); if (await act.run('POST', url, body)) { setMsg(ok); reload(); } }
  const ask = (q: string) => { const v = window.prompt(q); return v && v.trim().length >= 5 ? v.trim() : null; };
  const open = data.safety.filter((x: any) => !x.handled_at);
  return (
    <>
      <PageHeader kicker="Central ONEMA" title="Life Score">
        <p className="small">Modelo {data.modelId} · build {data.build}. {data.release ? `Liberação operacional ativa (${data.release.uat} · ${data.release.rt}).` : 'Sem liberação operacional: registros reais não calculam (contas fictícias seguem em homologação).'}
          {data.suspension.calcSuspended && ' Cálculo SUSPENSO.'}{data.suspension.remindersSuspended && ' Lembretes SUSPENSOS.'}</p>
      </PageHeader>
      <Alert error={act.error && !Array.isArray(act.error.details) ? act.error : null} success={msg} />
      {open.length > 0 && (
        <section className="surface">
          <h2>Preocupações de segurança abertas ({open.length})</h2>
          <ul className="list">{open.map((x: any) => (
            <li key={x.id}><div className="row between"><strong>{x.patient} · {x.specialist}</strong><Badge tone={x.level === 'IMMEDIATE' ? 'red' : 'orange'}>{x.level === 'IMMEDIATE' ? 'Imediata' : 'Prioridade'}</Badge></div>
              <div className="small muted">{dateTime(x.occurred_at)}{x.reason ? ` · ${x.reason}` : ''}</div>
              <button type="button" className="linklike small" onClick={() => { const n = ask('O que foi feito?'); if (n) go(`/api/admin/lifescore/safety-events/${x.id}/handled`, { note: n }, 'Registrado.'); }}>Registrar tratamento</button></li>
          ))}</ul>
        </section>
      )}
      <section className="surface">
        <div className="form-grid">
          <Field label="Situação"><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Todas</option><option value="RASCUNHO">Em andamento</option><option value="PUBLICADA">Publicadas</option><option value="RETIFICADA">Retificadas</option><option value="ENCERRADA_SEM_SCORE">Encerradas sem score</option></select></Field>
          <Field label="Paciente ou profissional"><input type="search" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></Field>
          <Field label="De"><input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
          <Field label="Até"><input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
        </div>
        {!data.assessments.length ? <Empty title="Nenhuma avaliação no filtro." /> : (
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Avaliações Life Score"><table>
            <thead><tr><th>Atualizada</th><th>Paciente</th><th>Profissional</th><th>Situação</th>{rt && <th>Índice</th>}<th>Plano</th><th></th></tr></thead>
            <tbody>{data.assessments.map((r: any) => (
              <tr key={r.id}><td>{dateTime(r.updated_at)}</td><td>{r.patient}</td><td>{r.specialist}</td>
                <td>{r.status === 'RASCUNHO' ? 'Em andamento' : r.status.toLowerCase().replace(/_/g, ' ')}{r.stale ? ' · pendente há +24 h' : ''}{r.environment === 'HOMOLOGATION' ? ' · homologação' : ''}</td>
                {rt && <td>{r.score_display ?? '—'}</td>}
                <td>{r.plan_kind === 'RETORNO' ? `${fmtDate(r.plan_date)} · ${(PLAN_STATUS[r.plan_status] ?? r.plan_status ?? '').toLowerCase()}` : r.plan_kind ? r.plan_kind.toLowerCase().replace(/_/g, ' ') : '—'}</td>
                <td>{rt && <button type="button" className="linklike small" onClick={async () => setDetail((await api<any>('GET', `/api/admin/lifescore/assessments/${r.id}`)))}>Abrir</button>}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      {detail && (
        <section className="surface">
          <h2>Avaliação · {detail.assessment.patient}</h2>
          <p className="small muted">{detail.assessment.specialist} · {detail.assessment.status} · modelo {detail.assessment.model_id} · {detail.assessment.environment}</p>
          {detail.assessment.result && <p>Índice: <strong>{fmtScore(detail.assessment.result.score)}</strong> · segurança: {SAFETY[detail.assessment.result.safety.level]?.label}</p>}
          <p className="small"><strong>Interpretação:</strong> {detail.assessment.interpretation ?? '—'}<br /><strong>Resumo ao paciente:</strong> {detail.assessment.patient_summary ?? '—'}</p>
          <details><summary className="small">Respostas ({Object.keys(detail.assessment.responses).length})</summary><ul className="small">{Object.entries<any>(detail.assessment.responses).map(([k, v]) => <li key={k}>{k}: {v.code}{v.rationale ? ` — ${v.rationale}` : ''}{v.naReason ? ` (NA: ${v.naReason})` : ''}</li>)}</ul></details>
          <details><summary className="small">Trilha de auditoria</summary><ul className="small">{detail.trail.map((t: any, i: number) => <li key={i}>{dateTime(t.occurred_at)} · {t.action}</li>)}</ul></details>
          <button type="button" className="linklike small" onClick={() => setDetail(null)}>Fechar</button>
        </section>
      )}
      <section className="surface">
        <h2>Lembretes PRIME</h2>
        {!data.reminders.length ? <p className="muted">Nenhum lembrete programado.</p> : (
          <ul className="list small">{data.reminders.slice(0, 60).map((r: any) => <li key={r.id}>{r.patient} · {r.wave === 0 ? 'D' : r.wave > 0 ? `D+${r.wave}` : `D${r.wave}`} ({fmtDate(r.plan_date)}) · {dateTime(r.scheduled_at)} · <strong>{r.status.toLowerCase().replace(/_/g, ' ')}</strong>{r.status_reason ? ` · ${r.status_reason}` : ''}{r.last_error ? ` · ${r.last_error}` : ''}</li>)}</ul>
        )}
      </section>
      {rt && (
        <section className="surface">
          <h2>Controle do RT</h2>
          <p className="small muted">Suspender não apaga avaliações nem interrompe a assistência. A liberação operacional vale para este modelo e build; fica registrada e pode ser revogada.</p>
          <div className="row">
            <Button className="sm secondary" busy={act.busy} onClick={() => { const r = ask('Justificativa:'); if (r) go('/api/admin/lifescore/suspension', { calc: !data.suspension.calcSuspended, reminders: data.suspension.remindersSuspended, reason: r }, 'Atualizado.'); }}>{data.suspension.calcSuspended ? 'Retomar cálculo' : 'Suspender cálculo'}</Button>
            <Button className="sm secondary" busy={act.busy} onClick={() => { const r = ask('Justificativa:'); if (r) go('/api/admin/lifescore/suspension', { calc: data.suspension.calcSuspended, reminders: !data.suspension.remindersSuspended, reason: r }, 'Atualizado.'); }}>{data.suspension.remindersSuspended ? 'Retomar lembretes' : 'Suspender lembretes'}</Button>
            {data.release
              ? <Button className="sm secondary" busy={act.busy} onClick={() => { const r = ask('Motivo da revogação:'); if (r) go('/api/admin/lifescore/release/revoke', { reason: r }, 'Liberação revogada.'); }}>Revogar liberação</Button>
              : <Button className="sm green" busy={act.busy} onClick={() => { const u = window.prompt('Referência do relatório de homologação (ex.: UAT-LS-2026-11-10):'); const a = u && window.prompt('Referência da aprovação do RT (ex.: ata/assinatura):'); if (u && a) go('/api/admin/lifescore/release', { uatReportRef: u, rtApprovalRef: a, confirm: true }, 'Liberação operacional registrada.'); }}>Registrar liberação operacional</Button>}
          </div>
        </section>
      )}
    </>
  );
}
