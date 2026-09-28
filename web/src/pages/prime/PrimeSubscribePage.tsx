import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { date, money, pct } from '../../lib/format';
import { useApi, useSubmit } from '../../lib/hooks';
import { Alert, Button, ErrorState, LegalText, Loading, PageHeader } from '../../ui/ui';
import { useT3 } from './t3';

type Pref = { enabled: boolean; channels: { app: boolean; email: boolean; whatsapp: boolean }; frequency?: string | null };
export const OFF: Pref = { enabled: false, channels: { app: false, email: false, whatsapp: false } };

export function ChannelPicker({ value, onChange, whatsappEnabled, idPrefix }: { value: Pref; onChange: (p: Pref) => void; whatsappEnabled: boolean; idPrefix: string }) {
  const set = (k: 'app' | 'email' | 'whatsapp', v: boolean) => onChange({ ...value, channels: { ...value.channels, [k]: v } });
  return (
    <fieldset style={{ border: 0, padding: '4px 0 0 32px', margin: 0 }} disabled={!value.enabled}>
      <legend className="small muted" style={{ padding: 0 }}>Canais para esta finalidade</legend>
      <div className="row">
        <label className="row small" htmlFor={`${idPrefix}-app`}><input id={`${idPrefix}-app`} type="checkbox" checked={value.channels.app} onChange={(e) => set('app', e.target.checked)} /> Aplicativo</label>
        <label className="row small" htmlFor={`${idPrefix}-email`}><input id={`${idPrefix}-email`} type="checkbox" checked={value.channels.email} onChange={(e) => set('email', e.target.checked)} /> E-mail</label>
        <label className="row small" htmlFor={`${idPrefix}-wa`} title={whatsappEnabled ? '' : 'Canal oficial ainda não habilitado'}>
          <input id={`${idPrefix}-wa`} type="checkbox" disabled={!whatsappEnabled} checked={value.channels.whatsapp} onChange={(e) => set('whatsapp', e.target.checked)} /> WhatsApp{!whatsappEnabled && ' (indisponível)'}
        </label>
      </div>
      {value.enabled && !value.channels.app && !value.channels.email && !value.channels.whatsapp && <p className="small" style={{ color: 'var(--amber-ink)' }}>Sem canal selecionado, nenhuma comunicação desta finalidade será enviada.</p>}
    </fieldset>
  );
}

