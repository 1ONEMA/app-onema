import type { FastifyInstance } from 'fastify';
import { one, run, tx } from '../../db/db.ts';
import { audit } from '../../lib/audit.ts';
import { requireRoles, requireUser } from '../../lib/context.ts';
import { badRequest, notFound } from '../../lib/errors.ts';
import { getObject, putObject } from '../../lib/storage.ts';
import { nowIso, sha256, uid } from '../../lib/util.ts';
import { sniffDocMime } from '../specialist/routes.ts';

/** Mesmo limite das fotos de especialista (5 MB). */
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

const currentPhoto = (userId: string) =>
  one<any>('SELECT * FROM user_photos WHERE user_id = ? AND removed_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1', userId);

/**
 * Foto do perfil do paciente/responsável — opcional. Nunca é importada nem atribuída automaticamente:
 * só existe se a própria pessoa enviar. As rotas são sempre "minha" foto (sem id na URL).
 * Especialistas continuam usando /api/specialist/photo.
 */
export async function userPhotoRoutes(app: FastifyInstance) {
  app.get('/api/me/photo', async (req, reply) => {
    const a = requireUser(req);
    const p = await currentPhoto(a.userId);
    if (!p || !String(p.mime).startsWith('image/')) throw notFound('Foto não enviada.');
    const buf = await getObject(p.storage_key);
    if (!buf || sha256(buf) !== p.sha256) throw notFound('Foto não disponível.');
    reply.header('Content-Type', p.mime);
    reply.header('Cache-Control', 'private, no-store');
    reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox");
    return reply.send(buf);
  });

  app.put('/api/me/photo', async (req) => {
    const a = requireRoles(req, ['PACIENTE']);
    let file: { buf: Buffer } | null = null;
    for await (const p of req.parts({ limits: { fileSize: MAX_PHOTO_BYTES + 1, files: 1 } })) if (p.type === 'file') file = { buf: await p.toBuffer() };
    if (!file || !file.buf.length) throw badRequest('FILE_REQUIRED', 'Selecione uma foto.');
    if (file.buf.length > MAX_PHOTO_BYTES) throw badRequest('FILE_TOO_LARGE', 'A foto deve ter no máximo 5 MB.');
    const mime = sniffDocMime(file.buf);
    if (!mime || !mime.startsWith('image/')) throw badRequest('FILE_TYPE', 'Envie a foto em JPG, PNG ou WEBP.');
    const id = uid(), key = `user-photo-${id}`, now = nowIso();
    await putObject(key, file.buf);
    const prev = await tx(async () => {
      const before = await currentPhoto(a.userId);
      await run('UPDATE user_photos SET removed_at = ? WHERE user_id = ? AND removed_at IS NULL', now, a.userId);
      await run('INSERT INTO user_photos (id, user_id, mime, size_bytes, sha256, storage_key, created_at) VALUES (?,?,?,?,?,?,?)',
        id, a.userId, mime, file!.buf.length, sha256(file!.buf), key, now);
      return before;
    });
    await audit({ actorId: a.userId, action: prev ? 'USER_PHOTO_CHANGED' : 'USER_PHOTO_ADDED', subjectType: 'user_photo', subjectId: id, correlationId: req.correlationId, meta: { mime, sizeBytes: file.buf.length } });
    return { ok: true, updatedAt: now };
  });

  app.delete('/api/me/photo', async (req) => {
    const a = requireUser(req);
    const p = await currentPhoto(a.userId);
    if (!p) throw notFound('Foto não enviada.');
    const now = nowIso();
    await run('UPDATE user_photos SET removed_at = ? WHERE user_id = ? AND removed_at IS NULL', now, a.userId);
    await audit({ actorId: a.userId, action: 'USER_PHOTO_REMOVED', subjectType: 'user_photo', subjectId: p.id, correlationId: req.correlationId });
    return { ok: true, removedAt: now };
  });
}
