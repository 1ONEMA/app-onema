import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api } from '../../lib/api';
import { useApi, useSubmit } from '../../lib/hooks';
import { dateTime } from '../../lib/format';
import { Alert, Badge, Button, ErrorState, Field, Loading, fieldError } from '../../ui/ui';
import { IconCheck } from '../../ui/icons';
import { LegalLink } from '../../ui/LegalDialog';

const STATUS: Record<string, { label: string; tone: string; text: string }> = {
  RASCUNHO: { label: 'Rascunho', tone: 'dark', text: 'Complete seus dados, envie os documentos e clique em "Enviar para análise".' },
  ENVIADA: { label: 'Em análise', tone: 'orange', text: 'A Central ONEMA está conferindo identidade, COREN e documentos. Você será avisada pelo app.' },
  PENDENCIA: { label: 'Pendência', tone: 'orange', text: 'A Central pediu um ajuste. Corrija e envie novamente.' },
  APROVADA: { label: 'Documentação aprovada', tone: '', text: 'Documentos validados. Sua ONEMA Academy está liberada: conclua os quatro cursos da Jornada de Integração para seguir ao credenciamento final.' },
  RECUSADA: { label: 'Não aprovada', tone: 'red', text: 'A candidatura não foi aprovada neste momento.' },
  SUSPENSA: { label: 'Suspenso / revalidar', tone: 'red', text: 'Seu cadastro precisa ser revalidado. Novos atendimentos ficam pausados até a nova análise.' },
};
/** [tipo, título, orientação, aceita vários arquivos] */
const DOCS = [
  ['FOTO', 'Foto sua (obrigatório)', 'De frente, rosto visível, de preferência com fundo branco. Aparece para o paciente identificar você.', false],
  ['PROVA_VIVA', 'Foto de prova viva (obrigatório)', 'Tire agora uma foto sua segurando a MESMA identidade ao lado do rosto, com rosto e dados legíveis. Serve só para a conferência humana da sua identidade (sem reconhecimento facial automático).', false],
  ['IDENTIDADE', 'Identidade com CPF (obrigatório)', 'Documento aberto mostrando frente e verso na mesma imagem.', false],
  ['COREN', 'Carteira do COREN (obrigatório)', 'Frente e verso legíveis.', false],
  ['DIPLOMA_FRENTE', 'Diploma de graduação — frente (obrigatório)', '', false],
  ['DIPLOMA_VERSO', 'Diploma de graduação — verso (obrigatório)', '', false],
  ['CERTIFICADO', 'Certificados de cursos e especializações (opcional)', 'Pode enviar mais de um.', true],
  ['COMPROVANTE_ENDERECO', 'Comprovante de endereço (opcional)', '', false],
] as const;
const LABEL: Record<string, string> = { PROVA_VIVA: 'foto de prova viva', FOTO: 'foto', IDENTIDADE: 'identidade com CPF', COREN: 'COREN', DIPLOMA_FRENTE: 'diploma (frente)', DIPLOMA_VERSO: 'diploma (verso)' };

