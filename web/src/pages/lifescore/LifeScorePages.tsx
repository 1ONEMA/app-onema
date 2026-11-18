import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type ApiError } from '../../lib/api';
import { useApi, useSubmit } from '../../lib/hooks';
import { dateTime } from '../../lib/format';
import { Alert, Badge, Button, Empty, ErrorState, Field, Loading, PageHeader, fieldError } from '../../ui/ui';

const CODES = ['R3', 'R2', 'R1', 'R0'] as const;
const BLOCKING: Record<string, string> = { NAO_AVALIADO: 'Não avaliado', DESCONHECIDO: 'Desconhecido', RECUSA: 'Recusa de informação', QI: 'Informação inadequada' };
const SAFETY_LEVEL: Record<string, string> = { IMMEDIATE: 'Imediata', PRIORITY: 'Prioritária', ROUTINE: 'Rotina' };
const SAFETY_STATUS: Record<string, string> = { ABERTA: 'Aberta', EM_ANDAMENTO: 'Em andamento', RESOLVIDA: 'Resolvida' };
const OBJECTS: [string, string][] = [['MEDICAMENTOS', 'Medicamentos'], ['SONDAS_CATETERES', 'Sondas/cateteres'], ['OXIGENIO', 'Oxigênio'], ['OUTROS_DISPOSITIVOS', 'Outros dispositivos']];
const PLAN_STATUS: Record<string, string> = { VIGENTE: 'Previsto', AGENDADO: 'Você informou que já agendou', SOLICITADO: 'Atendimento solicitado', PAUSADO: 'Lembretes pausados; a equipe vai falar com você', CONTRATADO: 'Atendimento contratado',
  RECUSADO: 'Você informou que não quer retornar agora', SUBSTITUIDO: 'Substituído por avaliação mais recente', ENCERRADO_SEM_RESPOSTA: 'Encerrado', CANCELADO: 'Cancelado' };
const fmtScore = (s: any) => (s == null ? '—' : Number(s).toFixed(2).replace('.', ','));
const fmtDate = (d?: string | null) => (d ? d.split('-').reverse().join('/') : '—');
const addDays = (n: number) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

/** Legenda de consulta (somente telas profissionais: especialista e RT). Recolhível, fechada por padrão. */
export function LifeScoreLegend({ m }: { m: any }) {
  if (!m) return null;
  return (
    <details className="ls-legend">
      <summary>Consultar legenda dos domínios e itens</summary>
      <p className="small">C, A, S e K identificam os quatro domínios; C1, C2 etc. são os oito itens.</p>
      <div className="ls-legend-grid">{m.domains.map((d: any) => (
        <div key={d.code}><strong>{d.name} — {d.code}</strong>
          <ul>{d.items.map((i: any) => <li key={i.id}><strong>{i.id}</strong> · {i.name}</li>)}</ul></div>
      ))}</div>
      <p className="small">{m.legendNote}</p>
    </details>
  );
}

