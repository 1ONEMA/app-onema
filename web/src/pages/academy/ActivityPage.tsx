import { useRef, useState } from 'react';
import './activity.css';
import { Link, useParams } from 'react-router-dom';
import { useApi, useSubmit } from '../../lib/hooks';
import { Alert, Badge, Button, ErrorState, Loading, PageHeader } from '../../ui/ui';

/** ACA-005 Atividade integradora: decisões sequenciais com feedback do roteiro aprovado. */
export function ActivityPage() {
  const { code } = useParams();
  const { data, error, loading, reload, setData } = useApi<any>(`/api/academy/courses/${code}/activity`);
  const start = useSubmit<any>();
  const decide = useSubmit<any>();
  const [choice, setChoice] = useState<Record<string, string>>({});
  if (loading && !data) return <Loading />;
  if (error) return <><PageHeader title="Atividade integradora" back={{ to: `/academy/cursos/${code}`, label: 'Voltar ao curso' }} /><ErrorState error={error} onRetry={reload} /></>;
  const a = data.activity;
  if (a.content) return <OfficialActivity code={code!} data={data} reload={reload} setData={setData} />;
  const attempt = a.attempt;
  const inProgress = attempt?.state === 'EM_ANDAMENTO';
  const solved = a.steps.filter((s: any) => s.solved).length;
  async function begin() { const r = await start.run('POST', `/api/academy/activities/${a.id}/attempts`, {}, { idempotent: true }); if (r) setData({ ...data, activity: r.activity }); }
  async function send(stepId: string) {
    const r = await decide.run('POST', `/api/academy/activity-attempts/${attempt.id}/decisions`, { stepId, optionId: choice[stepId] }, { idempotent: true });
    if (r) reload();
  }
  return (
    <>
      <PageHeader kicker={`${code} · versão ${a.version}`} title={a.title} back={{ to: `/academy/cursos/${code}`, label: 'Voltar ao curso' }}>
        <p>{a.intro}</p>
      </PageHeader>
      <section className="surface">
        <div className="row between">
          <div><strong>{solved}/{a.steps.length}</strong> decisões corretas{a.requiredCorrect ? ` (necessárias: ${a.requiredCorrect})` : ''}</div>
          {attempt && <Badge tone={attempt.state === 'CONCLUIDA' ? '' : 'blue'}>{attempt.state === 'CONCLUIDA' ? 'Atividade concluída' : `Tentativa ${attempt.attemptNo} em andamento`}</Badge>}
        </div>
        <p className="small muted mt mb0">Você pode revisar cada decisão após ler o feedback. As respostas são registradas no servidor.</p>
        <Alert error={start.error} />
        {(!attempt || attempt.state !== 'EM_ANDAMENTO') && attempt?.state !== 'CONCLUIDA' && <Button className="deep mt" busy={start.busy} onClick={begin}>Iniciar atividade</Button>}
      </section>
      <Alert error={decide.error} />
      {(inProgress || attempt?.state === 'CONCLUIDA') && a.steps.map((s: any) => (
        <section key={s.id} className="surface">
          <div className="row between"><span className="eyebrow">Decisão {s.order}</span>{s.solved ? <Badge>Correta</Badge> : s.tries ? <Badge tone="orange">Revise</Badge> : null}</div>
          <p><strong>{s.prompt}</strong></p>
          <fieldset className="radio-list" disabled={s.solved || !inProgress} style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="sr-only">Opções da decisão {s.order}</legend>
            {s.options.map((o: any) => (
              <label key={o.id} className={choice[s.id] === o.id ? 'selected' : ''}>
                <input type="radio" name={`step-${s.id}`} value={o.id} checked={(choice[s.id] ?? (s.solved ? s.lastDecision?.optionId : '')) === o.id} onChange={() => setChoice({ ...choice, [s.id]: o.id })} />
                <span>{o.text}</span>
              </label>
            ))}
          </fieldset>
          {s.lastDecision && <div className={s.lastDecision.correct ? 'success' : 'caution'} role="status"><strong>Feedback:</strong> {s.lastDecision.feedback}</div>}
          {!s.solved && inProgress && <Button className="sm" busy={decide.busy} disabled={!choice[s.id]} onClick={() => send(s.id)}>Confirmar decisão</Button>}
        </section>
      ))}
      {attempt?.state === 'CONCLUIDA' && (
        <section className="surface success-panel">
          <strong>Atividade concluída.</strong>
          <p className="mb0">Volte ao curso para seguir para a avaliação final.</p>
          <div className="row mt">
            <Link to={`/academy/cursos/${code}`} className="btn deep">Voltar ao curso</Link>
            <Link to="/academy" className="btn secondary">Ir para a Minha Jornada</Link>
          </div>
        </section>
      )}
    </>
  );
}

