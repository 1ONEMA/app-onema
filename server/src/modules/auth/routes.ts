import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { config } from '../../config.ts';
import { all, one, run, tx } from '../../db/db.ts';
import { audit } from '../../lib/audit.ts';
import { SESSION_COOKIE, needsMfa, parse, requireUser, type AuthCtx } from '../../lib/context.ts';
import { AppError, badRequest, conflict, unauthorized } from '../../lib/errors.ts';
import { ADMIN_ROLES } from '../../lib/roles.ts';
import {
  DUMMY_HASH, hashPassword, newTotpSecret, rateLimit, verifyPassword, verifyTotp,
} from '../../lib/security.ts';
import { addHours, nowIso, randomToken, sha256, uid } from '../../lib/util.ts';

export const passwordSchema = z.string()
  .min(10, 'A senha deve ter pelo menos 10 caracteres.')
  .max(200)
  .refine((s) => /[A-Za-z]/.test(s) && /\d/.test(s), 'Use letras e números na senha.');
const emailSchema = z.string().trim().toLowerCase().email('Informe um e-mail válido.').max(200);

function createSession(reply: FastifyReply, userId: string) {
  const sid = randomToken(32);
  const now = nowIso();
  run(`INSERT INTO sessions (id_hash, user_id, csrf_token, mfa_verified, created_at, expires_at, last_seen_at)
       VALUES (?,?,?,?,?,?,?)`, sha256(sid), userId, randomToken(24), 0, now, addHours(now, config.sessionTtlHours), now);
  reply.setCookie(SESSION_COOKIE, sid, {
    path: '/', httpOnly: true, sameSite: 'strict', secure: config.isProd, maxAge: config.sessionTtlHours * 3600,
  });
  return sha256(sid);
}

export function meResponse(req: FastifyRequest) {
  const a = req.auth;
  if (!a) return { user: null };
  const isAdmin = a.roles.some((r) => ADMIN_ROLES.includes(r));
  return {
    user: { id: a.userId, name: a.name, email: a.email, roles: a.roles, academyEligible: a.academyEligible },
    csrfToken: a.csrf,
    mfa: {
      required: config.requireAdminMfa && isAdmin,
      enabled: a.mfaEnabled,
      verified: a.mfaVerified,
      pending: needsMfa(a),
    },
  };
}

