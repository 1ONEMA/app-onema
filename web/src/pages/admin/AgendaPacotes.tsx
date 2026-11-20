import { useState } from 'react';
import { useLiveApi, useSubmit } from '../../lib/hooks';
import { dateTime } from '../../lib/format';
import { useAuth } from '../../lib/auth';
import { Alert, Badge, Button, Empty, ErrorState, Field, Loading, PageHeader } from '../../ui/ui';
import { OfflineNotice, fromLocalInput, toLocalInput } from '../../ui/Live';
import { STATE_TONE } from '../care/OrdersPages';

const ATTENTION: Record<string, string> = {
  JANELA_VENCIDA: 'Janela vencida sem aceite: combinar nova janela com o paciente',
  SEM_COBERTURA: 'Sem profissional elegível: acionar a rede ou reofertar',
  REVISAR_AGENDA: 'Aceite registrado antes da regra: confirmar ou corrigir a agenda',
};
const LOG_LABEL: Record<string, string> = {
  PUBLICADA: 'Oferta publicada', A_PROGRAMAR: 'A programar', PROGRAMADA: 'Janela programada', ONDA_AMPLIADA: 'Onda ampliada', RECUSA: 'Recusa',
  ACEITE: 'Aceite', JANELA_VENCIDA: 'Janela vencida', SEM_COBERTURA: 'Sem cobertura', REATRIBUIDA: 'Reatribuída', PENDENCIA_RESOLVIDA: 'Pendência resolvida',
  CONVITE_ENCERRADO: 'Convite encerrado (revisão)', REVISAR_AGENDA: 'Revisar agenda',
};

/**
 * Gestão › Agenda de pacotes (PAC-03): eventos de cada pedido com estado, janela, onda, referência, recusas e histórico;
 * ações de programar janela, liberar/reofertar, reatribuir e resolver pendência (sempre com motivo).
 */
export function AgendaPacotesPage() {
  const [all, setAll] = useState(false);
  const { data, error, loading, reload, offline } = useLiveApi<any>(`/api/admin/care/agenda${all ? '?all=1' : ''}`, 5000);
  const { has } = useAuth();
  const canAct = has('OPERADOR_CENTRAL', 'ADMIN_PRIME', 'AVALIADOR_RT');
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  const pend = data.orders.flatMap((o: any) => o.events.filter((e: any) => e.attention)).length;
  return (
    <>
      <PageHeader kicker="Gestão" title="Agenda de pacotes">
        <p>Motor de ofertas: só a avaliação inicial entra em oferta após o pagamento; os demais eventos ficam "A programar" até a Central validar a janela. A oferta abre na antecedência configurada, depois da avaliação inicial realizada.</p>
      </PageHeader>
      <OfflineNotice offline={offline} />
      <div className="row">
        {pend > 0 && <Badge tone="orange">{pend} pendência(s)</Badge>}
        <label className="choice"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /><span>Mostrar também pedidos sem eventos em aberto</span></label>
      </div>
      {!data.orders.length ? <div className="surface mt"><Empty title="Nenhum pedido com eventos em aberto." /></div> : (
        <div className="stack mt">{data.orders.map((o: any) => (
          <section key={o.id} className="surface">
            <div className="row between">
              <h2 className="h4 mb0">{o.itemCode} · {o.itemName}</h2>
              <span className="small muted">pago em {dateTime(o.paidAt)}</span>
            </div>
            <p className="small">{o.patientName} · {o.protocol ?? '—'} · {o.location ?? ''} {o.phone && <>· contato: <a href={`tel:${String(o.phone).replace(/[^0-9+]/g, '')}`}>{o.phone}</a></>}</p>
            <ul className="list">{o.events.map((e: any) => <li key={e.id}><AgendaEvent e={e} canAct={canAct} onDone={reload} /></li>)}</ul>
          </section>
        ))}</div>
      )}
      {has('ADMIN_PRIME', 'OPERADOR_CENTRAL') && <EngineParams params={data.params} onDone={reload} />}
    </>
  );
}

