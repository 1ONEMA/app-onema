import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { useApi, useSubmit } from '../../lib/hooks';
import { dateTime } from '../../lib/format';
import { Alert, Badge, Button, Empty, ErrorState, Field, Loading, PageHeader, fieldError } from '../../ui/ui';

const STATUS: Record<string, { label: string; tone: string }> = {
  PUBLICADO: { label: 'Liberado', tone: '' }, BLOQUEADO: { label: 'Aguardando liberação do RT', tone: 'orange' }, SUSPENSO: { label: 'Suspenso', tone: 'red' },
};
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const pdfUrl = (code: string, version?: string) => `/api/pops/${code}/pdf${version ? `?version=${encodeURIComponent(version)}` : ''}`;

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
        {!shown.length ? <Empty title={data.pops.length ? 'Nenhum POP encontrado.' : 'Nenhum POP liberado ainda pelo RT.'} /> : (
          <ul className="list">{shown.map((p: any) => (
            <li key={p.id} className="row between">
              <span>
                {rt && <input type="checkbox" aria-label={`Selecionar ${p.code}`} checked={sel.includes(p.code)} onChange={(e) => setSel(e.target.checked ? [...sel, p.code] : sel.filter((c) => c !== p.code))} />}{' '}
                <a href={pdfUrl(p.code, p.version)} target="_blank" rel="noopener noreferrer"><strong className="mono">{p.code}</strong> {p.title}</a>
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

/** No atendimento: POPs candidatos pelo serviço + busca; a enfermeira escolhe e justifica. */
export function PopPanel({ eventId, active }: { eventId: string; active: boolean }) {
  const data = useApi<any>(`/api/care/specialist/events/${eventId}/pops`);
  const lib = useApi<any>('/api/pops');
  const add = useSubmit<any>();
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const { q, setQ, shown } = usePopSearch(lib.data?.pops?.filter((p: any) => p.status === 'PUBLICADO') ?? []);
  if (data.error?.code === 'NOT_CREDENTIALED' || lib.error) return null;
  if (!data.data) return <Loading lines={2} />;
  const selected = data.data.selected;
  async function link() {
    const r = await add.run('POST', `/api/care/specialist/events/${eventId}/pops`, { code, reason });
    if (r) { setCode(''); setReason(''); data.reload(); }
  }
  return (
    <section className="flow-card mt">
      <h2>POPs de referência <span className="small muted">(opcional)</span></h2>
      <p className="small muted">{data.data.mappingNote} O POP fica registrado na Carteira do paciente com a versão usada e não substitui a evolução.</p>
      {selected.length > 0 && <ul className="list">{selected.map((s: any) => (
        <li key={s.id}><a href={pdfUrl(s.pop_code, s.pop_version)} target="_blank" rel="noopener noreferrer"><strong className="mono">{s.pop_code}</strong> {s.title}</a> <span className="small muted">· v{s.pop_version} · {dateTime(s.created_at)}</span><div className="small">{s.reason}</div></li>
      ))}</ul>}
      {active && (
        <>
          {data.data.candidates.length > 0 && <>
            <h3 className="small">Sugeridos para este serviço</h3>
            <div className="chips">{data.data.candidates.map((p: any) => (
              <button key={p.id} type="button" className={`chip ${code === p.code ? 'active' : ''}`} aria-pressed={code === p.code} title={p.title} onClick={() => setCode(p.code)}>{p.code.slice(-3)} · {p.title.slice(0, 48)}{p.title.length > 48 ? '…' : ''}</button>
            ))}</div>
          </>}
          <details className="mt"><summary className="small">Buscar outro POP na biblioteca</summary>
            <Field label="Código ou assunto"><input type="search" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
            {q && <ul className="list small">{shown.slice(0, 8).map((p: any) => <li key={p.id}><button type="button" className="linklike" onClick={() => setCode(p.code)}>{p.code} · {p.title}</button></li>)}</ul>}
          </details>
          {code && <>
            <p className="small mt">Selecionado: <strong>{code}</strong> · <a href={pdfUrl(code)} target="_blank" rel="noopener noreferrer">abrir PDF</a></p>
            <Field label="Por que este POP se aplica a este atendimento?" error={fieldError(add.error, 'reason')}><textarea rows={2} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></Field>
            <Alert error={add.error && !Array.isArray(add.error.details) ? add.error : null} />
            <Button className="sm deep" busy={add.busy} onClick={link}>Vincular ao atendimento</Button>
          </>}
          <p className="small mt"><Link to="/pops">Abrir a biblioteca completa</Link></p>
        </>
      )}
    </section>
  );
}
