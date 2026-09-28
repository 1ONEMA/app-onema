import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api, newKey } from '../../lib/api';
import { label } from '../../lib/format';
import { useApi } from '../../lib/hooks';
import { Alert, Badge, Button, ErrorState, Loading, PageHeader, Pending, Progress } from '../../ui/ui';

/** ACA-004 Player da aula: conteúdo, legenda/transcrição e conclusão controlada pelo servidor. */
export function LessonPage() {
  const { code } = useParams();
  const { data, error, loading, reload } = useApi<any>(`/api/academy/lessons/${code}`);
  const [progress, setProgress] = useState<any>(null);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const local = useRef({ percent: 0, position: 0 });
  const endRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const saveKey = useRef<string | null>(null);

  useEffect(() => { if (data) { setProgress(data.progress); local.current = { percent: data.progress.percent, position: data.progress.lastPosition }; } }, [data]);

  const save = useCallback(async (complete: boolean) => {
    if (!progress) return;
    setSaving(true); setSaveError(null);
    if (!saveKey.current) saveKey.current = newKey();
    try {
      const r = await api('PUT', `/api/academy/progress/${code}`, {
        percent: Math.round(local.current.percent), position: Math.round(local.current.position), complete, rowVersion: progress.rowVersion,
      }, { idempotencyKey: saveKey.current });
      saveKey.current = null;
      setProgress(r);
      if (complete) setNotice('Aula concluída e registrada.');
    } catch (e: any) {
      if (!(e instanceof ApiError) || !e.isNetwork) saveKey.current = null;
      if (e.code === 'PROGRESS_CONFLICT') { setProgress(e.details); local.current.percent = Math.max(local.current.percent, e.details.percent); setNotice(e.message); }
      else setSaveError(e);
    } finally { setSaving(false); }
  }, [code, progress]);

  // Texto: marca 100% quando o final do conteúdo é exibido
  useEffect(() => {
    if (!data || data.lesson.video || !endRef.current) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && local.current.percent < 100) { local.current.percent = 100; setProgress((p: any) => p && { ...p, percent: Math.max(p.percent, 100) }); }
    }, { threshold: 1 });
    io.observe(endRef.current);
    return () => io.disconnect();
  }, [data]);

  if (loading && !data) return <Loading />;
  if (error) return <><PageHeader title={`Aula ${code}`} back={{ to: `/academy/cursos/${code?.slice(0, 3)}`, label: 'Voltar ao curso' }} /><ErrorState error={error} onRetry={reload} /></>;
  const l = data.lesson;
  const p = progress ?? data.progress;
  const viewPercent = Math.max(p.percent, local.current.percent);
  const canComplete = l.completionMinPercent != null && viewPercent >= l.completionMinPercent && p.state !== 'CONCLUIDA';
  return (
    <>
      <PageHeader kicker={l.code} title={l.title} back={{ to: `/academy/cursos/${l.courseCode}`, label: 'Voltar ao curso' }}>
        <Badge tone={p.state === 'CONCLUIDA' ? '' : 'blue'}>{label(p.state)}</Badge>
      </PageHeader>
      <div className="two wide-left">
        <article className="surface">
          {!l.body && !l.video && <Pending>O conteúdo desta aula ainda não foi disponibilizado (P-006).</Pending>}
          {l.video && (
            <div className="stack">
              <video ref={videoRef} controls preload="metadata" style={{ width: '100%', borderRadius: 12, background: '#000' }}
                onTimeUpdate={(e) => { const v = e.currentTarget; if (v.duration) { local.current = { percent: Math.max(local.current.percent, (v.currentTime / v.duration) * 100), position: v.currentTime }; } }}
                onPause={() => save(false)} onEnded={() => save(false)}
                onLoadedMetadata={(e) => { if (p.lastPosition) e.currentTarget.currentTime = p.lastPosition; }}>
                <source src={l.video.url} type={l.video.mime} />
                {l.caption && <track kind="captions" src={l.caption.url} srcLang="pt-BR" label="Português" default />}
              </video>
              {l.transcript && <a href={l.transcript.url} target="_blank" rel="noopener">Abrir transcrição</a>}
            </div>
          )}
          {l.body && <div style={{ whiteSpace: 'pre-wrap' }}>{l.body}</div>}
          <div ref={endRef} aria-hidden style={{ height: 1 }} />
        </article>
        <aside className="surface">
          <h2>Seu progresso</h2>
          <Progress value={viewPercent} label="Progresso da aula" />
          <p className="small muted">{Math.round(viewPercent)}% percorrido{l.completionMinPercent != null ? ` · mínimo para concluir: ${l.completionMinPercent}%` : ''}</p>
          {l.completionMinPercent == null && <Pending>Critério de conclusão desta aula ainda não definido.</Pending>}
          <Alert error={saveError} success={notice} />
          <div className="row">
            <Button className="deep" busy={saving} disabled={!canComplete} onClick={() => save(true)}>{p.state === 'CONCLUIDA' ? 'Aula concluída' : 'Marcar como concluída'}</Button>
            {p.state !== 'CONCLUIDA' && <Button className="ghost" busy={saving} onClick={() => save(false)}>Salvar posição</Button>}
          </div>
          <hr className="divider" />
          <div className="row between">
            {l.prev ? <Link to={`/academy/aulas/${l.prev}`}>← {l.prev}</Link> : <span />}
            {l.next ? <Link to={`/academy/aulas/${l.next}`}>{l.next} →</Link> : <Link to={`/academy/cursos/${l.courseCode}`}>Voltar ao curso</Link>}
          </div>
        </aside>
      </div>
    </>
  );
}