/** Candidatura à rede ONEMA ONE: dados, documentos e acompanhamento da análise. */
export function ApplicationPage() {
  const { data, error, loading, reload, setData } = useApi<any>('/api/specialist/application');
  const save = useSubmit<any>();
  const send = useSubmit<any>();
  const [upErr, setUpErr] = useState<ApiError | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const reopen = useSubmit<any>();
  const [f, setF] = useState({ fullName: '', cpf: '', corenNumber: '', corenUf: 'SP', professionalCategory: 'ENFERMEIRO', states: ['SP'] as string[], phone: '', regions: '', needs: [] as string[], availability: '', consent: false, dataTerm: false });
  useEffect(() => { document.title = 'Candidatura ONEMA ONE · ONEMA SAÚDE'; }, []);
  useEffect(() => {
    const a = data?.application;
    if (a) setF((x) => ({ ...x, fullName: a.fullName, corenNumber: a.corenNumber, corenUf: a.corenUf, professionalCategory: a.professionalCategory ?? 'ENFERMEIRO', states: a.states?.length ? a.states : [a.corenUf], phone: a.phone, regions: a.regions, needs: a.needs, availability: a.availability ?? '' }));
  }, [data?.application?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const a = data.application;
  const editable = !a || ['RASCUNHO', 'PENDENCIA'].includes(a.status);
  const st = a ? STATUS[a.status] : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await save.run('PUT', '/api/specialist/application', { ...f, cpf: f.cpf || undefined });
    if (r) { setData({ ...data, application: r.application }); setF((x) => ({ ...x, cpf: '' })); }
  }
  async function upload(kind: string, file: File | undefined) {
    if (!file) return;
    setUpErr(null); setUploading(kind);
    const fd = new FormData(); fd.append('kind', kind); fd.append('file', file);
    try { const r = await api<any>('POST', '/api/specialist/application/documents', fd); setData({ ...data, application: r.application }); }
    catch (e) { setUpErr(e as ApiError); } finally { setUploading(null); }
  }
  async function removeDoc(id: string) {
    try { const r = await api<any>('DELETE', `/api/specialist/application/documents/${id}`); setData({ ...data, application: r.application }); } catch (e) { setUpErr(e as ApiError); }
  }
  async function finish() {
    const r = await send.run('POST', '/api/specialist/application/submit', {});
    if (r) setData({ ...data, application: r.application });
  }

  return (
    <div className="flow">
      <div className="eyebrow-teal">Rede ONEMA ONE</div>
      <h1 className="display-light">Candidatura de especialista</h1>
      <p className="lead">Cadastro com CPF, sem exigência de CNPJ. A Central ONEMA confere identidade, COREN e documentos antes de liberar a ONEMA Academy.</p>
      {st && <div className={st.tone === 'red' ? 'danger' : st.tone === '' ? 'success' : 'caution'} role="status"><Badge tone={st.tone}>{st.label}</Badge> {st.text}
        <p className="mb0 mt small">Situação para atendimentos: <strong>{a.partnerStateLabel}</strong>{a.nextRevalidationAt ? ` · próxima revalidação: ${new Date(a.nextRevalidationAt).toLocaleDateString('pt-BR')}` : ''}</p>
        {a.decisionNote && ['PENDENCIA', 'RECUSADA', 'SUSPENSA'].includes(a.status) && <p className="mb0 mt"><strong>Mensagem da Central:</strong> {a.decisionNote}</p>}
        {a.status === 'APROVADA' && <p className="mb0 mt"><Link to="/academy" className="btn sm deep">Abrir a ONEMA Academy</Link></p>}
        {['APROVADA', 'SUSPENSA'].includes(a.status) && (
          <p className="mb0 mt">
            <Button className="sm secondary" busy={reopen.busy} onClick={async () => { const r = await reopen.run('POST', '/api/specialist/application/reopen', { reason: a.status === 'SUSPENSA' ? 'REVALIDACAO' : 'MUDANCA_DADOS' }); if (r) setData({ ...data, application: r.application }); }}>
              {a.status === 'SUSPENSA' ? 'Enviar para revalidação' : 'Atualizar dados profissionais (nome, categoria, COREN ou UF)'}</Button>
            {a.status === 'APROVADA' && <span className="small muted"> Ao atualizar, novos atendimentos ficam pausados até a nova análise.</span>}
          </p>
        )}
        <Alert error={reopen.error} /></div>}

      <form className="flow-card mt" onSubmit={submit} noValidate>
        <h2>1. Seus dados</h2>
        <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="form-grid">
            <Field label="Nome completo" error={fieldError(save.error, 'fullName')}><input type="text" autoComplete="name" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></Field>
            <Field label={a ? `CPF (${a.cpfMasked})` : 'CPF'} hint={a ? 'Preencha de novo apenas se precisar corrigir.' : undefined} error={fieldError(save.error, 'cpf')}>
              <input type="text" inputMode="numeric" autoComplete="off" value={f.cpf} onChange={(e) => setF({ ...f, cpf: e.target.value })} placeholder="000.000.000-00" /></Field>
            <Field label="Número do COREN" error={fieldError(save.error, 'corenNumber')}><input type="text" value={f.corenNumber} onChange={(e) => setF({ ...f, corenNumber: e.target.value })} placeholder="Ex.: 123456" /></Field>
            <Field label="UF do COREN"><select value={f.corenUf} onChange={(e) => setF({ ...f, corenUf: e.target.value })}>{data.ufs.map((u: string) => <option key={u}>{u}</option>)}</select></Field>
            <Field label="Categoria profissional" error={fieldError(save.error, 'professionalCategory')}><select value={f.professionalCategory} onChange={(e) => setF({ ...f, professionalCategory: e.target.value })}>
              <option value="ENFERMEIRO">Enfermeiro(a)</option><option value="TECNICO_ENFERMAGEM">Técnico(a) de enfermagem</option></select></Field>
            <Field label="Estados em que pretende atender" hint="Segure Ctrl (ou toque) para escolher mais de um." error={fieldError(save.error, 'states')}>
              <select multiple size={4} value={f.states} onChange={(e) => setF({ ...f, states: Array.from(e.target.selectedOptions).map((o) => o.value) })}>{data.ufs.map((u: string) => <option key={u}>{u}</option>)}</select></Field>
            <Field label="Telefone (WhatsApp)" error={fieldError(save.error, 'phone')}><input type="tel" autoComplete="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="(11) 99999-9999" /></Field>
            <Field label="Regiões e bairros em que pode atender" error={fieldError(save.error, 'regions')}><input type="text" value={f.regions} onChange={(e) => setF({ ...f, regions: e.target.value })} placeholder="Ex.: Zona Sul, Vila Mariana, Moema" /></Field>
          </div>
          <fieldset className="checks-grid">
            <legend className="field-legend">Áreas de atendimento {fieldError(save.error, 'needs') && <span className="err small">— {fieldError(save.error, 'needs')}</span>}</legend>
            {data.needs.map((n: any) => (
              <label key={n.key} className="choice"><input type="checkbox" checked={f.needs.includes(n.key)} onChange={(e) => setF({ ...f, needs: e.target.checked ? [...f.needs, n.key] : f.needs.filter((x) => x !== n.key) })} /><span>{n.title}</span></label>
            ))}
          </fieldset>
          <Field label="Disponibilidade (opcional)"><input type="text" value={f.availability} onChange={(e) => setF({ ...f, availability: e.target.value })} placeholder="Ex.: manhãs em dias úteis" /></Field>
          <label className="choice mandatory"><input type="checkbox" checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} />
            <span><strong>Veracidade do cadastro.</strong> Declaro que as informações e os documentos apresentados são verdadeiros e comprometo-me a mantê-los atualizados.</span></label>
          <label className="choice mandatory"><input type="checkbox" checked={f.dataTerm} onChange={(e) => setF({ ...f, dataTerm: e.target.checked })} />
            <span><strong>Proteção de dados e sigilo.</strong> Li o <LegalLink kind="termo-especialista">Termo de Proteção de Dados, Sigilo e Responsabilidades</LegalLink> do Especialista ONEMA ONE e assumo os deveres de confidencialidade e uso seguro nele previstos. Estou ciente de como exercer meus direitos sobre meus dados pessoais.</span></label>
          <p className="small"><LegalLink kind="privacidade">Consultar a Política de Privacidade</LegalLink></p>
          {fieldError(save.error, 'dataTerm') && <p className="err small">{fieldError(save.error, 'dataTerm')}</p>}
          {fieldError(save.error, 'consent') && <p className="err small">{fieldError(save.error, 'consent')}</p>}
          <Alert error={save.error && !Array.isArray(save.error.details) ? save.error : null} />
          {editable && <Button className="deep" busy={save.busy}>Salvar dados</Button>}
        </fieldset>
      </form>

      {a && (
        <section className="flow-card mt">
          <h2>2. Documentos</h2>
          <p className="small muted">PDF, JPG, PNG ou WEBP, até 5 MB cada. Fotos tiradas com o celular servem, desde que legíveis. Você não precisa consultar o COREN nem enviar print da consulta: a ONEMA faz essa conferência.</p>
          <p className="small callout">{data.privacyNotice}</p>
          <ul className="list">
            {DOCS.map(([kind, title, hint, multiple]) => {
              const sent = a.documents.filter((d: any) => d.kind === kind);
              return (
                <li key={kind}>
                  <div className="row between"><strong>{title}</strong>{sent.length ? <Badge><IconCheck size={14} /> {sent.length > 1 ? `${sent.length} enviados` : 'Enviado'}</Badge> : <Badge tone={title.includes('opcional') ? 'dark' : 'orange'}>{title.includes('opcional') ? 'Opcional' : 'Pendente'}</Badge>}</div>
                  {hint && <div className="small muted">{hint}</div>}
                  {sent.map((d: any) => <div key={d.id} className="small muted row">{d.filename} · {Math.ceil(d.size_bytes / 1024)} KB · {dateTime(d.created_at)}
                    {editable && <button type="button" className="linklike small" onClick={() => removeDoc(d.id)}>Remover</button>}</div>)}
                  {editable && <label className="btn sm secondary mt upload-btn">{uploading === kind ? 'Enviando…' : sent.length ? (multiple ? 'Adicionar outro certificado' : 'Trocar arquivo') : 'Escolher arquivo'}
                    <input type="file" accept={kind === 'PROVA_VIVA' ? 'image/jpeg,image/png,image/webp' : 'application/pdf,image/jpeg,image/png,image/webp'} capture={kind === 'PROVA_VIVA' ? 'user' : undefined} className="sr-only" onChange={(e) => { upload(kind, e.target.files?.[0]); e.target.value = ''; }} /></label>}
                </li>
              );
            })}
          </ul>
          <Alert error={upErr ?? send.error} />
          {editable && (
            <div className="flow-actions"><Button className="green lg" busy={send.busy} disabled={a.missingDocuments.length > 0} onClick={finish}>Enviar para análise</Button></div>
          )}
          {a.missingDocuments.length > 0 && editable && <p className="small muted right">Faltam: {a.missingDocuments.map((m: string) => LABEL[m] ?? m).join(', ')}.</p>}
        </section>
      )}
      {a?.history?.length > 0 && (
        <section className="flow-card mt">
          <h2>Histórico do cadastro</h2>
          <ul className="small">{a.history.map((h: any, i: number) => <li key={i}>{dateTime(h.created_at)} · {HIST[h.action] ?? h.action}{h.note ? ` — ${h.note}` : ''}</li>)}</ul>
        </section>
      )}
    </div>
  );
}
const HIST: Record<string, string> = { ENVIADA: 'Enviado para análise', CORRECAO_SOLICITADA: 'Correção solicitada', APROVADA: 'Documentação aprovada', RECUSADA: 'Não aprovado', SUSPENSA: 'Suspenso', REABERTA: 'Reaberto para atualização' };
