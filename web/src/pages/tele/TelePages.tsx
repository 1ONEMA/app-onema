/**
 * Telenfermagem (POP-ONEMA-TELE-001) — HOMOLOGAÇÃO. Telas do paciente, da enfermeira e da Central/RT.
 * Sala audiovisual SIMULADA até a escolha do fornecedor: nenhuma mídia é transmitida ou gravada.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi, useSubmit } from '../../lib/hooks';
import { dateTime, money } from '../../lib/format';
import { Alert, Badge, Button, Empty, ErrorState, Field, Loading, PageHeader, fieldError } from '../../ui/ui';
import { EVO_SECTIONS } from '../care/WalletPage';
import { useDictation } from '../care/VisitPage';

const NOTE_SECTIONS = [...EVO_SECTIONS, ['origemDados', 'Origem dos dados'], ['limitacoes', 'Limitações da avaliação remota']] as const;
type Note = Record<string, any>;
const EMPTY_NOTE: Note = { relato: '', sinaisVitais: '', avaliacao: '', procedimentos: '', orientacoes: '', plano: '', observacoes: '', pendencias: [], origemDados: '',
  limitacoes: 'Avaliação remota, sem exame físico presencial. Dados relatados pelo paciente/cuidador e observados por vídeo.' };
const TONE: Record<string, string> = { CONCLUIDO: '', ASSINADO: '', AGENDADO: 'blue', EM_ATENDIMENTO: 'blue', FALHA_TECNICA: 'orange', AGUARDANDO_REGISTRO: 'orange',
  INELEGIVEL: 'dark', RECUSADO: 'dark', CANCELADO: 'dark', EXPIRADO: 'dark', NAO_COMPARECEU: 'orange', URGENCIA_ENCAMINHADA: 'red', ENCAMINHADO_PRESENCIAL: 'orange' };
const StatusBadge = ({ e }: { e: any }) => <Badge tone={TONE[e.status] ?? 'blue'}>{e.statusLabel}</Badge>;

export function HomologationBanner() {
  return <div className="callout caution small" role="note"><strong>Telenfermagem em homologação.</strong> Proibido uso clínico real: use apenas contas e dados de teste. A sala de vídeo é simulada (sem transmissão e sem gravação).</div>;
}

function NotesView({ notes }: { notes: any[] }) {
  const signed = notes.filter((n) => n.status === 'ASSINADA');
  if (!signed.length) return null;
  return (
    <section className="flow-card mt">
      <h2>Registro do teleatendimento</h2>
      {signed.map((n) => (
        <div key={n.id} className="mt">
          <p className="small muted">{n.kind === 'ADENDO' ? `Adendo v${n.version}` : 'Registro'} · assinado {dateTime(n.signedAt)}{n.aiSuggested ? ' · rascunho sugerido pela Kary e revisado pela enfermeira' : ''}</p>
          <dl className="kv">{NOTE_SECTIONS.map(([k, l]) => n.content[k] && <div key={k} className="contents"><dt>{l}</dt><dd>{n.content[k]}</dd></div>)}</dl>
        </div>
      ))}
    </section>
  );
}

/** Sala simulada: pede token de curta duração, entra e mostra o tempo. A entrada da enfermeira inicia o atendimento. */
function Room({ id, onChange }: { id: string; onChange: () => void }) {
  const tok = useSubmit<any>(); const join = useSubmit<any>();
  const [inside, setInside] = useState<string | null>(null);
  const [secs, setSecs] = useState(0);
  useEffect(() => { if (!inside) return; const t = window.setInterval(() => setSecs((s) => s + 1), 1000); return () => window.clearInterval(t); }, [inside]);
  async function enter() {
    const t = await tok.run('POST', `/api/tele/episodes/${id}/video-token`);
    if (!t) return;
    const j = await join.run('POST', `/api/tele/episodes/${id}/join`, { token: t.token });
    if (j) { setInside(t.room); setSecs(0); onChange(); }
  }
  if (inside) {
    return (
      <div className="tele-room" role="region" aria-label="Sala de teleatendimento">
        <div className="tele-room-screen"><span>Sala simulada · {inside}</span><strong>{String(Math.floor(secs / 60)).padStart(2, '0')}:{String(secs % 60).padStart(2, '0')}</strong><span className="small">Sem gravação</span></div>
        <button type="button" className="btn secondary sm mt" onClick={() => setInside(null)}>Sair da sala</button>
      </div>
    );
  }
  return (
    <div>
      <Alert error={tok.error ?? join.error} />
      <Button className="deep" busy={tok.busy || join.busy} onClick={enter}>Entrar na sala</Button>
      <p className="small muted mt">O acesso vale por 10 minutos e é pessoal. Não compartilhe o link nem use WhatsApp pessoal para o atendimento.</p>
    </div>
  );
}

