/**
 * Daily (vídeo da Telenfermagem). Ativo quando DAILY_API_KEY está no painel da hospedagem; senão a sala é SIMULADA.
 * Salas privadas por episódio, sem gravação, com expiração; acesso só com token de reunião de curta duração
 * emitido pelo servidor para o paciente ou a profissional designada.
 */
const API = 'https://api.daily.co/v1';
export const dailyEnabled = () => !!process.env.DAILY_API_KEY?.trim();

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method, signal: AbortSignal.timeout(8000),
    headers: { Authorization: `Bearer ${process.env.DAILY_API_KEY!.trim()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { /* corpo não-JSON */ }
  if (!res.ok) throw Object.assign(new Error(`Daily ${method} ${path}: HTTP ${res.status} ${json?.info ?? json?.error ?? ''}`), { status: res.status, info: json?.info ?? '' });
  return json;
}

/** Sala privada do episódio (cria se não existir). `expSec` = fim da validade da sala (Unix, segundos). */
export async function ensureRoom(name: string, expSec: number): Promise<{ name: string; url: string }> {
  try {
    const r = await call('GET', `/rooms/${encodeURIComponent(name)}`);
    // Ajusta o fim da sala ao prazo vigente (ex.: 30 minutos a partir da entrada da enfermeira).
    if (r?.config?.exp !== expSec) await call('POST', `/rooms/${encodeURIComponent(name)}`, { properties: { exp: expSec, eject_at_room_exp: true } });
    return { name: r.name, url: r.url };
  } catch (e: any) {
    if (e?.status !== 404) throw e;
  }
  const r = await call('POST', '/rooms', { name, privacy: 'private', properties: {
    exp: expSec, eject_at_room_exp: true, enable_chat: true, enable_screenshare: true, enable_prejoin_ui: true, lang: 'pt-BR',
    max_participants: 4, enable_knocking: false,
  } });
  return { name: r.name, url: r.url };
}

/** Token de reunião pessoal: entra até `expSec`; profissional como dona da sala; sem gravação. */
export async function meetingToken(room: string, userName: string, owner: boolean, expSec: number, userId?: string): Promise<string> {
  const r = await call('POST', '/meeting-tokens', { properties: {
    room_name: room, user_name: userName.slice(0, 60), is_owner: owner, exp: expSec, eject_at_token_exp: false, enable_recording: false,
    ...(userId ? { user_id: userId.slice(0, 36) } : {}),
    start_video_off: false, start_audio_off: false, lang: 'pt-BR',
  } });
  return r.token;
}

/** Encerra a sala (desconecta quem ainda estiver dentro). */
export async function closeRoom(name: string) {
  try { await call('DELETE', `/rooms/${encodeURIComponent(name)}`); } catch (e: any) { if (e?.status !== 404) throw e; }
}

/** Quem está de fato dentro da chamada agora (passou da tela de entrada). Fonte da presença real na sala. */
export async function roomPresence(name: string): Promise<{ userId: string | null; userName: string }[]> {
  try {
    const r = await call('GET', `/rooms/${encodeURIComponent(name)}/presence`);
    return (r?.data ?? []).map((p: any) => ({ userId: p.userId ?? p.user_id ?? null, userName: p.userName ?? p.user_name ?? '' }));
  } catch (e: any) { if (e?.status === 404) return []; throw e; }
}
