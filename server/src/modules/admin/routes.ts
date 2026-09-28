import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.ts';
import { all, one, run, tx } from '../../db/db.ts';
import { audit } from '../../lib/audit.ts';
import { parse, requireRoles, type AuthCtx } from '../../lib/context.ts';
import { conflict, forbidden, notFound } from '../../lib/errors.ts';
import { ROLES, ROLE_GRANTORS, ROLE_LABELS, type Role } from '../../lib/roles.ts';
import { hashPassword } from '../../lib/security.ts';
import { nowIso, randomToken, uid } from '../../lib/util.ts';
import { productionGates } from '../prime/admin.ts';

const USER_ADMINS: Role[] = ['ADMIN_ACADEMY', 'ADMIN_PRIME'];

function canGrant(a: AuthCtx, role: Role) {
  return ROLE_GRANTORS[role].some((r) => a.roles.includes(r));
}

export async function adminRoutes(app: FastifyInstance) {
  // Estado do ambiente para a interface (sem segredos)
  app.get('/api/system/status', async () => ({
    environment: config.appEnv,
    paymentProvider: config.paymentProvider,
    emailDeliveryConfigured: false,
    whatsappEnabled: config.whatsappEnabled,
    requireAdminMfa: config.requireAdminMfa,
    productionReady: (await productionGates()).productionReady,
    roleLabels: ROLE_LABELS,
  }));

  app.get('/api/admin/users', async (req) => {
    requireRoles(req, [...USER_ADMINS, 'AUDITOR']);
    const { q } = parse(z.object({ q: z.string().max(100).optional() }), req.query);
    const like = `%${(q ?? '').trim()}%`;
    return {
      users: await Promise.all((await all<any>(`SELECT id, name, email, status, academy_eligible, mfa_enabled, created_at FROM users WHERE name ILIKE ? OR email ILIKE ? ORDER BY name LIMIT 100`, like, like))
        .map(async (u) => ({ ...u, roles: (await all<any>('SELECT role FROM user_roles WHERE user_id = ?', u.id)).map((r) => r.role) }))),
      grantable: ROLES.filter((r) => r !== 'PACIENTE'),
    };
  });

  app.post('/api/admin/users', async (req) => {
    const a = requireRoles(req, USER_ADMINS);
    const b = parse(z.object({
      name: z.string().trim().min(3).max(120), email: z.string().trim().toLowerCase().email(),
      roles: z.array(z.enum(ROLES)).min(1), academyEligible: z.boolean().default(false),
    }), req.body);
    for (const r of b.roles) if (!canGrant(a, r)) throw forbidden(`Você não pode atribuir o perfil ${ROLE_LABELS[r]}.`);
    if (b.academyEligible && !a.roles.includes('ADMIN_ACADEMY')) throw forbidden('Somente o Administrador Academy registra elegibilidade.');
    const tempPassword = `${randomToken(9)}9a`;
    const id = uid();
    await tx(async () => {
      if (await one('SELECT 1 FROM users WHERE email = ?', b.email)) throw conflict('EMAIL_IN_USE', 'E-mail já cadastrado.');
      const now = nowIso();
      await run('INSERT INTO users (id, email, name, password_hash, academy_eligible, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
        id, b.email, b.name, hashPassword(tempPassword), b.academyEligible ? 1 : 0, now, now);
      for (const r of b.roles) await run('INSERT INTO user_roles (user_id, role, granted_by, granted_at) VALUES (?,?,?,?)', id, r, a.userId, now);
      await audit({ actorId: a.userId, action: 'USER_CREATED', subjectType: 'user', subjectId: id, correlationId: req.correlationId, meta: { roles: b.roles } });
    });
    // Sem provedor de e-mail: a senha temporária é exibida uma única vez ao administrador.
    return { id, tempPassword, notice: 'Senha temporária exibida uma única vez. Entregue-a por canal seguro; o envio automático por e-mail não está configurado.' };
  });

  app.put('/api/admin/users/:id/roles', async (req) => {
    const a = requireRoles(req, USER_ADMINS);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { roles } = parse(z.object({ roles: z.array(z.enum(ROLES)) }), req.body);
    return await tx(async () => {
      if (!await one('SELECT 1 FROM users WHERE id = ?', id)) throw notFound();
      const current = (await all<any>('SELECT role FROM user_roles WHERE user_id = ?', id)).map((r) => r.role as Role);
      const add = roles.filter((r) => !current.includes(r));
      const remove = current.filter((r) => !roles.includes(r));
      for (const r of [...add, ...remove]) {
        if (r === 'PACIENTE') throw forbidden('O perfil Paciente é gerido pelo próprio titular.');
        if (!canGrant(a, r)) throw forbidden(`Você não pode alterar o perfil ${ROLE_LABELS[r]}.`);
      }
      if (id === a.userId && remove.some((r) => USER_ADMINS.includes(r))) throw conflict('SELF_DEMOTION', 'Você não pode remover seu próprio perfil administrativo.');
      const now = nowIso();
      for (const r of add) await run('INSERT INTO user_roles (user_id, role, granted_by, granted_at) VALUES (?,?,?,?)', id, r, a.userId, now);
      for (const r of remove) await run('DELETE FROM user_roles WHERE user_id = ? AND role = ?', id, r);
      if (remove.length) await run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', now, id);
      await audit({ actorId: a.userId, action: 'USER_ROLES_CHANGED', subjectType: 'user', subjectId: id, correlationId: req.correlationId, meta: { add, remove } });
      return { ok: true };
    });
  });

  // Elegibilidade ONEMA ONE (integração com o ONEMA ONE pendente: registro manual e auditado)
  app.put('/api/admin/users/:id/eligibility', async (req) => {
    const a = requireRoles(req, ['ADMIN_ACADEMY']);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { eligible } = parse(z.object({ eligible: z.boolean() }), req.body);
    const r = await run('UPDATE users SET academy_eligible = ?, updated_at = ? WHERE id = ?', eligible ? 1 : 0, nowIso(), id);
    if (!r.changes) throw notFound();
    await audit({ actorId: a.userId, action: 'ELIGIBILITY_CHANGED', subjectType: 'user', subjectId: id, correlationId: req.correlationId, meta: { eligible } });
    return { ok: true };
  });

  app.put('/api/admin/users/:id/status', async (req) => {
    const a = requireRoles(req, USER_ADMINS);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { status } = parse(z.object({ status: z.enum(['ACTIVE', 'DISABLED']) }), req.body);
    if (id === a.userId) throw conflict('SELF_DISABLE', 'Você não pode desativar a própria conta.');
    return await tx(async () => {
      const r = await run('UPDATE users SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), id);
      if (!r.changes) throw notFound();
      if (status === 'DISABLED') await run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', nowIso(), id);
      await audit({ actorId: a.userId, action: 'USER_STATUS_CHANGED', subjectType: 'user', subjectId: id, correlationId: req.correlationId, meta: { status } });
      return { ok: true };
    });
  });

  // Auditoria: leitura paginada, sem escrita (ACA-015 / ACA-T027 / ACA-T028)
  app.get('/api/admin/audit', async (req) => {
    requireRoles(req, ['AUDITOR', 'ADMIN_ACADEMY', 'ADMIN_PRIME']);
    const q = parse(z.object({
      action: z.string().max(60).optional(), subjectType: z.string().max(60).optional(),
      page: z.coerce.number().int().min(1).max(10000).default(1),
    }), req.query);
    const where: string[] = [], params: any[] = [];
    if (q.action) { where.push('e.action = ?'); params.push(q.action); }
    if (q.subjectType) { where.push('e.subject_type = ?'); params.push(q.subjectType); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await one<any>(`SELECT COUNT(*) AS n FROM audit_events e ${w}`, ...params))!.n;
    return {
      total, page: q.page, pageSize: 50,
      events: await all(`SELECT e.seq, e.action, e.subject_type, e.subject_id, e.before_hash, e.after_hash, e.correlation_id, e.meta_json, e.occurred_at, u.name AS actor
                   FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id ${w} ORDER BY e.seq DESC LIMIT 50 OFFSET ?`, ...params, (q.page - 1) * 50),
      actions: (await all<any>('SELECT DISTINCT action FROM audit_events ORDER BY action')).map((r) => r.action),
    };
  });
}
