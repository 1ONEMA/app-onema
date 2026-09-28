import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { one, run, tx } from '../db/db.ts';
import { AppError, badRequest, conflict, forbidden, unauthorized } from './errors.ts';
import { ADMIN_ROLES, type Role } from './roles.ts';
import { nowIso, sha256, stableJson } from './util.ts';

export interface AuthCtx {
  userId: string;
  email: string;
  name: string;
  roles: Role[];
  sessionHash: string;
  csrf: string;
  mfaVerified: boolean;
  mfaEnabled: boolean;
  academyEligible: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthCtx | null;
    correlationId: string;
  }
  interface FastifyContextConfig {
    /** Rota sem exigência de CSRF (login, cadastro, verificação pública, webhook). */
    public?: boolean;
  }
}

export const SESSION_COOKIE = 'onema_sid';

export function loadSession(req: FastifyRequest): AuthCtx | null {
  const sid = req.cookies?.[SESSION_COOKIE];
  if (!sid) return null;
  const h = sha256(sid);
  const s = one<any>(
    `SELECT s.*, u.email, u.name, u.status, u.mfa_enabled, u.academy_eligible FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id_hash = ? AND s.revoked_at IS NULL`, h);
  if (!s || s.status !== 'ACTIVE' || s.expires_at < nowIso()) return null;
  const roles = one<any>('SELECT json_group_array(role) AS r FROM user_roles WHERE user_id = ?', s.user_id)!.r;
  run('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?', nowIso(), h);
  return {
    userId: s.user_id, email: s.email, name: s.name, roles: JSON.parse(roles), sessionHash: h, csrf: s.csrf_token,
    mfaVerified: !!s.mfa_verified, mfaEnabled: !!s.mfa_enabled, academyEligible: !!s.academy_eligible,
  };
}

export function needsMfa(a: AuthCtx) {
  return config.requireAdminMfa && a.roles.some((r) => ADMIN_ROLES.includes(r)) && !a.mfaVerified;
}

export function requireUser(req: FastifyRequest): AuthCtx {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

/** Autorização no servidor. Perfis administrativos exigem sessão com MFA verificado. */
export function requireRoles(req: FastifyRequest, roles: Role[]): AuthCtx {
  const a = requireUser(req);
  const matched = a.roles.filter((r) => roles.includes(r));
  if (!matched.length) throw forbidden();
  const onlyAdmin = matched.every((r) => ADMIN_ROLES.includes(r));
  if (onlyAdmin && config.requireAdminMfa && !a.mfaVerified) {
    throw forbidden('Confirme o segundo fator (MFA) para acessar funções administrativas.', 'MFA_REQUIRED');
  }
  return a;
}
export const hasRole = (a: AuthCtx | null, r: Role) => !!a && a.roles.includes(r);

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest('VALIDATION', 'Dados inválidos. Revise os campos destacados.',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

/**
 * Idempotência: a mesma Idempotency-Key com o mesmo corpo devolve a resposta original
 * (duplo clique / replay); com corpo diferente, 409.
 */
export function idempotent<T>(req: FastifyRequest, reply: FastifyReply, route: string, fn: () => { status: number; body: T }) {
  const a = requireUser(req);
  const key = String(req.headers['idempotency-key'] ?? '');
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(key)) throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Cabeçalho Idempotency-Key ausente ou inválido.');
  const reqHash = sha256(route + '|' + stableJson(req.body ?? null));
  return tx(() => {
    const prev = one<any>('SELECT * FROM idempotency_keys WHERE user_id = ? AND key = ?', a.userId, key);
    if (prev) {
      if (prev.route !== route || prev.request_hash !== reqHash) {
        throw conflict('IDEMPOTENCY_KEY_REUSED', 'Esta chave de operação já foi usada com outros dados.');
      }
      reply.header('Idempotent-Replay', 'true');
      reply.code(prev.status_code);
      return JSON.parse(prev.response_json) as T;
    }
    const res = fn();
    run(`INSERT INTO idempotency_keys (user_id, key, route, request_hash, status_code, response_json, created_at)
         VALUES (?,?,?,?,?,?,?)`, a.userId, key, route, reqHash, res.status, JSON.stringify(res.body), nowIso());
    reply.code(res.status);
    return res.body;
  });
}

export function sendError(reply: FastifyReply, e: AppError, correlationId: string) {
  reply.code(e.status).send({ error: { code: e.code, message: e.message, details: e.details, correlationId } });
}
