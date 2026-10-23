import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { useSubmit } from '../../lib/hooks';
import { Alert, Badge, Button, Field, PageHeader, fieldError } from '../../ui/ui';
import { PasswordField } from '../../ui/PasswordField';

export function AccountPage() {
  const { me, status, logout } = useAuth();
  const nav = useNavigate();
  const { run, busy, error } = useSubmit<any>();
  const [f, setF] = useState({ current: '', password: '' });
  const [ok, setOk] = useState<string | null>(null);
  const u = me!.user!;
  async function submit(e: FormEvent) {
    e.preventDefault(); setOk(null);
    const r = await run('POST', '/api/auth/password', f);
    if (r) { setOk('Senha alterada. Outras sessões foram encerradas.'); setF({ current: '', password: '' }); }
  }
  return (
    <>
      <PageHeader kicker="Minha conta" title={u.name}><p>{u.email}</p></PageHeader>
      <div className="two">
        <section className="surface">
          <h2>Perfis de acesso</h2>
          <div className="row">{u.roles.map((r) => <Badge key={r} tone="dark">{status?.roleLabels?.[r] ?? r}</Badge>)}</div>
          {me?.mfa?.required && (
            <p className="mt">Verificação em duas etapas: <strong>{me.mfa.enabled ? 'ativa' : 'não configurada'}</strong>
              {me.mfa.pending && <> — <Link to="/mfa">confirmar agora</Link></>}</p>
          )}
          <hr className="divider" />
          <p className="small muted">Seus dados são tratados conforme o Aviso de Privacidade da ONEMA SAÚDE. Para exercer direitos previstos na LGPD, utilize o canal oficial informado pela ONEMA.</p>
          <Button className="ghost" onClick={async () => { await logout(); nav('/entrar', { replace: true }); }}>Sair da conta</Button>
        </section>
        <section className="surface">
          <h2>Alterar senha</h2>
          <form onSubmit={submit} noValidate>
            <Alert error={error} success={ok} />
            <PasswordField label="Senha atual" autoComplete="current-password" value={f.current} onChange={(v) => setF({ ...f, current: v })} />
            <PasswordField label="Nova senha" autoComplete="new-password" hint="Mínimo de 10 caracteres, com letras e números." error={fieldError(error, 'password')} value={f.password} onChange={(v) => setF({ ...f, password: v })} />
            <Button type="submit" className="deep" busy={busy}>Salvar</Button>
          </form>
        </section>
      </div>
    </>
  );
}
