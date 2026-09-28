import { useState } from 'react';
import { useParams } from 'react-router-dom';
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
    </>
  );
}