function AgendaEvent({ e, canAct, onDone }: { e: any; canAct: boolean; onDone: () => void }) {
  const s = useSubmit<any>();
  const [mode, setMode] = useState<null | 'plan' | 'release' | 'reassign' | 'resolve'>(null);
  const [ws, setWs] = useState(toLocalInput(e.windowStart ?? new Date(Date.now() + 2 * 86400_000).toISOString()));
  const [we, setWe] = useState(toLocalInput(e.windowEnd ?? new Date(Date.now() + 2 * 86400_000 + 4 * 3600_000).toISOString()));
  const [note, setNote] = useState('');
  async function go(path: string, body: any) {
    if (await s.run('POST', `/api/admin/care/events/${e.id}/${path}`, body, { idempotent: true })) { setMode(null); setNote(''); onDone(); }
  }
  const open = ['A_PROGRAMAR', 'DISPONIVEL'].includes(e.status);
  return (<>
    <div className="row between">
      <span><strong>{e.seq}. {e.label}</strong> <span className="small muted">· {e.modality === 'REMOTO' ? 'remoto' : 'presencial'}</span></span>
      <Badge tone={STATE_TONE[e.state.code] ?? ''}>{e.state.label}</Badge>
    </div>
    {e.attention && <div className="caution small" role="status">{ATTENTION[e.attention] ?? e.attention}{e.attentionAt ? ` · desde ${dateTime(e.attentionAt)}` : ''}</div>}
    <div className="small muted">
      {e.window ? `Janela: ${e.window}` : 'Sem janela'}{e.offerOpensAt && e.status === 'A_PROGRAMAR' ? ` · oferta abre ${dateTime(e.offerOpensAt)}` : ''}
      {e.dependsOnSeq ? ` · depende do evento ${e.dependsOnSeq}` : ''}
      {e.status === 'DISPONIVEL' ? ` · onda ${e.wave}${e.reference ? ` (referência: ${e.reference}${e.referenceUntil ? ` até ${dateTime(e.referenceUntil)}` : ''})` : ''} · ${e.declines} recusa(s)` : ''}
      {e.specialist ? ` · ${e.specialist}` : ''}{e.scheduledAt ? ` · horário ${dateTime(e.scheduledAt)}` : ''}
    </div>
    {e.log.length > 0 && (
      <details className="small"><summary>Histórico do motor ({e.log.length})</summary>
        <ul>{e.log.map((l: any, i: number) => <li key={i}>{dateTime(l.created_at)} · {LOG_LABEL[l.kind] ?? l.kind}{l.wave ? ` · onda ${l.wave}` : ''}{l.specialist_name ? ` · ${l.specialist_name}` : ''}{l.actor_name ? ` · por ${l.actor_name}` : ''}{l.note ? ` · ${l.note}` : ''}</li>)}</ul>
      </details>
    )}
    {canAct && !mode && (
      <div className="row mt">
        {open && <button type="button" className="btn sm secondary" onClick={() => setMode('plan')}>{e.planValidatedAt || e.windowStart ? 'Reprogramar janela' : 'Programar janela'}</button>}
        {open && e.windowEnd && <button type="button" className="btn sm secondary" onClick={() => setMode('release')}>{e.status === 'DISPONIVEL' ? 'Reofertar' : 'Liberar oferta agora'}</button>}
        {e.status === 'ACEITO' && !e.startedAt && <button type="button" className="btn sm secondary" onClick={() => setMode('reassign')}>Reatribuir</button>}
        {e.attention && <button type="button" className="btn sm secondary" onClick={() => setMode('resolve')}>Resolver pendência</button>}
      </div>
    )}
    {mode && (
      <div className="mt">
        {mode === 'plan' && (
          <div className="row">
            <label className="field"><span className="small">Início da janela</span><input type="datetime-local" value={ws} onChange={(ev) => setWs(ev.target.value)} /></label>
            <label className="field"><span className="small">Fim da janela</span><input type="datetime-local" value={we} onChange={(ev) => setWe(ev.target.value)} /></label>
          </div>
        )}
        <Field label={mode === 'plan' ? 'Observação (opcional)' : 'Motivo'}><input value={note} maxLength={500} onChange={(ev) => setNote(ev.target.value)} /></Field>
        <div className="row">
          <Button className="sm deep" busy={s.busy} onClick={() => mode === 'plan'
            ? go('plan', { windowStart: fromLocalInput(ws), windowEnd: fromLocalInput(we), ...(note.trim() ? { note } : {}) })
            : go(mode === 'release' ? 'release' : mode === 'reassign' ? 'reassign' : 'confirm-agenda', { note })}>Confirmar</Button>
          <button type="button" className="btn sm secondary" onClick={() => setMode(null)}>Voltar</button>
        </div>
        <Alert error={s.error} />
      </div>
    )}
  </>);
}

