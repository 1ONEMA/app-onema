import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth, type Me } from '../../lib/auth';
import { useSubmit } from '../../lib/hooks';
import { Alert, Button, Field, fieldError } from '../../ui/ui';

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
          <img src="/icons/logo-onema-saude.png" alt="ONEMA SAÚDE" className="logo" />
          {status && status.environment !== 'production' && (
            <p className="caution small">Ambiente de homologação. Use apenas dados fictícios. Pagamentos são simulados.</p>
          )}
          {apiDown && (
            <div className="caution" role="alert">
              <strong>Serviço temporariamente indisponível.</strong> {error!.replace(/^API_UNAVAILABLE:/, '')} Entrar, cadastrar e demais operações ficam indisponíveis até a normalização.
            </div>
          )}
          <div className="surface">
            <h1 style={{ fontSize: 24 }}>{title}</h1>
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}

const safeReturn = (v: string | null) => (v && v.startsWith('/') && !v.startsWith('//') ? v : '/');

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
        <Field label="Senha"><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
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
  const { run, busy, error } = useSubmit<Me>();
  const [f, setF] = useState({ name: '', email: '', password: '', confirm: '' });
  const [mismatch, setMismatch] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (f.password !== f.confirm) { setMismatch(true); return; }
    setMismatch(false);
    const r = await run('POST', '/api/auth/register', { name: f.name, email: f.email, password: f.password });
    if (r) { setMe(r); nav('/minha-onema', { replace: true }); }
  }
  return (
    <AuthLayout title="Criar cadastro de paciente">
      <form onSubmit={submit} noValidate>
        <Alert error={error} />
        <Field label="Nome completo" error={fieldError(error, 'name')}><input type="text" autoComplete="name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="E-mail" error={fieldError(error, 'email')}><input type="email" autoComplete="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Senha" hint="Mínimo de 10 caracteres, com letras e números." error={fieldError(error, 'password')}>
          <input type="password" autoComplete="new-password" required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        </Field>
        <Field label="Confirme a senha" error={mismatch ? 'As senhas não conferem.' : null}>
          <input type="password" autoComplete="new-password" required aria-invalid={mismatch} value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} />
        </Field>
        <Button type="submit" className="block deep" busy={busy}>Criar cadastro</Button>
      </form>
      <p className="mt small">Já tem conta? <Link to="/entrar">Entrar</Link></p>
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
          <Field label="Nova senha" hint="Mínimo de 10 caracteres, com letras e números." error={fieldError(error, 'password')}>
            <input type="password" autoComplete="new-password" value={p1} onChange={(e) => setP1(e.target.value)} />
          </Field>
          <Field label="Confirme a nova senha" error={mismatch ? 'As senhas não conferem.' : null}>
            <input type="password" autoComplete="new-password" value={p2} onChange={(e) => setP2(e.target.value)} />
          </Field>
          <Button type="submit" className="block deep" busy={busy}>Salvar nova senha</Button>
        </form>
      )}
    </AuthLayout>
  );
}
