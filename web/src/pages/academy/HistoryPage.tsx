import { dateTime, label } from '../../lib/format';
import { useApi } from '../../lib/hooks';
import { Badge, Empty, ErrorState, Loading, PageHeader } from '../../ui/ui';

/** ACA-008 Histórico educacional (somente dados educacionais). */
export function HistoryPage() {
  const { data, error, loading, reload } = useApi<any>('/api/academy/history');
  return (
    <>
      <PageHeader kicker="ONEMA Academy" title="Histórico educacional" back={{ to: '/academy', label: 'Minha Jornada' }}>
        <p>Matrículas, versões cursadas, tentativas, conclusões e certificados. Este histórico pertence ao seu dossiê educacional e não contém dados de pacientes.</p>
      </PageHeader>
      <div className="row mb0" style={{ marginBottom: 16 }}>
        <a className="btn secondary" href="/api/academy/history/export" download>Exportar meu histórico (JSON)</a>
      </div>
      {loading ? <Loading /> : error ? <ErrorState error={error} onRetry={reload} /> : !data.enrollments.length ? (
        <div className="surface"><Empty title="Você ainda não possui matrícula." /></div>
      ) : data.enrollments.map((e: any) => (
        <section key={e.id} className="surface">
          <div className="row between"><h2 className="mb0">{e.journey_version}</h2><Badge tone="blue">{label(e.state)}</Badge></div>
          <p className="small muted">Início {dateTime(e.started_at)}{e.completed_at && ` · conclusão ${dateTime(e.completed_at)}`}</p>
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Cursos e versões</caption>
              <thead><tr><th>Curso</th><th>Versão</th><th>Vinculado em</th><th>Resultado</th></tr></thead>
              <tbody>{e.courses.map((c: any) => <tr key={c.code}><td>{c.code} · {c.title}</td><td>v{c.version}</td><td>{dateTime(c.bound_at)}</td><td>{c.result ? label(c.result === 'APROVADO' ? 'APROVADA' : 'REPROVADA') : 'Em curso'}</td></tr>)}</tbody>
            </table>
          </div>
          <div className="two mt">
            <div>
              <h3>Aulas</h3>
              <ul className="list small">{e.lessons.map((l: any) => <li key={l.code}>{l.code} · {l.title} — {label(l.state)} {l.completed_at && `(${dateTime(l.completed_at)})`}</li>)}</ul>
            </div>
            <div>
              <h3>Tentativas</h3>
              <ul className="list small">
                {e.activityAttempts.map((t: any, i: number) => <li key={`a${i}`}>{t.title} v{t.version} · tentativa {t.attempt_no} — {label(t.state)}</li>)}
                {e.assessmentAttempts.map((t: any, i: number) => <li key={`s${i}`}>Avaliação {t.code} v{t.version} · tentativa {t.attempt_no} — {label(t.state)}{t.correct_count != null && ` (${t.correct_count}/${t.question_count})`}</li>)}
                {!e.activityAttempts.length && !e.assessmentAttempts.length && <li className="muted">Nenhuma tentativa registrada.</li>}
              </ul>
            </div>
          </div>
        </section>
      ))}
    </>
  );
}
