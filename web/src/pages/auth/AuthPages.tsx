import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth, type Me } from '../../lib/auth';
import { useSubmit } from '../../lib/hooks';
import { Alert, Button, Field, fieldError } from '../../ui/ui';
import { PasswordField } from '../../ui/PasswordField';
import { Kary } from '../../ui/Kary';

/** Grafismo geométrico do manual (semicírculos Deep Blue / Health Green). */
export function Pattern() {
  return (
    <svg className="pattern" viewBox="0 0 200 240" aria-hidden>
      <path d="M40 0a60 60 0 0 1 0 120z" fill="#0A1F4D" /><circle cx="40" cy="45" r="22" fill="#02C0A4" />
      <path d="M100 60a60 60 0 0 1 60-60h20a40 40 0 0 1-40 40 40 40 0 0 0-40 40z" fill="#0A1F4D" />
      <path d="M140 60a60 60 0 0 1 0 120V140a20 20 0 0 0 0-40z" fill="#0A1F4D" /><circle cx="140" cy="120" r="22" fill="#02C0A4" />
      <path d="M40 120h60v60a60 60 0 0 1-60-60z" fill="#02C0A4" opacity=".9" />
      <path d="M40 180a60 60 0 0 1 0 60z" fill="#0A1F4D" /><circle cx="40" cy="215" r="22" fill="#02C0A4" />
    </svg>
  );
}

export function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  const { status, error } = useAuth();
  useEffect(() => { document.title = `${title} · ONEMA SAÚDE`; }, [title]);
  const apiDown = error?.startsWith('API_UNAVAILABLE:');
  return (
    <div className="auth-wrap">
      <aside className="auth-side">
        <Pattern />
        <div className="kicker">ONEMA SAÚDE</div>
        <h1>Sua saúde organizada<br />sempre com você!</h1>
        <p>Cuidado, informações e continuidade em um só lugar.</p>
      </aside>
      <main className="auth-main" id="conteudo">
        <div className="auth-card">
          <Link to="/" aria-label="ONEMA SAÚDE — página inicial"><img src="/icons/logo-onema-saude.png" alt="ONEMA SAÚDE" className="logo" /></Link>
          {status && status.environment !== 'production' && (
            <p className="env-note">Versão de homologação · pagamentos simulados</p>
          )}
          {apiDown && (
            <div className="caution" role="alert">
              <strong>Serviço temporariamente indisponível.</strong> {error!.replace(/^API_UNAVAILABLE:/, '')} Tentaremos novamente de forma automática a cada poucos segundos.
            </div>
          )}
          <div className="surface">
            <h1 style={{ fontSize: 24 }}>{title}</h1>
            {children}
          </div>
        </div>
      </main>
      <Kary />
    </div>
  );
}

const safeReturn = (v: string | null) => (v && v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') && v !== '/' ? v : '/inicio');

export function LoginPage() {
  const { me, setMe } = useAuth();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { run, busy, error } = useSubmit<Me>();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  if (me?.user && !busy) return <Navigate to={me.mfa?.pending ? '/mfa' : safeReturn(params.get('voltar'))} replace />;
  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await run('POST', '/api/auth/login', { email, password });
    if (r) { setMe(r); nav(r.mfa?.pending ? `/mfa?voltar=${encodeURIComponent(safeReturn(params.get('voltar')))}` : safeReturn(params.get('voltar')), { replace: true }); }
  }
  return (
    <AuthLayout title="Entrar">
      <form onSubmit={submit} noValidate>
        <Alert error={error} />
        <Field label="E-mail"><input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <PasswordField label="Senha" autoComplete="current-password" value={password} onChange={setPassword} />
        <Button type="submit" className="block deep" busy={busy}>Entrar</Button>
      </form>
      <p className="mt small"><Link to="/esqueci-senha">Esqueci minha senha</Link></p>
      <p className="small">Paciente sem conta? <Link to="/cadastro">Criar cadastro</Link></p>
      <p className="small muted">Especialistas e equipes ONEMA recebem acesso pela administração.</p>
    </AuthLayout>
  );
}

