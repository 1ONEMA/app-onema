import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import { date, dateTime, label, money } from '../../lib/format';
import { useApi, useSubmit } from '../../lib/hooks';
import { Alert, Badge, Button, Dialog, Empty, ErrorState, Field, Loading, PageHeader } from '../../ui/ui';

export function CredentialingPage() {
  const { has } = useAuth();
  const { data, error, loading, reload } = useApi<any>('/api/admin/academy/training-status');
  const decide = useSubmit<any>();
  const [sel, setSel] = useState<any>(null);
  const [f, setF] = useState({ decision: 'PENDENTE', note: '', otherGatesConfirmed: false });
  return (
    <>
      <PageHeader kicker="ONEMA ONE" title="Credenciamento"><p>A Academy atualiza somente a projeção de capacitação. Pagamento ou conclusão nunca geram aptidão automática: a decisão é humana e registrada.</p></PageHeader>
      {loading ? <Loading /> : error ? <ErrorState error={error} onRetry={reload} /> : (
        <section className="surface">
          {!data.partners.length ? <Empty title="Nenhum especialista cadastrado." /> : (
            <div className="table-wrap" tabIndex={0}><table><thead><tr><th>Especialista</th><th>Elegível ONEMA ONE</th><th>Jornada</th><th>Conclusão</th><th>Decisão</th><th /></tr></thead>
              <tbody>{data.partners.map((p: any) => <tr key={p.id}><td>{p.name}<br /><span className="small muted">{p.email}</span></td><td>{p.academy_eligible ? 'Sim' : 'Não'}</td><td>{label(p.journey_state ?? 'NAO_INICIADA')}</td><td>{date(p.completed_at)}</td>
                <td><Badge tone={p.credentialing_decision === 'APTO' ? '' : p.credentialing_decision === 'NAO_APTO' ? 'red' : 'orange'}>{label(p.credentialing_decision ?? 'PENDENTE')}</Badge>{p.decided_at && <div className="small muted">{dateTime(p.decided_at)}</div>}</td>
                <td>{has('CREDENCIAMENTO') && p.journey_state && <Button className="sm secondary" onClick={() => { setSel(p); setF({ decision: p.credentialing_decision ?? 'PENDENTE', note: '', otherGatesConfirmed: false }); }}>Registrar decisão</Button>}</td></tr>)}</tbody></table></div>
          )}
        </section>
      )}
      <Dialog open={!!sel} title={`Decisão · ${sel?.name}`} onClose={() => setSel(null)}>
        <Field label="Decisão"><select value={f.decision} onChange={(e) => setF({ ...f, decision: e.target.value })}><option value="PENDENTE">Pendente</option><option value="APTO">Apto</option><option value="NAO_APTO">Não apto</option></select></Field>
        <Field label="Justificativa"><textarea value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        <label className="choice"><input type="checkbox" checked={f.otherGatesConfirmed} onChange={(e) => setF({ ...f, otherGatesConfirmed: e.target.checked })} /><span>Confirmo que os demais requisitos de credenciamento foram verificados (regra formal pendente — P-010).</span></label>
        <Alert error={decide.error} />
        <Button className="deep" busy={decide.busy} onClick={async () => { if (await decide.run('POST', `/api/admin/academy/training-status/${sel.id}/decision`, f)) { setSel(null); reload(); } }}>Registrar</Button>
      </Dialog>
    </>
  );
}