// ---------------- Paciente ----------------
export function PatientTeleListPage() {
  const { data, error, loading, reload } = useApi<any>('/api/tele/episodes?scope=paciente');
  useEffect(() => { document.title = 'Telenfermagem · ONEMA SAÚDE'; }, []);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  return (
    <div className="flow">
      <PageHeader kicker="Carteira Digital" title="Teleatendimentos" back={{ to: '/carteira', label: 'Carteira Digital' }} />
      {data.homologation && <HomologationBanner />}
      {!data.episodes.length ? <Empty title="Nenhum teleatendimento.">A enfermeira ou a Central ONEMA indicam o teleatendimento quando ele faz sentido para o seu cuidado.</Empty> : (
        <ul className="list">{data.episodes.map((e: any) => (
          <li key={e.id}><div className="row between"><Link to={`/telenfermagem/${e.id}`}><strong>{e.modalityLabel}</strong></Link><StatusBadge e={e} /></div>
            <div className="small muted">{e.protocol}{e.scheduledAt ? ` · ${dateTime(e.scheduledAt)}` : ''}</div></li>
        ))}</ul>
      )}
    </div>
  );
}

export function PatientTeleEpisodePage() {
  const { id } = useParams();
  const { data, error, loading, reload } = useApi<any>(`/api/tele/episodes/${id}`);
  const act = useSubmit<any>();
  const [agree, setAgree] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const e = data.episode;
  async function consent(decision: string) {
    if (await act.run('POST', `/api/tele/episodes/${id}/consent`, { decision, ...(decision === 'ACEITO' && e.pricing?.rule === 'COBRADO' ? { acceptedPriceCents: e.pricing.priceCents } : {}) })) reload();
  }
  return (
    <div className="flow">
      <PageHeader kicker={e.protocol} title={e.modalityLabel} back={{ to: '/telenfermagem', label: 'Teleatendimentos' }} />
      {e.homologation && <HomologationBanner />}
      <section className="flow-card">
        <div className="row between"><h2 className="mb0">Situação</h2><StatusBadge e={e} /></div>
        {e.professionalName && <p>Enfermeira: <strong>{e.professionalName}</strong></p>}
        {e.scheduledAt && <p>Horário: <strong>{dateTime(e.scheduledAt)}</strong></p>}
        <p className="small muted">Indicação: {e.reason}</p>
        {e.outcomeReason && <p className="small">{e.outcomeReason}</p>}
        {e.outcomePlan && <p className="small"><strong>Orientação:</strong> {e.outcomePlan}</p>}
        {e.status === 'URGENCIA_ENCAMINHADA' && <div className="callout caution"><strong>{e.urgencyGuidance}</strong></div>}
      </section>

      {e.status === 'TRIAGEM' && (
        <section className="flow-card mt">
          <h2>Consentimento</h2>
          <p>{e.consentText.purpose}</p>
          {e.pricing?.rule === 'INCLUIDO' ? <p><Badge>Incluído</Badge> {e.pricing.reason}</p>
            : <p><strong>Valor: {money(e.pricing?.priceCents)}</strong> <span className="small muted">({e.pricing?.reason}) Nenhuma cobrança é feita automaticamente.</span></p>}
          <label className="check"><input type="checkbox" checked={agree} onChange={(ev) => setAgree(ev.target.checked)} /> Li e concordo com o atendimento remoto{e.pricing?.rule === 'COBRADO' ? ' e com o valor informado' : ''} (versão {e.consentText.version}).</label>
          <Alert error={act.error} />
          <div className="row"><Button className="deep" busy={act.busy} disabled={!agree} onClick={() => consent('ACEITO')}>Confirmar</Button>
            <button type="button" className="btn secondary" onClick={() => consent('RECUSADO')}>Não aceito</button></div>
        </section>
      )}

      {['AGENDADO', 'EM_ATENDIMENTO'].includes(e.status) && (
        <section className="flow-card mt"><h2>Sala do teleatendimento</h2><Room id={e.id} onChange={reload} /></section>
      )}

      <NotesView notes={e.notes} />

      {['TRIAGEM', 'OFERTADO', 'ACEITO', 'AGENDADO', 'FALHA_TECNICA'].includes(e.status) && (
        <details className="mt"><summary>Cancelar ou revogar consentimento</summary>
          <Field label="Motivo"><input value={cancelReason} onChange={(ev) => setCancelReason(ev.target.value)} maxLength={500} /></Field>
          <Button className="sm secondary" busy={act.busy} disabled={cancelReason.trim().length < 3} onClick={async () => { if (await act.run('POST', `/api/tele/episodes/${id}/cancel`, { reason: cancelReason })) reload(); }}>Cancelar teleatendimento</Button>
        </details>
      )}
      <p className="small muted mt">{e.urgencyGuidance}</p>
    </div>
  );
}

