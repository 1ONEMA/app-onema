import { useMemo, useState } from 'react';
import { DocLink } from '../../ui/DocViewer';
import { useAuth } from '../../lib/auth';
import { useApi, useSubmit } from '../../lib/hooks';
import { dateTime } from '../../lib/format';
import { Alert, Badge, Button, Empty, ErrorState, Field, Loading, PageHeader, fieldError } from '../../ui/ui';

const STATUS: Record<string, { label: string; tone: string }> = {
  PUBLICADO: { label: 'Liberado', tone: '' }, BLOQUEADO: { label: 'Aguardando liberação do RT', tone: 'orange' }, SUSPENSO: { label: 'Suspenso', tone: 'red' },
};
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const popPdf = (code: string, eventId?: string | null, version?: string) => {
  const q = new URLSearchParams(); if (version) q.set('version', version); if (eventId) q.set('eventId', eventId);
  return `/api/pops/${code}/pdf${q.toString() ? `?${q}` : ''}`;
};

/** Busca por código ou título (sem acentos). */
function usePopSearch(list: any[]) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const t = norm(q.trim());
    if (!t) return list;
    const num = t.replace(/\D/g, '');
    return list.filter((p) => norm(`${p.code} ${p.title}`).includes(t) || (num && p.code.endsWith(num.padStart(3, '0'))));
  }, [list, q]);
  return { q, setQ, shown };
}

/** Biblioteca institucional de POPs (RT e especialistas ONEMA ONE credenciadas). */
export function PopsLibraryPage() {
  const { has } = useAuth();
  const { data, error, loading, reload } = useApi<any>('/api/pops');
  const act = useSubmit<any>();
  const [sel, setSel] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const { q, setQ, shown } = usePopSearch(data?.pops ?? []);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const rt = data.canManage && has('AVALIADOR_RT');
  async function setStatus(status: string, all: boolean) {
    setMsg(null);
    const r = await act.run('POST', '/api/admin/pops/status', { status, note, ...(all ? { all: true } : { codes: sel }) });
    if (r) { setMsg(`${r.updated} POP(s) atualizados.`); setSel([]); setNote(''); reload(); }
  }
  const blocked = data.pops.filter((p: any) => p.status === 'BLOQUEADO').length;
  return (
    <>
      <PageHeader kicker="ONEMA SAÚDE" title="Biblioteca de POPs">
        <p>Procedimentos Operacionais Padrão da ONEMA, versão {data.libraryVersion}. {data.notice}</p>
      </PageHeader>
      {rt && (
        <section className="surface">
          <h2>Liberação (RT)</h2>
          <p className="small muted">Os documentos chegam bloqueados. Depois da homologação, libere para as especialistas. Suspender retira da consulta sem apagar os vínculos já feitos nos atendimentos. {blocked > 0 && <strong>{blocked} aguardando liberação.</strong>}</p>
          <Field label="Justificativa (fica na auditoria)" error={fieldError(act.error, 'note')}><input type="text" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: homologação técnica concluída em 10/11/2026" /></Field>
          <div className="row">
            <Button className="sm green" busy={act.busy} onClick={() => setStatus('PUBLICADO', true)}>Liberar todos</Button>
            <Button className="sm secondary" busy={act.busy} disabled={!sel.length} onClick={() => setStatus('PUBLICADO', false)}>Liberar selecionados ({sel.length})</Button>
            <Button className="sm secondary" busy={act.busy} disabled={!sel.length} onClick={() => setStatus('SUSPENSO', false)}>Suspender selecionados</Button>
          </div>
          <Alert error={act.error && !Array.isArray(act.error.details) ? act.error : null} success={msg} />
        </section>
      )}
      <section className="surface">
        <Field label="Buscar por código ou assunto"><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ex.: 018, curativo, sepse" /></Field>
        {!shown.length ? <Empty title={data.pops.length ? 'Nenhum POP encontrado.' : 'Nenhum POP disponível agora. Os POPs aparecem durante um atendimento seu em andamento.'} /> : (
          <ul className="list">{shown.map((p: any) => (
            <li key={p.id} className="row between">
              <span>
                {rt && <input type="checkbox" aria-label={`Selecionar ${p.code}`} checked={sel.includes(p.code)} onChange={(e) => setSel(e.target.checked ? [...sel, p.code] : sel.filter((c) => c !== p.code))} />}{' '}
                <DocLink url={popPdf(p.code, p.eventId, p.version)} name={`${p.code} ${p.title}`} />
                <span className="small muted"> · v{p.version} · vigência {p.effectiveFrom?.split('-').reverse().join('/')}</span>
              </span>
              {rt && <Badge tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Badge>}
            </li>
          ))}</ul>
        )}
      </section>
    </>
  );
}

