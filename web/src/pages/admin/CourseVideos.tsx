import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type ApiError } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { uploadInParts } from '../../lib/upload';
import { Alert, Badge, Button, ErrorState, Loading, PageHeader } from '../../ui/ui';
import { C05VideoSection } from './C05VideoSection';

/** Número da aula no nome do arquivo ("AULA 01.mp4", "Aula 3.mp4", "1", "02.mp4" → 1, 3, 1, 2). */
const lessonNumber = (name: string) => {
  const base = name.replace(/\.[a-z0-9]{2,4}$/i, '');
  const m = /aula\D{0,3}0*(\d{1,2})/i.exec(base) ?? /^\s*0*(\d{1,2})\s*$/.exec(base) ?? /(\d{1,2})\D*$/.exec(base);
  return m ? Number(m[1]) : null;
};

/**
 * Reconhece o vídeo pelo conteúdo, não só pelo nome: arquivos baixados do Drive às vezes vêm sem extensão ("1", "2"…).
 * MP4 ("ftyp" no byte 4, exceto QuickTime/MOV) e WebM (assinatura EBML). Devolve o arquivo com nome e tipo corretos.
 */
async function asVideo(file: File): Promise<{ file: File } | { reason: string }> {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const txt = (a: number, b: number) => String.fromCharCode(...head.slice(a, b));
  const base = file.name.replace(/\.[a-z0-9]{2,4}$/i, '');
  if (txt(4, 8) === 'ftyp') {
    if (txt(8, 12) === 'qt  ') return { reason: 'vídeo .MOV (iPhone/QuickTime): converta para MP4 antes de enviar' };
    return { file: new File([file], `${base}.mp4`, { type: 'video/mp4' }) };
  }
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return { file: new File([file], `${base}.webm`, { type: 'video/webm' }) };
  return { reason: 'não é um vídeo MP4 ou WEBM' };
}
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`;

type Row = { file: File; n: number | null; lesson?: any; status: string; pct: number; error?: string };
type Skipped = { name: string; reason: string };

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
  const [skipped, setSkipped] = useState<Record<string, Skipped[]>>({});
  const [lessonsOf, setLessonsOf] = useState<Record<string, any[]>>({});
  const setRow = (code: string, i: number, patch: Partial<Row>) => setRows((r) => ({ ...r, [code]: r[code].map((x, k) => (k === i ? { ...x, ...patch } : x)) }));
  const removeRow = (code: string, i: number) => setRows((r) => ({ ...r, [code]: r[code].filter((_, k) => k !== i) }));
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

  async function pick(code: string, files: File[]) {
    setErr({ ...err, [code]: null }); setDone({ ...done, [code]: '' });
    if (!files.length) return;
    try {
      const v = await draftFor(code);
      const lessons = [...v.lessons].sort((a: any, b: any) => a.sort_order - b.sort_order);
      const list: Row[] = []; const skip: Skipped[] = [];
      for (const f of files) {
        const v2 = await asVideo(f);
        if ('reason' in v2) { skip.push({ name: f.name, reason: v2.reason }); continue; }
        const n = lessonNumber(f.name);
        list.push({ file: v2.file, n, lesson: n ? lessons[n - 1] : undefined, status: 'pronto', pct: 0 });
      }
      list.sort((a, b) => (a.n ?? 99) - (b.n ?? 99));
      setSkipped({ ...skipped, [code]: skip });
      setLessonsOf((m) => ({ ...m, [code]: lessons }));
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
              <input type="file" multiple accept="video/mp4,video/webm" className="sr-only" disabled={!!busy} onChange={(e) => { const picked = Array.from(e.target.files ?? []); e.target.value = ''; void pick(c.code, picked); }} /></label>
            {(skipped[c.code]?.length ?? 0) > 0 && (
              <div className="caution small mt" role="alert"><strong>Arquivos que não serão enviados:</strong>
                <ul className="mb0">{skipped[c.code].map((k) => <li key={k.name}>{k.name}: {k.reason}</li>)}</ul></div>
            )}
            {list.length > 0 && (
              <>
                <p className="small muted mt">Confira a aula de cada vídeo. Se precisar, troque a aula na lista ou remova o vídeo antes de enviar.</p>
                <ul className="list small">{list.map((r, i) => {
                  const dup = r.lesson && list.some((x, k) => k !== i && x.lesson?.id === r.lesson.id);
                  const locked = !!busy || !!done[c.code] || r.status !== 'pronto';
                  return (
                    <li key={`${r.file.name}-${i}`} className="row between video-row">
                      <span>{r.file.name} ({mb(r.file.size)}) →{' '}
                        <select aria-label={`Aula do vídeo ${r.file.name}`} value={r.lesson?.id ?? ''} disabled={locked}
                          onChange={(e) => setRow(c.code, i, { lesson: (lessonsOf[c.code] ?? []).find((l) => l.id === e.target.value) })}>
                          <option value="">— escolha a aula —</option>
                          {(lessonsOf[c.code] ?? []).map((l) => <option key={l.id} value={l.id}>{l.code} · {l.title}</option>)}
                        </select>
                        {!r.lesson && <span className="err"> sem aula escolhida (não será enviado)</span>}
                        {dup && <span className="err"> outra linha usa a mesma aula</span>}
                      </span>
                      <span className="row">
                        <span>{r.status}{r.pct > 0 && r.pct < 100 ? ` · ${r.pct}%` : ''}</span>
                        {!locked && <button type="button" className="btn sm secondary" aria-label={`Remover ${r.file.name}`} onClick={() => removeRow(c.code, i)}>Remover</button>}
                      </span>
                    </li>
                  );
                })}</ul>
                {!done[c.code] && <Button className="deep" busy={busy === c.code}
                  disabled={!!busy || !list.some((r) => r.lesson) || list.some((r, i) => r.lesson && list.some((x, k) => k !== i && x.lesson?.id === r.lesson.id))}
                  onClick={() => send(c.code)}>Enviar e mandar para o RT ({list.filter((r) => r.lesson).length} vídeo{list.filter((r) => r.lesson).length === 1 ? '' : 's'})</Button>}
              </>
            )}
            <Alert error={err[c.code] ?? null} />
            {err[c.code] && Array.isArray((err[c.code] as any)?.details) && <ul className="small">{(err[c.code] as any).details.map((d: string) => <li key={d}>{d}</li>)}</ul>}
            {done[c.code] && <div className="success mt" role="status">Vídeos enviados e versão enviada para o RT. O RT abre a <Link to={`/admin/conteudo/versoes/${done[c.code]}`}>versão</Link> e clica em “Aprovar versão (RT)” (os vídeos são aprovados junto); depois o Admin Academy clica em “Publicar”.</div>}
          </section>
        );
      })}
      <C05VideoSection />
    </>
  );
}
