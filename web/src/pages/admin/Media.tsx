import { useState, type FormEvent } from 'react';
import { api } from '../../lib/api';
import { uploadInParts } from '../../lib/upload';
import { useAuth } from '../../lib/auth';
import { date, dateTime, label } from '../../lib/format';
import { useApi, useSubmit } from '../../lib/hooks';
import { Alert, Badge, Button, ErrorState, Field, Loading, PageHeader } from '../../ui/ui';

/** ACA-013 Gestão de mídia: upload privado, checksum, aprovação RT e pré-visualização por URL assinada. */
export function MediaPage() {
  const { has } = useAuth();
  const { data, error, loading, reload } = useApi<any>('/api/admin/academy/media');
  const approve = useSubmit<any>();
  const del = useSubmit<any>();
  const [ok, setOk] = useState<string | null>(null);
  const [upErr, setUpErr] = useState<any>(null);
  const [progress, setProgress] = useState<{ label: string; pct: number } | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setOk(null); setUpErr(null);
    if (progress) return;
    const form = e.currentTarget;
    const fd = new FormData(form);
    const file = fd.get('file') as File | null;
    if (!file || !file.size) { setUpErr({ message: 'Selecione um arquivo.' }); return; }
    setProgress({ label: 'Preparando', pct: 0 });
    try {
      const r = await uploadInParts(file, { kind: String(fd.get('kind')), title: String(fd.get('title')), expectedChecksum: String(fd.get('expectedChecksum') ?? '') }, (label, pct) => setProgress({ label, pct }));
      setOk(`Arquivo registrado (SHA-256 ${r.checksum.slice(0, 16)}…). Aguardando aprovação RT.`); form.reset(); reload();
    } catch (err: any) { setUpErr(err); reload(); } finally { setProgress(null); }
  }
  async function preview(id: string) { try { const r = await api('GET', `/api/admin/academy/media/${id}/preview`); window.open(r.url, '_blank', 'noopener'); } catch (e: any) { alert(e.message); } }
  return (
    <>
      <PageHeader kicker="ONEMA Academy · ACA-013" title="Mídia"><p>Arquivos ficam em armazenamento privado e só são servidos por URL assinada e temporária, com verificação de integridade.</p></PageHeader>
      {has('GESTOR_CONTEUDO', 'ADMIN_ACADEMY') && (
        <form className="surface" onSubmit={submit}>
          <h2>Enviar arquivo</h2>
          <div className="grid">
            <Field label="Tipo"><select name="kind" required><option value="VIDEO">Vídeo (mp4/webm)</option><option value="CAPTION">Legenda (VTT)</option><option value="TRANSCRIPT">Transcrição (txt/md/pdf)</option><option value="AUDIO">Áudio</option><option value="IMAGE">Imagem</option></select></Field>
            <Field label="Título"><input type="text" name="title" required minLength={3} /></Field>
            <Field label="Checksum SHA-256 esperado (opcional)" hint="Se informado e divergente, o arquivo é bloqueado."><input type="text" name="expectedChecksum" pattern="[a-f0-9]{64}" /></Field>
          </div>
          <Field label="Arquivo"><input type="file" name="file" required /></Field>
          {progress && <div className="mt" role="status"><div className="small">{progress.label} · {progress.pct}%</div><progress max={100} value={progress.pct} style={{ width: '100%' }} /></div>}
          <Alert error={upErr} success={ok} />
          <Button type="submit" className="deep" busy={!!progress}>Enviar</Button>
        </form>
      )}
      {loading ? <Loading /> : error ? <ErrorState error={error} onRetry={reload} /> : (
        <section className="surface">
          <h2>Biblioteca</h2>
          <Alert error={approve.error || del.error} />
          {!data.assets.length ? <p className="muted">Nenhum arquivo. Os vídeos, legendas e transcrições oficiais ainda não foram entregues (P-006).</p> : (
            <div className="table-wrap"><table><thead><tr><th>Título</th><th>Tipo</th><th>Tamanho</th><th>SHA-256</th><th>Estado</th><th /></tr></thead>
              <tbody>{data.assets.map((m: any) => <tr key={m.id}><td>{m.title}<br /><span className="small muted">{m.filename} · {dateTime(m.created_at)}</span></td><td>{m.kind}</td><td className="nowrap">{m.size_bytes > 1048576 ? `${(m.size_bytes / 1048576).toFixed(1)} MB` : `${(m.size_bytes / 1024).toFixed(0)} KB`}</td><td className="mono">{m.checksum_sha256.slice(0, 16)}…</td>
                <td><Badge tone={m.state === 'APPROVED' ? '' : m.state === 'BLOCKED' ? 'red' : 'orange'}>{label(m.state)}</Badge></td>
                <td className="row">{m.state !== 'BLOCKED' && m.state !== 'UPLOADING' && <Button className="sm ghost" onClick={() => preview(m.id)}>Visualizar</Button>}
                  {m.state === 'PENDING' && has('AVALIADOR_RT') && <Button className="sm green" busy={approve.busy} onClick={async () => { if (await approve.run('POST', `/api/admin/academy/media/${m.id}/approve`, {})) reload(); }}>Aprovar</Button>}
                  {has('GESTOR_CONTEUDO', 'ADMIN_ACADEMY') && <Button className="sm danger" busy={del.busy} onClick={async () => { if (confirm(`Excluir a mídia “${m.title}”?`) && await del.run('DELETE', `/api/admin/academy/media/${m.id}`)) reload(); }}>Excluir</Button>}</td></tr>)}</tbody></table></div>
          )}
        </section>
      )}
    </>
  );
}

