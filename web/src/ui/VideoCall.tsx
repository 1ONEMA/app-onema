import { useEffect, useState } from 'react';
import type { ApiError } from '../lib/api';
import { Alert, Button } from './ui';

export interface VideoInfo { provider: 'DAILY' | 'SIMULADO'; url: string | null; endsAt: string; maxMinutes: number }

/**
 * Sala de vídeo (Telenfermagem e atendimentos online): Daily dentro do app, sem gravação, com contagem regressiva
 * até o fim do tempo (30 min). Sem o Daily configurado, mostra a sala simulada de homologação.
 */
export function VideoCall({ enter, busy, error, label = 'Entrar na sala', onLeave }: {
  enter: () => Promise<VideoInfo | null>; busy?: boolean; error?: ApiError | null; label?: string; onLeave?: () => void;
}) {
  const [video, setVideo] = useState<VideoInfo | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!video) return; const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, [video]);
  const left = video ? Math.max(0, new Date(video.endsAt).getTime() - now) : 0;
  const mm = String(Math.floor(left / 60000)).padStart(2, '0'), ss = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
  if (video) {
    return (
      <div className="tele-room" role="region" aria-label="Sala de atendimento online">
        <p className={`small ${left <= 5 * 60_000 ? 'caution' : 'muted'}`} role="timer" aria-live="off">
          Tempo restante: <strong>{mm}:{ss}</strong> (máximo de {video.maxMinutes} minutos){left <= 5 * 60_000 && left > 0 ? ' · faltam poucos minutos, prepare o encerramento.' : ''}{left === 0 ? ' · tempo encerrado.' : ''}
        </p>
        {video.url && left > 0 ? (
          <iframe className="tele-video" src={video.url} title="Vídeo do atendimento" allow="camera; microphone; fullscreen; display-capture; autoplay" />
        ) : (
          <div className="tele-room-screen"><span>{video.url ? 'Tempo do atendimento encerrado' : 'Sala simulada (homologação)'}</span><strong>{mm}:{ss}</strong><span className="small">Sem gravação</span></div>
        )}
        <p className="small muted mt">Atendimento sem gravação. Se a imagem ou o som falharem, saia e entre de novo.</p>
        <button type="button" className="btn secondary sm" onClick={() => { setVideo(null); onLeave?.(); }}>Sair da sala</button>
      </div>
    );
  }
  return (
    <div>
      <Alert error={error ?? null} />
      <Button className="deep" busy={busy} onClick={async () => { const v = await enter(); if (v) { setVideo(v); setNow(Date.now()); } }}>{label}</Button>
      <p className="small muted mt">Permita câmera e microfone quando o navegador pedir. O atendimento dura até 30 minutos e não é gravado. Não use WhatsApp pessoal para o atendimento.</p>
    </div>
  );
}
