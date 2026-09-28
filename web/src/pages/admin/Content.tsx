import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { dateTime, label } from '../../lib/format';
import { useApi, useSubmit } from '../../lib/hooks';
import { Alert, Badge, Button, ErrorState, Field, Loading, PageHeader, Pending } from '../../ui/ui';

const tone = (s: string) => (s === 'PUBLISHED' || s === 'APPROVED' ? '' : s === 'IN_REVIEW' ? 'orange' : 'dark');

export function ContentPage() {
  const { has } = useAuth();
  const nav = useNavigate();
  const { data, error, loading, reload } = useApi<any>('/api/admin/academy/courses');
  const create = useSubmit<any>();
  const status = useSubmit<any>();
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  return (
    <>
      <PageHeader kicker="ONEMA Academy · ACA-012" title="Catálogo e versões de curso"><p>Rascunhos são editáveis; versões em revisão, aprovadas e publicadas são imutáveis. A publicação exige aprovação do Avaliador/RT.</p></PageHeader>
      <Alert error={create.error || status.error} />
      {data.courses.map((c: any) => (
        <section key={c.id} className="surface">
          <div className="row between">
            <h2 className="mb0">{c.code} · {c.versions[0]?.title}</h2>
            <div className="row">
              <Badge tone={c.status === 'ACTIVE' ? '' : 'red'}>{label(c.status)}</Badge>
              {has('GESTOR_CONTEUDO', 'ADMIN_ACADEMY') && <Button className="sm secondary" busy={create.busy} onClick={async () => { const r = await create.run('POST', '/api/admin/academy/course-versions', { courseCode: c.code }); if (r) nav(`/admin/conteudo/versoes/${r.id}`); }}>Novo rascunho</Button>}
              {has('ADMIN_ACADEMY') && <Button className="sm ghost" busy={status.busy} onClick={async () => { if (await status.run('PUT', `/api/admin/academy/courses/${c.code}/status`, { status: c.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' })) reload(); }}>{c.status === 'ACTIVE' ? 'Desativar curso' : 'Reativar curso'}</Button>}
            </div>
          </div>
          <div className="table-wrap mt"><table><thead><tr><th>Versão</th><th>Estado</th><th>Criada</th><th>Aprovada</th><th>Publicada</th><th /></tr></thead>
            <tbody>{c.versions.map((v: any) => <tr key={v.id}><td>v{v.version}</td><td><Badge tone={tone(v.state)}>{label(v.state)}</Badge></td><td>{dateTime(v.created_at)}</td><td>{dateTime(v.approved_at)}</td><td>{dateTime(v.published_at)}</td><td><Link to={`/admin/conteudo/versoes/${v.id}`}>Abrir</Link></td></tr>)}</tbody></table></div>
          {c.versions[0]?.source_note && <p className="small muted mt mb0">Fonte: {c.versions[0].source_note}</p>}
        </section>
      ))}
    </>
  );
}

function LessonForm({ l, editable, media, onSaved }: { l: any; editable: boolean; media: any[]; onSaved: () => void }) {
  const save = useSubmit<any>();
  const [f, setF] = useState({ title: l.title, body: l.body ?? '', videoAssetId: l.video_asset_id ?? '', captionAssetId: l.caption_asset_id ?? '', transcriptAssetId: l.transcript_asset_id ?? '', completionMinPercent: l.completion_min_percent ?? '' });
  const [ok, setOk] = useState<string | null>(null);
  const opts = (kind: string) => media.filter((m) => m.kind === kind && m.state !== 'BLOCKED');
  const sel = (k: 'videoAssetId' | 'captionAssetId' | 'transcriptAssetId', kind: string, lbl: string) => (
    <Field label={lbl}><select disabled={!editable} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })}><option value="">— nenhum —</option>{opts(kind).map((m) => <option key={m.id} value={m.id}>{m.title} ({label(m.state)})</option>)}</select></Field>
  );
  return (
    <details className="tile" style={{ marginBottom: 10 }}>
      <summary><strong>{l.code}</strong> · {l.title} {!l.body && !l.video_asset_id && <Badge tone="orange">conteúdo pendente</Badge>}</summary>
      <div className="mt">
        <Field label="Título"><input type="text" disabled={!editable} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Conteúdo (texto)"><textarea disabled={!editable} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
        <div className="grid">{sel('videoAssetId', 'VIDEO', 'Vídeo')}{sel('captionAssetId', 'CAPTION', 'Legenda (VTT)')}{sel('transcriptAssetId', 'TRANSCRIPT', 'Transcrição')}</div>
        <Field label="Mínimo percorrido para concluir (%)" hint="Critério de conclusão da aula — decisão institucional."><input type="number" min={1} max={100} disabled={!editable} value={f.completionMinPercent} onChange={(e) => setF({ ...f, completionMinPercent: e.target.value })} /></Field>
        <Alert error={save.error} success={ok} />
        {editable && <Button className="sm deep" busy={save.busy} onClick={async () => {
          setOk(null);
          const r = await save.run('PUT', `/api/admin/academy/lessons/${l.id}`, { title: f.title, body: f.body || null, videoAssetId: f.videoAssetId || null, captionAssetId: f.captionAssetId || null, transcriptAssetId: f.transcriptAssetId || null, completionMinPercent: f.completionMinPercent === '' ? null : Number(f.completionMinPercent) });
          if (r) { setOk('Aula salva.'); onSaved(); }
        }}>Salvar aula</Button>}
      </div>
    </details>
  );
}

function ActivityEditor({ act, onSaved }: { act: any; onSaved: () => void }) {
  const { has } = useAuth();
  const save = useSubmit<any>();
  const approve = useSubmit<any>();
  const editable = act.state === 'DRAFT' && has('GESTOR_CONTEUDO', 'AVALIADOR_RT');
  const [f, setF] = useState<any>({ title: act.title, intro: act.intro ?? '', requiredCorrect: act.required_correct ?? '', steps: act.steps.map((s: any) => ({ prompt: s.prompt, options: s.options.map((o: any) => ({ text: o.text, correct: !!o.correct, feedback: o.feedback ?? '' })) })) });
  const setStep = (i: number, v: any) => setF({ ...f, steps: f.steps.map((s: any, j: number) => (j === i ? v : s)) });
  return (
    <div className="tile" style={{ marginBottom: 10 }}>
      <div className="row between"><strong>{act.title} · v{act.version}</strong><Badge tone={tone(act.state)}>{label(act.state)}</Badge></div>
      {act.source_note && <p className="small muted">Fonte: {act.source_note}</p>}
      {act.issues.length > 0 && act.state === 'DRAFT' && <Pending>{act.issues.join(' ')}</Pending>}
      {editable ? (
        <div className="mt">
          <Field label="Título"><input type="text" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Introdução"><textarea value={f.intro} onChange={(e) => setF({ ...f, intro: e.target.value })} /></Field>
          <Field label="Decisões corretas exigidas" hint="Regra de conclusão aprovada (ex.: C01 = 6)."><input type="number" min={1} value={f.requiredCorrect} onChange={(e) => setF({ ...f, requiredCorrect: e.target.value })} /></Field>
          {f.steps.map((s: any, i: number) => (
            <fieldset key={i} className="tile" style={{ marginBottom: 8 }}>
              <legend className="eyebrow">Decisão {i + 1}</legend>
              <Field label="Situação/pergunta"><textarea value={s.prompt} onChange={(e) => setStep(i, { ...s, prompt: e.target.value })} /></Field>
              {s.options.map((o: any, j: number) => (
                <div key={j} className="row" style={{ alignItems: 'flex-start' }}>
                  <label className="row small"><input type="radio" name={`c${i}`} checked={o.correct} onChange={() => setStep(i, { ...s, options: s.options.map((x: any, k: number) => ({ ...x, correct: k === j })) })} /> correta</label>
                  <input type="text" style={{ flex: 2 }} placeholder="Opção" value={o.text} onChange={(e) => setStep(i, { ...s, options: s.options.map((x: any, k: number) => (k === j ? { ...x, text: e.target.value } : x)) })} />
                  <input type="text" style={{ flex: 3 }} placeholder="Feedback aprovado" value={o.feedback} onChange={(e) => setStep(i, { ...s, options: s.options.map((x: any, k: number) => (k === j ? { ...x, feedback: e.target.value } : x)) })} />
                </div>
              ))}
              <div className="row mt"><Button className="sm ghost" onClick={() => setStep(i, { ...s, options: [...s.options, { text: '', correct: false, feedback: '' }] })}>+ opção</Button>
                <Button className="sm ghost" onClick={() => setF({ ...f, steps: f.steps.filter((_: any, k: number) => k !== i) })}>Remover decisão</Button></div>
            </fieldset>
          ))}
          <Alert error={save.error} />
          <div className="row">
          <Button className="sm secondary" onClick={() => setF({ ...f, steps: [...f.steps, { prompt: '', options: [{ text: '', correct: true, feedback: '' }, { text: '', correct: false, feedback: '' }] }] })}>+ decisão</Button>
          <Button className="sm deep" busy={save.busy} onClick={async () => { if (await save.run('PUT', `/api/admin/academy/activities/${act.id}`, { title: f.title, intro: f.intro || null, requiredCorrect: f.requiredCorrect === '' ? null : Number(f.requiredCorrect), steps: f.steps })) onSaved(); }}>Salvar roteiro</Button>
          </div>
        </div>
      ) : <p className="small">{act.steps.length} decisões · regra: {act.required_correct ?? 'pendente'} corretas</p>}
      {act.state === 'DRAFT' && has('AVALIADOR_RT') && (<><Alert error={approve.error} /><Button className="sm green mt" busy={approve.busy} onClick={async () => { if (await approve.run('POST', `/api/admin/academy/activities/${act.id}/approve`, {})) onSaved(); }}>Aprovar roteiro (RT)</Button></>)}
    </div>
  );
}

export function VersionEditor() {
  const { id } = useParams();
  const { has } = useAuth();
  const { data, error, loading, reload } = useApi<any>(`/api/admin/academy/course-versions/${id}`);
  const media = useApi<any>('/api/admin/academy/media');
  const meta = useSubmit<any>();
  const action = useSubmit<any>();
  const newAct = useSubmit<any>();
  const newAsm = useSubmit<any>();
  const [f, setF] = useState<any>(null);
  const [note, setNote] = useState('');
  const [ok, setOk] = useState<string | null>(null);
  useEffect(() => { if (data) setF({ title: data.version.title, objectives: data.version.objectives ?? '', activityRequired: data.version.activity_required, workloadText: data.version.workload_text ?? '' }); }, [data]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const v = data.version;
  const editable = v.state === 'DRAFT' && has('GESTOR_CONTEUDO', 'ADMIN_ACADEMY');
  const doAction = async (path: string, body: any = {}, msg: string) => { setOk(null); if (await action.run('POST', `/api/admin/academy/course-versions/${id}/${path}`, body)) { setOk(msg); reload(); } };
  return (
    <>
      <PageHeader kicker={`${v.code} · versão ${v.version}`} title={v.title} back={{ to: '/admin/conteudo', label: 'Catálogo' }}><Badge tone={tone(v.state)}>{label(v.state)}</Badge></PageHeader>
      <Alert error={action.error} success={ok} />
      {data.issues.length > 0 && v.state !== 'PUBLISHED' && v.state !== 'ARCHIVED' && <div className="caution"><strong>Pendências para liberação:</strong><ul className="small mb0">{data.issues.map((i: string) => <li key={i}>{i}</li>)}</ul></div>}
      <div className="row" style={{ marginBottom: 16 }}>
        {v.state === 'DRAFT' && has('GESTOR_CONTEUDO', 'ADMIN_ACADEMY') && <Button className="deep" busy={action.busy} onClick={() => doAction('submit', {}, 'Enviado para revisão do RT.')}>Enviar para revisão RT</Button>}
        {v.state === 'IN_REVIEW' && has('AVALIADOR_RT') && <>
          <Button className="green" busy={action.busy} onClick={() => doAction('approve', {}, 'Versão aprovada.')}>Aprovar versão (RT)</Button>
          <input type="text" placeholder="Motivo da devolução" value={note} onChange={(e) => setNote(e.target.value)} style={{ maxWidth: 320 }} />
          <Button className="ghost" busy={action.busy} onClick={() => doAction('reject', { note }, 'Devolvida para rascunho.')}>Devolver</Button></>}
        {v.state === 'APPROVED' && has('ADMIN_ACADEMY') && <Button className="deep" busy={action.busy} onClick={() => doAction('publish', {}, 'Versão publicada para novas vinculações.')}>Publicar</Button>}
      </div>
      {f && (
        <section className="surface">
          <h2>Dados da versão</h2>
          <Field label="Título"><input type="text" disabled={!editable} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Objetivos"><textarea disabled={!editable} value={f.objectives} onChange={(e) => setF({ ...f, objectives: e.target.value })} /></Field>
          <Field label="Atividade integradora"><select disabled={!editable} value={f.activityRequired == null ? '' : String(f.activityRequired)} onChange={(e) => setF({ ...f, activityRequired: e.target.value === '' ? null : Number(e.target.value) })}>
            <option value="">Pendente de definição</option><option value="1">Obrigatória</option><option value="0">Não exigida</option></select></Field>
          <Field label="Carga horária" hint="Não preencher por estimativa: somente após decisão institucional rastreável (P-005)."><input type="text" disabled={!editable} value={f.workloadText} onChange={(e) => setF({ ...f, workloadText: e.target.value })} /></Field>
          {v.source_note && <p className="small muted">Fonte: {v.source_note}</p>}
          <Alert error={meta.error} />
          {editable && <Button className="sm deep" busy={meta.busy} onClick={async () => { if (await meta.run('PUT', `/api/admin/academy/course-versions/${id}`, { ...f, objectives: f.objectives || null, workloadText: f.workloadText || null })) reload(); }}>Salvar dados</Button>}
        </section>
      )}
      <section className="surface">
        <h2>Aulas</h2>
        {data.lessons.map((l: any) => <LessonForm key={l.id + v.state} l={l} editable={editable} media={media.data?.assets ?? []} onSaved={reload} />)}
      </section>
      <section className="surface">
        <div className="row between"><h2 className="mb0">Atividades integradoras</h2>
          {has('GESTOR_CONTEUDO', 'AVALIADOR_RT') && <Button className="sm secondary" busy={newAct.busy} onClick={async () => { if (await newAct.run('POST', `/api/admin/academy/course-versions/${id}/activities`, {})) reload(); }}>Novo rascunho de atividade</Button>}</div>
        <Alert error={newAct.error} />
        {!data.activities.length ? <p className="muted mt">Nenhuma atividade cadastrada.</p> : data.activities.map((a: any) => <ActivityEditor key={a.id + a.state} act={a} onSaved={reload} />)}
      </section>
      <section className="surface">
        <div className="row between"><h2 className="mb0">Avaliações</h2>
          {has('GESTOR_CONTEUDO', 'AVALIADOR_RT') && <Button className="sm secondary" busy={newAsm.busy} onClick={async () => { if (await newAsm.run('POST', `/api/admin/academy/course-versions/${id}/assessments`, {})) reload(); }}>Novo rascunho de avaliação</Button>}</div>
        <Alert error={newAsm.error} />
        <div className="table-wrap mt"><table><thead><tr><th>Versão</th><th>Estado</th><th>Regra</th><th>Banco</th><th /></tr></thead>
          <tbody>{data.assessments.map((s: any) => <tr key={s.id}><td>v{s.version}</td><td><Badge tone={tone(s.state)}>{label(s.state)}</Badge></td>
            <td className="small">{s.question_count ?? '?'} questões · mín. {s.pass_min_correct ?? '?'} · tentativas {s.max_attempts ?? 'pendente'}{s.critical_gate ? ' · críticas como gate' : ''}</td>
            <td>{s.questionTotal}</td><td>{has('AVALIADOR_RT', 'GESTOR_CONTEUDO') ? <Link to={`/admin/conteudo/avaliacoes/${s.id}`}>Banco de questões</Link> : <span className="small muted">restrito</span>}</td></tr>)}</tbody></table></div>
      </section>
    </>
  );
}

/** ACA-014 Banco de questões (gabarito restrito) + regras (somente RT). */
export function AssessmentEditor() {
  const { id } = useParams();
  const { has } = useAuth();
  const { data, error, loading, reload } = useApi<any>(`/api/admin/academy/assessments/${id}/questions`);
  const rules = useSubmit<any>();
  const add = useSubmit<any>();
  const del = useSubmit<any>();
  const approve = useSubmit<any>();
  const [r, setR] = useState<any>(null);
  const [q, setQ] = useState<any>({ position: '', critical: false, stem: '', options: ['', '', '', ''], correctIndex: 0 });
  const [ok, setOk] = useState<string | null>(null);
  useEffect(() => { if (data) setR({ questionCount: data.assessment.question_count ?? '', passMinCorrect: data.assessment.pass_min_correct ?? '', maxAttempts: data.assessment.max_attempts ?? '', criticalGate: !!data.assessment.critical_gate, sourceNote: data.assessment.source_note ?? '' }); }, [data]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const s = data.assessment;
  const draft = s.state === 'DRAFT';
  const n = (v: any) => (v === '' ? null : Number(v));
  return (
    <>
      <PageHeader kicker={`Avaliação v${s.version} · ACA-014`} title="Banco de questões" back={{ to: `/admin/conteudo/versoes/${s.course_version_id}`, label: 'Versão do curso' }}>
        <Badge tone={tone(s.state)}>{label(s.state)}</Badge> {!data.keyVisible && <Badge tone="dark">gabarito oculto</Badge>}
      </PageHeader>
      <Alert success={ok} />
      {s.issues.length > 0 && draft && <div className="caution"><strong>Pendências:</strong><ul className="small mb0">{s.issues.map((i: string) => <li key={i}>{i}</li>)}</ul></div>}
      {r && (
        <section className="surface">
          <h2>Regra de aprovação</h2>
          <p className="small muted">Decisão institucional: somente o Avaliador/RT altera. Não preencher por estimativa.</p>
          <div className="grid">
            <Field label="Número de questões"><input type="number" disabled={!draft || !has('AVALIADOR_RT')} value={r.questionCount} onChange={(e) => setR({ ...r, questionCount: e.target.value })} /></Field>
            <Field label="Mínimo de acertos"><input type="number" disabled={!draft || !has('AVALIADOR_RT')} value={r.passMinCorrect} onChange={(e) => setR({ ...r, passMinCorrect: e.target.value })} /></Field>
            <Field label="Limite de tentativas"><input type="number" disabled={!draft || !has('AVALIADOR_RT')} value={r.maxAttempts} onChange={(e) => setR({ ...r, maxAttempts: e.target.value })} /></Field>
          </div>
          <label className="choice"><input type="checkbox" disabled={!draft || !has('AVALIADOR_RT')} checked={r.criticalGate} onChange={(e) => setR({ ...r, criticalGate: e.target.checked })} /><span>Questões críticas são gate independente da nota</span></label>
          <Field label="Fonte/decisão"><input type="text" disabled={!draft || !has('AVALIADOR_RT')} value={r.sourceNote} onChange={(e) => setR({ ...r, sourceNote: e.target.value })} /></Field>
          <Alert error={rules.error} />
          {draft && has('AVALIADOR_RT') && <Button className="sm deep" busy={rules.busy} onClick={async () => { if (await rules.run('PUT', `/api/admin/academy/assessments/${id}/rules`, { questionCount: n(r.questionCount), passMinCorrect: n(r.passMinCorrect), maxAttempts: n(r.maxAttempts), criticalGate: r.criticalGate, sourceNote: r.sourceNote || null })) { setOk('Regra salva.'); reload(); } }}>Salvar regra</Button>}
        </section>
      )}
      <section className="surface">
        <h2>Questões ({data.questions.length})</h2>
        <Alert error={del.error} />
        <ol className="list">{data.questions.map((x: any) => (
          <li key={x.id}>
            <div className="row between"><strong>Questão {x.position} {x.critical && <Badge tone="red">crítica</Badge>}</strong>{draft && <Button className="sm ghost" busy={del.busy} onClick={async () => { if (await del.run('DELETE', `/api/admin/academy/questions/${x.id}`)) reload(); }}>Excluir</Button>}</div>
            <p className="mb0">{x.stem}</p>
            <ul className="small">{x.options.map((o: any) => <li key={o.id}>{o.text}{data.keyVisible && x.correctOptionId === o.id && <strong> ✓ gabarito</strong>}</li>)}</ul>
          </li>))}
        </ol>
        {draft && (
          <div className="tile mt">
            <h3>Adicionar questão</h3>
            <div className="grid"><Field label="Número"><input type="number" value={q.position} onChange={(e) => setQ({ ...q, position: e.target.value })} /></Field>
              <label className="choice" style={{ alignSelf: 'end' }}><input type="checkbox" checked={q.critical} onChange={(e) => setQ({ ...q, critical: e.target.checked })} /><span>Questão crítica</span></label></div>
            <Field label="Enunciado"><textarea value={q.stem} onChange={(e) => setQ({ ...q, stem: e.target.value })} /></Field>
            {q.options.map((o: string, i: number) => (
              <div key={i} className="row"><label className="row small"><input type="radio" name="key" checked={q.correctIndex === i} onChange={() => setQ({ ...q, correctIndex: i })} /> correta</label>
                <input type="text" style={{ flex: 1 }} placeholder={`Alternativa ${i + 1}`} value={o} onChange={(e) => setQ({ ...q, options: q.options.map((x: string, j: number) => (j === i ? e.target.value : x)) })} /></div>
            ))}
            <Alert error={add.error} />
            <Button className="sm deep mt" busy={add.busy} onClick={async () => {
              const opts = q.options.filter((o: string) => o.trim());
              if (await add.run('POST', `/api/admin/academy/assessments/${id}/questions`, { position: n(q.position), critical: q.critical, stem: q.stem, options: opts, correctIndex: q.correctIndex })) { setQ({ position: '', critical: false, stem: '', options: ['', '', '', ''], correctIndex: 0 }); reload(); }
            }}>Adicionar</Button>
          </div>
        )}
        {draft && has('AVALIADOR_RT') && <><Alert error={approve.error} /><Button className="green mt" busy={approve.busy} onClick={async () => { if (await approve.run('POST', `/api/admin/academy/assessments/${id}/approve`, {})) { setOk('Avaliação aprovada e vigente para a versão do curso.'); reload(); } }}>Aprovar avaliação (RT)</Button></>}
      </section>
    </>
  );
}
