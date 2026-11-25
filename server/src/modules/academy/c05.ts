import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, run } from '../../db/db.ts';
import { audit } from '../../lib/audit.ts';
import { parse, requireRoles } from '../../lib/context.ts';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.ts';
import { nowIso } from '../../lib/util.ts';
import { assertPartner } from './core.ts';
import { signedMediaUrl, verifyMedia } from './routes.ts';

/**
 * C05 · V1 — "Seu primeiro atendimento com a ONEMA SAÚDE?" (vídeo de orientação da Kary).
 * NÃO é curso: não entra em contagem, progresso, estado da jornada, certificado ou credenciamento.
 * Só um card na entrada da Academy + um vídeo configurado pela Gestão (system_settings).
 *
 * Reprodução: mesma rota privada /api/academy/media/:id com URL assinada (HMAC + expiração) e verificação
 * de integridade por parte. O ativo NÃO é marcado como APPROVED (isso o faria passar por "aprovado pelo RT"
 * se fosse ligado depois a uma aula); a URL é emitida com a marca p=1, que a rota de mídia já aceita para
 * ativos PENDING (nunca BLOCKED). Só é emitida para especialistas autenticados e só para o ativo configurado.
 */
export const C05_SETTING_KEY = 'academy_c05_video_asset';
const PLAY_TTL_SEC = 4 * 3600;
const PLAYABLE = ['PENDING', 'APPROVED'];

async function configured() {
  const s = await one<any>('SELECT value, created_at FROM system_settings WHERE key = ?', C05_SETTING_KEY);
  if (!s?.value) return null;
  const m = await one<any>('SELECT id, kind, title, filename, mime, size_bytes, state, created_at FROM academy_media_assets WHERE id = ?', s.value);
  return { assetId: s.value as string, configuredAt: s.created_at as string, asset: m ?? null };
}

const playable = (m: any) => !!m && m.kind === 'VIDEO' && PLAYABLE.includes(m.state);

export async function academyC05Routes(app: FastifyInstance) {
  // Especialista: URL de reprodução do vídeo do card C05 (null enquanto não configurado).
  app.get('/api/academy/orientation-video', async (req) => {
    const a = requireRoles(req, ['ESPECIALISTA']);
    assertPartner(a);
    const c = await configured();
    if (!c || !playable(c.asset)) return { configured: false, video: null };
    const m = c.asset;
    return { configured: true, video: { title: 'Seu primeiro atendimento com a ONEMA SAÚDE', mime: m.mime, url: signedMediaUrl(m.id, PLAY_TTL_SEC, m.state !== 'APPROVED') } };
  });

  // Gestão: situação atual.
  app.get('/api/admin/academy/orientation-video', async (req) => {
    requireRoles(req, ['GESTOR_CONTEUDO', 'ADMIN_ACADEMY', 'AVALIADOR_RT', 'AUDITOR']);
    const c = await configured();
    if (!c) return { configured: false, asset: null };
    const m = c.asset;
    return {
      configured: playable(m),
      configuredAt: c.configuredAt,
      asset: m ? { id: m.id, filename: m.filename, mime: m.mime, sizeBytes: Number(m.size_bytes), state: m.state } : { id: c.assetId, missing: true },
      previewUrl: playable(m) ? signedMediaUrl(m.id, 3600, true) : null,
    };
  });

  // Gestão: define (ou troca) o vídeo do C05. Mesmos perfis do envio de vídeos das aulas.
  app.put('/api/admin/academy/orientation-video', async (req) => {
    const a = requireRoles(req, ['GESTOR_CONTEUDO', 'ADMIN_ACADEMY']);
    const { assetId } = parse(z.object({ assetId: z.string().uuid() }), req.body);
    const m = await one<any>('SELECT * FROM academy_media_assets WHERE id = ?', assetId);
    if (!m) throw notFound('Mídia não encontrada.');
    if (m.kind !== 'VIDEO') throw badRequest('INVALID_MEDIA', 'Escolha um arquivo de vídeo (MP4 ou WEBM).');
    if (m.state === 'UPLOADING') throw conflict('UPLOAD_INCOMPLETE', 'O envio deste vídeo não foi concluído.');
    if (m.state === 'BLOCKED') throw conflict('MEDIA_BLOCKED', 'Mídia bloqueada não pode ser usada. Envie um novo arquivo.');
    if (!(await verifyMedia(m))) {
      await run(`UPDATE academy_media_assets SET state = 'BLOCKED' WHERE id = ?`, assetId);
      throw new AppError(409, 'MEDIA_INTEGRITY', 'O vídeo falhou na verificação de integridade e foi bloqueado. Envie novamente.');
    }
    const before = (await one<any>('SELECT value FROM system_settings WHERE key = ?', C05_SETTING_KEY))?.value ?? null;
    await run(`INSERT INTO system_settings (key, value, created_at) VALUES (?, ?, ?)
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, created_at = EXCLUDED.created_at`, C05_SETTING_KEY, assetId, nowIso());
    await audit({ actorId: a.userId, action: 'ACADEMY_C05_VIDEO_SET', subjectType: 'system_settings', subjectId: C05_SETTING_KEY, correlationId: req.correlationId,
      before: { assetId: before }, after: { assetId }, meta: { previousAssetId: before, assetId, checksum: m.checksum_sha256, mediaState: m.state } });
    return { ok: true, configured: true, assetId };
  });
}
