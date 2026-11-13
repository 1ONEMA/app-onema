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
      <p className="small muted">A validação documental (identidade, prova viva e COREN) fica em <a href="/admin/parceiros">Validação de parceiros</a>. Aqui fica a decisão final de credenciamento, depois da Academy.</p>
      <h2 className="mt">Capacitação e decisão final</h2>
      {loading ? <Loading /> : error ? <ErrorState error={error} onRetry={reload} /> : (
        <section className="surface">
          {!data.partners.length ? <Empty title="Nenhum especialista cadastrado." /> : (
            <div className="table-wrap" tabIndex={0}><table><thead><tr><th>Especialista</th><th>Elegível ONEMA ONE</th><th>Jornada</th><th>Conclusão</th><th>Decisão</th><th /></tr></thead>
              <tbody>{data.partners.map((p: any) => <tr key={p.id}><td>{p.name}<br /><span className="small muted">{p.email}</span></td><td>{p.academy_eligible ? 'Sim' : 'Não'}</td><td>{label(p.journey_state ?? 'NAO_INICIADA')}</td><td>{date(p.completed_at)}</td>
                <td><Badge tone={p.credentialing_decision === 'APTO' ? '' : p.credentialing_decision === 'NAO_APTO' ? 'red' : 'orange'}>{label(p.credentialing_decision ?? 'PENDENTE')}</Badge>{p.decided_at && <div className="small muted">{dateTime(p.decided_at)}</div>}</td>
                <td>{has('CREDENCIAMENTO', 'ADMIN_ACADEMY') && p.journey_state && <Button className="sm secondary" onClick={() => { setSel(p); setF({ decision: p.credentialing_decision ?? 'PENDENTE', note: '', otherGatesConfirmed: false }); }}>Registrar decisão</Button>}</td></tr>)}</tbody></table></div>
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

const APP_STATUS: Record<string, { label: string; tone: string }> = {
  ENVIADA: { label: 'Aguardando análise', tone: 'orange' }, PENDENCIA: { label: 'Correção solicitada', tone: 'orange' },
  APROVADA: { label: 'Documentação aprovada', tone: '' }, RECUSADA: { label: 'Reprovada', tone: 'red' }, SUSPENSA: { label: 'Suspensa / revalidar', tone: 'red' },
};
const DOC_LABEL: Record<string, string> = { FOTO: 'Foto', PROVA_VIVA: 'Prova viva', IDENTIDADE: 'Identidade', COREN: 'COREN', DIPLOMA_FRENTE: 'Diploma (frente)', DIPLOMA_VERSO: 'Diploma (verso)', CERTIFICADO: 'Certificado', COMPROVANTE_ENDERECO: 'Comprovante de endereço', OUTRO: 'Outro' };
const CHECK_LABEL: Record<string, string> = { PROVA_VIVA: 'Prova viva (conferência visual humana)', IDENTIDADE: 'Identidade', INSCRICAO: 'Inscrição COREN/COFEN', CATEGORIA: 'Categoria profissional', AUTENTICIDADE: 'Autenticidade documental' };
const RESULT_LABEL: Record<string, string> = { CONFERIDA: 'Conferida', PENDENTE: 'Pendente', DIVERGENTE: 'Divergente', INDISPONIVEL: 'Consulta indisponível', NAO_ENCONTRADA: 'Inscrição não encontrada', NAO_AUTENTICAVEL: 'Não autenticável' };
const CAT_LABEL: Record<string, string> = { ENFERMEIRO: 'Enfermeiro(a)', TECNICO_ENFERMAGEM: 'Técnico(a) de enfermagem' };

/**
 * Validação documental de parceiros: fila de novos cadastros e revalidações, conferências humanas (prova viva, identidade,
 * inscrição), evidência interna da consulta oficial (só RT/autorizados) e decisões com justificativa.
 */
export function PartnerValidationPage() {
  const { has } = useAuth();
  const { data, error, loading, reload } = useApi<any>('/api/admin/specialist-applications');
  const act = useSubmit<any>();
  const [sel, setSel] = useState<any>(null);
  const [queue, setQueue] = useState<'TODOS' | 'NOVO' | 'REVALIDACAO'>('TODOS');
  const [chk, setChk] = useState({ checkKind: 'PROVA_VIVA', result: 'CONFERIDA', source: '', sourceUrl: '', note: '' });
  const [dec, setDec] = useState({ decision: 'APROVADA', note: '' });
  const [evFile, setEvFile] = useState<Record<string, File | null>>({});
  const [msg, setMsg] = useState<string | null>(null);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const canDecide = has('CREDENCIAMENTO', 'AVALIADOR_RT', 'ADMIN_ACADEMY');
  const canAttach = has('AVALIADOR_RT', 'CREDENCIAMENTO');
  const list = data.applications.filter((a: any) => queue === 'TODOS' || a.queue === queue);
  const cur = sel ? data.applications.find((a: any) => a.id === sel) : null;
  async function addCheck() {
    if (await act.run('POST', `/api/admin/specialist-applications/${cur.id}/verifications`, { ...chk, sourceUrl: chk.sourceUrl || undefined, source: chk.source || undefined })) {
      setMsg('Conferência registrada.'); setChk({ ...chk, note: '' }); reload();
    }
  }
  async function attach(vid: string) {
    const file = evFile[vid]; if (!file) return;
    const fd = new FormData(); fd.append('file', file);
    if (await act.run('POST', `/api/admin/specialist-applications/${cur.id}/verifications/${vid}/evidence`, fd)) { setMsg('Captura anexada à conferência.'); setEvFile({ ...evFile, [vid]: null }); reload(); }
  }
  async function decide() {
    if (await act.run('POST', `/api/admin/specialist-applications/${cur.id}/decision`, dec)) { setMsg('Decisão registrada.'); setDec({ decision: 'APROVADA', note: '' }); reload(); }
  }
  return (
    <>
      <PageHeader kicker="Credenciamento · RT" title="Validação de parceiros" />
      <p className="small muted">Ativo para atendimento somente com identidade e prova viva conferidas, inscrição confirmada no canal oficial, documentação aprovada e os quatro cursos da integração concluídos (decisão final em Credenciamento). Conferência manual nos portais oficiais — sem raspagem e sem reconhecimento facial. Revalidação a cada {data.revalidationDays} dias.</p>
      <p className="small">Canais oficiais: {data.officialSources.map((o: any, i: number) => <span key={o.url}>{i ? ' · ' : ''}<a href={o.url} target="_blank" rel="noopener noreferrer">{o.name}</a></span>)}</p>
      <nav className="pills" aria-label="Fila">{(['TODOS', 'NOVO', 'REVALIDACAO'] as const).map((q) => <button key={q} type="button" className={queue === q ? 'active' : ''} onClick={() => setQueue(q)}>{q === 'TODOS' ? 'Todos' : q === 'NOVO' ? 'Novos cadastros' : 'Revalidação'}</button>)}</nav>
      <Alert error={act.error} success={msg} />
      {!list.length ? <Empty title="Nenhum cadastro nesta fila." /> : (
        <ul className="list">{list.map((a: any) => (
          <li key={a.id}>
            <div className="row between"><button type="button" className="linklike" onClick={() => { setSel(sel === a.id ? null : a.id); setMsg(null); }}><strong>{a.fullName}</strong></button>
              <span><Badge tone={APP_STATUS[a.status]?.tone ?? 'dark'}>{APP_STATUS[a.status]?.label ?? a.status}</Badge> <Badge tone="blue">{a.partnerStateLabel}</Badge></span></div>
            <div className="small muted">{CAT_LABEL[a.professionalCategory] ?? 'Categoria não informada'} · COREN-{a.corenUf} {a.corenNumber} · atua em {a.states.join(', ') || '—'} · {a.reviewReason === 'INICIAL' ? 'cadastro novo' : `revisão: ${a.reviewReason}`}{a.nextRevalidationAt ? ` · revalidar até ${date(a.nextRevalidationAt)}` : ''}</div>
            <div className="row small">{a.requiredChecks.map((c: any) => <Badge key={c.kind} tone={c.result === 'CONFERIDA' ? '' : c.result === 'PENDENTE' ? 'orange' : 'red'}>{CHECK_LABEL[c.kind].split(' (')[0]}: {RESULT_LABEL[c.result]}</Badge>)}</div>
            {sel === a.id && (
              <div className="mt flow">
                <div className="small">CPF {a.cpf} · {a.phone} · {a.email} · regiões: {a.regions} · áreas: {a.needs.join(', ')}</div>
                <h3>Documentos (versões preservadas)</h3>
                <div className="row small">{a.documents.map((d: any) => (
                  <a key={d.id} href={`/api/admin/specialist-applications/${a.id}/documents/${d.id}`} target="_blank" rel="noopener noreferrer" className={`badge ${d.superseded_at || d.removed_at ? 'dark' : 'blue'}`}>
                    {DOC_LABEL[d.kind]} · {dateTime(d.created_at)}{d.superseded_at ? ' (substituído)' : d.removed_at ? ' (removido)' : ''}</a>
                ))}</div>
                <h3>Conferências</h3>
                {!a.checks.length ? <p className="small muted">Nenhuma conferência registrada.</p> : (
                  <ul className="list small">{a.checks.map((c: any) => (
                    <li key={c.id}><strong>{CHECK_LABEL[c.kind]}</strong>: {RESULT_LABEL[c.result]} · {dateTime(c.consultedAt)} · {c.actor}{c.source ? ` · ${c.source}` : ''}{c.sourceUrl ? <> · <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer">URL</a></> : ''}{c.corenNumber ? ` · COREN-${c.corenUf} ${c.corenNumber}` : ''}
                      {c.note && <div className="muted">{c.note}</div>}
                      {c.evidence.map((e: any) => <div key={e.id}><a href={`/api/admin/specialist-applications/${a.id}/evidence/${e.id}`} target="_blank" rel="noopener noreferrer">Captura da consulta · {e.filename}</a> · {e.uploaded_by} · {dateTime(e.created_at)}</div>)}
                      {canAttach && c.kind === 'INSCRICAO' && (
                        <div className="row"><input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" aria-label="Captura da consulta oficial" onChange={(e) => setEvFile({ ...evFile, [c.id]: e.target.files?.[0] ?? null })} />
                          <Button className="sm secondary" busy={act.busy} disabled={!evFile[c.id]} onClick={() => attach(c.id)}>Anexar captura</Button></div>
                      )}
                    </li>
                  ))}</ul>
                )}
                {canDecide && (<>
                  <h3>Registrar conferência</h3>
                  <div className="form-grid">
                    <Field label="Verificação"><select value={chk.checkKind} onChange={(e) => setChk({ ...chk, checkKind: e.target.value })}>{Object.entries(CHECK_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
                    <Field label="Resultado"><select value={chk.result} onChange={(e) => setChk({ ...chk, result: e.target.value })}>{Object.entries(RESULT_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
                    <Field label="Fonte consultada" hint="Ex.: COFEN — Consulta de profissionais"><input value={chk.source} onChange={(e) => setChk({ ...chk, source: e.target.value })} /></Field>
                    <Field label="URL consultada"><input type="url" value={chk.sourceUrl} onChange={(e) => setChk({ ...chk, sourceUrl: e.target.value })} /></Field>
                  </div>
                  <Field label="Observação / justificativa" hint="Obrigatória quando o resultado não for &quot;conferida&quot;."><textarea rows={2} value={chk.note} onChange={(e) => setChk({ ...chk, note: e.target.value })} /></Field>
                  <Button className="sm secondary" busy={act.busy} onClick={addCheck}>Registrar conferência</Button>
                  {['ENVIADA', 'APROVADA'].includes(a.status) && (<>
                    <h3>Decisão</h3>
                    <Field label="Decisão"><select value={dec.decision} onChange={(e) => setDec({ ...dec, decision: e.target.value })}>
                      {a.status === 'ENVIADA' ? <><option value="APROVADA">Aprovar documentação</option><option value="PENDENCIA">Solicitar correção</option><option value="RECUSADA">Reprovar</option></>
                        : <option value="SUSPENSA">Suspender (revalidar)</option>}</select></Field>
                    <Field label="Justificativa" hint="O parceiro vê esta mensagem em correção, reprovação ou suspensão."><textarea value={dec.note} onChange={(e) => setDec({ ...dec, note: e.target.value })} /></Field>
                    <Button className="deep" busy={act.busy} onClick={decide}>Registrar decisão</Button>
                  </>)}
                </>)}
                <h3>Histórico</h3>
                <ul className="small">{a.history.map((h: any, i: number) => <li key={i}>{dateTime(h.created_at)} · {h.action} · {h.actor ?? 'Sistema'}{h.note ? ` — ${h.note}` : ''}</li>)}</ul>
              </div>
            )}
          </li>
        ))}</ul>
      )}
    </>
  );
}
