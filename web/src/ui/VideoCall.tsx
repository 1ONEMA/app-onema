import { useEffect, useRef, useState } from 'react';
import { type ApiError, api } from '../lib/api';
import { Alert, Button } from './ui';

export interface VideoInfo { provider: 'DAILY' | 'SIMULADO'; url: string | null; endsAt: string; maxMinutes: number }
interface Presence { patient: string; specialist: string; sessionStartedAt: string | null; endsAt: string | null; maxMinutes: number; ended: boolean; provider: string }

const OTHER_TEXT: Record<string, Record<string, string>> = {
  PACIENTE: { AGUARDANDO: 'Especialista entrou e está aguardando', CONECTADO: 'Participantes conectados', DESCONECTADO: 'Especialista desconectada — aguardando reconexão' },
  ESPECIALISTA: { AGUARDANDO: 'Paciente entrou e está aguardando', CONECTADO: 'Participantes conectados', DESCONECTADO: 'Paciente desconectado — aguardando reconexão' },
};
const mmss = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

/**
 * Sala de vídeo (Telenfermagem e atendimentos online): Daily dentro do app, sem gravação. Com `presenceUrl`
 * (ajuste 05 do RT): avisa quando a outra pessoa entra/sai, separa o tempo de espera do tempo efetivo da sessão
 * e só começa a contar os 30 minutos com os dois presentes. A presença vem do Daily (quem está de fato na chamada);
 * na sala simulada de homologação, do sinal do app enquanto a sala está aberta.
 */
export function VideoCall({ enter, busy, error, label = 'Entrar na sala', onLeave, presenceUrl, role }: {
  enter: () => Promise<VideoInfo | null>; busy?: boolean; error?: ApiError | null; label?: string; onLeave?: () => void;
  presenceUrl?: string; role?: 'PACIENTE' | 'ESPECIALISTA';
}) {
  const [video, setVideo] = useState<VideoInfo | null>(null);
  const [joinedAt, setJoinedAt] = useState<number | null>(null);
  const [presence, setPresence] = useState<Presence | null>(null);
  const [now, setNow] = useState(Date.now());
  const inRoom = useRef(false);
  inRoom.current = !!video;
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, []);
  useEffect(() => {
    if (!presenceUrl) return;
    let stop = false;
    const tick = async () => {
      if (document.visibilityState !== 'visible' && !inRoom.current) return;
      try { const p = await api<Presence>('POST', presenceUrl, { inRoom: inRoom.current }); if (!stop) setPresence(p); } catch { /* tenta de novo no próximo ciclo */ }
    };
    void tick();
    const t = window.setInterval(tick, 3000);
    return () => { stop = true; window.clearInterval(t); };
  }, [presenceUrl, !!video]);

  const me = role === 'ESPECIALISTA' ? presence?.specialist : presence?.patient;
  const other = role === 'ESPECIALISTA' ? presence?.patient : presence?.specialist;
  const otherText = role && other ? OTHER_TEXT[role][other] : null;
  const sessionEnds = presence?.endsAt ? new Date(presence.endsAt).getTime() : null;

  if (video) {
    // Sem presença (Telenfermagem): contagem a partir do fim informado pelo servidor.
    const left = presenceUrl ? (sessionEnds ? Math.max(0, sessionEnds - now) : null) : Math.max(0, new Date(video.endsAt).getTime() - now);
    const waiting = presenceUrl && !presence?.sessionStartedAt;
    return (
      <div className="tele-room" role="region" aria-label="Sala de atendimento online">
        {presenceUrl && (
          <p className="small" role="status" aria-live="polite">
            <strong>{presence?.sessionStartedAt ? (otherText ?? 'Participantes conectados') : me === 'AGUARDANDO' || me === 'CONECTADO' ? `Você está na sala. ${role === 'ESPECIALISTA' ? 'Aguardando o paciente' : 'Aguardando a especialista'}.` : 'Conectando à sala…'}</strong>
          </p>
        )}
        {waiting ? (
          <p className="small muted" role="timer" aria-live="off">Tempo de espera: <strong>{mmss(joinedAt ? now - joinedAt : 0)}</strong> · os {video.maxMinutes} minutos de atendimento começam quando os dois estiverem conectados.</p>
        ) : left != null && (
          <p className={`small ${left <= 5 * 60_000 ? 'caution' : 'muted'}`} role="timer" aria-live="off">
            Tempo de atendimento restante: <strong>{mmss(left)}</strong> (máximo de {video.maxMinutes} minutos){left <= 5 * 60_000 && left > 0 ? ' · faltam poucos minutos, prepare o encerramento.' : ''}{left === 0 ? ' · tempo encerrado.' : ''}
          </p>
        )}
        {video.url && (left == null || left > 0) ? (
          <iframe className="tele-video" src={video.url} title="Vídeo do atendimento" allow="camera; microphone; fullscreen; display-capture; autoplay" />
        ) : (
          <div className="tele-room-screen"><span>{video.url ? 'Tempo do atendimento encerrado' : 'Sala simulada (homologação)'}</span><strong>{left != null ? mmss(left) : '--:--'}</strong><span className="small">Sem gravação</span></div>
        )}
        <p className="small muted mt">Atendimento sem gravação. Se a imagem ou o som falharem, saia e entre de novo.</p>
        <button type="button" className="btn secondary sm" onClick={() => { setVideo(null); setJoinedAt(null); onLeave?.(); }}>Sair da sala</button>
      </div>
    );
  }
  return (
    <div>
      {otherText && other !== 'AUSENTE' && <div className={other === 'AGUARDANDO' ? 'success small' : 'small muted'} role="status" aria-live="polite">{otherText}</div>}
      <Alert error={error ?? null} />
      <Button className="deep" busy={busy} onClick={async () => { const v = await enter(); if (v) { setVideo(v); setJoinedAt(Date.now()); setNow(Date.now()); } }}>{label}</Button>
      <p className="small muted mt">Permita câmera e microfone quando o navegador pedir. O atendimento dura até 30 minutos (contados a partir de quando os dois estão na sala) e não é gravado. Não use WhatsApp pessoal para o atendimento.</p>
    </div>
  );
}
