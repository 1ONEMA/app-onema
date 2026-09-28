import { useEffect, useState } from 'react';
import { dateTime } from '../../lib/format';
import { useApi, useSubmit } from '../../lib/hooks';
import { Alert, Button, ErrorState, Loading, PageHeader } from '../../ui/ui';
import { ChannelPicker } from './PrimeSubscribePage';
import { useT3 } from './t3';

const EVENT: Record<string, string> = { OPT_IN: 'Ativado', OPT_OUT: 'Desativado', CHANGE: 'Alterado' };
const PURPOSE: Record<string, string> = { LEMBRETES: 'Lembretes opcionais', RESUMO_MENSAL: 'Resumo mensal', OFERTAS: 'Ofertas e novidades' };

/** PRIME → preferências: finalidade × canal × frequência, com histórico de alterações. */
export function PreferencesPage() {
  const { data, error, loading, reload } = useApi<any>('/api/prime/preferences');
  const t3 = useT3();
  const save = useSubmit<any>();
  const [prefs, setPrefs] = useState<any>(null);
  const [ok, setOk] = useState<string | null>(null);
  useEffect(() => { if (data) setPrefs(data.preferences); }, [data]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!prefs) return <Loading />;
  const labels: Record<string, string> = { LEMBRETES: t3.reminders, RESUMO_MENSAL: t3.summary, OFERTAS: t3.marketing };
  async function submit() {
    setOk(null);
    const body = Object.fromEntries(Object.entries(prefs).map(([k, v]: any) => [k, { enabled: v.enabled, channels: v.channels, ...(k === 'LEMBRETES' ? { frequency: v.frequency } : {}) }]));
    const r = await save.run('PUT', '/api/prime/preferences', body);
    if (r) { setOk('Preferências salvas. Novos envios opcionais seguem imediatamente estas escolhas.'); reload(); }
  }
  return (
    <>
      <PageHeader kicker="ONEMA PRIME" title="Escolha seus avisos" back={{ to: '/prime/assinatura', label: 'Minha assinatura' }}>
        <p>Avisos essenciais de serviço e cobrança seguem finalidade própria. Você controla os opcionais.</p>
      </PageHeader>
      {!data.dispatchConfigured && <div className="caution small">O envio de lembretes, resumos e ofertas por e-mail/WhatsApp ainda não está integrado neste ambiente. Suas escolhas ficam registradas e serão respeitadas quando o envio for habilitado.</div>}
      <section className="surface">
        {Object.keys(PURPOSE).map((k) => (
          <div key={k} className="choice" style={{ display: 'block' }}>
            <label className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
              <input type="checkbox" checked={prefs[k].enabled} onChange={(e) => setPrefs({ ...prefs, [k]: { ...prefs[k], enabled: e.target.checked } })} />
              <span><strong>{PURPOSE[k]}</strong><br /><span className="small">{labels[k]}</span></span>
            </label>
            <ChannelPicker idPrefix={k} value={prefs[k]} onChange={(p) => setPrefs({ ...prefs, [k]: { ...prefs[k], ...p } })} whatsappEnabled={data.whatsappEnabled} />
            {k === 'LEMBRETES' && prefs[k].enabled && (
              <label className="row small" style={{ paddingLeft: 32, marginTop: 6 }}>Frequência
                <select style={{ width: 'auto' }} value={prefs[k].frequency ?? ''} onChange={(e) => setPrefs({ ...prefs, [k]: { ...prefs[k], frequency: e.target.value || null } })}>
                  <option value="">Selecione</option>{data.reminderFrequencies.map((f: string) => <option key={f} value={f}>{f.toLowerCase()}</option>)}
                </select>
              </label>
            )}
            {prefs[k].updatedAt && <p className="small muted mb0" style={{ paddingLeft: 32 }}>Última alteração: {dateTime(prefs[k].updatedAt)}</p>}
          </div>
        ))}
        <p className="small muted">{t3.channels}</p>
        <Alert error={save.error} success={ok} />
        <Button className="deep" busy={save.busy} disabled={prefs.LEMBRETES.enabled && !prefs.LEMBRETES.frequency} onClick={submit}>Salvar preferências</Button>
      </section>
      <section className="surface">
        <h2>Histórico de escolhas</h2>
        {!data.events.length ? <p className="muted">Nenhuma alteração registrada.</p> : (
          <ul className="list small">{data.events.map((e: any, i: number) => <li key={i}>{dateTime(e.occurred_at)} · {PURPOSE[e.purpose]} {e.channel ? `· ${e.channel.toLowerCase()}` : ''} — <strong>{EVENT[e.event]}</strong></li>)}</ul>
        )}
      </section>
    </>
  );
}