/**
 * No atendimento (comando do RT, 21/11/2026): bloco "POPs sugeridos para este serviço", liberado no início do atendimento
 * e revogado ao concluir/cancelar. "Abrir POP" mostra o conteúdo integral dentro do app (consulta registrada; não registra
 * procedimento). Opcional: registrar na Carteira o POP usado, com justificativa.
 */
export function PopPanel({ eventId }: { eventId: string; active?: boolean }) {
  const data = useApi<any>(`/api/care/specialist/events/${eventId}/pops`);
  const add = useSubmit<any>();
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  if (data.error?.code === 'NOT_CREDENTIALED') return null;
  if (data.error) return <ErrorState error={data.error} onRetry={data.reload} />;
  if (!data.data) return <Loading lines={2} />;
  const d = data.data;
  async function link() {
    const r = await add.run('POST', `/api/care/specialist/events/${eventId}/pops`, { code, reason });
    if (r) { setCode(''); setReason(''); data.reload(); }
  }
  const linked = new Set(d.selected.map((x: any) => x.pop_code));
  return (
    <section className="flow-card mt pop-suggest" aria-label="POPs sugeridos para este serviço">
      <h2>POPs sugeridos para este serviço</h2>
      {!d.active ? <p className="small muted">{d.accessNote}</p> : d.noMapping ? (
        <div className="caution small" role="status">Sem POP vinculado a este serviço. A pendência foi encaminhada ao RT.</div>
      ) : (<>
        <p className="small muted">{d.mappingNote}</p>
        <ul className="list">{d.candidates.map((p: any) => (
          <li key={p.id} className="row between">
            <span><strong className="mono">{p.code}</strong> | {p.title} | v{p.version}{linked.has(p.code) ? <Badge>Registrado na Carteira</Badge> : null}</span>
            <span className="row">
              <DocLink url={popPdf(p.code, eventId, p.version)} name="Abrir POP" className="btn sm deep" />
              {!linked.has(p.code) && <button type="button" className="btn sm secondary" onClick={() => setCode(p.code)}>Registrar uso</button>}
            </span>
          </li>
        ))}</ul>
        {code && <>
          <p className="small mt">Registrar na Carteira do paciente o uso do <strong>{code}</strong> neste atendimento (opcional; não substitui a evolução).</p>
          <Field label="Por que este POP se aplica a este atendimento?" error={fieldError(add.error, 'reason')}><textarea rows={2} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></Field>
          <Alert error={add.error && !Array.isArray(add.error.details) ? add.error : null} />
          <div className="row"><Button className="sm deep" busy={add.busy} onClick={link}>Registrar</Button><button type="button" className="btn sm secondary" onClick={() => setCode('')}>Cancelar</button></div>
        </>}
      </>)}
      {d.selected.length > 0 && <>
        <h3 className="small mt">Registrados neste atendimento</h3>
        <ul className="list small">{d.selected.map((x: any) => <li key={x.id}><strong className="mono">{x.pop_code}</strong> {x.title} · v{x.pop_version} · {dateTime(x.created_at)}<div>{x.reason}</div></li>)}</ul>
      </>}
    </section>
  );
}