export function SupportPage() {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const { data, error, loading, reload } = useApi<any>(`/api/admin/academy/partners?q=${encodeURIComponent(query)}`);
  const tickets = useApi<any>('/api/admin/support-tickets');
  const open = useSubmit<any>();
  const close = useSubmit<any>();
  const { has } = useAuth();
  const [t, setT] = useState<any>(null);
  return (
    <>
      <PageHeader kicker="ONEMA Academy" title="Suporte"><p>Estado técnico do parceiro (sem notas, respostas ou gabarito). O suporte orienta e registra chamados; não altera nota, conclusão ou aptidão.</p></PageHeader>
      <form className="surface row" onSubmit={(e) => { e.preventDefault(); setQuery(q); }}>
        <input type="search" placeholder="Nome ou e-mail do especialista" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} aria-label="Buscar especialista" />
        <Button type="submit" className="deep">Buscar</Button>
      </form>
      {loading ? <Loading /> : error ? <ErrorState error={error} onRetry={reload} /> : data.partners.map((p: any) => (
        <section key={p.id} className="surface">
          <div className="row between"><div><strong>{p.name}</strong> <span className="small muted">{p.email}</span></div>
            {has('SUPORTE_ACADEMY') && <Button className="sm secondary" onClick={() => setT({ userId: p.id, name: p.name, category: 'ACESSO', description: '' })}>Registrar chamado</Button>}</div>
          <p className="small">Elegível: {p.academy_eligible ? 'sim' : 'não'} · Matrícula: {label(p.enrollment?.state ?? 'NAO_INICIADA')} · Pagamento: {label(p.payment?.status) } · Chamados abertos: {p.openTickets}</p>
          {p.courses.length > 0 && <div className="row">{p.courses.map((c: any) => <Badge key={c.code} tone="dark">{c.code}: {label(c.state)} · {c.lessonsDone}/{c.lessonsTotal} aulas · {c.attemptsUsed} tentativas</Badge>)}</div>}
        </section>
      ))}
      <section className="surface">
        <h2>Chamados</h2>
        <Alert error={close.error} />
        {!tickets.data?.tickets.length ? <p className="muted">Nenhum chamado.</p> : (
          <ul className="list">{tickets.data.tickets.map((x: any) => <li key={x.id}><div className="row between"><strong>{x.subject_name} · {x.category}</strong><Badge tone={x.status === 'ABERTO' ? 'orange' : 'dark'}>{x.status === 'ABERTO' ? 'Aberto' : 'Encerrado'}</Badge></div>
            <p className="small mb0">{x.description}</p><span className="small muted">{dateTime(x.created_at)} por {x.opened_by_name}</span>
            {x.status === 'ABERTO' && has('SUPORTE_ACADEMY') && <div><Button className="sm ghost" busy={close.busy} onClick={async () => { if (await close.run('POST', `/api/admin/support-tickets/${x.id}/close`, {})) tickets.reload(); }}>Encerrar</Button></div>}</li>)}</ul>
        )}
      </section>
      <Dialog open={!!t} title={`Chamado · ${t?.name}`} onClose={() => setT(null)}>
        <Field label="Categoria"><select value={t?.category} onChange={(e) => setT({ ...t, category: e.target.value })}>{['ACESSO', 'PAGAMENTO', 'PROGRESSO', 'CERTIFICADO', 'OUTRO'].map((c) => <option key={c}>{c}</option>)}</select></Field>
        <Field label="Descrição"><textarea value={t?.description ?? ''} onChange={(e) => setT({ ...t, description: e.target.value })} /></Field>
        <Alert error={open.error} />
        <Button className="deep" busy={open.busy} onClick={async () => { if (await open.run('POST', '/api/admin/support-tickets', { userId: t.userId, category: t.category, description: t.description })) { setT(null); tickets.reload(); reload(); } }}>Registrar</Button>
      </Dialog>
    </>
  );
}

export function ReportsPage() {
  const { data, error, loading, reload } = useApi<any>('/api/admin/academy/reports');
  const table = (rows: any[], cols: [string, string][]) => !rows.length ? <p className="muted small">Sem registros.</p> : (
    <div className="table-wrap" tabIndex={0}><table><thead><tr>{cols.map(([, h]) => <th key={h}>{h}</th>)}</tr></thead><tbody>{rows.map((r, i) => <tr key={i}>{cols.map(([k]) => <td key={k}>{k.includes('amount') ? money(r[k]) : r[k] == null ? '—' : label(String(r[k]))}</td>)}</tr>)}</tbody></table></div>
  );
  return (
    <>
      <PageHeader kicker="ONEMA Academy · ACA-015" title="Relatórios"><p>Contagens reais calculadas no momento da consulta. Nenhum número é estimado.</p></PageHeader>
      {loading ? <Loading /> : error ? <ErrorState error={error} onRetry={reload} /> : (
        <div className="two">
          <section className="surface"><h2>Matrículas por estado</h2>{table(data.enrollmentsByState, [['state', 'Estado'], ['total', 'Total']])}</section>
          <section className="surface"><h2>Resultados por curso</h2>{table(data.courseResults, [['code', 'Curso'], ['result', 'Resultado'], ['total', 'Total']])}</section>
          <section className="surface"><h2>Tentativas de avaliação</h2>{table(data.attemptsByResult, [['code', 'Curso'], ['state', 'Situação'], ['total', 'Total']])}</section>
          <section className="surface"><h2>Pagamentos (sandbox)</h2>{table(data.payments, [['status', 'Situação'], ['total', 'Pedidos'], ['amount_cents', 'Valor']])}</section>
          <section className="surface"><h2>Certificados</h2><p>Emitidos: <strong>{data.certificates.issued}</strong> · revogados: <strong>{data.certificates.revoked ?? 0}</strong></p></section>
          <section className="surface"><h2>Credenciamento</h2>{table(data.credentialing, [['decision', 'Decisão'], ['total', 'Total']])}</section>
        </div>
      )}
      <p className="small muted">Gerado em {data && dateTime(data.generatedAt)}</p>
    </>
  );
}
