import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import { dateTime } from '../../lib/format';
import { useApi, useSubmit } from '../../lib/hooks';
import { Alert, Badge, Button, Dialog, ErrorState, Field, Loading, PageHeader } from '../../ui/ui';

export function UsersPage() {
  const { has, status, me } = useAuth();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const { data, error, loading, reload } = useApi<any>(`/api/admin/users?q=${encodeURIComponent(query)}`);
  const create = useSubmit<any>(); const roles = useSubmit<any>(); const elig = useSubmit<any>(); const st = useSubmit<any>();
  const del = useSubmit<any>(); const quick = useSubmit<any>();
  const [bulk, setBulk] = useState<string | null>(null);
  const setRoles = async (u: any, next: string[]) => { if (await quick.run('PUT', `/api/admin/users/${u.id}/roles`, { roles: next })) reload(); };
  const remove = async (u: any) => {
    if (!confirm(`Excluir o usuário ${u.name} (${u.email})?\n\nSem histórico vinculado, a conta é apagada; com histórico, os dados pessoais são anonimizados e o acesso é encerrado.`)) return;
    if (await del.run('DELETE', `/api/admin/users/${u.id}`)) reload();
  };
  const removeDemo = async () => {
    const demo = (data?.users ?? []).filter((u: any) => u.email.endsWith('@exemplo.test') && u.id !== me?.user?.id);
    if (!demo.length || !confirm(`Excluir ${demo.length} contas de demonstração (@exemplo.test)?`)) return;
    let n = 0;
    for (const u of demo) { setBulk(`Excluindo ${++n}/${demo.length}…`); if (!(await del.run('DELETE', `/api/admin/users/${u.id}`))) break; }
    setBulk(null); reload();
  };
  const [nu, setNu] = useState<any>(null);
  const [created, setCreated] = useState<any>(null);
  const [edit, setEdit] = useState<any>(null);
  const canEdit = has('ADMIN_ACADEMY', 'ADMIN_PRIME');
  const L = status?.roleLabels ?? {};
  return (
    <>
      <PageHeader kicker="Gestão" title="Usuários e perfis"><p>Cada perfil só pode ser atribuído por quem tem a função correspondente. Pacientes criam a própria conta.</p></PageHeader>
      <form className="surface row" onSubmit={(e) => { e.preventDefault(); setQuery(q); }}>
        <input type="search" aria-label="Buscar usuário" placeholder="Nome ou e-mail" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
        <Button type="submit" className="deep">Buscar</Button>
        {canEdit && <Button className="secondary" onClick={() => { setCreated(null); setNu({ name: '', email: '', roles: [], academyEligible: false }); }}>Novo usuário</Button>}
        {canEdit && data?.users.some((u: any) => u.email.endsWith('@exemplo.test')) && <Button className="danger" busy={!!bulk} onClick={removeDemo}>{bulk ?? 'Excluir contas de demonstração'}</Button>}
      </form>
      <Alert error={elig.error || st.error || del.error || quick.error} />
      {loading ? <Loading /> : error ? <ErrorState error={error} onRetry={reload} /> : (
        <div className="table-wrap" tabIndex={0}><table><thead><tr><th>Nome</th><th>Perfis</th><th>Elegível Academy</th><th>MFA</th><th>Situação</th><th /></tr></thead>
          <tbody>{data.users.map((u: any) => <tr key={u.id}><td>{u.name}<br /><span className="small muted">{u.email}</span></td>
            <td><div className="row" style={{ gap: 6 }}>{u.roles.map((r: string) => <span key={r} className="row" style={{ gap: 2 }}><Badge tone="dark">{L[r] ?? r}</Badge>
              {canEdit && r !== 'PACIENTE' && <button type="button" className="icon-x" aria-label={`Remover perfil ${L[r] ?? r} de ${u.name}`} title="Remover perfil" disabled={quick.busy} onClick={() => { if (confirm(`Remover o perfil ${L[r] ?? r} de ${u.name}?`)) setRoles(u, u.roles.filter((x: string) => x !== r)); }}>×</button>}</span>)}
              {canEdit && <select aria-label={`Adicionar perfil a ${u.name}`} value="" disabled={quick.busy} onChange={(e) => { if (e.target.value) setRoles(u, [...u.roles, e.target.value]); }} style={{ width: 130, flex: '0 0 auto', minHeight: 32, padding: '2px 8px' }}>
                <option value="">+ perfil</option>{data.grantable.filter((r: string) => !u.roles.includes(r)).map((r: string) => <option key={r} value={r}>{L[r] ?? r}</option>)}</select>}</div></td>
            <td>{u.roles.includes('ESPECIALISTA') ? (has('ADMIN_ACADEMY') ? <Button className="sm ghost" busy={elig.busy} onClick={async () => { if (await elig.run('PUT', `/api/admin/users/${u.id}/eligibility`, { eligible: !u.academy_eligible })) reload(); }}>{u.academy_eligible ? 'Sim · revogar' : 'Não · confirmar'}</Button> : (u.academy_eligible ? 'Sim' : 'Não')) : '—'}</td>
            <td>{u.mfa_enabled ? 'Ativo' : '—'}</td><td>{u.status === 'ACTIVE' ? 'Ativo' : 'Desativado'}</td>
            <td className="row">{canEdit && <><Button className="sm ghost" onClick={() => setEdit({ id: u.id, name: u.name, roles: u.roles })}>Perfis</Button>
              {u.id !== me?.user?.id && <Button className="sm ghost" busy={st.busy} onClick={async () => { if (await st.run('PUT', `/api/admin/users/${u.id}/status`, { status: u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' })) reload(); }}>{u.status === 'ACTIVE' ? 'Desativar' : 'Reativar'}</Button>}
              {u.id !== me?.user?.id && <Button className="sm danger" busy={del.busy} onClick={() => remove(u)}>Excluir</Button>}</>}</td></tr>)}</tbody></table></div>
      )}
      <Dialog open={!!nu} title="Novo usuário" onClose={() => setNu(null)}>
        {created ? <><div className="success">Usuário criado.</div><p>Senha temporária (exibida uma única vez): <strong className="mono">{created.tempPassword}</strong></p><p className="small muted">{created.notice}</p><Button onClick={() => setNu(null)}>Fechar</Button></> : nu && <>
          <Field label="Nome"><input type="text" value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} /></Field>
          <Field label="E-mail"><input type="email" value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} /></Field>
          <fieldset style={{ border: 0, padding: 0 }}><legend className="eyebrow">Perfis</legend>{data?.grantable.map((r: string) => <label key={r} className="choice"><input type="checkbox" checked={nu.roles.includes(r)} onChange={(e) => setNu({ ...nu, roles: e.target.checked ? [...nu.roles, r] : nu.roles.filter((x: string) => x !== r) })} /><span>{L[r] ?? r}</span></label>)}</fieldset>
          {has('ADMIN_ACADEMY') && nu.roles.includes('ESPECIALISTA') && <label className="choice"><input type="checkbox" checked={nu.academyEligible} onChange={(e) => setNu({ ...nu, academyEligible: e.target.checked })} /><span>Elegibilidade ONEMA ONE confirmada</span></label>}
          <Alert error={create.error} />
          <Button className="deep" busy={create.busy} onClick={async () => { const r = await create.run('POST', '/api/admin/users', nu); if (r) { setCreated(r); reload(); } }}>Criar</Button></>}
      </Dialog>
      <Dialog open={!!edit} title={`Perfis · ${edit?.name}`} onClose={() => setEdit(null)}>
        {edit && <>{data?.grantable.map((r: string) => <label key={r} className="choice"><input type="checkbox" checked={edit.roles.includes(r)} onChange={(e) => setEdit({ ...edit, roles: e.target.checked ? [...edit.roles, r] : edit.roles.filter((x: string) => x !== r) })} /><span>{L[r] ?? r}</span></label>)}
          <Alert error={roles.error} />
          <Button className="deep" busy={roles.busy} onClick={async () => { if (await roles.run('PUT', `/api/admin/users/${edit.id}/roles`, { roles: edit.roles })) { setEdit(null); reload(); } }}>Salvar perfis</Button></>}
      </Dialog>
    </>
  );
}

export function AuditPage() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const { data, error, loading, reload } = useApi<any>(`/api/admin/audit?page=${page}${action ? `&action=${action}` : ''}`);
  return (
    <>
      <PageHeader kicker="Auditoria" title="Trilha de eventos"><p>Registro append-only (sem edição ou exclusão). Guarda ator, ação, objeto, hashes antes/depois e correlation id — sem conteúdo sensível.</p></PageHeader>
      <div className="surface row">
        <Field label="Filtrar por ação"><select value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}><option value="">Todas</option>{data?.actions.map((a: string) => <option key={a}>{a}</option>)}</select></Field>
      </div>
      {loading && !data ? <Loading /> : error ? <ErrorState error={error} onRetry={reload} /> : (
        <>
          <div className="table-wrap" tabIndex={0}><table><thead><tr><th>#</th><th>Quando</th><th>Ator</th><th>Ação</th><th>Objeto</th><th>Hash antes/depois</th><th>Correlation</th></tr></thead>
            <tbody>{data.events.map((e: any) => <tr key={e.seq}><td>{e.seq}</td><td className="nowrap">{dateTime(e.occurred_at)}</td><td>{e.actor ?? 'sistema'}</td><td><strong>{e.action}</strong>{e.meta_json && <div className="small muted mono">{e.meta_json}</div>}</td><td className="small">{e.subject_type}<br /><span className="mono">{e.subject_id?.slice(0, 12)}</span></td>
              <td className="mono">{e.before_hash?.slice(0, 10) ?? '—'} / {e.after_hash?.slice(0, 10) ?? '—'}</td><td className="mono">{e.correlation_id?.slice(0, 8)}</td></tr>)}</tbody></table></div>
          <div className="row mt"><Button className="sm ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</Button><span className="small">Página {page} de {Math.max(1, Math.ceil(data.total / data.pageSize))} · {data.total} eventos</span><Button className="sm ghost" disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>Próxima</Button></div>
        </>
      )}
    </>
  );
}

export function BackupsPage() {
  const { data, error, loading, reload } = useApi<any>('/api/admin/backups');
  const make = useSubmit<any>();
  const [ok, setOk] = useState<string | null>(null);
  return (
    <>
      <PageHeader kicker="Gestão" title="Backups"><p>Cópia automática diária de todo o banco, guardada em armazenamento privado (as {data?.keep ?? 30} mais recentes). A restauração é feita por linha de comando, com backup de segurança automático antes — veja docs/IMPLANTACAO.md.</p></PageHeader>
      <div className="surface">
        <p className="small">O arquivo contém dados pessoais e de saúde. Baixe somente quando necessário e guarde em local protegido. Todo download fica registrado na auditoria.</p>
        <Alert error={make.error} success={ok} />
        <Button className="deep" busy={make.busy} onClick={async () => { setOk(null); const r = await make.run('POST', '/api/admin/backups', {}); if (r) { setOk(`Backup gerado: ${r.tables} tabelas, ${r.rows} registros.`); reload(); } }}>Gerar backup agora</Button>
      </div>
      {loading ? <Loading /> : error ? <ErrorState error={error} onRetry={reload} /> : (
        <section className="surface">
          <h2>Cópias disponíveis</h2>
          {!data.backups.length ? <p className="muted">Nenhum backup ainda. O primeiro automático ocorre em até 24 h, ou gere agora.</p> : (
            <div className="table-wrap" tabIndex={0}><table><thead><tr><th>Data</th><th>Tamanho</th><th /></tr></thead>
              <tbody>{data.backups.map((b: any) => <tr key={b.key}><td>{b.createdAt ? dateTime(b.createdAt) : b.key}</td><td>{(b.size / 1024).toFixed(0)} KB</td>
                <td><a className="btn sm ghost" href={`/api/admin/backups/${encodeURIComponent(b.key)}`} download>Baixar</a></td></tr>)}</tbody></table></div>
          )}
        </section>
      )}
    </>
  );
}