export function RegisterPage() {
  const { setMe } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const specialist = params.get('perfil') === 'especialista';
  const { run, busy, error } = useSubmit<Me>();
  const [f, setF] = useState({ name: '', email: '', password: '', confirm: '' });
  const [mismatch, setMismatch] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (f.password !== f.confirm) { setMismatch(true); return; }
    setMismatch(false);
    let referralCode: string | undefined;
    try { referralCode = localStorage.getItem('onema.indicacao') ?? undefined; } catch { /* sem armazenamento */ }
    const r = await run('POST', '/api/auth/register', { name: f.name, email: f.email, password: f.password, ...(referralCode ? { referralCode } : {}) });
    if (r) { try { localStorage.removeItem('onema.indicacao'); } catch { /* sem armazenamento */ } }
    if (r) { setMe(r); nav(specialist ? '/especialista/candidatura' : params.get('voltar') ? safeReturn(params.get('voltar')) : '/minha-onema', { replace: true }); }
  }
  return (
    <AuthLayout title={specialist ? 'Cadastro na rede ONEMA ONE' : 'Criar cadastro de paciente'}>
      {specialist && <div className="callout small">Crie sua conta com seus dados pessoais. Em seguida, a Central ONEMA valida identidade, COREN e documentos e libera a ONEMA Academy. Só depois disso o perfil passa a receber ofertas.</div>}
      <form onSubmit={submit} noValidate>
        <Alert error={error} />
        <Field label="Nome completo" error={fieldError(error, 'name')}><input type="text" autoComplete="name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="E-mail" error={fieldError(error, 'email')}><input type="email" autoComplete="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <PasswordField label="Senha" autoComplete="new-password" hint="Mínimo de 10 caracteres, com letras e números." error={fieldError(error, 'password')}
          value={f.password} onChange={(v) => setF({ ...f, password: v })} />
        <PasswordField label="Confirme a senha" autoComplete="new-password" error={mismatch ? 'As senhas não conferem.' : null}
          value={f.confirm} onChange={(v) => setF({ ...f, confirm: v })} />
        <Button type="submit" className="block deep" busy={busy}>Criar cadastro</Button>
      </form>
      <p className="mt small">Já tem conta? <Link to={`/entrar${params.get('voltar') ? `?voltar=${encodeURIComponent(params.get('voltar')!)}` : ''}`}>Entrar</Link></p>
    </AuthLayout>
  );
}

export function ForgotPage() {
  const { run, busy, error } = useSubmit<any>();
  const [email, setEmail] = useState('');
  const [done, setDone] = useState<any>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await run('POST', '/api/auth/forgot', { email });
    if (r) setDone(r);
  }
  return (
    <AuthLayout title="Recuperar acesso">
      {done ? (
        <>
          <div className="success" role="status">{done.message}</div>
          {!done.emailDeliveryConfigured && (
            <p className="caution small">O envio automático de e-mails ainda não está configurado neste ambiente. A solicitação foi registrada; a equipe técnica pode concluir a redefinição com o link gerado no servidor.</p>
          )}
          <Link to="/entrar" className="btn secondary block">Voltar para entrar</Link>
        </>
      ) : (
        <form onSubmit={submit} noValidate>
          <Alert error={error} />
          <Field label="E-mail cadastrado"><input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Button type="submit" className="block deep" busy={busy}>Enviar instruções</Button>
          <p className="mt small"><Link to="/entrar">Voltar</Link></p>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPage() {
  const [params] = useSearchParams();
  const { run, busy, error } = useSubmit<any>();
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [ok, setOk] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const token = params.get('token') ?? '';
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (p1 !== p2) { setMismatch(true); return; }
    const r = await run('POST', '/api/auth/reset', { token, password: p1 });
    if (r) setOk(r.message);
  }
  return (
    <AuthLayout title="Definir nova senha">
      {ok ? (<><div className="success">{ok}</div><Link to="/entrar" className="btn deep block">Entrar</Link></>) : !token ? (
        <p className="danger">Link incompleto. Solicite uma nova redefinição.</p>
      ) : (
        <form onSubmit={submit} noValidate>
          <Alert error={error} />
          <PasswordField label="Nova senha" autoComplete="new-password" hint="Mínimo de 10 caracteres, com letras e números." error={fieldError(error, 'password')} value={p1} onChange={setP1} />
          <PasswordField label="Confirme a nova senha" autoComplete="new-password" error={mismatch ? 'As senhas não conferem.' : null} value={p2} onChange={setP2} />
          <Button type="submit" className="block deep" busy={busy}>Salvar nova senha</Button>
        </form>
      )}
    </AuthLayout>
  );
}