export function CertAdminPage() {
  const { has } = useAuth();
  const tpl = useApi<any>('/api/admin/academy/certificate-templates');
  const certs = useApi<any>(has('AVALIADOR_RT', 'ADMIN_ACADEMY', 'AUDITOR') ? '/api/admin/academy/certificates' : null);
  const create = useSubmit<any>();
  const approve = useSubmit<any>();
  const revoke = useSubmit<any>();
  const [f, setF] = useState({ heading: '', declaration: 'A conclusão não autoriza atendimento nem credenciamento automático.', signatories: [{ name: '', role: '' }] });
  const [reason, setReason] = useState('');
  return (
    <>
      <PageHeader kicker="ONEMA Academy · ACA-009" title="Certificados"><p>O modelo final, signatários e dados exibidos no QR dependem de aprovação da ONEMA (P-008). Sem modelo aprovado, a emissão fica bloqueada.</p></PageHeader>
      {tpl.loading ? <Loading /> : tpl.error ? <ErrorState error={tpl.error} /> : (
        <section className="surface">
          <h2>Modelos</h2>
          <Alert error={approve.error} />
          {!tpl.data.templates.length ? <p className="muted">Nenhum modelo cadastrado.</p> : (
            <ul className="list">{tpl.data.templates.map((t: any) => (
              <li key={t.id}><div className="row between"><strong>v{t.version} · {t.heading}</strong><Badge tone={t.state === 'APPROVED' ? '' : 'dark'}>{label(t.state)}</Badge></div>
                <p className="small mb0">{t.declaration}</p><p className="small muted">Signatários: {t.signatories.map((s: any) => `${s.name} (${s.role})`).join(', ')}</p>
                {t.state === 'DRAFT' && has('AVALIADOR_RT') && <Button className="sm green" busy={approve.busy} onClick={async () => { if (await approve.run('POST', `/api/admin/academy/certificate-templates/${t.id}/approve`, {})) tpl.reload(); }}>Aprovar modelo (RT)</Button>}
              </li>))}</ul>
          )}
          {has('ADMIN_ACADEMY', 'GESTOR_CONTEUDO') && (
            <div className="tile mt">
              <h3>Novo modelo (rascunho)</h3>
              <Field label="Título/cabeçalho"><input type="text" value={f.heading} onChange={(e) => setF({ ...f, heading: e.target.value })} /></Field>
              <Field label="Declaração" hint="Deve conter a declaração expressa de que a conclusão não autoriza atendimento nem credenciamento automático."><textarea value={f.declaration} onChange={(e) => setF({ ...f, declaration: e.target.value })} /></Field>
              {f.signatories.map((s, i) => <div key={i} className="row"><input type="text" placeholder="Nome do signatário autorizado" value={s.name} onChange={(e) => setF({ ...f, signatories: f.signatories.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} style={{ flex: 1 }} /><input type="text" placeholder="Cargo" value={s.role} onChange={(e) => setF({ ...f, signatories: f.signatories.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)) })} style={{ flex: 1 }} /></div>)}
              <Button className="sm ghost mt" onClick={() => setF({ ...f, signatories: [...f.signatories, { name: '', role: '' }] })}>+ signatário</Button>
              <Alert error={create.error} />
              <Button className="sm deep mt" busy={create.busy} onClick={async () => { if (await create.run('POST', '/api/admin/academy/certificate-templates', f)) tpl.reload(); }}>Salvar rascunho</Button>
            </div>
          )}
        </section>
      )}
      {certs.data && (
        <section className="surface">
          <h2>Emitidos</h2>
          <Alert error={revoke.error} />
          {!certs.data.certificates.length ? <p className="muted">Nenhum certificado emitido.</p> : (
            <div className="table-wrap"><table><thead><tr><th>Código</th><th>Titular</th><th>Emissão</th><th>Situação</th><th /></tr></thead>
              <tbody>{certs.data.certificates.map((c: any) => <tr key={c.id}><td className="mono">{c.public_code}</td><td>{c.holder}</td><td>{date(c.issued_at)}</td><td>{c.revoked_at ? <Badge tone="red">Revogado</Badge> : <Badge>Válido</Badge>}</td>
                <td>{!c.revoked_at && has('AVALIADOR_RT', 'ADMIN_ACADEMY') && <div className="row"><input type="text" placeholder="Motivo da revogação" value={reason} onChange={(e) => setReason(e.target.value)} /><Button className="sm danger" busy={revoke.busy} onClick={async () => { if (await revoke.run('POST', `/api/admin/academy/certificates/${c.id}/revoke`, { reason })) certs.reload(); }}>Revogar</Button></div>}</td></tr>)}</tbody></table></div>
          )}
        </section>
      )}
    </>
  );
}