function reloadAuth(req: FastifyRequest, sessionHash: string) {
  const s = one<any>(`SELECT s.*, u.email, u.name, u.mfa_enabled, u.academy_eligible FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`, sessionHash)!;
  const roles = JSON.parse(one<any>('SELECT json_group_array(role) AS r FROM user_roles WHERE user_id = ?', s.user_id)!.r);
  req.auth = {
    userId: s.user_id, email: s.email, name: s.name, roles, sessionHash, csrf: s.csrf_token,
    mfaVerified: !!s.mfa_verified, mfaEnabled: !!s.mfa_enabled, academyEligible: !!s.academy_eligible,
  } satisfies AuthCtx;
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/auth/me', async (req) => meResponse(req));

  app.post('/api/auth/register', { config: { public: true } }, async (req, reply) => {
    if (!rateLimit(`register:${req.ip}`, 10, 3600_000)) throw new AppError(429, 'RATE_LIMIT', 'Muitas tentativas. Aguarde e tente novamente.');
    const body = parse(z.object({
      name: z.string().trim().min(3, 'Informe seu nome completo.').max(120),
      email: emailSchema,
      password: passwordSchema,
    }), req.body);
    const id = uid();
    tx(() => {
      if (one('SELECT 1 FROM users WHERE email = ?', body.email)) {
        throw conflict('EMAIL_IN_USE', 'Já existe uma conta com este e-mail. Use "Esqueci minha senha" se necessário.');
      }
      const now = nowIso();
      run(`INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
        id, body.email, body.name, hashPassword(body.password), now, now);
      run(`INSERT INTO user_roles (user_id, role, granted_by, granted_at) VALUES (?, 'PACIENTE', NULL, ?)`, id, now);
      audit({ actorId: id, action: 'USER_REGISTERED', subjectType: 'user', subjectId: id, correlationId: req.correlationId });
    });
    const h = createSession(reply, id);
    reloadAuth(req, h);
    reply.code(201);
    return meResponse(req);
  });

  app.post('/api/auth/login', { config: { public: true } }, async (req, reply) => {
    const body = parse(z.object({ email: emailSchema, password: z.string().min(1).max(200) }), req.body);
    if (!rateLimit(`login:${req.ip}:${body.email}`, 8, 15 * 60_000)) {
      throw new AppError(429, 'RATE_LIMIT', 'Muitas tentativas de acesso. Aguarde 15 minutos e tente novamente.');
    }
    const u = one<any>('SELECT * FROM users WHERE email = ?', body.email);
    const ok = verifyPassword(body.password, u?.password_hash ?? DUMMY_HASH) && !!u && u.status === 'ACTIVE';
    if (!ok) {
      audit({ actorId: u?.id ?? null, action: 'LOGIN_FAILED', subjectType: 'user', subjectId: u?.id ?? null, correlationId: req.correlationId });
      throw unauthorized('E-mail ou senha incorretos.');
    }
    const h = createSession(reply, u.id);
    audit({ actorId: u.id, action: 'LOGIN', subjectType: 'session', subjectId: h.slice(0, 12), correlationId: req.correlationId });
    reloadAuth(req, h);
    return meResponse(req);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.auth) {
      run('UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', nowIso(), req.auth.sessionHash);
      audit({ actorId: req.auth.userId, action: 'LOGOUT', subjectType: 'session', subjectId: req.auth.sessionHash.slice(0, 12), correlationId: req.correlationId });
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/forgot', { config: { public: true } }, async (req, reply) => {
    const body = parse(z.object({ email: emailSchema }), req.body);
    if (!rateLimit(`forgot:${req.ip}`, 5, 15 * 60_000)) throw new AppError(429, 'RATE_LIMIT', 'Muitas solicitações. Aguarde e tente novamente.');
    const u = one<any>('SELECT id, email FROM users WHERE email = ? AND status = ?', body.email, 'ACTIVE');
    if (u) {
      const token = randomToken(32);
      const now = nowIso();
      tx(() => {
        run('INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)',
          sha256(token), u.id, now, new Date(Date.now() + config.passwordResetTtlMinutes * 60_000).toISOString());
        // Sem provedor de e-mail configurado: a mensagem fica registrada como NÃO ENVIADA.
        run(`INSERT INTO outbox_messages (id, channel, purpose, recipient_user_id, recipient_address, template, payload_json, status, created_at)
             VALUES (?,?,?,?,?,?,?,?,?)`, uid(), 'EMAIL', 'ESSENCIAL', u.id, u.email, 'PASSWORD_RESET',
          JSON.stringify({ expiresInMinutes: config.passwordResetTtlMinutes }), 'NAO_ENVIADO_SEM_PROVEDOR', now);
        audit({ actorId: u.id, action: 'PASSWORD_RESET_REQUESTED', subjectType: 'user', subjectId: u.id, correlationId: req.correlationId });
      });
      if (!config.isProd && !config.isTest) {
        req.log.warn(`[DEV] Link de redefinição (e-mail não configurado): ${config.publicOrigin}/redefinir-senha?token=${token}`);
      }
      if (config.isTest) reply.header('x-test-reset-token', token);
    }
    reply.code(202);
    return {
      message: 'Se o e-mail estiver cadastrado, enviaremos as instruções de redefinição.',
      emailDeliveryConfigured: false,
    };
  });

  app.post('/api/auth/reset', { config: { public: true } }, async (req) => {
    const body = parse(z.object({ token: z.string().min(20).max(200), password: passwordSchema }), req.body);
    if (!rateLimit(`reset:${req.ip}`, 10, 15 * 60_000)) throw new AppError(429, 'RATE_LIMIT', 'Muitas tentativas. Aguarde e tente novamente.');
    tx(() => {
      const r = one<any>('SELECT * FROM password_resets WHERE token_hash = ?', sha256(body.token));
      if (!r || r.used_at || r.expires_at < nowIso()) throw badRequest('INVALID_TOKEN', 'Link inválido ou expirado. Solicite uma nova redefinição.');
      const now = nowIso();
      run('UPDATE password_resets SET used_at = ? WHERE token_hash = ?', now, r.token_hash);
      run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hashPassword(body.password), now, r.user_id);
      run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', now, r.user_id);
      audit({ actorId: r.user_id, action: 'PASSWORD_RESET_COMPLETED', subjectType: 'user', subjectId: r.user_id, correlationId: req.correlationId });
    });
    return { ok: true, message: 'Senha redefinida. Entre novamente com a nova senha.' };
  });

  app.post('/api/auth/password', async (req) => {
    const a = requireUser(req);
    const body = parse(z.object({ current: z.string().min(1), password: passwordSchema }), req.body);
    const u = one<any>('SELECT password_hash FROM users WHERE id = ?', a.userId)!;
    if (!verifyPassword(body.current, u.password_hash)) throw badRequest('WRONG_PASSWORD', 'A senha atual não confere.');
    tx(() => {
      const now = nowIso();
      run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hashPassword(body.password), now, a.userId);
      run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id_hash <> ? AND revoked_at IS NULL', now, a.userId, a.sessionHash);
      audit({ actorId: a.userId, action: 'PASSWORD_CHANGED', subjectType: 'user', subjectId: a.userId, correlationId: req.correlationId });
    });
    return { ok: true };
  });

  // ---- MFA (TOTP) ----
  app.post('/api/auth/mfa/setup', async (req) => {
    const a = requireUser(req);
    const u = one<any>('SELECT mfa_enabled FROM users WHERE id = ?', a.userId)!;
    if (u.mfa_enabled) throw conflict('MFA_ALREADY_ENABLED', 'O segundo fator já está ativo nesta conta.');
    const secret = newTotpSecret();
    run('UPDATE users SET mfa_secret = ?, updated_at = ? WHERE id = ?', secret, nowIso(), a.userId);
    const otpauth = `otpauth://totp/${encodeURIComponent('ONEMA SAÚDE')}:${encodeURIComponent(a.email)}?secret=${secret}&issuer=${encodeURIComponent('ONEMA SAÚDE')}`;
    return { secret, otpauth, qrDataUrl: await QRCode.toDataURL(otpauth, { margin: 1, width: 220 }) };
  });

  app.post('/api/auth/mfa/enable', async (req) => {
    const a = requireUser(req);
    const { code } = parse(z.object({ code: z.string().trim() }), req.body);
    const u = one<any>('SELECT mfa_secret, mfa_enabled FROM users WHERE id = ?', a.userId)!;
    if (u.mfa_enabled) throw conflict('MFA_ALREADY_ENABLED', 'O segundo fator já está ativo.');
    if (!u.mfa_secret || !verifyTotp(u.mfa_secret, code)) throw badRequest('INVALID_CODE', 'Código inválido. Confira o horário do dispositivo e tente novamente.');
    tx(() => {
      run('UPDATE users SET mfa_enabled = 1, updated_at = ? WHERE id = ?', nowIso(), a.userId);
      run('UPDATE sessions SET mfa_verified = 1 WHERE id_hash = ?', a.sessionHash);
      audit({ actorId: a.userId, action: 'MFA_ENABLED', subjectType: 'user', subjectId: a.userId, correlationId: req.correlationId });
    });
    reloadAuth(req, a.sessionHash);
    return meResponse(req);
  });

  app.post('/api/auth/mfa/verify', async (req) => {
    const a = requireUser(req);
    if (!rateLimit(`mfa:${a.userId}`, 6, 10 * 60_000)) throw new AppError(429, 'RATE_LIMIT', 'Muitas tentativas. Aguarde 10 minutos.');
    const { code } = parse(z.object({ code: z.string().trim() }), req.body);
    const u = one<any>('SELECT mfa_secret, mfa_enabled FROM users WHERE id = ?', a.userId)!;
    if (!u.mfa_enabled || !verifyTotp(u.mfa_secret, code)) {
      audit({ actorId: a.userId, action: 'MFA_FAILED', subjectType: 'user', subjectId: a.userId, correlationId: req.correlationId });
      throw badRequest('INVALID_CODE', 'Código inválido.');
    }
    run('UPDATE sessions SET mfa_verified = 1 WHERE id_hash = ?', a.sessionHash);
    audit({ actorId: a.userId, action: 'MFA_VERIFIED', subjectType: 'session', subjectId: a.sessionHash.slice(0, 12), correlationId: req.correlationId });
    reloadAuth(req, a.sessionHash);
    return meResponse(req);
  });

  // Avisos in-app do próprio usuário
  app.get('/api/notifications', async (req) => {
    const a = requireUser(req);
    return {
      items: all(
        'SELECT id, purpose, title, body, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', a.userId),
    };
  });
  app.post('/api/notifications/read', async (req) => {
    const a = requireUser(req);
    run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', nowIso(), a.userId);
    return { ok: true };
  });
}