/** PRIME → adesão: preço, ciclo, meio de pagamento, T1 + T2, aceite obrigatório e opcionais em blocos distintos, nada pré-marcado. */
export function PrimeSubscribePage() {
  const nav = useNavigate();
  const offer = useApi<any>('/api/prime/offer');
  const preview = useApi<any>('/api/prime/subscriptions/preview');
  const t1 = useApi<any>('/api/prime/texts/T1');
  const t2 = useApi<any>('/api/prime/texts/T2');
  const t3 = useT3();
  const submit = useSubmit<any>();
  const [accept, setAccept] = useState(false);
  const [method, setMethod] = useState('');
  const [prefs, setPrefs] = useState<Record<string, Pref>>({ LEMBRETES: { ...OFF, frequency: null }, RESUMO_MENSAL: OFF, OFERTAS: OFF });
  const [result, setResult] = useState<any>(null);
  if (offer.loading || preview.loading || t1.loading || t2.loading) return <Loading />;
  const err = offer.error || preview.error || t1.error || t2.error;
  if (err) return <ErrorState error={err} onRetry={() => { offer.reload(); preview.reload(); t1.reload(); t2.reload(); }} />;
  const o = offer.data, pv = preview.data;
  const setPref = (k: string, p: Pref) => setPrefs({ ...prefs, [k]: p });

  async function confirm() {
    const r = await submit.run('POST', '/api/prime/subscriptions', {
      acceptTerms: accept, termsTextId: o.terms.id, privacyTextId: o.privacy.id, paymentMethod: method, preferences: prefs,
    }, { idempotent: true });
    if (r) setResult(r);
  }
  if (result) {
    return (
      <>
        <PageHeader kicker="ONEMA PRIME" title={result.paid ? 'Assinatura ativada' : 'Pagamento não confirmado'} />
        <section className="surface">
          {result.paid ? <div className="success" role="status">Seu ONEMA PRIME foi ativado. Protocolo {result.subscription.protocol}. O comprovante completo está na Central PRIME.</div>
            : <div className="caution" role="status">{result.message}</div>}
          <Link to="/prime/assinatura" className="btn deep">Ir para a Central PRIME</Link>
        </section>
      </>
    );
  }
  return (
    <>
      <PageHeader kicker="ONEMA PRIME · adesão" title="Confira antes de assinar" back={{ to: '/prime', label: 'Oferta PRIME' }}>
        <p>Nenhuma opção vem marcada. As escolhas opcionais não impedem o uso do aplicativo.</p>
      </PageHeader>
      <div className="two">
        <section className="surface">
          <h2>Resumo da contratação</h2>
          <ul className="list">
            <li className="row between"><span>Mensalidade</span><strong>{money(pv.amountCents)}</strong></li>
            <li className="row between"><span>Primeira cobrança prevista</span><strong>{date(pv.firstChargeAt)}</strong></li>
            <li className="row between"><span>Referência</span><strong>{pv.cycleReference}: {date(pv.cycleStartsAt)} a {date(pv.cycleEndsAt)}</strong></li>
            <li className="row between"><span>Próxima renovação prevista</span><strong>{date(pv.nextRenewalAt)}</strong></li>
            <li className="row between"><span>Desconto do ciclo</span><strong>{pct(o.discountBps)} em um pedido elegível, até {money(o.discountCapCents)}</strong></li>
          </ul>
          <p className="small muted">{pv.note}</p>
          <h3 className="mt">Meio de pagamento</h3>
          <div className="radio-list" role="radiogroup" aria-label="Meio de pagamento">
            {o.paymentMethods.map((m: any) => (
              <label key={m.id} className={method === m.id ? 'selected' : ''}>
                <input type="radio" name="method" value={m.id} checked={method === m.id} onChange={() => setMethod(m.id)} />
                <span>{m.label} <span className="demo-flag">SANDBOX</span></span>
              </label>
            ))}
          </div>
          <p className="small muted">Pagamentos simulados. Nenhuma cobrança real é feita neste ambiente.</p>
          <h3 className="mt">Fornecedor</h3>
          {o.provider.validated ? (
            <p className="small">{o.provider.legalName} · CNPJ {o.provider.cnpj}<br />{o.provider.address}<br />Atendimento: {o.provider.supportChannel}</p>
          ) : <p className="caution small">Identificação formal do fornecedor (razão social, CNPJ, endereço e canal de atendimento) pendente de validação jurídica. A publicação em produção permanece bloqueada.</p>}
        </section>
        <section className="surface" id="termos">
          <h2>{t1.data.title}</h2>
          <div className="contract-scroll" tabIndex={0} aria-label="Termos completos da assinatura"><LegalText body={t1.data.body} /></div>
          <h2 className="mt">{t2.data.title}</h2>
          <div className="contract-scroll" tabIndex={0} aria-label="Aviso de privacidade"><LegalText body={t2.data.body} /></div>
          <p className="small muted">Versão {t1.data.version} · revisão jurídica: {t1.data.legalReview === 'APROVADO' ? 'aprovada' : 'pendente (homologação)'}</p>
        </section>
      </div>
      <section className="surface">
        <h2>Aceite obrigatório</h2>
        <label className="choice mandatory"><input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} /><span>{t3.mandatory}</span></label>
        <h2 className="mt">Escolhas opcionais</h2>
        <p className="small muted">{t3.channels}</p>
        <div className="choice" style={{ display: 'block' }}>
          <label className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}><input type="checkbox" checked={prefs.LEMBRETES.enabled} onChange={(e) => setPref('LEMBRETES', { ...prefs.LEMBRETES, enabled: e.target.checked })} /><span>{t3.reminders}</span></label>
          <ChannelPicker idPrefix="lem" value={prefs.LEMBRETES} onChange={(p) => setPref('LEMBRETES', p)} whatsappEnabled={o.whatsappEnabled} />
          {prefs.LEMBRETES.enabled && (
            <label className="row small" style={{ paddingLeft: 32, marginTop: 6 }}>Frequência
              <select value={prefs.LEMBRETES.frequency ?? ''} onChange={(e) => setPref('LEMBRETES', { ...prefs.LEMBRETES, frequency: e.target.value || null })} style={{ width: 'auto' }}>
                <option value="">Selecione</option>{o.reminderFrequencies.map((f: string) => <option key={f} value={f}>{f.toLowerCase()}</option>)}
              </select>
            </label>
          )}
        </div>
        <div className="choice" style={{ display: 'block' }}>
          <label className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}><input type="checkbox" checked={prefs.RESUMO_MENSAL.enabled} onChange={(e) => setPref('RESUMO_MENSAL', { ...prefs.RESUMO_MENSAL, enabled: e.target.checked })} /><span>{t3.summary}</span></label>
          <ChannelPicker idPrefix="res" value={prefs.RESUMO_MENSAL} onChange={(p) => setPref('RESUMO_MENSAL', p)} whatsappEnabled={o.whatsappEnabled} />
        </div>
        <div className="choice" style={{ display: 'block' }}>
          <label className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}><input type="checkbox" checked={prefs.OFERTAS.enabled} onChange={(e) => setPref('OFERTAS', { ...prefs.OFERTAS, enabled: e.target.checked })} /><span>{t3.marketing}</span></label>
          <ChannelPicker idPrefix="ofe" value={prefs.OFERTAS} onChange={(p) => setPref('OFERTAS', p)} whatsappEnabled={o.whatsappEnabled} />
        </div>
        <Alert error={submit.error} />
        <div className="row mt">
          <Button className="deep" busy={submit.busy} disabled={!accept || !method || !t3.loaded || (prefs.LEMBRETES.enabled && !prefs.LEMBRETES.frequency)} onClick={confirm}>Confirmar assinatura</Button>
          <Button className="ghost" onClick={() => nav('/minha-onema')}>Continuar sem PRIME</Button>
        </div>
        {(!accept || !method) && <p className="small muted mt">Para confirmar, marque o aceite obrigatório e escolha o meio de pagamento.</p>}
      </section>
    </>
  );
}
