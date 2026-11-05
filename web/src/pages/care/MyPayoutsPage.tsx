import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useApi, useSubmit } from '../../lib/hooks';
import { dateTime, money } from '../../lib/format';
import { Alert, Badge, Button, Empty, ErrorState, Field, Loading, fieldError } from '../../ui/ui';

const TONE: Record<string, string> = { CONFIRMADO: '', CANCELADO: 'dark', RECUSADO: 'red', BLOQUEADO: 'red', FALHA: 'orange', SALDO_INSUFICIENTE: 'orange', ENVIO_INCERTO: 'orange' };
const KEY_TYPES = [['CPF', 'CPF (recomendado)'], ['EMAIL', 'E-mail'], ['PHONE', 'Celular'], ['EVP', 'Chave aleatória']] as const;

/** Repasses da especialista: chave Pix (com verificação forte) e situação de cada repasse. Sem preço do paciente. */
export function MyPayoutsPage() {
  const { data, error, loading, reload, setData } = useApi<any>('/api/specialist/payouts');
  const save = useSubmit<any>();
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({ pixKeyType: 'CPF', pixKey: '', holderName: '', password: '' });
  useEffect(() => { document.title = 'Meus repasses · ONEMA SAÚDE'; }, []);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const d = data.destination;
  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await save.run('PUT', '/api/specialist/bank-destination', f);
    if (r) { setData({ ...data, destination: r.destination }); setEdit(false); setF({ ...f, pixKey: '', password: '' }); }
  }
  return (
    <div className="flow">
      <div className="eyebrow-teal">Rede ONEMA ONE</div>
      <h1 className="display-light">Meus repasses</h1>
      <p className="lead">{data.rule}</p>

      <section className="flow-card">
        <h2>Chave Pix para receber</h2>
        {d && !edit ? (
          <>
            <p className="mb0"><strong>{d.pixKeyType} {d.maskedKey}</strong> · {d.holderName} <Badge tone={d.status === 'VERIFICADA' ? '' : 'orange'}>{d.status === 'VERIFICADA' ? 'Verificada' : 'Em conferência pela Central'}</Badge></p>
            {new Date(d.availableFrom) > new Date() && <p className="small caution mt">Por segurança, repasses para esta chave ficam liberados a partir de {dateTime(d.availableFrom)}.</p>}
            <p className="mt"><button type="button" className="linklike" onClick={() => setEdit(true)}>Trocar chave Pix</button></p>
          </>
        ) : (
          <form onSubmit={submit} noValidate>
            <p className="small muted">Use uma chave em seu nome (de preferência o seu CPF: a conferência é imediata). Trocar a chave bloqueia novos repasses por 24 h e passa por dupla conferência da Central.</p>
            <div className="form-grid">
              <Field label="Tipo de chave"><select value={f.pixKeyType} onChange={(e) => setF({ ...f, pixKeyType: e.target.value })}>{KEY_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
              <Field label="Chave Pix" error={fieldError(save.error, 'pixKey')}><input type="text" autoComplete="off" value={f.pixKey} onChange={(e) => setF({ ...f, pixKey: e.target.value })} /></Field>
              <Field label="Nome do titular" error={fieldError(save.error, 'holderName')}><input type="text" autoComplete="name" value={f.holderName} onChange={(e) => setF({ ...f, holderName: e.target.value })} /></Field>
              <Field label="Sua senha (confirmação)" error={fieldError(save.error, 'password')}><input type="password" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
            </div>
            <Alert error={save.error && !Array.isArray(save.error.details) ? save.error : null} />
            <div className="row"><Button className="deep" busy={save.busy}>Salvar chave Pix</Button>{d && <button type="button" className="btn secondary" onClick={() => setEdit(false)}>Cancelar</button>}</div>
          </form>
        )}
      </section>

      <section className="flow-card mt">
        <h2>Repasses</h2>
        {!data.payouts.length ? <Empty title="Nenhum repasse ainda." /> : (
          <ul className="list">{data.payouts.map((p: any) => (
            <li key={p.id}>
              <div className="row between"><strong>{p.label}</strong><Badge tone={TONE[p.status] ?? 'blue'}>{p.statusLabel}</Badge></div>
              <div className="small muted">
                {p.completedAt ? `Concluído ${dateTime(p.completedAt)} · ` : ''}Bruto {money(p.grossCents)}{p.withholdingCents ? ` · retenções ${money(p.withholdingCents)}` : ''} · <strong>líquido {money(p.netCents)}</strong>
                {p.dueAt && !p.confirmedAt && ` · previsão até ${dateTime(p.dueAt)}`}{p.confirmedAt && ` · pago ${dateTime(p.confirmedAt)}`}
                {p.receiptUrl && <> · <a href={p.receiptUrl} target="_blank" rel="noopener noreferrer">comprovante</a></>}
              </div>
              {p.note && <div className="small">{p.note}</div>}
            </li>
          ))}</ul>
        )}
      </section>
      <p><Link to="/especialista">Voltar às ofertas</Link></p>
    </div>
  );
}
