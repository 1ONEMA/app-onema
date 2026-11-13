import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type ApiError } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { uploadInParts } from '../../lib/upload';
import { Alert, Badge, Button, ErrorState, Loading, PageHeader } from '../../ui/ui';

/** Número da aula no nome do arquivo ("AULA 01.mp4", "Aula 3.mp4" → 1, 3). */
const lessonNumber = (name: string) => { const m = /aula\D{0,3}0*(\d{1,2})/i.exec(name) ?? /(\d{1,2})\D*\.\w+$/.exec(name); return m ? Number(m[1]) : null; };
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`;

type Row = { file: File; n: number | null; lesson?: any; status: string; pct: number; error?: string };

/**
 * Envio em lote dos vídeos das aulas: para cada curso, cria (ou reaproveita) o rascunho da nova versão,
 * liga AULA 01 → A01, AULA 02 → A02… e envia para a revisão do RT. Nada vai ao ar sem a aprovação do RT e a publicação.
 */
export function CourseVideosPage() {
  const { data, error, loading, reload } = useApi<any>('/api/admin/academy/courses');
  const [rows, setRows] = useState<Record<string, Row[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<Record<string, ApiError | null>>({});
  const [done, setDone] = useState<Record<string, string>>({});
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  async function draftFor(code: string) {
    const c = data.courses.find((x: any) => x.code === code);
    const review = c.versions.find((v: any) => v.state === 'IN_REVIEW');
    if (review) throw Object.assign(new Error(`O curso ${code} já tem uma versão em revisão do RT. Aguarde a aprovação ou devolução antes de enviar novos vídeos.`), { code: 'IN_REVIEW' });
    const draft = c.versions.find((v: any) => v.state === 'DRAFT');
    const id = draft?.id ?? (await api<any>('POST', '/api/admin/academy/course-versions', { courseCode: code })).id;
    return await api<any>('GET', `/api/admin/academy/course-versions/${id}`);
  }

  async function pick(code: string, files: FileList | null) {
    setErr({ ...err, [code]: null }); setDone({ ...done, [code]: '' });
    if (!files?.length) return;
    try {
      const v = await draftFor(code);
      const lessons = [...v.lessons].sort((a: any, b: any) => a.sort_order - b.sort_order);
      const list: Row[] = [...files].filter((f) => /\.(mp4|webm)$/i.test(f.name)).map((file) => {
        const n = lessonNumber(file.name);
        return { file, n, lesson: n ? lessons[n - 1] : undefined, status: 'pronto', pct: 0 };
      }).sort((a, b) => (a.n ?? 99) - (b.n ?? 99));
      setRows({ ...rows, [code]: list.map((r) => ({ ...r, versionId: v.version.id } as any)) });
      reload();
    } catch (e) { setErr({ ...err, [code]: e as ApiError }); }
  }

  async function send(code: string) {
    const list = rows[code];
    if (!list?.length) return;
    setBusy(code); setErr({ ...err, [code]: null });
    const update = (i: number, patch: Partial<Row>) => setRows((r) => ({ ...r, [code]: r[code].map((x, k) => (k === i ? { ...x, ...patch } : x)) }));
    try {
      const versionId = (list[0] as any).versionId;
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (!r.lesson) { update(i, { status: 'ignorado (sem aula correspondente)' }); continue; }
        update(i, { status: 'enviando', pct: 0 });
        const up = await uploadInParts(r.file, { kind: 'VIDEO', title: `${r.lesson.code} · ${r.lesson.title}`, expectedChecksum: '' }, (label, pct) => update(i, { status: label, pct }));
        const l = r.lesson;
        await api('PUT', `/api/admin/academy/lessons/${l.id}`, { title: l.title, body: l.body ?? null, videoAssetId: up.id, captionAssetId: l.caption_asset_id ?? null,
          transcriptAssetId: l.transcript_asset_id ?? null, completionMinPercent: l.completion_min_percent ?? 90 });
        update(i, { status: 'enviado ✓', pct: 100 });
      }
      await api('POST', `/api/admin/academy/course-versions/${versionId}/submit`, {});
      setDone({ ...done, [code]: versionId });
      reload();
    } catch (e) { setErr({ ...err, [code]: e as ApiError }); } finally { setBusy(null); }
  }

  return (
    <>
      <PageHeader kicker="ONEMA Academy" title="Vídeos das aulas (envio em lote)" back={{ to: '/admin/conteudo', label: 'Catálogo' }}>
        <p>Baixe a pasta do curso no computador e selecione todos os vídeos de uma vez. A plataforma liga <strong>AULA 01 → aula 1</strong>, <strong>AULA 02 → aula 2</strong>… em uma nova versão do curso e envia para a revisão do RT.
          Os vídeos ficam em armazenamento privado. Deixe esta página aberta até terminar (vídeos grandes levam alguns minutos).</p>
      </PageHeader>
      {data.courses.map((c: any) => {
        const list = rows[c.code] ?? [];
        const pub = c.versions.find((v: any) => v.state === 'PUBLISHED');
        return (
          <section key={c.code} className="surface">
            <div className="row between"><h2 className="mb0">{c.code} · {pub?.title ?? c.versions[0]?.title}</h2>
              {c.versions.find((v: any) => v.state === 'IN_REVIEW') && <Badge tone="orange">Em revisão do RT</Badge>}</div>
            <label className="btn sm secondary mt upload-btn">{list.length ? 'Escolher outros vídeos' : 'Escolher os vídeos deste curso'}
              <input type="file" multiple accept="video/mp4,video/webm" className="sr-only" disabled={!!busy} onChange={(e) => { pick(c.code, e.target.files); e.target.value = ''; }} /></label>
            {list.length > 0 && (
              <>
                <ul className="list small mt">{list.map((r, i) => (
                  <li key={i} className="row between">
                    <span>{r.file.name} ({mb(r.file.size)}) → {r.lesson ? <strong>{r.lesson.code} · {r.lesson.title}</strong> : <span className="err">sem aula correspondente</span>}</span>
                    <span>{r.status}{r.pct > 0 && r.pct < 100 ? ` · ${r.pct}%` : ''}</span>
                  </li>
                ))}</ul>
                {!done[c.code] && <Button className="deep" busy={busy === c.code} disabled={!!busy || !list.some((r) => r.lesson)} onClick={() => send(c.code)}>Enviar e mandar para o RT</Button>}
              </>
            )}
            <Alert error={err[c.code] ?? null} />
            {err[c.code] && Array.isArray((err[c.code] as any)?.details) && <ul className="small">{(err[c.code] as any).details.map((d: string) => <li key={d}>{d}</li>)}</ul>}
            {done[c.code] && <div className="success mt" role="status">Vídeos enviados e versão enviada para o RT. O RT abre a <Link to={`/admin/conteudo/versoes/${done[c.code]}`}>versão</Link> e clica em “Aprovar versão (RT)” (os vídeos são aprovados junto); depois o Admin Academy clica em “Publicar”.</div>}
          </section>
        );
      })}
    </>
  );
}
