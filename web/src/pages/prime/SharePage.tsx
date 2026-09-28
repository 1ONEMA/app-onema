import { useState } from 'react';
import { Link } from 'react-router-dom';
import { dateTime, label } from '../../lib/format';
import { useApi, useSubmit } from '../../lib/hooks';
import { Alert, Badge, Button, Dialog, ErrorState, Field, Loading, PageHeader, fieldError } from '../../ui/ui';
import { useT3 } from './t3';

const SCOPES = [['AGENDA', 'Pode ver agenda'], ['DOCUMENTOS', 'Pode ver documentos clínicos selecionados'], ['COBRANCAS', 'Pode ver cobranças e recibos']] as const;

/** PRIME → responsável: convite, escopos independentes, estado, acessos e revogação (A06). */
export function SharePage() {
  const { data, error, loading, reload } = useApi<any>('/api/prime/share');
  const t3 = useT3();
  const invite = useSubmit<any>();
  const scopes = useSubmit<any>();
  const revoke = useSubmit<any>();
  const [f, setF] = useState({ name: '', email: '', scopes: { AGENDA: false, DOCUMENTOS: false, COBRANCAS: false }, acknowledge: false });
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const active = data.grants.find((g: any) => ['INVITED', 'ACCEPTED', 'VERIFIED'].includes(g.status));
  async function send() { const r = await invite.run('POST', '/api/prime/share/invites', f, { idempotent: true }); if (r) { setMsg('Convite registrado. O acesso começa somente após o aceite autenticado e a verificação da ONEMA.'); reload(); } }
  async function toggle(scope: string, v: boolean) {
    const r = await scopes.run('PUT', `/api/prime/share/${active.id}/scopes`, { ...active.scopes, [scope]: v });
    if (r) { setMsg(v ? 'Permissão concedida.' : 'Permissão revogada. Nenhum novo acesso a esse conteúdo será permitido.'); reload(); }
  }
  async function doRevoke() { const r = await revoke.run('POST', `/api/prime/share/${active.id}/revoke`, {}); if (r) { setConfirmRevoke(false); setMsg(r.text); reload(); } }
  return (
    <>
      <PageHeader kicker="ONEMA PRIME" title="Responsável principal" back={{ to: '/prime/assinatura', label: 'Minha assinatura' }}>
        <p>Você decide se quer um responsável e o que ele poderá acompanhar. Nenhuma opção concede acesso por si só.</p>
      </PageHeader>
      <Alert success={msg} error={scopes.error || revoke.error} />
      {active ? (
        <section className="surface">
          <div className="row between"><div><h2 className="mb0">{active.inviteeName}</h2><span className="small muted">{active.inviteeEmail}</span></div><Badge tone={active.status === 'VERIFIED' ? '' : 'orange'}>{label(active.status)}</Badge></div>
          <p className="small muted">Convite em {dateTime(active.invitedAt)}{active.status === 'INVITED' && ` · válido até ${dateTime(active.expiresAt)}`}</p>
          <h3>Permissões</h3>
          {SCOPES.map(([k, l]) => (
            <label key={k} className="choice"><input type="checkbox" checked={active.scopes[k]} disabled={scopes.busy} onChange={(e) => toggle(k, e.target.checked)} /><span>{l}</span></label>
          ))}
          <Button className="danger" onClick={() => setConfirmRevoke(true)}>Revogar todas as permissões</Button>
        </section>
      ) : !data.primeActive ? (
        <section className="surface"><p>O convite a um responsável principal é um recurso do ONEMA PRIME ativo.</p><Link to="/prime" className="btn deep">Conhecer o PRIME</Link></section>
      ) : (
        <section className="surface">
          <h2>Convidar pessoa de confiança</h2>
          <Field label="Nome da pessoa" error={fieldError(invite.error, 'name')}><input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="E-mail da pessoa" hint="A pessoa precisa entrar com uma conta ONEMA usando este e-mail." error={fieldError(invite.error, 'email')}><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          {SCOPES.map(([k, l]) => (
            <label key={k} className="choice"><input type="checkbox" checked={f.scopes[k]} onChange={(e) => setF({ ...f, scopes: { ...f.scopes, [k]: e.target.checked } })} /><span>{l}</span></label>
          ))}
          <label className="choice mandatory"><input type="checkbox" checked={f.acknowledge} onChange={(e) => setF({ ...f, acknowledge: e.target.checked })} /><span>{t3.invite}</span></label>
          <Alert error={invite.error} />
          <Button className="deep" busy={invite.busy} disabled={!f.acknowledge} onClick={send}>Enviar convite</Button>
          <p className="small muted mt">No lançamento, apenas um responsável principal. Representação legal depende de verificação documental, não de autodeclaração.</p>
        </section>
      )}
      <section className="surface">
        <h2>Histórico de acessos</h2>
        {!data.accessLog.length ? <p className="muted">Nenhum acesso registrado.</p> : (
          <ul className="list small">{data.accessLog.map((l: any, i: number) => <li key={i}>{dateTime(l.accessed_at)} · {l.accessor} · {l.scope.toLowerCase()} — <strong>{l.result === 'PERMITIDO' ? 'permitido' : 'negado'}</strong></li>)}</ul>
        )}
        {data.grants.filter((g: any) => g !== active).length > 0 && (
          <><h3 className="mt">Convites anteriores</h3><ul className="list small">{data.grants.filter((g: any) => g !== active).map((g: any) => <li key={g.id}>{g.inviteeName} · {label(g.status)} · {dateTime(g.invitedAt)}</li>)}</ul></>
        )}
      </section>
      <Dialog open={confirmRevoke} title="Revogar permissões" onClose={() => setConfirmRevoke(false)}>
        <p>A pessoa não poderá fazer novos acessos por sua autorização. O histórico de acessos permanece guardado.</p>
        <div className="row"><Button className="danger" busy={revoke.busy} onClick={doRevoke}>Revogar</Button><Button className="ghost" onClick={() => setConfirmRevoke(false)}>Voltar</Button></div>
      </Dialog>
    </>
  );
}