// ---------------- Enfermeira ----------------
export function SpecialistTeleListPage() {
  const { data, error, loading, reload } = useApi<any>('/api/tele/episodes?scope=profissional');
  const visits = useApi<any>('/api/care/specialist/offers');
  const create = useSubmit<any>();
  const [f, setF] = useState({ originEventId: '', modality: 'RETORNO_ONLINE', reason: '', windowDays: 15 });
  const [ok, setOk] = useState<string | null>(null);
  useEffect(() => { document.title = 'Telenfermagem · ONEMA ONE'; }, []);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const done = (visits.data?.mine ?? []).filter((m: any) => m.status === 'CONCLUIDO');
  const accept = async (eid: string) => { if (await create.run('POST', `/api/tele/episodes/${eid}/accept`)) reload(); };
  async function indicate(ev: FormEvent) {
    ev.preventDefault();
    const r = await create.run('POST', '/api/tele/episodes', { ...f, windowDays: Number(f.windowDays) });
    if (r) { setOk(`Indicação registrada (${r.episode.protocol}). A Central/RT avalia a elegibilidade.`); setF({ ...f, reason: '' }); reload(); }
  }
  const offers = data.episodes.filter((e: any) => e.status === 'OFERTADO' && !e.professionalName);
  const mine = data.episodes.filter((e: any) => !(e.status === 'OFERTADO' && !e.professionalName));
  return (
    <div className="flow">
      <PageHeader kicker="Rede ONEMA ONE" title="Telenfermagem" back={{ to: '/especialista', label: 'Painel' }} />
      {data.homologation && <HomologationBanner />}
      <Alert error={create.error} success={ok} />
      <section className="flow-card">
        <h2>Ofertas de teleatendimento</h2>
        {!offers.length ? <p className="muted">Nenhuma oferta agora.</p> : (
          <ul className="list">{offers.map((e: any) => (
            <li key={e.id} className="row between"><span><strong>{e.modalityLabel}</strong>{e.preferred && <> <Badge>Paciente seu</Badge></>}<br /><span className="small muted">Janela até {dateTime(e.windowUntil)} · oferta até {dateTime(e.offerExpiresAt)}</span></span>
              <Button className="sm deep" busy={create.busy} onClick={() => accept(e.id)}>Aceitar</Button></li>
          ))}</ul>
        )}
      </section>
      <section className="flow-card mt">
        <h2>Meus teleatendimentos</h2>
        {!mine.length ? <p className="muted">Nenhum ainda.</p> : (
          <ul className="list">{mine.map((e: any) => (
            <li key={e.id}><div className="row between"><Link to={`/especialista/telenfermagem/${e.id}`}><strong>{e.modalityLabel}</strong> · {e.patientName}</Link><StatusBadge e={e} /></div>
              <div className="small muted">{e.protocol}{e.scheduledAt ? ` · ${dateTime(e.scheduledAt)}` : ''}</div></li>
          ))}</ul>
        )}
      </section>
      <section className="flow-card mt">
        <h2>Indicar retorno online</h2>
        {!done.length ? <p className="muted">A indicação parte de um atendimento presencial que você concluiu.</p> : (
          <form onSubmit={indicate} noValidate>
            <div className="form-grid">
              <Field label="Atendimento de origem"><select value={f.originEventId} onChange={(ev) => setF({ ...f, originEventId: ev.target.value })}>
                <option value="">Selecione…</option>{done.map((m: any) => <option key={m.id} value={m.id}>{m.label} · {m.item_name} · {dateTime(m.completed_at)}</option>)}</select></Field>
              <Field label="Modalidade"><select value={f.modality} onChange={(ev) => setF({ ...f, modality: ev.target.value })}>
                <option value="RETORNO_ONLINE">Retorno online</option><option value="MONITORAMENTO">Monitoramento digital</option><option value="CONSULTA_REMOTA">Consulta de Enfermagem remota</option></select></Field>
              <Field label="Janela (dias)"><input type="number" min={1} max={90} value={f.windowDays} onChange={(ev) => setF({ ...f, windowDays: Number(ev.target.value) })} /></Field>
            </div>
            <Field label="Justificativa clínica" error={fieldError(create.error, 'reason')}><textarea rows={3} value={f.reason} maxLength={2000} onChange={(ev) => setF({ ...f, reason: ev.target.value })} /></Field>
            <Button className="deep" busy={create.busy} disabled={!f.originEventId}>Registrar indicação</Button>
          </form>
        )}
      </section>
    </div>
  );
}

