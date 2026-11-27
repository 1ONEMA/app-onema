import { useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type ApiError } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { Alert, Dialog } from '../../ui/ui';
import './c05-card.css';

type Video = { title: string; mime: string; url: string };

/**
 * C05 · V1 — orientação "Seu primeiro atendimento com a ONEMA SAÚDE?" (Kary).
 * Não é curso: fica fora de contagem, progresso, jornada, certificado e credenciamento.
 * O vídeo abre em uma janela sobre a lista (a rolagem da página é preservada) e só toca por ação do usuário.
 */
export function C05Card() {
  const { data } = useApi<{ configured: boolean; video: Video | null }>('/api/academy/orientation-video');
  const [video, setVideo] = useState<Video | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const ready = !!data?.configured && !!data.video;

  async function open() {
    setErr(null); setBusy(true);
    try {
      // URL assinada renovada a cada abertura (a página pode ficar aberta além da validade do link).
      const r = await api<{ configured: boolean; video: Video | null }>('GET', '/api/academy/orientation-video');
      if (r.video) setVideo(r.video);
    } catch (e) {
      if (data?.video) setVideo(data.video); else setErr(e as ApiError);
    } finally { setBusy(false); }
  }

  return (
    <div className="tile c05-card">
      <div className="course-card">
        <div className="course-num c05-num" aria-hidden="true">C05</div>
        <div className="c05-body">
          <span className="eyebrow">C05 · V1</span>
          <h3>Seu primeiro atendimento com a ONEMA SAÚDE?</h3>
          <p className="small c05-sub">A Kary, nossa assistente virtual, mostra o caminho.</p>
          {ready
            ? <button type="button" className="btn sm secondary c05-btn" disabled={busy} onClick={open}>Veja como funciona ▶</button>
            : <button type="button" className="btn sm secondary c05-btn" disabled aria-disabled="true">Vídeo em preparação</button>}
          <Alert error={err} />
        </div>
      </div>
      {video && createPortal(<Dialog open={!!video} title="Seu primeiro atendimento com a ONEMA SAÚDE" onClose={() => setVideo(null)}>
        {video && (
          <div className="c05-player">
            <video controls playsInline preload="metadata" controlsList="nodownload">
              <source src={video.url} type={video.mime} />
              Seu navegador não reproduz este vídeo.
            </video>
            <button type="button" className="btn ghost sm mt" onClick={() => setVideo(null)}>Voltar para a Academy</button>
          </div>
        )}
      </Dialog>, document.body)}
    </div>
  );
}
