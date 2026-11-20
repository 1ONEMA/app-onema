import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { prepareUpload } from '../../lib/files';
import { emitPhotoChanged, noExportImgProps } from '../../lib/photo-events';
import { IconUser } from '../../ui/icons';
import '../../ui/header-avatar.css';
import './user-photo.css';

/**
 * Foto do perfil do paciente/responsável — totalmente opcional. Nada é importado nem atribuído automaticamente:
 * sem foto enviada, o app mostra o ícone neutro.
 */
export function UserPhotoSection() {
  const [v, setV] = useState(() => Date.now());
  const [has, setHas] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => { setHas(null); }, [v]);

  async function change(file?: File) {
    if (!file) return;
    setBusy(true); setErr(null); setOk(null);
    const had = has;
    try {
      const fd = new FormData(); fd.append('file', await prepareUpload(file));
      await api('PUT', '/api/me/photo', fd);
      setV(Date.now()); emitPhotoChanged();
      setOk(had ? 'Foto trocada.' : 'Foto adicionada.');
    } catch (e: any) { setErr(e?.message ?? 'Não foi possível enviar a foto.'); } finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true); setErr(null); setOk(null);
    try { await api('DELETE', '/api/me/photo'); setV(Date.now()); emitPhotoChanged(); setOk('Foto removida. O app volta a mostrar o ícone neutro.'); }
    catch (e: any) { setErr(e?.message ?? 'Não foi possível remover a foto.'); } finally { setBusy(false); }
  }

  return (
    <section className="surface user-photo-section" aria-labelledby="user-photo-title">
      <h2 id="user-photo-title">Foto do perfil (opcional)</h2>
      <p className="small muted">Se quiser, adicione uma foto para identificar sua conta no app. Sem foto, mostramos um ícone neutro.</p>
      <div className="user-photo-row">
        <span className="user-photo-frame">
          {has !== false && (
            <img key={v} className="user-photo-img photo-protect" src={`/api/me/photo?v=${v}`} alt="Sua foto do perfil" width={88} height={88}
              style={has ? undefined : { display: 'none' }} onLoad={() => setHas(true)} onError={() => setHas(false)} {...noExportImgProps} />
          )}
          {!has && <span className="user-photo-placeholder" aria-hidden="true"><IconUser size={40} /></span>}
        </span>
        <div className="user-photo-actions">
          <label className={`btn sm secondary upload-btn user-photo-btn${busy ? ' disabled' : ''}`}>
            {busy ? 'Enviando…' : has ? 'Trocar foto' : 'Adicionar foto'}
            <input type="file" accept="image/jpeg,image/png,image/webp,image/heic" className="sr-only" disabled={busy}
              onChange={(e) => { change(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          {has && <button type="button" className="btn sm ghost user-photo-btn" disabled={busy} onClick={remove}>Remover foto</button>}
        </div>
      </div>
      <p className="small muted mb0">JPG, PNG ou WEBP, até 5 MB. Fotos grandes são reduzidas automaticamente.</p>
      {err && <p className="small danger" role="alert">{err}</p>}
      {ok && <p className="small" role="status">{ok}</p>}
    </section>
  );
}
