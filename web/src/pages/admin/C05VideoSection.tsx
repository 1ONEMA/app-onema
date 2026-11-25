import { useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { uploadInParts } from '../../lib/upload';
import { Alert, Badge, ErrorState, Loading } from '../../ui/ui';

/** Confere a assinatura do arquivo (MP4 "ftyp", exceto QuickTime/MOV; WebM EBML) e corrige nome/tipo. */
async function asVideo(file: File): Promise<File | string> {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const txt = (a: number, b: number) => String.fromCharCode(...head.slice(a, b));
  const base = file.name.replace(/\.[a-z0-9]{2,4}$/i, '');
  if (txt(4, 8) === 'ftyp') {
    if (txt(8, 12) === 'qt  ') return 'vídeo .MOV (iPhone/QuickTime): converta para MP4 antes de enviar';
    return new File([file], `${base}.mp4`, { type: 'video/mp4' });
  }
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return new File([file], `${base}.webm`, { type: 'video/webm' });
  return 'não é um vídeo MP4 ou WEBM';
}

/**
 * C05 · V1 — vídeo de orientação "Seu primeiro atendimento com a ONEMA SAÚDE" (card da entrada da Academy).
 * Não é curso: não passa por versão/revisão de curso; fica disponível aos especialistas assim que configurado.
 */
export function C05VideoSection() {
  const { data, error, loading, reload } = useApi<any>('/api/admin/academy/orientation-video');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function send(picked: File | undefined) {
    setErr(null); setMsg(null);
    if (!picked) return;
    const file = await asVideo(picked);
    if (typeof file === 'string') { setErr(new ApiError(400, 'INVALID_FILE', `${picked.name}: ${file}.`)); return; }
    setBusy(true);
    try {
      const up = await uploadInParts(file, { kind: 'VIDEO', title: 'C05 · Seu primeiro atendimento com a ONEMA SAÚDE', expectedChecksum: '' }, (label, pct) => setStatus(`${label} · ${pct}%`));
      await api('PUT', '/api/admin/academy/orientation-video', { assetId: up.id });
      setMsg('Vídeo do C05 configurado. Os especialistas já podem assistir pela entrada da ONEMA Academy.');
      reload();
    } catch (e) { setErr(e as ApiError); } finally { setBusy(false); setStatus(''); }
  }

  return (
    <section className="surface">
      <div className="row between">
        <h2 className="mb0">C05 · Vídeo de orientação (Seu primeiro atendimento)</h2>
        {data && (data.configured ? <Badge>Configurado</Badge> : <Badge tone="orange">Não configurado</Badge>)}
      </div>
      <p className="small muted mt">Card “Seu primeiro atendimento com a ONEMA SAÚDE?” na entrada da Academy. Não é curso: não conta na jornada, no progresso nem no certificado.
        Envie um arquivo MP4 ou WEBM (ex.: “AULA 05.mp4”); ele fica em armazenamento privado.</p>
      {loading && !data && <Loading />}
      {error && <ErrorState error={error} onRetry={reload} />}
      {data?.asset && (
        <p className="small">Arquivo atual: <strong>{data.asset.filename ?? data.asset.id}</strong>
          {data.asset.sizeBytes ? ` (${(data.asset.sizeBytes / 1024 / 1024).toFixed(1)} MB)` : ''}
          {data.asset.missing ? ' — arquivo não encontrado, envie novamente' : ''}
          {data.configuredAt ? ` · configurado em ${new Date(data.configuredAt).toLocaleString('pt-BR')}` : ''}
          {data.previewUrl && <> · <a href={data.previewUrl} target="_blank" rel="noreferrer">Pré-visualizar</a></>}</p>
      )}
      <label className="btn sm secondary upload-btn" aria-disabled={busy}>{data?.asset ? 'Substituir vídeo' : 'Escolher o vídeo'}
        <input type="file" accept="video/mp4,video/webm" className="sr-only" disabled={busy}
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void send(f); }} /></label>
      {status && <p className="small mt" role="status">{status}</p>}
      <Alert error={err} success={msg} />
    </section>
  );
}
