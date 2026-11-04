/**
 * Compartilhar o relatório do atendimento (evolução assinada) — benefício ONEMA PRIME.
 * O paciente gera um link próprio para enviar por WhatsApp ou e-mail: validade de 7 dias, revogável,
 * guardamos só o hash do token e cada abertura é contada e auditada. O conteúdo não vai na mensagem.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, one, run } from '../../db/db.ts';
import { config } from '../../config.ts';
import { audit } from '../../lib/audit.ts';
import { parse, requireRoles } from '../../lib/context.ts';
import { AppError, forbidden, notFound } from '../../lib/errors.ts';
import { rateLimit } from '../../lib/security.ts';
import { addDays, nowIso, randomToken, sha256, uid } from '../../lib/util.ts';
import { benefitState, latestSubscription } from '../prime/core.ts';

export const SHARE_DAYS = 7;
const firstName = (n: string) => String(n).split(' ')[0];

export async function primeActive(userId: string) {
  return (await benefitState(await latestSubscription(userId))).active;
}

export async function reportShareRoutes(app: FastifyInstance) {
  app.post('/api/care/evolutions/:id/share', async (req) => {
    const a = requireRoles(req, ['PACIENTE']);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { channel } = parse(z.object({ channel: z.enum(['WHATSAPP', 'EMAIL', 'LINK']) }), req.body ?? {});
    const v = await one<any>(`SELECT id FROM care_evolutions WHERE id = ? AND patient_id = ? AND status = 'ASSINADA'`, id, a.userId);
    if (!v) throw notFound('Relatório não encontrado.');
    if (!(await primeActive(a.userId))) throw forbidden('Compartilhar o relatório é um benefício do ONEMA PRIME.', 'PRIME_REQUIRED');
    if (!await rateLimit(`report-share:${a.userId}`, 20, 3600_000)) throw new AppError(429, 'RATE_LIMIT', 'Muitos compartilhamentos em pouco tempo. Aguarde um pouco.');
    const token = randomToken(32);
    const now = nowIso();
    const expires = addDays(now, SHARE_DAYS);
    const shareId = uid();
    await run('INSERT INTO report_shares (id, token_hash, patient_id, evolution_id, channel, created_at, expires_at) VALUES (?,?,?,?,?,?,?)',
      shareId, sha256(token), a.userId, id, channel, now, expires);
    await audit({ actorId: a.userId, action: 'REPORT_SHARED', subjectType: 'care_evolution', subjectId: id, correlationId: req.correlationId, meta: { channel, shareId } });
    return { id: shareId, url: `${config.publicOrigin}/relatorio/${token}`, expiresAt: expires };
  });

  app.get('/api/care/report-shares', async (req) => {
    const a = requireRoles(req, ['PACIENTE']);
    return { shares: await all(`SELECT s.id, s.channel, s.created_at, s.expires_at, s.revoked_at, s.access_count, s.last_access_at, e.label
      FROM report_shares s JOIN care_evolutions v ON v.id = s.evolution_id JOIN care_events e ON e.id = v.event_id WHERE s.patient_id = ? ORDER BY s.created_at DESC LIMIT 100`, a.userId) };
  });

  app.post('/api/care/report-shares/:id/revoke', async (req) => {
    const a = requireRoles(req, ['PACIENTE']);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const r = await run('UPDATE report_shares SET revoked_at = ? WHERE id = ? AND patient_id = ? AND revoked_at IS NULL', nowIso(), id, a.userId);
    if (!r.changes) throw notFound('Compartilhamento não encontrado.');
    await audit({ actorId: a.userId, action: 'REPORT_SHARE_REVOKED', subjectType: 'report_share', subjectId: id, correlationId: req.correlationId });
    return { ok: true };
  });

  /** Abertura pública do link: só o relatório compartilhado, sem dados de contato do paciente. */
  app.get('/api/public/reports/:token', async (req, reply) => {
    if (!await rateLimit(`report-open:${req.ip}`, 60, 15 * 60_000)) throw new AppError(429, 'RATE_LIMIT', 'Muitas consultas. Aguarde alguns minutos.');
    const { token } = parse(z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{30,80}$/) }), req.params);
    const s = await one<any>('SELECT * FROM report_shares WHERE token_hash = ?', sha256(token));
    if (!s || s.revoked_at || s.expires_at <= nowIso()) throw notFound('Este link não está mais disponível. Peça um novo ao paciente.');
    const d = (await one<any>(`SELECT v.signed_at, v.content_json, e.label, o.item_name, u.name AS specialist, p.name AS patient,
        (SELECT sa.coren_number || '-' || sa.coren_uf FROM specialist_applications sa WHERE sa.user_id = v.specialist_id AND sa.status = 'APROVADA') AS coren
      FROM care_evolutions v JOIN care_events e ON e.id = v.event_id JOIN service_orders o ON o.id = v.order_id
      JOIN users u ON u.id = v.specialist_id JOIN users p ON p.id = v.patient_id WHERE v.id = ?`, s.evolution_id))!;
    await run('UPDATE report_shares SET access_count = access_count + 1, last_access_at = ? WHERE id = ?', nowIso(), s.id);
    await audit({ actorId: null, action: 'REPORT_SHARE_OPENED', subjectType: 'report_share', subjectId: s.id, correlationId: req.correlationId });
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    const { pendencias: _p, ...content } = JSON.parse(d.content_json);
    return { patient: firstName(d.patient), label: d.label, itemName: d.item_name, signedAt: d.signed_at, specialist: d.specialist, coren: d.coren, content, expiresAt: s.expires_at };
  });
}
