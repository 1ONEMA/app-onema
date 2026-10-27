import { useState, type FormEvent } from 'react';
import { useAuth } from '../../lib/auth';
import { useApi, useSubmit } from '../../lib/hooks';
import { Alert, Badge, Button, Dialog, ErrorState, Field, Loading, PageHeader, fieldError } from '../../ui/ui';

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const br = (iso: string) => iso.split('-').reverse().join('/');

/** Café com a ONEMA: próximos 14 dias e publicação de um devocional próprio para qualquer data. */
export function CafeAdminPage() {
  const { has } = useAuth();
  const canEdit = has('GESTOR_CONTEUDO', 'ADMIN_PRIME', 'ADMIN_ACADEMY');
  const { data, error, loading, reload } = useApi<any>(`/api/admin/cafe?from=${today()}`);
  const save = useSubmit<any>();
  const del = useSubmit<any>();
  const [edit, setEdit] = useState<{ date: string; ref: string; verse: string; reflection: string } | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!edit) return;
    const { date, ...body } = edit;
    if (await save.run('PUT', `/api/admin/cafe/${date}`, body)) { setEdit(null); reload(); }
  }
  async function restore(date: string) {
    if (!window.confirm(`Voltar ao devocional da biblioteca em ${br(date)}?`)) return;
    if (await del.run('DELETE', `/api/admin/cafe/${date}`)) reload();
  }
  return (
    <>
      <PageHeader kicker="Conteúdo do app" title="Café com a ONEMA">
        <p>Um devocional por dia: versículo, referência e um parágrafo autoral de reflexão. A biblioteca anual cobre todos os dias; publique um texto próprio para trocar o de uma data.</p>
      </PageHeader>
      {loading && !data ? <Loading /> : error ? <ErrorState error={error} onRetry={reload} /> : (
        <ul className="list">
          {data.days.map((d: any) => (
            <li key={d.date}>
              <div className="row between">
                <strong>{br(d.date)} · {d.ref}</strong>
                <Badge tone={d.source === 'PUBLICACAO' ? '' : 'dark'}>{d.source === 'PUBLICACAO' ? 'Publicação da equipe' : 'Biblioteca'}</Badge>
              </div>
              <p className="small mb0">“{d.verse}”</p>
              <p className="small muted">{d.reflection.slice(0, 180)}…</p>
              {canEdit && (
                <div className="row">
                  <Button className="sm secondary" onClick={() => { save.setError(null); setEdit({ date: d.date, ref: d.ref, verse: d.verse, reflection: d.reflection }); }}>
                    {d.source === 'PUBLICACAO' ? 'Editar publicação' : 'Publicar outro texto neste dia'}
                  </Button>
                  {d.source === 'PUBLICACAO' && <Button className="sm ghost" busy={del.busy} onClick={() => restore(d.date)}>Voltar ao da biblioteca</Button>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <Alert error={del.error} />
      <Dialog open={!!edit} title={edit ? `Devocional de ${br(edit.date)}` : ''} onClose={() => setEdit(null)}>
        {edit && (
          <form onSubmit={submit} noValidate>
            <Field label="Referência bíblica" error={fieldError(save.error, 'ref')}><input type="text" value={edit.ref} onChange={(e) => setEdit({ ...edit, ref: e.target.value })} placeholder="Ex.: Salmos 23:1" /></Field>
            <Field label="Versículo" error={fieldError(save.error, 'verse')}><textarea value={edit.verse} maxLength={400} onChange={(e) => setEdit({ ...edit, verse: e.target.value })} /></Field>
            <Field label="Reflexão (1 parágrafo autoral)" hint="Texto próprio da ONEMA. Não copie trechos de livros devocionais." error={fieldError(save.error, 'reflection')}>
              <textarea rows={8} value={edit.reflection} maxLength={1600} onChange={(e) => setEdit({ ...edit, reflection: e.target.value })} /></Field>
            <Alert error={save.error && !Array.isArray(save.error.details) ? save.error : null} />
            <div className="row"><Button className="deep" busy={save.busy}>Publicar</Button><Button type="button" className="ghost" onClick={() => setEdit(null)}>Cancelar</Button></div>
          </form>
        )}
      </Dialog>
    </>
  );
}
