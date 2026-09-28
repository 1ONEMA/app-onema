import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { label } from '../../lib/format';
import { useApi, useSubmit } from '../../lib/hooks';
import { Alert, Badge, Button, Dialog, ErrorState, Loading, PageHeader } from '../../ui/ui';
import { IconCheck } from '../../ui/icons';

/** ACA-006 Avaliação final + ACA-007 Resultado. Respostas ficam só em memória até a submissão confirmada. */
export function AssessmentPage() {
  const { attemptId } = useParams();
  const { data, error, loading, reload, setData } = useApi<any>(`/api/academy/assessment-attempts/${attemptId}`);
  const submit = useSubmit<any>();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState(false);
  // Submissão concluída em outra sessão: recarrega o resultado oficial do servidor (ACA-T022)
  useEffect(() => { if (submit.error?.code === 'ATTEMPT_ALREADY_SUBMITTED') reload(); }, [submit.error, reload]);
  if (loading && !data) return <Loading />;
  if (error) return <><PageHeader title="Avaliação" back={{ to: '/academy', label: 'Minha Jornada' }} /><ErrorState error={error} onRetry={reload} /></>;
  const t = data.attempt;
  const course = data.courseCode;
  const open = ['CRIADA', 'EM_ANDAMENTO'].includes(t.state);
  const answered = open ? t.questions.filter((q: any) => answers[q.questionId]).length : 0;
  async function send() {
    setConfirm(false);
    const r = await submit.run('POST', `/api/academy/assessment-attempts/${t.id}/submit`, {
      answers: t.questions.map((q: any) => ({ questionId: q.questionId, optionId: answers[q.questionId] })),
    }, { idempotent: true });
    if (r) setData({ ...data, attempt: r.attempt });
  }
  return (
    <>
      <PageHeader kicker={`${course} · avaliação v${t.assessment.version} · tentativa ${t.attemptNo}`} title={open ? 'Avaliação final' : 'Resultado da avaliação'} back={{ to: `/academy/cursos/${course}`, label: 'Voltar ao curso' }}>
        <p>{t.assessment.questionCount} questões · aprovação com no mínimo {t.assessment.passMinCorrect} acertos{t.assessment.criticalGate ? ' e todas as questões críticas corretas' : ''}.</p>
      </PageHeader>
      {!open && t.result && (
        <section className="surface" aria-live="polite">
          <div className="row between">
            <h2 className="mb0">{t.state === 'APROVADA' ? 'Aprovado' : 'Não aprovado nesta tentativa'}</h2>
            <Badge tone={t.state === 'APROVADA' ? '' : 'red'}>{label(t.state)}</Badge>
          </div>
          <span className="value mt">{t.result.correct}/{t.result.total} acertos</span>
          <ul className="list">
            {t.result.rules.map((r: any) => <li key={r.rule} className="row"><span aria-hidden>{r.met ? <IconCheck size={18} /> : '✕'}</span> {r.rule} — <strong>{r.met ? 'atendido' : 'não atendido'}</strong></li>)}
          </ul>
          <p className="small muted">O gabarito não é exibido. Revise as aulas do curso antes de uma nova tentativa.</p>
          <Link to={`/academy/cursos/${course}`} className="btn deep">Próximo passo</Link>
        </section>
      )}
      {!open && !t.result && <section className="surface"><p>Esta tentativa está em estado: {label(t.state)}.</p></section>}
      {open && (
        <>
          <div className="caution small">Suas respostas só são registradas ao enviar. Se a conexão cair, nada é aprovado localmente: reconecte-se e envie novamente — a mesma submissão é reaproveitada, sem duplicidade.</div>
          <Alert error={submit.error} />
          {t.questions.map((q: any) => (
            <fieldset key={q.questionId} className="surface" style={{ margin: '0 0 16px' }}>
              <legend className="eyebrow" style={{ padding: 0 }}>Questão {q.number}</legend>
              <p><strong>{q.stem}</strong></p>
              <div className="radio-list">
                {q.options.map((o: any) => (
                  <label key={o.id} className={answers[q.questionId] === o.id ? 'selected' : ''}>
                    <input type="radio" name={q.questionId} value={o.id} checked={answers[q.questionId] === o.id} onChange={() => setAnswers({ ...answers, [q.questionId]: o.id })} />
                    <span>{o.text}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          <div className="surface row between" style={{ position: 'sticky', bottom: 76 }}>
            <span><strong>{answered}/{t.questions.length}</strong> respondidas</span>
            <Button className="deep" busy={submit.busy} disabled={answered !== t.questions.length} onClick={() => setConfirm(true)}>Enviar respostas</Button>
          </div>
          <Dialog open={confirm} title="Enviar avaliação?" onClose={() => setConfirm(false)}>
            <p>Após o envio, esta tentativa será corrigida e não poderá ser alterada.</p>
            <div className="row"><Button className="deep" onClick={send}>Confirmar envio</Button><Button className="ghost" onClick={() => setConfirm(false)}>Revisar</Button></div>
          </Dialog>
        </>
      )}
    </>
  );
}
