/**
 * Sala de vídeo da Telenfermagem e dos atendimentos online do catálogo (mesmo escopo, decisão do RT 13/11/2026).
 * Daily quando DAILY_API_KEY existe; senão sala simulada. Sem gravação. Duração máxima: TELE_MAX_MINUTES (padrão 30):
 * a sala expira 30 minutos depois que a enfermeira entra e o Daily desconecta todos nesse momento.
 */
import { config } from '../../config.ts';
import { sha256 } from '../../lib/util.ts';
import { AppError } from '../../lib/errors.ts';
import { closeRoom, dailyEnabled, ensureRoom, meetingToken } from '../../lib/daily.ts';

export const maxCallMinutes = () => Math.min(180, Math.max(10, Number(process.env.TELE_MAX_MINUTES ?? 30)));
/** Nome opaco da sala (não revela paciente, pedido nem episódio). */
export const roomName = (key: string) => `onema-${sha256(`${key}:${config.appSecret}`).slice(0, 16)}`;

/**
 * Abre (ou reabre) a sala e devolve o endereço com o token pessoal.
 * `startedAt` = quando a enfermeira entrou (início do atendimento); antes disso, a sala vale até `notBefore` + duração.
 */
export async function openVideo(p: { key: string; userName: string; owner: boolean; startedAt: string | null; notBefore?: string | null }) {
  const minutes = maxCallMinutes();
  const base = p.startedAt ? new Date(p.startedAt).getTime() : Math.max(Date.now(), p.notBefore ? new Date(p.notBefore).getTime() : 0);
  const endsAt = new Date(base + minutes * 60_000).toISOString();
  if (new Date(endsAt).getTime() <= Date.now()) {
    throw new AppError(409, 'CALL_TIME_OVER', `O tempo do atendimento online (${minutes} minutos) terminou. Encerre a chamada e registre o atendimento.`);
  }
  if (!dailyEnabled()) return { provider: 'SIMULADO' as const, url: null, endsAt, maxMinutes: minutes };
  const room = await ensureRoom(roomName(p.key), Math.floor(new Date(endsAt).getTime() / 1000));
  const token = await meetingToken(room.name, p.userName, p.owner, Math.floor(Date.now() / 1000) + 15 * 60);
  return { provider: 'DAILY' as const, url: `${room.url}?t=${encodeURIComponent(token)}`, endsAt, maxMinutes: minutes };
}

export async function closeVideo(key: string) {
  if (dailyEnabled()) await closeRoom(roomName(key));
}
