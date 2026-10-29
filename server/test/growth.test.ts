import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, emailOf, loginAs, one, setup } from './helpers.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });

describe('Crescimento: indicação e recomendação', () => {
  it('paciente tem link de indicação; cadastro com o código registra a indicação; código inválido é ignorado', async () => {
    const c = new Client(app); await c.login(emailOf('paciente'));
    const r1 = (await c.get('/api/care/referral')).body;
    expect(r1.code).toMatch(/^[A-Z0-9]{6,12}$/);
    expect(r1.link).toContain(`?indicacao=${r1.code}`);
    expect((await c.get('/api/care/referral')).body.code).toBe(r1.code); // estável
    const novo = new Client(app);
    expect((await novo.req('POST', '/api/auth/register', { name: 'Amiga Indicada', email: 'amiga@exemplo.test', password: 'SenhaSegura2026', referralCode: r1.code.toLowerCase() })).status).toBe(201);
    const outro = new Client(app);
    expect((await outro.req('POST', '/api/auth/register', { name: 'Sem Indicação', email: 'sem@exemplo.test', password: 'SenhaSegura2026', referralCode: 'NAOEXISTE' })).status).toBe(201);
    expect((await c.get('/api/care/referral')).body.referrals).toBe(1);
    expect((await one<any>(`SELECT referred_by FROM users WHERE email = 'sem@exemplo.test'`)).referred_by).toBeNull();
    // perfis da equipe veem o resumo; especialista não tem link de paciente
    const sp = new Client(app); await sp.login(emailOf('especialistaOne'));
    expect((await sp.get('/api/care/referral')).status).toBe(403);
    const op = await loginAs(app, 'financeiro');
    expect((await op.get('/api/admin/care/overview')).body.growth).toMatchObject({ referredSignups: 1, npsResponses: 0, nps: null });
  });
});