const audioUrl = (id: string) => `/academy/atividades/audio/${id}.mp3`;

/** Botão "Ouvir": narração do roteiro oficial (um áudio por vez, só por ação do usuário). */
function useNarration() {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  function toggle(id: string | null | undefined) {
    if (!id) return;
    if (!ref.current) { ref.current = new Audio(); ref.current.onended = () => setPlaying(null); ref.current.onerror = () => setPlaying(null); }
    const el = ref.current;
    if (playing === id) { el.pause(); setPlaying(null); return; }
    el.pause(); el.src = audioUrl(id); el.currentTime = 0;
    void el.play().then(() => setPlaying(id)).catch(() => setPlaying(null));
  }
  function stop() { ref.current?.pause(); setPlaying(null); }
  const Btn = ({ id, label = 'Ouvir' }: { id?: string | null; label?: string }) => !id ? null : (
    <button type="button" className={`listen-btn${playing === id ? ' on' : ''}`} aria-pressed={playing === id} onClick={() => toggle(id)}>
      <span aria-hidden="true">{playing === id ? '■' : '▶'}</span> {playing === id ? 'Parar' : label}
    </button>
  );
  return { Btn, stop };
}

/**
 * Atividade integradora oficial (RT, 26/11/2026): caso com cena ilustrada e narração, decisões em sequência com retorno
 * explicado e nova tentativa, transição após a resposta correta e síntese final com confirmação de leitura.
 */
