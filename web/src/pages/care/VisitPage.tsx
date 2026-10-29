import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApi, useSubmit } from '../../lib/hooks';
import { Alert, Badge, Button, ErrorState, Field, Loading, PageHeader, fieldError } from '../../ui/ui';
import { IconCheck, IconShield } from '../../ui/icons';
import { EVO_SECTIONS } from './WalletPage';

type Evo = { relato: string; sinaisVitais: string; avaliacao: string; procedimentos: string; orientacoes: string; plano: string; observacoes: string; pendencias: string[] };
const EMPTY: Evo = { relato: '', sinaisVitais: '', avaliacao: '', procedimentos: '', orientacoes: '', plano: '', observacoes: '', pendencias: [] };

/** Reconhecimento de voz do navegador (Chrome/Android e Safari/iOS). Sem suporte, a enfermeira digita ou usa o microfone do teclado. */
function useDictation(onText: (t: string) => void) {
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

/** Atendimento da especialista: início com o código do paciente, evolução ditada e organizada pela Kary, assinatura e conclusão. */
export function VisitPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data, error, loading, reload } = useApi<any>(`/api/care/specialist/events/${id}/evolution`);
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
  const mic = useDictation((t) => setDictation((d) => (d ? `${d} ${t}` : t)));
  useEffect(() => { document.title = 'Atendimento · ONEMA ONE'; }, []);
  useEffect(() => {
    if (data?.evolution) { setEvo({ ...EMPTY, ...data.evolution.content }); setDictation((d) => d || data.evolution.dictation || ''); }
  }, [data?.evolution?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
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
    if (r) { setEvo({ ...EMPTY, ...r.evolution.content }); setNotice(r.message); }
  }
  async function doSave() { if (evo && await save.run('PUT', `/api/care/specialist/events/${id}/evolution`, { dictation, content: evo })) setNotice('Rascunho salvo.'); }
  async function doSign() { if (evo && await sign.run('POST', `/api/care/specialist/events/${id}/evolution/sign`, { content: evo, confirm })) { setNotice(null); reload(); } }
  async function doComplete() { if (await complete.run('POST', `/api/care/specialist/events/${id}/complete`, {})) nav('/especialista#ofertas'); }

  return (
    <div className="flow">
      <PageHeader kicker="Atendimento ONEMA ONE" title={e.label} back={{ to: '/especialista#ofertas', label: 'Meus atendimentos' }}>
        <p>{e.itemName} · {e.modality === 'REMOTO' ? 'remoto' : 'presencial'}</p>
      </PageHeader>

      <section className="flow-card">
        <h2>1. Iniciar o atendimento</h2>
        {e.modality !== 'PRESENCIAL' ? <p className="muted">Atendimento remoto: não exige código de início.</p>
          : e.startedAt ? <div className="success" role="status"><IconCheck size={18} /> Atendimento iniciado e confirmado com o código do paciente.</div> : (
          <>
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
              <Button className="sm deep" busy={organize.busy} disabled={dictation.trim().length < 20} onClick={doOrganize}>{data.aiEnabled ? 'Organizar com a Kary' : 'Usar o ditado no rascunho'}</Button>
              {!evo && <Button type="button" className="sm ghost" onClick={() => setEvo({ ...EMPTY })}>Preencher manualmente</Button>}
            </div>
            <Alert error={organize.error && !Array.isArray(organize.error.details) ? organize.error : null} />
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
        <h2>3. Concluir</h2>
        <p className="muted">A conclusão libera o repasse do atendimento e pede a avaliação do paciente.</p>
        <Alert error={complete.error} />
        <Button className="green" busy={complete.busy} disabled={!signed} onClick={doComplete}>Registrar conclusão</Button>
        {!signed && <p className="small muted">Disponível depois de assinar a evolução.</p>}
      </section>
      <p className="small"><Link to="/especialista#ofertas">Voltar aos meus atendimentos</Link></p>
    </div>
  );
}
