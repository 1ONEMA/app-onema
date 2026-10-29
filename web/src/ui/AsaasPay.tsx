import { useEffect } from 'react';
import type { ApiError } from '../lib/api';
import { Field, fieldError } from './ui';
import { IconShield } from './icons';

/** Abre a página segura do Asaas em outra aba (se o navegador bloquear, segue na mesma aba). */
export function openPayment(url: string | null | undefined) {
  if (!url) return;
  const w = window.open(url, '_blank', 'noopener');
  if (!w) window.location.assign(url);
}

/** Aviso do pagamento real + CPF do pagador (pedido só quando o Asaas ainda não conhece o pagador). */
export function AsaasNotice({ error, cpf, setCpf }: { error: ApiError | null; cpf: string; setCpf: (v: string) => void }) {
  const askCpf = error?.code === 'CPF_REQUIRED' || !!fieldError(error, 'payerCpf') || cpf.length > 0;
  return (
    <div className="asaas-box">
      <div className="row"><span className="nav-shield" aria-hidden><IconShield size={18} /></span>
        <p className="mb0"><strong>Pagamento seguro pelo Asaas.</strong> Você escolhe Pix, boleto ou cartão na página do Asaas. Os dados do cartão não passam pela ONEMA.</p></div>
      {askCpf && (
        <Field label="CPF de quem vai pagar" hint="Exigido pelo Asaas para emitir a cobrança. Pedimos só uma vez e não guardamos o número na ONEMA." error={fieldError(error, 'payerCpf')}>
          <input type="text" inputMode="numeric" autoComplete="off" value={cpf} onChange={(e) => setCpf(e.target.value)} placeholder="000.000.000-00" />
        </Field>
      )}
    </div>
  );
}

/** Pagamento emitido e ainda não confirmado: link para a página do Asaas + atualização automática. */
export function PendingPayment({ url, onPoll, what = 'pedido' }: { url: string | null; onPoll: () => void; what?: string }) {
  useEffect(() => {
    const t = window.setInterval(onPoll, 6000);
    return () => window.clearInterval(t);
  }, [onPoll]);
  return (
    <div className="caution" role="status">
      <strong>Aguardando a confirmação do pagamento.</strong> Assim que o Asaas confirmar, o {what} é liberado automaticamente nesta tela.
      {url && <div className="mt"><button type="button" className="btn sm deep" onClick={() => openPayment(url)}>Abrir a página de pagamento</button></div>}
    </div>
  );
}
