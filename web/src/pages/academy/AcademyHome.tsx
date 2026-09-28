import { Link } from 'react-router-dom';
import { COURSE_STATE, date, label, money } from '../../lib/format';
import { useApi, useSubmit } from '../../lib/hooks';
import { Alert, Badge, Button, ErrorState, Loading, PageHeader, Pending, Progress } from '../../ui/ui';
import { IconAward, IconBook, IconLock } from '../../ui/icons';

/** ACA-001 Entrada + ACA-002 Minha Jornada + ACA-010 Pagamento da jornada */
export function AcademyHome() {
  const { data, error, loading, reload } = useApi<any>('/api/academy/journey');
  const order = useSubmit<any>();
  const pay = useSubmit<any>();
  const enroll = useSubmit<any>();
  if (loading && !data) return <><Header /><Loading /></>;
  if (error) return <><Header /><ErrorState error={error} onRetry={reload} /></>;
  const j = data;
  const approved = j.courses.filter((c: any) => c.state === 'APROVADO').length;
  const paid = j.payment?.status === 'PAGO';
  const needsPayment = j.requirePayment && !paid;

  async function createOrder() { const r = await order.run('POST', '/api/academy/payment-orders', {}, { idempotent: true }); if (r) reload(); }
  async function sandbox(outcome: 'APROVADO' | 'RECUSADO') { const r = await pay.run('POST', `/api/academy/payment-orders/${j.payment.id}/sandbox-pay`, { outcome }); if (r) reload(); }
  async function start() { const r = await enroll.run('POST', '/api/academy/enrollments', {}, { idempotent: true }); if (r) reload(); }

  return (
    <>
      <Header />
      <div className="callout"><strong>Importante:</strong> {j.notice}</div>

      {!j.enrollment && (
        <section className="surface">
          <h2>Antes de começar</h2>
          <ol className="stack" style={{ paddingLeft: 18 }}>
            <li>
              <strong>Elegibilidade ONEMA ONE:</strong>{' '}
              {j.eligible ? <Badge>Confirmada</Badge> : <Badge tone="orange">Não confirmada</Badge>}
              {!j.eligible && <p className="small muted mb0">Sua elegibilidade é registrada pela equipe ONEMA. Procure o credenciamento se acreditar que já deveria estar liberado.</p>}
            </li>
            {j.requirePayment && (
              <li>
                <strong>Taxa de acesso à Jornada de Integração:</strong> {money(j.fee.amountCents)}{' '}
                {j.payment ? <Badge tone={paid ? '' : j.payment.status === 'PENDENTE' ? 'orange' : 'red'}>{label(j.payment.status)}</Badge> : <Badge tone="dark">Não iniciado</Badge>}
                <p className="small muted mb0">O pagamento libera o acesso comercial aos quatro cursos. Não equivale a aprovação, certificado ou aptidão.</p>
                <Alert error={order.error || pay.error} />
                {(!j.payment || ['RECUSADO', 'CANCELADO', 'ESTORNADO'].includes(j.payment.status)) && (
                  <Button className="mt" busy={order.busy} onClick={createOrder}>Gerar pedido de {money(j.fee.amountCents)}</Button>
                )}
                {j.payment?.status === 'PENDENTE' && (
                  <div className="surface mt" style={{ background: '#FFFBF3' }}>
                    <span className="demo-flag">SANDBOX</span>
                    <p className="small">Integração com gateway real não autorizada nesta entrega (P-009). Simule o retorno do provedor:</p>
                    <div className="row">
                      <Button className="sm" busy={pay.busy} onClick={() => sandbox('APROVADO')}>Simular pagamento aprovado</Button>
                      <Button className="sm secondary" busy={pay.busy} onClick={() => sandbox('RECUSADO')}>Simular recusa</Button>
                    </div>
                  </div>
                )}
              </li>
            )}
          </ol>
          <Alert error={enroll.error} />
          <Button className="deep mt" busy={enroll.busy} disabled={!j.eligible || needsPayment} onClick={start}>Iniciar Jornada de Integração</Button>
        </section>
      )}

      {j.enrollment && (
        <section className="surface">
          <div className="row between">
            <div>
              <div className="eyebrow">Minha Jornada · {j.enrollment.journeyVersion}</div>
              <h2 className="mb0">{approved} de {j.courses.length} cursos aprovados</h2>
            </div>
            <Badge tone={j.enrollment.state === 'CONCLUIDA' ? '' : 'blue'}>{label(j.enrollment.state)}</Badge>
          </div>
          <div className="mt"><Progress value={(approved / j.courses.length) * 100} label="Progresso da jornada" /></div>
          <p className="small muted mt mb0">Iniciada em {date(j.enrollment.startedAt)}{j.enrollment.completedAt && ` · concluída em ${date(j.enrollment.completedAt)}`}</p>
        </section>
      )}

      <div className="grid">
        {j.courses.map((c: any, i: number) => {
          const st = COURSE_STATE[c.state];
          const locked = c.state === 'BLOQUEADO' || !j.enrollment;
          const inner = (
            <div className="course-card">
              <div className={`course-num ${c.state === 'APROVADO' ? 'done' : locked ? 'locked' : ''}`}>{locked ? <IconLock /> : c.code}</div>
              <div>
                <div className="row between"><span className="eyebrow">{c.code}{c.version ? ` · v${c.version}` : ''}</span><Badge tone={st.tone}>{st.label}</Badge></div>
                <h3 style={{ margin: '4px 0 8px' }}>{c.title}</h3>
                {j.enrollment && c.lessonsTotal > 0 && (
                  <>
                    <Progress value={(c.lessonsDone / c.lessonsTotal) * 100} label={`Aulas concluídas em ${c.code}`} />
                    <p className="small muted mb0">{c.lessonsDone}/{c.lessonsTotal} aulas · atividade: {c.activityRequired === 1 ? (c.activityDone ? 'concluída' : 'obrigatória') : c.activityRequired === 0 ? 'não exigida' : 'pendente de definição'}
                      {c.assessment.maxAttempts ? ` · tentativas ${c.assessment.attemptsUsed}/${c.assessment.maxAttempts}` : ''}</p>
                  </>
                )}
                {j.enrollment && c.pending.length > 0 && c.state !== 'APROVADO' && (
                  <ul className="small" style={{ margin: '8px 0 0', paddingLeft: 18, color: 'var(--amber-ink)' }}>{c.pending.map((p: string) => <li key={p}>{p}</li>)}</ul>
                )}
              </div>
            </div>
          );
          return locked ? <div key={c.code} className="tile" aria-disabled="true" style={{ opacity: i > 0 && !j.enrollment ? 0.85 : 1 }}>{inner}</div>
            : <Link key={c.code} to={`/academy/cursos/${c.code}`} className="tile link">{inner}</Link>;
        })}
      </div>

      <div className="two mt">
        <section className="surface">
          <div className="row"><IconAward /><h2 className="mb0">Certificado</h2></div>
          <p className="mt">Situação: <Badge tone={j.certificate.state === 'EMITIDO' ? '' : 'dark'}>{label(j.certificate.state)}</Badge></p>
          {j.certificate.state === 'ELEGIVEL' || j.certificate.state === 'EMITIDO' || j.certificate.state === 'REVOGADO'
            ? <Link to="/academy/certificados" className="btn secondary">Ver certificados</Link>
            : <p className="small muted">Disponível após a aprovação nos quatro cursos da jornada.</p>}
        </section>
        <section className="surface">
          <div className="row"><IconBook /><h2 className="mb0">Capacitação e credenciamento</h2></div>
          <p className="mt mb0">Projeção de capacitação: <strong>{label(j.training?.journey_state ?? 'NAO_INICIADA')}</strong></p>
          <p>Decisão de credenciamento: <strong>{label(j.training?.credentialing_decision ?? 'PENDENTE')}</strong></p>
          <p className="small muted">A decisão de credenciamento é humana e considera outros requisitos além da Academy.</p>
          <Link to="/academy/historico" className="btn ghost">Histórico educacional</Link>
        </section>
      </div>
      {!j.courses.some((c: any) => c.version) && <Pending>Nenhum curso publicado. O conteúdo das aulas (P-006) e as regras pendentes precisam ser aprovados pela ONEMA.</Pending>}
    </>
  );
}

function Header() {
  return (
    <PageHeader kicker="Área do Especialista · ONEMA ONE" title="ONEMA Academy">
      <p>Jornada de Integração: quatro cursos e 17 aulas sobre atendimento, segurança do paciente, Carteira Digital e operação ONEMA. Seu histórico educacional é separado do prontuário e da Carteira Digital dos pacientes.</p>
    </PageHeader>
  );
}