/** Especialista (e RT como enfermeiro executante): oito itens em quatro domínios, segurança independente, prévia, plano e publicação. */
export function SpecialistLifeScorePage() {
  const { id } = useParams();
  const base = `/api/care/specialist/events/${id}/lifescore`;
  const st = useApi<any>(base);
  const mdl = useApi<any>('/api/lifescore/model');
  const save = useSubmit<any>(); const prev = useSubmit<any>(); const fin = useSubmit<any>(); const safe = useSubmit<any>();
  const [resp, setResp] = useState<Record<string, any>>({});
  const [rev, setRev] = useState(0);
  const [step, setStep] = useState(0);
  const [interp, setInterp] = useState(''); const [summary, setSummary] = useState('');
  const [plan, setPlan] = useState<{ kind: string; date?: string; justification?: string }>({ kind: '' });
  const [preview, setPreview] = useState<any>(null);
  const [review, setReview] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [closeReason, setCloseReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [sf, setSf] = useState({ level: 'PRIORITY', reason: '', action: '', responsible: '', status: 'ABERTA' });
  useEffect(() => { document.title = 'Life Score · ONEMA SAÚDE'; }, []);
  useEffect(() => {
    const d = st.data?.draft;
    if (d) { setResp(d.responses ?? {}); setRev(d.revision); setInterp(d.interpretation ?? ''); setSummary(d.patientSummary ?? ''); setPlan({ kind: d.plan?.kind ?? '', date: d.plan?.date ?? undefined, justification: d.plan?.justification ?? undefined }); }
  }, [st.data?.draft?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const answered = useMemo(() => Object.values(resp).filter((r: any) => CODES.includes(r?.code)).length, [resp]);
  if ((st.loading && !st.data) || (mdl.loading && !mdl.data)) return <Loading />;
  if (st.error) return <ErrorState error={st.error} onRetry={st.reload} />;
  if (mdl.error) return <ErrorState error={mdl.error} onRetry={mdl.reload} />;
  const s = st.data, m = mdl.data;
  const set = (item: string, patch: any) => { setResp((r) => ({ ...r, [item]: { ...(r[item] ?? {}), ...patch } })); setPreview(null); setReview(false); };
  const setCtx = (item: string, patch: any) => set(item, { context: { ...(resp[item]?.context ?? {}), ...patch } });

  async function doSave(quiet = false) {
    const r = await save.run('PUT', base, { revision: rev, responses: resp, interpretation: interp || undefined, patientSummary: summary || undefined,
      plan: plan.kind ? { kind: plan.kind, date: plan.date ?? null, justification: plan.justification ?? null } : undefined });
    if (r) { setRev(r.revision); if (!quiet) setNotice('Rascunho salvo. Nada foi publicado e o paciente não vê o rascunho.'); }
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
    if (r) { setNotice(r.status === 'PUBLICADA' ? `Avaliação publicada em ${new Date().toLocaleString('pt-BR')}. O paciente vê o resultado em Meu acompanhamento.` : 'Avaliação encerrada sem score.'); setPreview(null); setReview(false); setConfirm(false); st.reload(); }
  }
  async function doSafety() { const r = await safe.run('POST', `/api/care/specialist/events/${id}/safety-events`, sf); if (r) { setSf({ ...sf, reason: '', action: '' }); st.reload(); } }
  const d = m.domains[step];

  return (
    <div className="flow">
      <PageHeader kicker="Atendimento" title="Life Score™" back={{ to: `/especialista/atendimentos/${id}`, label: 'Voltar ao atendimento' }}>
        <p className="small">{m.disclaimer} Modelo {m.modelId}. {s.environment === 'HOMOLOGACAO' ? 'Homologação: paciente fictício.' : s.releaseActive ? 'Liberação operacional ativa.' : 'Registros reais calculam só depois da liberação operacional do RT.'}</p>
        <p className="small">Estado: <strong>{s.draft ? 'Rascunho' : s.published ? (s.published.status === 'PUBLICADA' ? 'Publicada' : 'Encerrada sem score') : 'Nova avaliação'}</strong></p>
      </PageHeader>
      {s.calcSuspended && <div className="caution" role="status">O Life Score está suspenso pelo RT. O atendimento, a evolução e o registro de preocupação de segurança seguem normalmente.</div>}

      {s.evolution && (
        <details className="flow-card"><summary><strong>Evolução deste atendimento (fonte de consulta)</strong></summary>
          <p className="small muted">Use como referência. As respostas são confirmadas por você; nada é preenchido automaticamente.</p>
          <dl className="kv small">{Object.entries<any>(s.evolution.content).filter(([k, v]) => k !== 'pendencias' && v).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl>
        </details>
      )}

      {s.published && !s.draft && (
        <div className="success mt" role="status">Avaliação deste atendimento {s.published.status === 'PUBLICADA' ? `publicada: ${fmtScore(s.published.score_display)}` : 'encerrada sem score'} em {dateTime(s.published.published_at)}.
          {s.published.status === 'PUBLICADA' && <> <button type="button" className="linklike" onClick={async () => { const reason = window.prompt('Motivo da retificação (fica no histórico; a original é preservada):'); if (reason) { try { await api('POST', `/api/lifescore/assessments/${s.published.id}/rectify`, { reason }); st.reload(); } catch (e) { setNotice((e as ApiError).message); } } }}>Retificar</button></>}</div>
      )}

      {!s.calcSuspended && ['ACEITO', 'CONCLUIDO'].includes(s.eventStatus) && (s.draft || !s.published) && (
        <section className="flow-card mt">
          <div className="row between"><h2 className="mb0">Domínio {step + 1} de 4 · {d.name}</h2><span className="small muted">{answered}/8 itens respondidos</span></div>
          <p className="small muted">{d.plain} Peso {d.weight}. Nenhuma resposta vem marcada: selecione cada uma.</p>
          {d.items.map((it: any) => {
            const r = resp[it.id] ?? {};
            return (
              <div key={it.id} className="ls-item">
                <div><strong>{it.id} — {it.name}</strong> <span className="small muted">({it.points} pontos)</span><div>{it.question}</div><div className="small muted">{it.help}</div></div>
                {it.context === 'TASK' && <Field label="Tarefa de referência (a de maior necessidade de ajuda)"><input value={r.context?.task ?? ''} maxLength={200} onChange={(e) => setCtx(it.id, { task: e.target.value })} placeholder="Ex.: transferência cama-cadeira" /></Field>}
                {it.context === 'ACTIVITIES' && <Field label="Atividades de autocuidado consideradas (separe por vírgula)"><input value={(r.context?.activities ?? []).join(', ')} onChange={(e) => setCtx(it.id, { activities: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} placeholder="Ex.: banho, vestir-se, alimentação" /></Field>}
                {it.context === 'EXECUTOR' && <Field label="Quem executa as ações essenciais"><select value={r.context?.executor ?? ''} onChange={(e) => setCtx(it.id, { executor: e.target.value || undefined })}><option value="">Selecione…</option><option value="PACIENTE">Paciente</option><option value="CUIDADOR">Responsável/cuidador</option><option value="AMBOS">Ambos</option></select></Field>}
                {it.context === 'OBJECTS' && (
                  <fieldset className="checks-grid"><legend className="field-legend">Verificado</legend>
                    {OBJECTS.map(([k, l]) => <label key={k} className="choice"><input type="checkbox" checked={(r.context?.objects ?? []).includes(k)} onChange={(e) => setCtx(it.id, { noneConfirmed: false, objects: e.target.checked ? [...(r.context?.objects ?? []), k] : (r.context?.objects ?? []).filter((x: string) => x !== k) })} /><span>{l}</span></label>)}
                    <label className="choice"><input type="checkbox" checked={!!r.context?.noneConfirmed} onChange={(e) => setCtx(it.id, { noneConfirmed: e.target.checked, objects: e.target.checked ? [] : r.context?.objects })} /><span>Sem medicamento/dispositivo pertinente (confirmado)</span></label>
                  </fieldset>
                )}
                {it.context === 'WOUND' && <Field label="Há ferida?"><select value={r.context?.wound == null ? '' : r.context.wound ? 'S' : 'N'} onChange={(e) => setCtx(it.id, { wound: e.target.value === '' ? undefined : e.target.value === 'S' })}><option value="">Selecione…</option><option value="N">Não (avaliar pele e ambiente)</option><option value="S">Sim</option></select></Field>}
                <div className="ls-anchors" role="radiogroup" aria-label={`${it.id} — ${it.name}`}>
                  {!r.code && <p className="small muted mb0">Selecione uma resposta.</p>}
                  {CODES.map((c) => (
                    <label key={c} className={`ls-anchor ${r.code === c ? 'on' : ''}`}>
                      <input type="radio" name={it.id} checked={r.code === c} onChange={() => set(it.id, { code: c })} />
                      <span><strong>{c}</strong> {it.anchors[c]}</span>
                    </label>
                  ))}
                  <label className={`ls-anchor ${r.code && !CODES.includes(r.code) ? 'on' : ''}`}>
                    <span className="small">Não foi possível responder:</span>
                    <select aria-label={`Situação de ${it.id}`} value={r.code && !CODES.includes(r.code) ? r.code : ''} onChange={(e) => set(it.id, { code: e.target.value || undefined })}>
                      <option value="">—</option>{Object.entries(BLOCKING).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                  </label>
                </div>
                <Field label={r.code === 'R0' ? 'Fundamento (obrigatório em R0)' : 'Fundamento / observação do item (opcional)'}><input value={r.rationale ?? ''} maxLength={800} onChange={(e) => set(it.id, { rationale: e.target.value })} /></Field>
              </div>
            );
          })}
          <div className="row">
            <button type="button" className="btn secondary" disabled={step === 0} onClick={() => setStep(step - 1)}>Anterior</button>
            <button type="button" className="btn secondary" disabled={step === 3} onClick={() => setStep(step + 1)}>Próximo</button>
            <span className="small muted">{m.domains.map((x: any, k: number) => <button key={x.code} type="button" className={`linklike ${k === step ? 'strong' : ''}`} onClick={() => setStep(k)}>{x.code}</button>)}</span>
          </div>
          <LifeScoreLegend m={m} />
        </section>
      )}

      <section className="flow-card mt">
        <h2>Preocupação de segurança</h2>
        <p className="small muted">Independente do score: salve a qualquer momento. Total alto não encerra pendência.</p>
        {s.safetyEvents.map((x: any) => <div key={x.id} className={x.level === 'IMMEDIATE' ? 'danger small' : 'caution small'}>{SAFETY_LEVEL[x.level]} · {SAFETY_STATUS[x.status] ?? x.status} · {dateTime(x.occurred_at)} · {x.reason}{x.action_taken ? ` · Ação: ${x.action_taken}` : ''}{x.responsible ? ` · Resp.: ${x.responsible}` : ''}</div>)}
        <div className="form-grid">
          <Field label="Prioridade (definida por você)"><select value={sf.level} onChange={(e) => setSf({ ...sf, level: e.target.value })}><option value="IMMEDIATE">Imediata</option><option value="PRIORITY">Prioritária</option><option value="ROUTINE">Rotina</option></select></Field>
          <Field label="Situação"><select value={sf.status} onChange={(e) => setSf({ ...sf, status: e.target.value })}>{Object.entries(SAFETY_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Responsável" error={fieldError(safe.error, 'responsible')}><input value={sf.responsible} maxLength={120} onChange={(e) => setSf({ ...sf, responsible: e.target.value })} /></Field>
        </div>
        <Field label="Descrição da preocupação" error={fieldError(safe.error, 'reason')}><input value={sf.reason} maxLength={1000} onChange={(e) => setSf({ ...sf, reason: e.target.value })} /></Field>
        <Field label="Ação registrada" error={fieldError(safe.error, 'action')}><input value={sf.action} maxLength={1000} onChange={(e) => setSf({ ...sf, action: e.target.value })} /></Field>
        <Alert error={safe.error && !Array.isArray(safe.error.details) ? safe.error : null} />
        <Button className="sm secondary" busy={safe.busy} onClick={doSafety}>Salvar preocupação de segurança</Button>
      </section>

      {!s.calcSuspended && ['ACEITO', 'CONCLUIDO'].includes(s.eventStatus) && (s.draft || !s.published) && (
        <section className="flow-card mt">
          <h2>Observações, resumo e plano</h2>
          <Field label="Observações do enfermeiro sobre a avaliação" hint="Registre os achados que fundamentam as respostas, limitações da avaliação e particularidades relevantes deste caso." error={fieldError(fin.error, 'interpretation')}><textarea rows={3} value={interp} maxLength={2000} onChange={(e) => setInterp(e.target.value)} /></Field>
          <Field label="Resumo e orientações para o paciente (revise: é o que ele vai ler)" hint="Linguagem simples, sem códigos, números de risco ou promessas." error={fieldError(fin.error, 'patientSummary')}><textarea rows={3} value={summary} maxLength={1500} onChange={(e) => setSummary(e.target.value)} /></Field>
          <fieldset className="checks-grid">
            <legend className="field-legend">Plano de acompanhamento (sua decisão; a nota não define a data)</legend>
            {[['RETORNO', 'Retorno com data e justificativa'], ['SEM_RETORNO', 'Sem retorno programado'], ['DEFINIR_DEPOIS', 'Definição posterior justificada']].map(([k, l]) => (
              <label key={k} className="choice"><input type="radio" name="plan" checked={plan.kind === k} onChange={() => setPlan({ kind: k })} /><span>{l}</span></label>
            ))}
          </fieldset>
          {plan.kind === 'RETORNO' && <div className="row"><input type="date" aria-label="Data prevista" min={addDays(0)} value={plan.date ?? ''} onChange={(e) => setPlan({ ...plan, date: e.target.value })} /></div>}
          {plan.kind && plan.kind !== 'SEM_RETORNO' && <Field label="Justificativa"><input value={plan.justification ?? ''} maxLength={500} onChange={(e) => setPlan({ ...plan, justification: e.target.value })} /></Field>}
          <Alert error={save.error && !Array.isArray(save.error.details) ? save.error : null} success={notice} />
          <div className="row"><Button className="secondary" busy={save.busy} onClick={() => doSave()}>Salvar rascunho</Button><Button className="deep" busy={prev.busy || save.busy} onClick={async () => { await doPreview(); setReview(true); }}>Revisar e publicar</Button></div>
        </section>
      )}

      {review && preview && (
        <section className="flow-card mt" aria-live="polite">
          <h2>Revisão final (prévia profissional — ainda não publicada)</h2>
          <p className="small muted">{preview.disclaimer} Modelo {preview.modelId}.</p>
          {preview.calculable ? <p className="ls-score">{fmtScore(preview.score)}</p> : (
            <><p><strong>Global indisponível.</strong> Itens a revisar:</p><ul className="small">{preview.issues.slice(0, 30).map((i: any, k: number) => <li key={k}>{i.label}</li>)}</ul></>
          )}
          <ul className="list small">{preview.domains.map((x: any) => <li key={x.code}><strong>{x.name}</strong>: {x.score == null ? 'incompleto' : `${fmtScore(x.score)} (0–100)`} {x.contribution != null && <span className="muted">· contribui {fmtScore(x.contribution)} de {x.weight} no global</span>}</li>)}</ul>
          <details className="small"><summary>Contribuição de cada item</summary><ul>{preview.contributions.map((c: any) => <li key={c.item}>{c.item} — {c.name}: {c.value == null ? '—' : fmtScore(c.value)}</li>)}</ul></details>
          {preview.review.length > 0 && <div className="caution small">{preview.review.map((r: any) => <div key={r.item_id}>{r.label}</div>)}</div>}
          {preview.safety?.professional && <div className="caution small">Preocupação de segurança registrada: {SAFETY_LEVEL[preview.safety.professional.level]} — {preview.safety.professional.reason}</div>}
          <p className="small"><strong>Resumo ao paciente:</strong> {summary || '—'}<br /><strong>Plano:</strong> {plan.kind === 'RETORNO' ? `retorno em ${fmtDate(plan.date)}` : plan.kind === 'SEM_RETORNO' ? 'sem retorno programado' : plan.kind === 'DEFINIR_DEPOIS' ? 'definição posterior' : '—'}{plan.justification ? ` — ${plan.justification}` : ''}</p>
          <label className="choice mandatory"><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /><span>Confirmo que revisei as respostas, a segurança, a interpretação destinada ao paciente e o plano.</span></label>
          <Alert error={fin.error && !Array.isArray(fin.error.details) ? fin.error : null} />
          {Array.isArray(fin.error?.details) && fin.error!.code === 'NOT_CALCULABLE' && <ul className="small">{fin.error!.details.slice(0, 20).map((i: any, k: number) => <li key={k}>{i.label}</li>)}</ul>}
          <Button className="green" busy={fin.busy} disabled={!confirm || !preview.calculable} onClick={() => doFinalize(false)}>Publicar</Button>
          <details className="mt"><summary className="small">Encerrar sem score (dados insuficientes)</summary>
            <Field label="Justificativa"><input value={closeReason} maxLength={500} onChange={(e) => setCloseReason(e.target.value)} /></Field>
            <Button className="sm secondary" busy={fin.busy} disabled={!confirm || closeReason.trim().length < 10} onClick={() => doFinalize(true)}>Encerrar sem score</Button>
          </details>
          <LifeScoreLegend m={m} />
        </section>
      )}

      {s.history.length > 0 && (
        <details className="flow-card mt"><summary><strong>Histórico publicado deste paciente ({s.history.length})</strong></summary>
          <ul className="list small">{s.history.map((h: any) => <li key={h.id}>{dateTime(h.publishedAt)} · {fmtScore(h.score)} · {h.specialist}{h.status === 'RETIFICADA' ? ' · retificada' : ''}{h.legacy ? ' · modelo anterior (24 itens)' : ''}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

/** Paciente: card "Meu acompanhamento" na Carteira (ordem e texto da especificação v0.4; sem códigos nem legenda técnica). */
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
          <p className="ls-explanation">{data.explanation}</p>
          <ul className="list small">{l.domains.map((d: any) => <li key={d.code}><div className="row between"><strong>{d.name}</strong><span>{fmtScore(d.score)}</span></div><div className="muted">{d.plain}</div></li>)}</ul>
          {l.summary && <p className="mb0"><strong>Resumo do enfermeiro:</strong> {l.summary}</p>}
        </>
      )}
      <p className="mb0 mt"><Link to="/acompanhamento">Ver avaliação e histórico</Link></p>
    </section>
  );
}

export function MyFollowupPage() {
  const { data, error, loading, reload } = useApi<any>('/api/lifescore/me');
  const act = useSubmit<any>();
  const nav = useNavigate();
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { document.title = 'Meu acompanhamento · ONEMA SAÚDE'; }, []);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const l = data.latest;
  async function plan(action: string) {
    setMsg(null);
    const r = await act.run('POST', `/api/lifescore/me/${l.id}/plan`, { action });
    if (r) { setMsg(r.message); reload(); if (r.next) nav(r.next); }
  }
  const active = l && ['VIGENTE', 'PAUSADO', 'SOLICITADO', 'AGENDADO'].includes(l.plan.status);
  return (
    <div className="flow">
      <PageHeader kicker="Carteira Digital ONEMA" title="Meu acompanhamento" back={{ to: '/carteira', label: 'Carteira' }} />
      {!l ? <Empty title={data.emptyText}><Link className="btn green" to="/solicitar">Solicitar atendimento</Link></Empty> : (
        <>
          <section className="flow-card">
            <h2>Meu acompanhamento</h2>
            <p className="ls-score">{fmtScore(l.score)}</p>
            <p className="small muted mb0">Avaliação de {dateTime(l.publishedAt)} · {l.specialist}</p>
            <p className="ls-explanation">{data.explanation}</p>
            <ul className="list">{l.domains.map((d: any) => <li key={d.code}><div className="row between"><strong>{d.name}</strong><span>{fmtScore(d.score)}</span></div><div className="small muted">{d.plain}</div></li>)}</ul>
            {l.summary && <p><strong>Resumo do enfermeiro:</strong> {l.summary}</p>}
            {l.comparison && <p className="small">{l.comparison.comparable ? `Diferença em relação à avaliação anterior equivalente: ${l.comparison.delta > 0 ? '+' : ''}${fmtScore(l.comparison.delta)}. ` : ''}{l.comparison.note}</p>}
          </section>
          <section className="flow-card mt">
            <h2>Seu próximo cuidado</h2>
            {l.plan.kind === 'RETORNO' ? <p>Seu acompanhamento está previsto para <strong>{fmtDate(l.plan.date)}</strong>, conforme o plano registrado pelo enfermeiro. <span className="small muted">Previsão não é horário reservado, serviço incluído ou contratação.</span></p>
              : l.plan.kind === 'DEFINIR_DEPOIS' ? <p>O plano aguarda definição pelo enfermeiro.</p> : <p>O enfermeiro registrou que não há retorno programado. Você pode solicitar atendimento quando quiser.</p>}
            <p className="small">Situação: <strong>{PLAN_STATUS[l.plan.status] ?? l.plan.status}</strong></p>
            <Alert error={act.error} success={msg} />
            <div className="row">
              <Button className="green" busy={act.busy} onClick={() => (active && l.plan.kind === 'RETORNO' ? plan('SOLICITAR_ATENDIMENTO') : nav('/solicitar'))}>Solicitar atendimento</Button>
              {active && l.plan.kind === 'RETORNO' && <>
                <Button className="secondary" busy={act.busy} onClick={() => plan('LEMBRAR_DEPOIS')}>Lembrar depois</Button>
                <Button className="secondary" busy={act.busy} onClick={() => plan('JA_AGENDEI')}>Já agendei</Button>
                <Button className="secondary" busy={act.busy} onClick={() => plan('NAO_QUERO_RETORNAR')}>Não quero retornar</Button>
              </>}
            </div>
            <p className="small muted mt">{data.primeNote}</p>
            {data.primeActive && active && !l.plan.remindersOptOut && <button type="button" className="linklike small" onClick={() => plan('RECUSAR_LEMBRETES')}>Não quero lembretes deste retorno</button>}
          </section>
          <p className="small caution">{data.urgencyNotice}</p>
          <section className="flow-card mt">
            <h2>Histórico</h2>
            <ul className="list">{data.history.map((h: any) => (
              <li key={h.id}><div className="row between"><span>{dateTime(h.publishedAt)} · {h.specialist}</span><span>{fmtScore(h.score)}{h.status === 'RETIFICADA' && <Badge tone="dark"> retificada</Badge>}</span></div>
                {h.legacy && <div className="small muted">Modelo anterior (24 itens): não é comparável ao modelo atual.</div>}
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
  const [f, setF] = useState({ status: '', plan: '', q: '', from: '', to: '' });
  const mdl = useApi<any>('/api/lifescore/model');
  const tests = useApi<any>('/api/admin/lifescore/tests');
  const [t, setT] = useState({ caseCode: 'SIM8-01', expected: '', observed: '', status: 'EM_ANALISE', evidence: '' });
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
        <p className="small">Modelo {data.modelId} (8 itens, v0.4) · build {data.build}. Registros do modelo anterior de 24 itens: {data.legacyCount} (arquivados, sem recálculo). {data.release ? `Liberação operacional ativa (${data.release.uat} · ${data.release.rt}).` : 'Sem liberação operacional: registros reais não calculam (contas fictícias seguem em homologação).'}
          {data.suspension.calcSuspended && ' Cálculo SUSPENSO.'}{data.suspension.remindersSuspended && ' Lembretes SUSPENSOS.'}</p>
      </PageHeader>
      <Alert error={act.error && !Array.isArray(act.error.details) ? act.error : null} success={msg} />
      {open.length > 0 && (
        <section className="surface">
          <h2>Preocupações de segurança abertas ({open.length})</h2>
          <ul className="list">{open.map((x: any) => (
            <li key={x.id}><div className="row between"><strong>{x.patient} · {x.specialist}</strong><Badge tone={x.level === 'IMMEDIATE' ? 'red' : 'orange'}>{SAFETY_LEVEL[x.level] ?? x.level}</Badge></div>
              <div className="small muted">{dateTime(x.occurred_at)}{x.reason ? ` · ${x.reason}` : ''}{x.action_taken ? ` · ação: ${x.action_taken}` : ''}{x.responsible ? ` · resp.: ${x.responsible}` : ''}{x.status ? ` · ${SAFETY_STATUS[x.status] ?? x.status}` : ''}</div>
              <button type="button" className="linklike small" onClick={() => { const n = ask('O que foi feito?'); if (n) go(`/api/admin/lifescore/safety-events/${x.id}/handled`, { note: n }, 'Registrado.'); }}>Registrar tratamento</button></li>
          ))}</ul>
        </section>
      )}
      <section className="surface">
        <div className="form-grid">
          <Field label="Situação"><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Todas</option><option value="RASCUNHO">Em andamento</option><option value="PUBLICADA">Publicadas</option><option value="RETIFICADA">Retificadas</option><option value="ENCERRADA_SEM_SCORE">Encerradas sem score</option></select></Field>
          <Field label="Continuidade (Guardian)"><select value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value })}><option value="">Todos</option>{Object.entries(PLAN_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
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
                <td>{rt && <button type="button" className="linklike small" onClick={async () => setDetail((await api<any>('GET', `/api/admin/lifescore/assessments/${r.id}`)))}>Abrir</button>}
                  {['PAUSADO', 'ENCERRADO_SEM_RESPOSTA'].includes(r.plan_status) && <button type="button" className="linklike small" onClick={() => { const n = ask('Providência da equipe (responsável e resolução):'); if (n) go(`/api/admin/lifescore/plans/${r.id}/team-note`, { note: n }, 'Providência registrada.'); }}>{r.team_note ? 'Atualizar providência' : 'Registrar providência'}</button>}
                  {r.team_note && <div className="small muted">{r.team_note}</div>}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      {detail && (
        <section className="surface">
          <h2>Avaliação · {detail.assessment.patient}</h2>
          <p className="small muted">{detail.assessment.specialist} · {detail.assessment.status} · modelo {detail.assessment.model_id} · {detail.assessment.environment}</p>
          {detail.assessment.result && <>
            <p>Índice: <strong>{fmtScore(detail.assessment.result.score)}</strong>{detail.assessment.result.legacy ? ' · modelo anterior (24 itens, arquivado)' : ''}</p>
            <ul className="small">{detail.assessment.result.domains.map((x: any) => <li key={x.code}>{x.name}: {x.score == null ? 'incompleto' : fmtScore(x.score)}{x.contribution != null ? ` · contribuição ${fmtScore(x.contribution)}` : ''}</li>)}</ul>
            {detail.assessment.result.review?.length > 0 && <div className="caution small">{detail.assessment.result.review.map((r: any) => <div key={r.item_id}>{r.label}</div>)}</div>}
          </>}
          <p className="small"><strong>Interpretação:</strong> {detail.assessment.interpretation ?? '—'}<br /><strong>Resumo ao paciente:</strong> {detail.assessment.patient_summary ?? '—'}</p>
          <details><summary className="small">Respostas ({Object.keys(detail.assessment.responses).length})</summary><ul className="small">{Object.entries<any>(detail.assessment.responses).map(([k, v]) => <li key={k}>{k}: {v.code}{v.rationale ? ` — ${v.rationale}` : ''}{v.context ? ` · contexto: ${JSON.stringify(v.context)}` : ''}</li>)}</ul></details>
          <LifeScoreLegend m={mdl.data} />
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
          <h2>Homologação e revisão: registros de teste</h2>
          <p className="small muted">Resultado esperado × observado com evidência. Registrar análise ou aprovar teste NÃO ativa produção; a liberação final é registro separado abaixo.</p>
          <div className="form-grid">
            <Field label="Caso"><input value={t.caseCode} maxLength={40} onChange={(e) => setT({ ...t, caseCode: e.target.value })} /></Field>
            <Field label="Situação"><select value={t.status} onChange={(e) => setT({ ...t, status: e.target.value })}><option value="EM_ANALISE">Em análise</option><option value="APROVADO">Aprovado</option><option value="REPROVADO">Reprovado</option><option value="AJUSTE_SOLICITADO">Ajuste solicitado</option></select></Field>
            <Field label="Resultado esperado"><input value={t.expected} onChange={(e) => setT({ ...t, expected: e.target.value })} /></Field>
            <Field label="Resultado observado"><input value={t.observed} onChange={(e) => setT({ ...t, observed: e.target.value })} /></Field>
          </div>
          <Field label="Evidência (link, print, observação)"><input value={t.evidence} onChange={(e) => setT({ ...t, evidence: e.target.value })} /></Field>
          <div className="row"><Button className="sm secondary" busy={act.busy} onClick={async () => { if (await act.run('POST', '/api/admin/lifescore/tests', { ...t, evidence: t.evidence || undefined })) { setMsg('Análise registrada.'); setT({ ...t, expected: '', observed: '', evidence: '' }); tests.reload(); } }}>Registrar análise</Button>
            <Button className="sm secondary" busy={act.busy} onClick={async () => { if (await act.run('POST', '/api/admin/lifescore/tests', { ...t, status: 'AJUSTE_SOLICITADO', evidence: t.evidence || undefined })) { setMsg('Ajuste solicitado registrado.'); tests.reload(); } }}>Solicitar ajuste</Button></div>
          {tests.data?.tests?.length > 0 && <ul className="list small">{tests.data.tests.map((x: any) => <li key={x.id}>{dateTime(x.created_at)} · <strong>{x.case_code}</strong> · {x.status.toLowerCase().replace(/_/g, ' ')} · esperado {x.expected} · observado {x.observed}{x.evidence ? ` · ${x.evidence}` : ''} · {x.actor} · {x.model_id}</li>)}</ul>}
          <LifeScoreLegend m={mdl.data} />
        </section>
      )}
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