function OfficialActivity({ code, data, reload, setData }: { code: string; data: any; reload: () => void; setData: (d: any) => void }) {
  const a = data.activity, c = a.content;
  const attempt = a.attempt;
  const start = useSubmit<any>(); const decide = useSubmit<any>(); const done = useSubmit<any>();
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [ack, setAck] = useState(false);
  const { Btn, stop } = useNarration();
  const inProgress = attempt?.state === 'EM_ANDAMENTO';
  const finished = attempt?.state === 'CONCLUIDA';
  const solvedN = a.steps.filter((s: any) => s.solved).length;
  const currentIdx = a.steps.findIndex((s: any) => !s.solved);
  async function begin() { const r = await start.run('POST', `/api/academy/activities/${a.id}/attempts`, {}, { idempotent: true }); if (r) setData({ ...data, activity: r.activity }); }
  async function send(stepId: string) { stop(); await decide.run('POST', `/api/academy/activity-attempts/${attempt.id}/decisions`, { stepId, optionId: choice[stepId] }, { idempotent: true }); reload(); }
  async function finish() { stop(); if (await done.run('POST', `/api/academy/activity-attempts/${attempt.id}/complete`, { acknowledged: true }, { idempotent: true })) reload(); }
  return (
    <>
      <PageHeader kicker={`${code} · atividade integradora`} title={a.title} back={{ to: `/academy/cursos/${code}`, label: 'Voltar ao curso' }}>
        <p>{c.objective}</p>
      </PageHeader>
      <section className="surface act-case">
        <img src={c.image} alt={`Cena do caso: ${a.title}`} className="act-scene" loading="lazy" />
        <div>
          <h2 className="h4">O caso</h2>
          <p>{c.caseText}</p>
          <p className="small muted"><strong>Participantes:</strong> {c.cast}</p>
          <div className="act-opening"><p className="mb0">{c.opening}</p><Btn id={c.openingAudio} label="Ouvir a abertura" /></div>
        </div>
      </section>
      <section className="surface">
        <div className="row between">
          <div><strong>{solvedN}/{a.steps.length}</strong> decisões resolvidas</div>
          {attempt && <Badge tone={finished ? '' : 'blue'}>{finished ? 'Atividade concluída' : `Tentativa ${attempt.attemptNo} em andamento`}</Badge>}
        </div>
        <div className="act-progress" aria-hidden="true"><span style={{ width: `${(solvedN / a.steps.length) * 100}%` }} /></div>
        <p className="small muted mt mb0">Leia ou ouça cada alternativa antes de escolher. Se a resposta não for a esperada, o retorno explica o motivo e você tenta de novo.</p>
        <Alert error={start.error} />
        {!inProgress && !finished && <Button className="deep mt" busy={start.busy} onClick={begin}>Iniciar atividade</Button>}
      </section>
      <Alert error={decide.error} />
      {(inProgress || finished) && a.steps.map((s: any, i: number) => {
        if (!s.solved && i !== currentIdx) return null;
        const current = i === currentIdx && inProgress;
        return (
          <section key={s.id} className={`surface act-step${s.solved ? ' solved' : ''}`}>
            <div className="row between"><span className="eyebrow">Decisão {s.order} de {a.steps.length}{s.title ? ` · ${s.title}` : ''}</span>{s.solved ? <Badge>Resolvida</Badge> : s.tries ? <Badge tone="orange">Revise</Badge> : null}</div>
            {s.scene && <div className="act-scene-text"><p className="mb0">{s.scene}</p><Btn id={s.sceneAudio} label="Ouvir a situação" /></div>}
            <p className="act-prompt"><strong>{s.prompt}</strong></p>
            <fieldset className="radio-list act-options" disabled={s.solved || !current}>
              <legend className="sr-only">Alternativas da decisão {s.order}</legend>
              {s.options.map((o: any) => {
                const picked = (choice[s.id] ?? (s.solved ? s.lastDecision?.optionId : '')) === o.id;
                return (
                  <div key={o.id} className={`act-option${picked ? ' selected' : ''}`}>
                    <label><input type="radio" name={`step-${s.id}`} value={o.id} checked={picked} onChange={() => setChoice({ ...choice, [s.id]: o.id })} /><span><strong>{o.id}.</strong> {o.text}</span></label>
                    <Btn id={o.audio} label="Ouvir" />
                  </div>
                );
              })}
            </fieldset>
            {s.lastDecision && (
              <div className={s.lastDecision.correct ? 'success' : 'caution'} role="status">
                <strong>{s.lastDecision.correct ? 'Retorno' : 'Revise'}:</strong> {s.lastDecision.feedback} <Btn id={s.lastDecision.feedbackAudio} label="Ouvir o retorno" />
              </div>
            )}
            {current && <Button className="deep" busy={decide.busy} disabled={!choice[s.id]} onClick={() => send(s.id)}>{decide.busy ? 'Confirmando…' : 'Confirmar decisão'}</Button>}
            {s.solved && s.transition && <div className="act-transition"><p className="mb0">{s.transition}</p><Btn id={s.transitionAudio} label="Ouvir a continuidade" /></div>}
          </section>
        );
      })}
      {inProgress && a.allSolved && c.closing && (
        <section className="surface act-closing">
          <h2 className="h4">Síntese</h2>
          <p>{c.closing}</p>
          <Btn id={c.closingAudio} label="Ouvir a síntese" />
          <label className="choice mandatory mt"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /><span>Li a síntese e confirmo a conclusão da atividade.</span></label>
          <Alert error={done.error} />
          <Button className="green mt" busy={done.busy} disabled={!ack} onClick={finish}>Confirmar conclusão</Button>
        </section>
      )}
      {finished && (
        <section className="surface success-panel">
          <strong>Atividade concluída.</strong>
          <p className="mb0">A atividade e a avaliação final são etapas diferentes. Siga para a avaliação final do curso.</p>
          <div className="row mt">
            <Link to={`/academy/cursos/${code}`} className="btn deep">Voltar ao curso</Link>
            <Link to="/academy" className="btn secondary">Ir para a Minha Jornada</Link>
          </div>
        </section>
      )}
    </>
  );
}