function toLocalInput(iso?: string | null) {
  const d = iso ? new Date(iso) : new Date(Date.now() + 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function SpecialistTeleEpisodePage() {
  const { id } = useParams();
  const { data, error, loading, reload } = useApi<any>(`/api/tele/episodes/${id}`);
  const act = useSubmit<any>();
  const [when, setWhen] = useState('');
  const [note, setNote] = useState<Note | null>(null);
  const [dictation, setDictation] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [ref, setRef] = useState({ kind: 'PRESENCIAL', reason: '', plan: '' });
  const [addendum, setAddendum] = useState('');
  const mic = useDictation((t) => setDictation((d) => (d ? `${d} ${t}` : t)));
  const e = data?.episode;
  const draft = e?.notes?.find((n: any) => n.kind === 'REGISTRO');
  useEffect(() => { if (e) { setNote({ ...EMPTY_NOTE, ...(draft?.content ?? {}) }); setDictation((d) => d || draft?.dictation || ''); setWhen(toLocalInput(e.scheduledAt)); } }, [e?.id, draft?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const post = async (path: string, body?: unknown) => { setMsg(null); const r = await act.run('POST', `/api/tele/episodes/${id}/${path}`, body); if (r) reload(); return r; };
  const signed = draft?.status === 'ASSINADA';
  const canNote = ['EM_ATENDIMENTO', 'AGUARDANDO_REGISTRO', 'ENCAMINHADO_PRESENCIAL', 'URGENCIA_ENCAMINHADA'].includes(e.status) && !signed;
  return (
    <div className="flow">
      <PageHeader kicker={e.protocol} title={`${e.modalityLabel} · ${e.patientName ?? ''}`} back={{ to: '/especialista/telenfermagem', label: 'Telenfermagem' }} />
      {e.homologation && <HomologationBanner />}
      <Alert error={act.error} success={msg} />
      <section className="flow-card">
        <div className="row between"><h2 className="mb0">Situação</h2><StatusBadge e={e} /></div>
        <p className="small">Indicação: {e.reason}</p>
        {e.pricing && <p className="small muted">{e.pricing.rule === 'INCLUIDO' ? 'Retorno incluído.' : `Cobrado: ${money(e.pricing.priceCents)} (aceito pelo paciente).`}</p>}
        {e.scheduledAt && <p>Horário: <strong>{dateTime(e.scheduledAt)}</strong></p>}
        {e.outcomeReason && <p className="small">{e.outcomeReason}</p>}
      </section>

      {['ACEITO', 'AGENDADO', 'FALHA_TECNICA'].includes(e.status) && (
        <section className="flow-card mt">
          <h2>{e.status === 'ACEITO' ? 'Agendar' : 'Reagendar'}</h2>
          <div className="row"><input type="datetime-local" value={when} onChange={(ev) => setWhen(ev.target.value)} aria-label="Data e hora" />
            <Button className="sm deep" busy={act.busy} onClick={() => post('schedule', { startAt: new Date(when).toISOString() })}>Salvar horário</Button></div>
          <p className="small muted">O paciente recebe um lembrete sem informações clínicas.</p>
        </section>
      )}

      {['AGENDADO', 'EM_ATENDIMENTO'].includes(e.status) && (
        <section className="flow-card mt">
          <h2>Sala</h2>
          <Room id={e.id} onChange={reload} />
          <div className="row mt">
            {e.status === 'EM_ATENDIMENTO' && <Button className="sm deep" busy={act.busy} onClick={() => post('end', { outcome: 'ENCERRADO' })}>Encerrar chamada</Button>}
            <button type="button" className="btn sm secondary" onClick={() => post('end', { outcome: 'FALHA_TECNICA' })}>Registrar queda de conexão</button>
            <button type="button" className="btn sm secondary" onClick={() => post('end', { outcome: 'NAO_COMPARECEU' })}>Paciente não compareceu</button>
          </div>
        </section>
      )}

      {canNote && note && (
        <section className="flow-card mt">
          <h2>Registro de enfermagem</h2>
          <Field label="Ditado" hint="A Kary só sugere o rascunho. Revise cada seção antes de assinar.">
            <textarea rows={5} value={dictation} maxLength={8000} onChange={(ev) => setDictation(ev.target.value)} />
          </Field>
          <div className="row">
            {mic.supported && <Button type="button" className={mic.on ? 'sm red' : 'sm secondary'} onClick={mic.toggle}>{mic.on ? 'Parar ditado' : 'Ditar'}</Button>}
            <Button className="sm secondary" busy={act.busy} disabled={dictation.trim().length < 20} onClick={async () => { const r = await act.run('POST', `/api/tele/episodes/${id}/notes/organize`, { dictation }); if (r) { setMsg(r.aiMessage); setNote({ ...EMPTY_NOTE, ...(r.episode.notes.find((n: any) => n.kind === 'REGISTRO')?.content ?? {}) }); } }}>Sugerir com a Kary</Button>
          </div>
          {draft?.aiSuggested && <p className="small caution">Rascunho sugerido pela Kary: confira tudo.</p>}
          {NOTE_SECTIONS.map(([k, l]) => (
            <Field key={k} label={l}><textarea rows={k === 'relato' || k === 'avaliacao' ? 3 : 2} value={note[k] ?? ''} maxLength={4000} onChange={(ev) => setNote({ ...note, [k]: ev.target.value })} /></Field>
          ))}
          {note.pendencias?.length > 0 && <div className="callout small"><strong>Conferir:</strong> {note.pendencias.join('; ')}</div>}
          <div className="row">
            <Button className="sm secondary" busy={act.busy} onClick={async () => { if (await act.run('PUT', `/api/tele/episodes/${id}/notes`, { dictation, content: note })) setMsg('Rascunho salvo.'); }}>Salvar rascunho</Button>
          </div>
          {e.status !== 'EM_ATENDIMENTO' && (<>
            <label className="check mt"><input type="checkbox" checked={confirm} onChange={(ev) => setConfirm(ev.target.checked)} /> Revisei o registro e assumo a responsabilidade técnica pelo conteúdo.</label>
            <Button className="deep" busy={act.busy} disabled={!confirm} onClick={() => post('sign', { content: note, confirm: true })}>Assinar registro</Button>
          </>)}
        </section>
      )}

      {['AGENDADO', 'EM_ATENDIMENTO', 'AGUARDANDO_REGISTRO'].includes(e.status) && (
        <details className="mt"><summary>Encaminhar (presencial ou urgência)</summary>
          <Field label="Tipo"><select value={ref.kind} onChange={(ev) => setRef({ ...ref, kind: ev.target.value })}><option value="PRESENCIAL">Atendimento presencial</option><option value="URGENCIA">Urgência / emergência</option></select></Field>
          <Field label="Motivo"><textarea rows={2} value={ref.reason} onChange={(ev) => setRef({ ...ref, reason: ev.target.value })} /></Field>
          <Field label="Plano / orientação dada"><textarea rows={2} value={ref.plan} onChange={(ev) => setRef({ ...ref, plan: ev.target.value })} /></Field>
          {ref.kind === 'URGENCIA' && <p className="small caution">{e.urgencyGuidance}</p>}
          <Button className="sm red" busy={act.busy} onClick={() => post('referral', ref)}>Registrar encaminhamento</Button>
        </details>
      )}

      {signed && (
        <>
          <NotesView notes={e.notes} />
          {e.status === 'ASSINADO' && <Button className="deep mt" busy={act.busy} onClick={() => post('close')}>Concluir teleatendimento</Button>}
          <details className="mt"><summary>Adicionar adendo (o original é preservado)</summary>
            <Field label="Adendo"><textarea rows={3} value={addendum} maxLength={4000} onChange={(ev) => setAddendum(ev.target.value)} /></Field>
            <Button className="sm secondary" busy={act.busy} disabled={addendum.trim().length < 5} onClick={async () => { if (await post('addenda', { text: addendum, confirm: true })) setAddendum(''); }}>Assinar adendo</Button>
          </details>
        </>
      )}
    </div>
  );
}

// ---------------- Central / RT ----------------
export function AdminTelePage() {
  const { data, error, loading, reload } = useApi<any>('/api/tele/episodes?scope=central');
  const pend = useApi<any>('/api/admin/tele/pending');
  const act = useSubmit<any>();
  const [sel, setSel] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [assignTo, setAssignTo] = useState('');
  const [trail, setTrail] = useState<any[] | null>(null);
  const [f, setF] = useState({ patientEmail: '', modality: 'CONSULTA_REMOTA', reason: '', windowDays: 15 });
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const refresh = () => { reload(); pend.reload(); };
  const post = async (eid: string, path: string, body?: unknown) => { if (await act.run('POST', `/api/tele/episodes/${eid}/${path}`, body)) { setNote(''); refresh(); } };
  const p = pend.data?.pending;
  return (
    <div className="flow">
      <PageHeader kicker="Central / RT" title="Telenfermagem" />
      <HomologationBanner />
      {p && <div className="stats"><div><strong>{p.triage}</strong><span>aguardando triagem</span></div><div><strong>{p.overdueOffers}</strong><span>ofertas vencidas</span></div>
        <div><strong>{p.unsignedOver24h}</strong><span>sem registro há +24 h</span></div><div><strong>{p.technicalFailures}</strong><span>falhas técnicas</span></div></div>}
      <p className="small muted">Regras: {pend.data?.protocolVersion}. Retorno incluído até {pend.data?.returnWindowDays} dias após o presencial.</p>
      <Alert error={act.error} />
      <section className="flow-card">
        <h2>Episódios</h2>
        {!data.episodes.length ? <p className="muted">Nenhum episódio.</p> : (
          <ul className="list">{data.episodes.map((e: any) => (
            <li key={e.id}>
              <div className="row between"><button type="button" className="linklike" onClick={() => { setSel(sel === e.id ? null : e.id); setTrail(null); }}><strong>{e.modalityLabel}</strong> · {e.patientName} · {e.protocol}</button><StatusBadge e={e} /></div>
              <div className="small muted">{e.professionalName ? `Enfermeira: ${e.professionalName}` : e.offeredTo ? `Oferta: ${e.offeredTo}` : ''}{e.scheduledAt ? ` · ${dateTime(e.scheduledAt)}` : ''}</div>
              {sel === e.id && (
                <div className="mt">
                  <p className="small">Indicação: {e.reason}</p>
                  {e.status === 'SOLICITADO' && (<>
                    <Field label="Decisão de elegibilidade (motivo)"><input value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={1000} /></Field>
                    <div className="row"><Button className="sm deep" busy={act.busy} onClick={() => post(e.id, 'eligibility', { eligible: true, note })}>Elegível</Button>
                      <button type="button" className="btn sm secondary" onClick={() => post(e.id, 'eligibility', { eligible: false, note })}>Inelegível</button></div>
                  </>)}
                  {e.status === 'OFERTADO' && (
                    <div className="row"><input type="email" placeholder="e-mail da enfermeira (vazio = rede)" value={assignTo} onChange={(ev) => setAssignTo(ev.target.value)} />
                      <Button className="sm secondary" busy={act.busy} onClick={() => post(e.id, 'assign', { professionalEmail: assignTo.trim() || null })}>Redistribuir</Button></div>
                  )}
                  {e.status === 'ASSINADO' && <Button className="sm deep" busy={act.busy} onClick={() => post(e.id, 'close')}>Concluir</Button>}
                  <button type="button" className="linklike small mt" onClick={async () => { const r = await act.run('GET', `/api/tele/episodes/${e.id}/audit`); if (r) setTrail(r.events); }}>Ver trilha de auditoria</button>
                  {trail && <ul className="small">{trail.map((t, i) => <li key={i}>{dateTime(t.at)} · {t.action}{t.meta?.to ? ` → ${t.meta.to}` : ''} · {t.actor}</li>)}</ul>}
                </div>
              )}
            </li>
          ))}</ul>
        )}
      </section>
      <section className="flow-card mt">
        <h2>Novo episódio (paciente de teste)</h2>
        <form onSubmit={async (ev) => { ev.preventDefault(); if (await act.run('POST', '/api/tele/episodes', { ...f, windowDays: Number(f.windowDays) })) { setF({ ...f, reason: '' }); refresh(); } }} noValidate>
          <div className="form-grid">
            <Field label="E-mail do paciente"><input type="email" value={f.patientEmail} onChange={(ev) => setF({ ...f, patientEmail: ev.target.value })} /></Field>
            <Field label="Modalidade"><select value={f.modality} onChange={(ev) => setF({ ...f, modality: ev.target.value })}><option value="MONITORAMENTO">Monitoramento digital</option><option value="CONSULTA_REMOTA">Consulta de Enfermagem remota</option><option value="RETORNO_ONLINE">Retorno online</option></select></Field>
          </div>
          <Field label="Justificativa"><textarea rows={2} value={f.reason} onChange={(ev) => setF({ ...f, reason: ev.target.value })} /></Field>
          <Button className="deep" busy={act.busy}>Criar</Button>
        </form>
      </section>
    </div>
  );
}
