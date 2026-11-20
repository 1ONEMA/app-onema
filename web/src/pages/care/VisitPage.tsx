import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useApi, useLiveApi, useSubmit } from '../../lib/hooks';
import { OfflineNotice, fromLocalInput, toLocalInput } from '../../ui/Live';
import { Alert, Badge, Button, ErrorState, Field, Loading, PageHeader, fieldError } from '../../ui/ui';
import { IconCheck, IconShield } from '../../ui/icons';
import { EVO_SECTIONS } from './WalletPage';
import { CarePlanEditor } from '../carteira/CarteiraPages';
import { VideoCall } from '../../ui/VideoCall';
import { DocLink } from '../../ui/DocViewer';
import { PopPanel } from '../pops/PopsPages';

type Evo = { relato: string; sinaisVitais: string; avaliacao: string; procedimentos: string; orientacoes: string; plano: string; observacoes: string; pendencias: string[] };
const EMPTY: Evo = { relato: '', sinaisVitais: '', avaliacao: '', procedimentos: '', orientacoes: '', plano: '', observacoes: '', pendencias: [] };

/** Reconhecimento de voz do navegador (Chrome/Android e Safari/iOS). Sem suporte, a enfermeira digita ou usa o microfone do teclado. */
export function useDictation(onText: (t: string) => void) {
  const SR: any = typeof window !== 'undefined' ? (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition : null;
  const [on, setOn] = useState(false);
  const rec = useRef<any>(null);
  useEffect(() => () => rec.current?.stop?.(), []);
  function toggle() {
    if (!SR) return;
    if (on) { rec.current?.stop(); return; }
    const r = new SR();
    r.lang = 'pt-BR'; r.continuous = true; r.interimResults = false;
    r.onresult = (e: any) => {
      let t = '';
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) t += e.results[i][0].transcript;
      if (t.trim()) onText(t.trim());
    };
    r.onend = () => setOn(false);
    r.onerror = () => setOn(false);
    rec.current = r; r.start(); setOn(true);
  }
  return { supported: !!SR, on, toggle };
}

/** A tela inteira se atualiza sozinha (useLiveApi); aqui só o aviso enquanto aguarda a assinatura do paciente. */
function SignatureWatcher() {
  return <p className="small" role="status">Aguardando a assinatura…</p>;
}

