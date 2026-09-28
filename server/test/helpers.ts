import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { all, exec, newMemoryDriver, one, run, setDriver } from '../src/db/db.ts';
import { migrate } from '../src/db/migrate.ts';
import { DEMO_PASSWORD, DEMO_USERS, seedDemo } from '../src/db/seed.ts';
import { resetRateLimits, totp } from '../src/lib/security.ts';
import { randomToken } from '../src/lib/util.ts';

let migrated = false;
/** Um banco PGlite em memória por arquivo de teste; cada teste começa com dados limpos + seed de demonstração. */
export async function setup() {
  if (!migrated) {
    setDriver(newMemoryDriver());
    await migrate();
    migrated = true;
  } else {
    const tables = (await all<any>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`)).map((t) => `"${t.tablename}"`);
    await exec(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
  }
  await seedDemo();
  await resetRateLimits();
  const app = await buildApp();
  return app;
}

export type DemoKey = (typeof DEMO_USERS)[number]['key'];
export const emailOf = (k: DemoKey) => DEMO_USERS.find((u) => u.key === k)!.email;
export const idOf = async (k: DemoKey) => (await one<any>('SELECT id FROM users WHERE email = ?', emailOf(k)))!.id as string;

export class Client {
  cookie = '';
  csrf = '';
  constructor(public app: FastifyInstance) {}
  async req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (this.csrf && method !== 'GET' && !('x-csrf-token' in headers)) h['x-csrf-token'] = this.csrf;
    const res = await this.app.inject({ method: method as any, url, payload: body as any, headers: h });
    const set = res.headers['set-cookie'];
    if (set) {
      const c = (Array.isArray(set) ? set : [set]).find((s) => s.startsWith('onema_sid='));
      if (c) this.cookie = c.split(';')[0];
    }
    let json: any = null;
    try { json = res.json(); } catch { /* not json */ }
    if (json?.csrfToken) this.csrf = json.csrfToken;
    return { status: res.statusCode, body: json, headers: res.headers };
  }
  get(url: string) { return this.req('GET', url); }
  post(url: string, body?: unknown, idem?: string | boolean) {
    return this.req('POST', url, body ?? {}, idem ? { 'idempotency-key': typeof idem === 'string' ? idem : `k_${randomToken(12)}` } : {});
  }
  put(url: string, body?: unknown, idem?: string | boolean) {
    return this.req('PUT', url, body ?? {}, idem ? { 'idempotency-key': typeof idem === 'string' ? idem : `k_${randomToken(12)}` } : {});
  }
  async login(email: string, password = DEMO_PASSWORD) {
    const r = await this.req('POST', '/api/auth/login', { email, password });
    if (r.status !== 200) throw new Error(`login failed ${r.status} ${JSON.stringify(r.body)}`);
    return r;
  }
}

/** Login com MFA para perfis administrativos (cadastra TOTP na primeira vez). */
export async function loginAs(app: FastifyInstance, key: DemoKey) {
  const c = new Client(app);
  const r = await c.login(emailOf(key));
  if (r.body.mfa.required) {
    const u = (await one<any>('SELECT mfa_enabled, mfa_secret FROM users WHERE email = ?', emailOf(key)))!;
    if (!u.mfa_enabled) {
      const s = await c.post('/api/auth/mfa/setup');
      const e = await c.post('/api/auth/mfa/enable', { code: totp(s.body.secret) });
      if (e.status !== 200) throw new Error('mfa enable failed');
    } else {
      const v = await c.post('/api/auth/mfa/verify', { code: totp(u.mfa_secret) });
      if (v.status !== 200) throw new Error('mfa verify failed');
    }
  }
  return c;
}

export { all, one, run };
