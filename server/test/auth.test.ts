import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, emailOf, loginAs, one, setup } from './helpers.ts';
import { totp } from '../src/lib/security.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });

describe('Autenticação e sessão', () => {
  it('cadastro de paciente, sessão persistente, logout', async () => {
    const c = new Client(app);
    const r = await c.req('POST', '/api/auth/register', { name: 'Pessoa Teste', email: 'nova@exemplo.test', password: 'senhaSegura123' });
    expect(r.status).toBe(201);
    expect(r.body.user.roles).toEqual(['PACIENTE']);
    expect((await c.get('/api/auth/me')).body.user.email).toBe('nova@exemplo.test');
    expect((await c.post('/api/auth/logout')).status).toBe(200);
    expect((await c.get('/api/auth/me')).body.user).toBeNull();
  });

  it('valida senha fraca e e-mail duplicado', async () => {
    const c = new Client(app);
    expect((await c.req('POST', '/api/auth/register', { name: 'Pessoa', email: 'x@exemplo.test', password: 'curta' })).status).toBe(400);
    const dup = await c.req('POST', '/api/auth/register', { name: 'Pessoa', email: emailOf('paciente'), password: 'senhaSegura123' });
    expect(dup.status).toBe(409);
  });

  it('rejeita senha incorreta sem revelar se o e-mail existe', async () => {
    const c = new Client(app);
    const a = await c.req('POST', '/api/auth/login', { email: emailOf('paciente'), password: 'errada-123' });
    const b = await c.req('POST', '/api/auth/login', { email: 'naoexiste@exemplo.test', password: 'errada-123' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it('exige token CSRF e Origin permitido em mutações autenticadas', async () => {
    const c = new Client(app);
    await c.login(emailOf('paciente'));
    const noCsrf = await c.req('PUT', '/api/prime/preferences', {}, { 'x-csrf-token': '' });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe('CSRF');
    const badOrigin = await c.req('POST', '/api/auth/logout', {}, { origin: 'https://evil.example' });
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.body.error.code).toBe('BAD_ORIGIN');
  });

  it('recuperação de senha: token único, revoga sessões antigas', async () => {
    const c = new Client(app);
    await c.login(emailOf('paciente'));
    const f = await new Client(app).req('POST', '/api/auth/forgot', { email: emailOf('paciente') });
    expect(f.status).toBe(202);
    expect(f.body.emailDeliveryConfigured).toBe(false);
    const token = f.headers['x-test-reset-token'] as string;
    const r = await new Client(app).req('POST', '/api/auth/reset', { token, password: 'novaSenha2026x' });
    expect(r.status).toBe(200);
    expect((await c.get('/api/auth/me')).body.user).toBeNull(); // sessão antiga revogada
    expect((await new Client(app).req('POST', '/api/auth/reset', { token, password: 'outraSenha2026x' })).status).toBe(400);
    await new Client(app).login(emailOf('paciente'), 'novaSenha2026x');
    // e-mail inexistente: mesma resposta
    const f2 = await new Client(app).req('POST', '/api/auth/forgot', { email: 'ninguem@exemplo.test' });
    expect(f2.status).toBe(202);
    expect(f2.body.message).toBe(f.body.message);
  });

  it('perfis administrativos exigem MFA antes de acessar funções administrativas', async () => {
    const c = new Client(app);
    const r = await c.login(emailOf('auditor'));
    expect(r.body.mfa.required).toBe(true);
    const denied = await c.get('/api/admin/audit');
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('MFA_REQUIRED');
    const s = await c.post('/api/auth/mfa/setup');
    expect(s.body.qrDataUrl).toMatch(/^data:image\/png/);
    expect((await c.post('/api/auth/mfa/enable', { code: '000000' })).status).toBe(400);
    expect((await c.post('/api/auth/mfa/enable', { code: totp(s.body.secret) })).status).toBe(200);
    expect((await c.get('/api/admin/audit')).status).toBe(200);
    // novo login exige verificação
    const c2 = new Client(app);
    await c2.login(emailOf('auditor'));
    expect((await c2.get('/api/admin/audit')).status).toBe(403);
    const secret = one<any>('SELECT mfa_secret FROM users WHERE email = ?', emailOf('auditor'))!.mfa_secret;
    expect((await c2.post('/api/auth/mfa/verify', { code: totp(secret) })).status).toBe(200);
    expect((await c2.get('/api/admin/audit')).status).toBe(200);
  });

  it('usuário não autenticado recebe 401 nas APIs protegidas (ACA-T001)', async () => {
    const c = new Client(app);
    expect((await c.get('/api/academy/journey')).status).toBe(401);
    expect((await c.get('/api/prime/me')).status).toBe(401);
    expect((await c.get('/api/admin/users')).status).toBe(401);
  });

  it('perfis sem permissão recebem 403 (paciente x Academy, especialista x PRIME, admin x dados alheios)', async () => {
    const p = new Client(app); await p.login(emailOf('paciente'));
    expect((await p.get('/api/academy/journey')).status).toBe(403);
    expect((await p.get('/api/admin/prime/overview')).status).toBe(403);
    const e = new Client(app); await e.login(emailOf('especialista'));
    expect((await e.get('/api/prime/me')).status).toBe(403);
    const fin = await loginAs(app, 'financeiro');
    expect((await fin.get('/api/admin/academy/assessments/00000000-0000-4000-8000-000000000000/questions')).status).toBe(403);
    const sup = await loginAs(app, 'suporte');
    expect((await sup.get('/api/admin/academy/training-status')).status).toBe(403);
  });

  it('gestão de usuários respeita quem pode atribuir cada perfil', async () => {
    const ap = await loginAs(app, 'adminPrime');
    const denied = await ap.post('/api/admin/users', { name: 'Novo RT', email: 'rt2@exemplo.test', roles: ['AVALIADOR_RT'] });
    expect(denied.status).toBe(403);
    const ok = await ap.post('/api/admin/users', { name: 'Novo Operador', email: 'op2@exemplo.test', roles: ['OPERADOR_CENTRAL'] });
    expect(ok.status).toBe(200);
    expect(ok.body.tempPassword).toBeTruthy();
  });
});