/** Atendimento da especialista: início com o código do paciente, evolução ditada e organizada pela Kary, assinatura e conclusão. */
export function VisitPage() {
  const { id } = useParams();
  const { data, error, loading, reload, offline } = useLiveApi<any>(`/api/care/specialist/events/${id}/evolution`, 2000);
  const [showRecord, setShowRecord] = useState(false);
  const start = useSubmit<any>();
  const organize = useSubmit<any>();
  const save = useSubmit<any>();
  const sign = useSubmit<any>();
  const complete = useSubmit<any>();
  const [code, setCode] = useState('');
  const [shareLoc, setShareLoc] = useState(false);
  const [dictation, setDictation] = useState('');
  const [evo, setEvo] = useState<Evo | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const mic = useDictation((t) => setDictation((d) => (d ? `${d} ${t}` : t)));
  useEffect(() => { document.title = 'Atendimento · ONEMA ONE'; }, []);
  useEffect(() => {
    if (data?.evolution) { setEvo({ ...EMPTY, ...data.evolution.content }); setDictation((d) => d || data.evolution.dictation || ''); }
  }, [data?.evolution?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  const e = data.event;
  const signed = data.evolution?.status === 'ASSINADA';
  const started = !!e.startedAt || e.modality !== 'PRESENCIAL';

  async function doStart() {
    let location: any;
    if (shareLoc && navigator.geolocation) {
      location = await new Promise((res) => navigator.geolocation.getCurrentPosition(
        (p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }), () => res(undefined), { timeout: 8000, maximumAge: 60000 }));
    }
    if (await start.run('POST', `/api/care/specialist/events/${id}/start`, { code, ...(location ? { location } : {}) })) reload();
  }
  async function doOrganize() {
    const r = await organize.run('POST', `/api/care/specialist/events/${id}/evolution/organize`, { dictation });
    if (!r) return;
    let ev = r.evolution;
    setWorking(ev.aiStatus === 'PROCESSANDO');
    // Acompanha a organização feita em segundo plano (até ~2 min).
    for (let i = 0; i < 60 && ev.aiStatus === 'PROCESSANDO'; i++) {
      await new Promise((res) => setTimeout(res, 2000));
      try { ev = (await api<any>('GET', `/api/care/specialist/events/${id}/evolution`)).evolution; } catch { /* tenta de novo */ }
    }
    setWorking(false);
    setEvo({ ...EMPTY, ...ev.content });
    setNotice(ev.aiMessage ?? null);
  }
  async function doSave() { if (evo && await save.run('PUT', `/api/care/specialist/events/${id}/evolution`, { dictation, content: evo })) setNotice('Rascunho salvo.'); }
  async function doSign() { if (evo && await sign.run('POST', `/api/care/specialist/events/${id}/evolution/sign`, { content: evo, confirm })) { setNotice(null); reload(); } }
  async function doComplete() { if (await complete.run('POST', `/api/care/specialist/events/${id}/complete`, {})) reload(); }

  return (
    <div className="flow">
      <PageHeader kicker="Atendimento ONEMA ONE" title={e.label} back={{ to: '/especialista#ofertas', label: 'Meus atendimentos' }}>
        <p>{e.itemName} · {e.modality === 'REMOTO' ? 'remoto' : 'presencial'}{e.window ? ` · janela: ${e.window}` : ''}</p>
      </PageHeader>
      <OfflineNotice offline={offline} />
      {e.status === 'CONCLUIDO' ? (
        <>
          {/* Ajuste 08: concluído no servidor → só o resumo de encerramento; o registro fica em modo de consulta. */}
          <section className="flow-card closing-summary" role="status">
            <h2>Atendimento concluído</h2>
            <dl className="kv">
              <dt>Assinatura do paciente/responsável</dt><dd>{e.patientSignedAt ? `registrada (${e.patientSignatureName}, ${new Date(e.patientSignedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })})` : '—'}</dd>
              <dt>Encerramento</dt><dd>{new Date(e.completedAt).toLocaleDateString('pt-BR')} às {new Date(e.completedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</dd>
              <dt>Repasse</dt><dd>segue para validação da ONEMA</dd>
            </dl>
            <button type="button" className="btn sm secondary" aria-expanded={showRecord} onClick={() => setShowRecord((v) => !v)}>{showRecord ? 'Ocultar registro' : 'Ver registro do atendimento'}</button>
          </section>
          {showRecord && (
            <>
              <section className="flow-card mt">
                <h2>Evolução de enfermagem <Badge>Assinada</Badge></h2>
                {signed ? <dl className="kv">{EVO_SECTIONS.map(([k, l]) => (data.evolution.content as any)[k] && <div key={k} className="contents"><dt>{l}</dt><dd>{(data.evolution.content as any)[k]}</dd></div>)}</dl> : <p className="muted">Sem evolução registrada.</p>}
              </section>
              {signed && <CarePlanEditor eventId={id!} />}
              <PopPanel eventId={id!} active={false} />
            </>
          )}
          <p className="small"><Link to="/especialista#ofertas">Voltar aos meus atendimentos</Link></p>
        </>
      ) : (<>

      <section className="flow-card">
        <h2>1. Iniciar o atendimento</h2>
        {e.modality !== 'PRESENCIAL' ? <OnlineCallCard id={id!} e={e} onChange={reload} />
          : e.startedAt ? <div className="success" role="status"><IconCheck size={18} /> Atendimento iniciado e confirmado com o código do paciente.</div> : (
          <>
            <SpecialistSchedule id={id!} e={e} onChange={reload} />
            <p className="muted">Ao chegar, peça ao paciente o <strong>código de 6 números</strong> que aparece no app dele. Isso confirma, para a família, que é você quem está no atendimento.</p>
            <Field label="Código do paciente" error={fieldError(start.error, 'code')}>
              <input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(ev) => setCode(ev.target.value.replace(/\D/g, ''))} placeholder="000000" />
            </Field>
            <label className="choice"><input type="checkbox" checked={shareLoc} onChange={(ev) => setShareLoc(ev.target.checked)} />
              <span>Registrar minha localização aproximada no início do atendimento <span className="small muted">(opcional; guardamos só uma área de ~100 m)</span></span></label>
            <Alert error={start.error && !Array.isArray(start.error.details) ? start.error : null} />
            <Button className="deep" busy={start.busy} disabled={code.length !== 6} onClick={doStart}><IconShield size={18} /> Confirmar início</Button>
          </>
        )}
      </section>

      <section className="flow-card mt" aria-disabled={!started}>
        <h2>2. Evolução de enfermagem {signed && <Badge>Assinada</Badge>}</h2>
        {!started ? <p className="muted">Disponível depois de iniciar o atendimento.</p> : signed ? (
          <dl className="kv">{EVO_SECTIONS.map(([k, l]) => (data.evolution.content as any)[k] && <div key={k} className="contents"><dt>{l}</dt><dd>{(data.evolution.content as any)[k]}</dd></div>)}</dl>
        ) : (
          <>
            <p className="muted">Fale a evolução como você faria no prontuário. A Kary organiza nas seções e você revisa antes de assinar. {!data.aiEnabled && <strong>Organização por IA ainda não configurada: preencha as seções manualmente.</strong>}</p>
            <Field label="Ditado da evolução" hint={mic.supported ? 'Toque em "Ditar" e fale. Você também pode digitar ou usar o microfone do teclado.' : 'Use o microfone do teclado do celular para ditar, ou digite.'} error={fieldError(organize.error, 'dictation')}>
              <textarea rows={6} value={dictation} maxLength={8000} onChange={(ev) => setDictation(ev.target.value)} placeholder="Ex.: Paciente refere melhora da dor. PA 12 por 8, saturação 97%. Ferida em calcâneo direito com tecido de granulação... Realizado curativo com... Orientada a família..." />
            </Field>
            <p className="small muted">Não diga nome completo, CPF ou endereço do paciente no ditado. O áudio é convertido em texto pelo próprio celular.</p>
            <div className="row">
              {mic.supported && <Button type="button" className={mic.on ? 'sm red' : 'sm secondary'} onClick={mic.toggle}>{mic.on ? 'Parar ditado' : 'Ditar'}</Button>}
              <Button className="sm deep" busy={organize.busy || working} disabled={dictation.trim().length < 20} onClick={doOrganize}>{data.aiEnabled ? 'Organizar com a Kary' : 'Usar o ditado no rascunho'}</Button>
              {!evo && <Button type="button" className="sm ghost" onClick={() => setEvo({ ...EMPTY })}>Preencher manualmente</Button>}
            </div>
            <Alert error={organize.error && !Array.isArray(organize.error.details) ? organize.error : null} />
            {working && <div className="callout small mt" role="status">A Kary está organizando o ditado. Isso leva alguns segundos…</div>}
            {notice && <div className="callout small mt" role="status">{notice}</div>}
            {evo && (
              <div className="evo-form mt">
                {evo.pendencias.length > 0 && (
                  <div className="caution small"><strong>Confira antes de assinar (não foi dito):</strong>
                    <ul className="mb0">{evo.pendencias.map((p) => <li key={p}>{p}</li>)}</ul></div>
                )}
                {EVO_SECTIONS.map(([k, l]) => (
                  <Field key={k} label={l}>
                    <textarea rows={k === 'avaliacao' || k === 'procedimentos' ? 4 : 2} value={(evo as any)[k]} maxLength={4000} onChange={(ev) => setEvo({ ...evo, [k]: ev.target.value })} />
                  </Field>
                ))}
                <label className="choice mandatory"><input type="checkbox" checked={confirm} onChange={(ev) => setConfirm(ev.target.checked)} />
                  <span>Revisei a evolução: as informações conferem com o atendimento que realizei. Assino como responsável técnica pelo registro.</span></label>
                <Alert error={(save.error ?? sign.error) && !Array.isArray((save.error ?? sign.error)!.details) ? (save.error ?? sign.error) : null} />
                <div className="row">
                  <Button className="sm secondary" busy={save.busy} onClick={doSave}>Salvar rascunho</Button>
                  <Button className="sm green" busy={sign.busy} disabled={!confirm} onClick={doSign}>Assinar evolução</Button>
                </div>
              </div>
            )}
          </>
        )}
      </section>

      <section className="flow-card mt">
        <h2>3. Assinatura do paciente ou responsável</h2>
        {e.patientSignedAt ? <div className="success" role="status"><IconCheck size={18} /> Assinado por {e.patientSignatureName} em {new Date(e.patientSignedAt).toLocaleString('pt-BR')}.</div>
          : !signed ? <p className="muted">Depois que você assinar a evolução, o paciente ou responsável confirma o atendimento no app dele.</p>
          : <><p className="muted">Peça ao paciente ou responsável para abrir o pedido no app e tocar em <strong>Assinar atendimento</strong>. Esta tela atualiza sozinha.</p><SignatureWatcher /></>}
      </section>

      <section className="flow-card mt">
        <h2>4. Concluir</h2>
        {e.status === 'CONCLUIDO' ? (
          <div className="success" role="status"><IconCheck size={18} /> Atendimento concluído em {new Date(e.completedAt).toLocaleString('pt-BR')}. O repasse segue para validação da ONEMA.</div>
        ) : (
          <>
            <p className="muted">A conclusão libera o repasse do atendimento (após a validação da ONEMA) e pede a avaliação do paciente.</p>
            <Alert error={complete.error} />
            <Button className="green" busy={complete.busy} disabled={!signed || !e.patientSignedAt} onClick={doComplete}>Registrar conclusão</Button>
            {(!signed || !e.patientSignedAt) && <p className="small muted">Disponível depois da sua assinatura da evolução e da assinatura do paciente ou responsável.</p>}
          </>
        )}
      </section>
      <VisitInfo eventId={id!} visit={data.visit} />
      <section className="flow-card mt">
        <h2>Life Score <span className="small muted">(opcional)</span></h2>
        <p className="small muted">Índice descritivo a partir dos 5 itens que você confirma. Não é necessário para concluir o atendimento.</p>
        <Link className="btn sm deep" to={`/especialista/atendimentos/${id}/lifescore`}>Abrir Life Score</Link>
      </section>
      {signed && <CarePlanEditor eventId={id!} />}
      <PopPanel eventId={id!} active={['ACEITO', 'CONCLUIDO'].includes(e.status)} />
      <p className="small"><Link to="/especialista#ofertas">Voltar aos meus atendimentos</Link></p>
      </>)}
    </div>
  );
}

/**
 * Agendamento (ajuste 09): proposta da especialista e resposta do paciente com o mesmo estado e versão nas duas telas.
 * Pedido de alteração só vira horário combinado depois do aceite; qualquer remarcação cria nova proposta rastreável.
 */
function SpecialistSchedule({ id, e, onChange }: { id: string; e: any; onChange: () => void }) {
  const sched = useSubmit<any>(); const acc = useSubmit<any>();
  const [when, setWhen] = useState(toLocalInput(e.callScheduledAt ?? new Date(Date.now() + 3600_000).toISOString()));
  if (e.status !== 'ACEITO') return null;
  const s = e.schedule;
  return (
    <div className="schedule-box" role="region" aria-label="Agendamento">
      <h3 className="h4">Agendamento</h3>
      {s ? (
        <dl className="kv small">
          <dt>Proposta</dt><dd>{new Date(s.proposedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</dd>
          <dt>Status</dt><dd><strong>{s.label}</strong>{s.respondedAt && s.status === 'CONFIRMADO' ? ` (resposta em ${new Date(s.respondedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })})` : ''}</dd>
          {s.status === 'ALTERACAO_SOLICITADA' && <><dt>Nova proposta</dt><dd><strong>{new Date(s.changeRequestedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</strong> · pendente de resposta: você</dd></>}
          {s.status === 'AGUARDANDO_PACIENTE' && <><dt>Pendente de resposta</dt><dd>paciente</dd></>}
        </dl>
      ) : <p className="small muted">Combine o horário com o paciente: ele confirma ou pede alteração pelo app.</p>}
      {s?.status === 'ALTERACAO_SOLICITADA' && (
        <Button className="sm green" busy={acc.busy} onClick={async () => { await acc.run('POST', `/api/care/specialist/events/${id}/schedule/accept-change`, { rev: s.rev }, { idempotent: true }); onChange(); }}>
          {acc.busy ? 'Confirmando…' : 'Aceitar nova data'}</Button>
      )}
      {!e.callStartedAt && !e.startedAt && (
        <div className="row mt">
          <input type="datetime-local" value={when} onChange={(ev) => setWhen(ev.target.value)} aria-label="Data e hora do atendimento" />
          <Button className="sm secondary" busy={sched.busy} onClick={async () => { if (await sched.run('POST', `/api/care/specialist/events/${id}/call-schedule`, { startAt: fromLocalInput(when) }, { idempotent: true })) onChange(); }}>
            {s ? 'Remarcar' : 'Combinar horário'}</Button>
        </div>
      )}
      <Alert error={sched.error ?? acc.error} />
    </div>
  );
}

const TW: Record<string, string> = { MANHA: 'manhã (8h–12h)', TARDE: 'tarde (12h–18h)', NOITE: 'noite (18h–21h)', QUALQUER: 'qualquer horário' };
/** Dados do paciente para a visita, pedido médico/exames (somente leitura) e orientação de materiais. */
function VisitInfo({ eventId, visit }: { eventId: string; visit: any }) {
  const docs = useApi<any>(`/api/care/specialist/events/${eventId}/documents`);
  const send = useSubmit<any>();
  const [text, setText] = useState('');
  if (!visit) return null;
  const g = docs.data?.guidance;
  const ad = visit.address;
  return (
    <section className="flow-card mt">
      <h2>Paciente e local</h2>
      <dl className="kv small">
        <dt>Paciente</dt><dd>{visit.patientName}</dd>
        <dt>Data de nasc.</dt><dd>{visit.patientBirthDate ? new Date(`${visit.patientBirthDate}T12:00:00`).toLocaleDateString('pt-BR') : 'Não informada'} <span className="small muted">(confirme com o paciente no início)</span></dd>
        <dt>Telefone</dt><dd><a href={`tel:${String(visit.phone).replace(/[^0-9+]/g, '')}`}>{visit.phone}</a></dd>
        <dt>Endereço</dt><dd>{ad ? `${ad.street}, ${ad.number}${ad.complement ? ` – ${ad.complement}` : ''} · ${ad.district} · ${ad.city} · CEP ${ad.cep}${ad.reference ? ` · ref.: ${ad.reference}` : ''}` : visit.location}</dd>
        <dt>Preferência</dt><dd>{visit.whenDate ? visit.whenDate.split('-').reverse().join('/') : visit.whenPref?.toLowerCase().replace('_', ' ')}{visit.timeWindow ? ` · ${TW[visit.timeWindow]}` : ''}</dd>
        {visit.notes && <><dt>Observação</dt><dd>{visit.notes}</dd></>}
      </dl>
      <h3>Pedido médico e exames</h3>
      {!docs.data ? <Loading lines={1} /> : !docs.data.documents.length ? <p className="small muted">Nenhum anexo do paciente.</p> : (
        <ul className="list small">{docs.data.documents.map((d: any) => <li key={d.id}><DocLink url={`/api/care/specialist/events/${eventId}/documents/${d.id}`} name={d.filename} /> · {d.kind === 'EXAME' ? 'exame' : 'pedido médico'} (somente leitura)</li>)}</ul>
      )}
      {g && g.status !== 'NAO_APLICAVEL' && (
        <>
          <h3>Orientação de materiais</h3>
          <p className="small">{g.status === 'SOLICITADA' ? 'O paciente pediu orientação: envie a lista de materiais e links para compra.' : g.status === 'ENVIADA' ? `Orientação enviada em ${new Date(g.at).toLocaleString('pt-BR')}. Aguardando o paciente confirmar.` : 'O paciente confirmou que providenciou os materiais.'}</p>
          {g.text && <p className="small pre-wrap">{g.text}</p>}
          {g.status !== 'MATERIAIS_CONFIRMADOS' && <>
            <Field label={g.text ? 'Atualizar orientação' : 'Lista de materiais e links'}><textarea rows={3} value={text} maxLength={3000} onChange={(e) => setText(e.target.value)} placeholder="Ex.: 10 gazes estéreis, soro fisiológico 0,9% 250 ml, luvas de procedimento. Links: …" /></Field>
            <Alert error={send.error} />
            <Button className="sm deep" busy={send.busy} disabled={text.trim().length < 10} onClick={async () => { const r = await send.run('POST', '/api/care/requests/' + docs.data.requestId + '/guidance', { text }); if (r) { setText(''); docs.reload(); } }}>Enviar orientação ao paciente</Button>
          </>}
        </>
      )}
    </section>
  );
}

/** Atendimento online (remoto): horário combinado, link por e-mail e sala de vídeo (até 30 min de sessão), com aviso de presença. */
function OnlineCallCard({ id, e, onChange }: { id: string; e: any; onChange: () => void }) {
  const call = useSubmit<any>(); const end = useSubmit<any>();
  if (e.status !== 'ACEITO') return <p className="muted">Atendimento online{e.callEndedAt ? ` · chamada encerrada em ${new Date(e.callEndedAt).toLocaleString('pt-BR')}` : ''}.</p>;
  const opensAt = e.callScheduledAt ? new Date(e.callScheduledAt).getTime() - 30 * 60_000 : Infinity;
  return (
    <div>
      <p className="muted">Atendimento online: combine o horário; paciente e você recebem o link por e-mail e aviso no app. A chamada dura até 30 minutos (a partir de quando os dois estão na sala), sem gravação.</p>
      <SpecialistSchedule id={id} e={e} onChange={onChange} />
      {e.callScheduledAt && !e.callEndedAt && (
        <div className="mt">
          <VideoCall busy={call.busy} error={call.error} onLeave={onChange} role="ESPECIALISTA" presenceUrl={Date.now() >= opensAt ? `/api/care/events/${id}/call/presence` : undefined}
            enter={async () => { const r = await call.run('POST', `/api/care/events/${id}/call`); return r ? r.video : null; }} />
          {e.callStartedAt && <Button className="sm secondary mt" busy={end.busy} onClick={async () => { if (await end.run('POST', `/api/care/specialist/events/${id}/call-end`)) onChange(); }}>Encerrar chamada</Button>}
          <Alert error={end.error} />
        </div>
      )}
      {e.callEndedAt && <div className="success" role="status"><IconCheck size={18} /> Chamada encerrada. Registre e assine a evolução abaixo.</div>}
    </div>
  );
}