function EngineParams({ params, onDone }: { params: any; onDone: () => void }) {
  const s = useSubmit<any>();
  const [p, setP] = useState(params);
  const [ok, setOk] = useState(false);
  const num = (v: string) => Number(v.replace(/\D/g, '') || 0);
  return (
    <section className="surface mt">
      <h2>Parâmetros do motor</h2>
      <p className="small muted">Faixas de "Hoje à noite" etc. (horário de Brasília), prazo exclusivo do profissional de referência e antecedência de abertura por modalidade. Valem para novas solicitações e novas ofertas.</p>
      <div className="form-grid">
        {(['MANHA', 'TARDE', 'NOITE', 'QUALQUER'] as const).map((k) => (
          <Field key={k} label={`Faixa ${k.toLowerCase()} (início–fim, h)`}>
            <div className="row">
              <input inputMode="numeric" value={p.faixas[k][0]} onChange={(e) => setP({ ...p, faixas: { ...p.faixas, [k]: [num(e.target.value), p.faixas[k][1]] } })} aria-label={`Início ${k}`} />
              <input inputMode="numeric" value={p.faixas[k][1]} onChange={(e) => setP({ ...p, faixas: { ...p.faixas, [k]: [p.faixas[k][0], num(e.target.value)] } })} aria-label={`Fim ${k}`} />
            </div>
          </Field>
        ))}
        <Field label='"Agora": janela em horas'><input inputMode="numeric" value={p.agoraHours} onChange={(e) => setP({ ...p, agoraHours: num(e.target.value) })} /></Field>
        <Field label='"Próximos dias": até N dias'><input inputMode="numeric" value={p.proximosDias} onChange={(e) => setP({ ...p, proximosDias: num(e.target.value) })} /></Field>
        <Field label="Prazo da referência (minutos)"><input inputMode="numeric" value={p.referenceMinutes} onChange={(e) => setP({ ...p, referenceMinutes: num(e.target.value) })} /></Field>
        <Field label="Antecedência presencial (horas)"><input inputMode="numeric" value={p.leadHours.PRESENCIAL} onChange={(e) => setP({ ...p, leadHours: { ...p.leadHours, PRESENCIAL: num(e.target.value) } })} /></Field>
        <Field label="Antecedência remoto (horas)"><input inputMode="numeric" value={p.leadHours.REMOTO} onChange={(e) => setP({ ...p, leadHours: { ...p.leadHours, REMOTO: num(e.target.value) } })} /></Field>
      </div>
      <Alert error={s.error} success={ok ? 'Parâmetros salvos.' : null} />
      <Button className="sm deep" busy={s.busy} onClick={async () => { setOk(false); if (await s.run('PUT', '/api/admin/care/offer-params', p)) { setOk(true); onDone(); } }}>Salvar parâmetros</Button>
    </section>
  );
}
