import { Link, useNavigate, useParams } from 'react-router-dom';
import { COURSE_STATE, dateTime, label } from '../../lib/format';
import { useApi, useSubmit } from '../../lib/hooks';
import { Alert, Badge, Button, ErrorState, Loading, PageHeader, Pending, Progress } from '../../ui/ui';
import { IconCheck } from '../../ui/icons';

/** ACA-003 Detalhe do curso */
export function CoursePage() {
  const { code } = useParams();
  const nav = useNavigate();
  const { data, error, loading, reload } = useApi<any>(`/api/academy/courses/${code}`);
  const start = useSubmit<any>();
  if (loading && !data) return <Loading />;
  if (error) return <><PageHeader title={`Curso ${code}`} back={{ to: '/academy', label: 'Minha Jornada' }} /><ErrorState error={error} onRetry={reload} /></>;
  const d = data, c = d.course, st = COURSE_STATE[c.state];
  const a = d.assessment;
  const openAttempt = a.attempts.find((t: any) => ['CRIADA', 'EM_ANDAMENTO'].includes(t.state));
  async function startAssessment() {
    const r = await start.run('POST', `/api/academy/assessments/${a.id}/attempts`, {}, { idempotent: true });
    if (r) nav(`/academy/avaliacoes/${r.attempt.id}`);
  }
  return (
    <>
      <PageHeader kicker={`${c.code} · versão ${c.version}`} title={c.title} back={{ to: '/academy', label: 'Minha Jornada' }}>
        <div className="row"><Badge tone={st.tone}>{st.label}</Badge></div>
      </PageHeader>
      {d.objectives && <div className="callout">{d.objectives}</div>}
      <div className="two wide-left">
        <section className="surface">
          <h2>Aulas</h2>
          <Progress value={c.lessonsTotal ? (c.lessonsDone / c.lessonsTotal) * 100 : 0} label="Aulas concluídas" />
          <ol className="list mt">
            {d.lessons.map((l: any) => (
              <li key={l.code} className="row between">
                <div>
                  <span className="eyebrow">{l.code}</span>
                  <div><Link to={`/academy/aulas/${l.code}`}>{l.title}</Link></div>
                  {!l.contentAvailable && <span className="small" style={{ color: 'var(--amber-ink)' }}>Conteúdo pendente</span>}
                </div>
                {l.state === 'CONCLUIDA' ? <Badge><IconCheck size={14} /> Concluída</Badge> : <Badge tone={l.state === 'EM_ANDAMENTO' ? 'blue' : 'dark'}>{label(l.state)}{l.percent ? ` · ${l.percent}%` : ''}</Badge>}
              </li>
            ))}
          </ol>
        </section>
        <div>
          <section className="surface">
            <h2>Atividade integradora</h2>
            {d.activityRequired === 0 && <p className="muted">Não exigida neste curso.</p>}
            {d.activityRequired == null && <Pending>Obrigatoriedade da atividade ainda não definida.</Pending>}
            {d.activityRequired === 1 && (d.activity
              ? <>
                  <p>{c.activityDone ? <Badge>Concluída</Badge> : <Badge tone="orange">Obrigatória</Badge>}</p>
                  <Link className="btn secondary" to={`/academy/cursos/${c.code}/atividade`}>{c.activityDone ? 'Rever atividade' : 'Abrir atividade'}</Link>
                </>
              : <Pending>Roteiro da atividade pendente de aprovação.</Pending>)}
          </section>
          <section className="surface">
            <h2>Avaliação final</h2>
            {!a.ready ? (
              <Pending>Falta definir: {a.missing.join('; ')}.{a.sourceNote && <><br /><span className="small">{a.sourceNote}</span></>}</Pending>
            ) : (
              <>
                <ul className="list small">
                  <li>{a.questionCount} questões · aprovação com no mínimo {a.passMinCorrect} acertos</li>
                  <li>Até {a.maxAttempts} tentativas · usadas: {a.attempts.filter((t: any) => t.state !== 'INVALIDADA').length}</li>
                </ul>
                <Alert error={start.error} />
                {c.state === 'APROVADO' ? <div className="success">Você foi aprovado neste curso.</div>
                  : c.state === 'REPROVADO' ? <div className="danger">Limite de tentativas atingido. Procure o suporte da Academy para orientação.</div>
                  : openAttempt ? <Link className="btn deep" to={`/academy/avaliacoes/${openAttempt.id}`}>Continuar tentativa {openAttempt.attemptNo}</Link>
                  : <Button className="deep" busy={start.busy} disabled={c.state !== 'AGUARDANDO_AVALIACAO'} onClick={startAssessment}>Iniciar avaliação</Button>}
                {c.state !== 'AGUARDANDO_AVALIACAO' && c.state !== 'APROVADO' && c.state !== 'REPROVADO' && !openAttempt && (
                  <p className="small muted mt">Disponível após concluir todas as aulas{d.activityRequired === 1 ? ' e a atividade integradora' : ''}.</p>
                )}
              </>
            )}
            {a.attempts.length > 0 && (
              <ul className="list small mt">
                {a.attempts.map((t: any) => (
                  <li key={t.id} className="row between"><span>Tentativa {t.attemptNo} · {dateTime(t.submittedAt)}</span>
                    <span>{t.correct != null && `${t.correct}/${a.questionCount} · `}<Badge tone={t.state === 'APROVADA' ? '' : t.state === 'REPROVADA' ? 'red' : 'blue'}>{label(t.state)}</Badge></span></li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
