import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { useSubmit } from '../../lib/hooks';
import { Alert, Button, Field, PageHeader } from '../../ui/ui';

/** Segundo fator (TOTP) obrigatório para perfis administrativos. */
export function MfaPage() {
  const { me, setMe } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const setup = useSubmit<any>();
  const verify = useSubmit<any>();
  const [secret, setSecret] = useState<any>(null);
  const [code, setCode] = useState('');
  const enabled = me?.mfa?.enabled;
  const back = params.get('voltar') || '/admin';
  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await verify.run('POST', enabled ? '/api/auth/mfa/verify' : '/api/auth/mfa/enable', { code: code.trim() });
    if (r) { setMe(r); nav(back.startsWith('/') ? back : '/admin', { replace: true }); }
  }
  return (
    <>
      <PageHeader kicker="Segurança" title="Verificação em duas etapas"><p>Perfis administrativos exigem um código do aplicativo autenticador (TOTP) a cada novo acesso.</p></PageHeader>
      <div className="surface" style={{ maxWidth: 560 }}>
        {!enabled && !secret && (
          <>
            <p>Para ativar, instale um aplicativo autenticador compatível com TOTP e gere o código de configuração.</p>
            <Alert error={setup.error} />
            <Button className="deep" busy={setup.busy} onClick={async () => { const r = await setup.run('POST', '/api/auth/mfa/setup', {}); if (r) setSecret(r); }}>Gerar código de configuração</Button>
          </>
        )}
        {!enabled && secret && (
          <div className="stack">
            <p>Escaneie o QR code no aplicativo autenticador ou digite a chave manualmente:</p>
            <img src={secret.qrDataUrl} alt="QR code para configurar o autenticador" width={200} height={200} />
            <p className="mono">{secret.secret}</p>
          </div>
        )}
        {(enabled || secret) && (
          <form onSubmit={submit} className="mt">
            <Alert error={verify.error} />
            <Field label="Código de 6 dígitos"><input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></Field>
            <Button type="submit" className="deep" busy={verify.busy} disabled={code.length !== 6}>{enabled ? 'Verificar' : 'Ativar e continuar'}</Button>
          </form>
        )}
      </div>
    </>
  );
}
