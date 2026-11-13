import { describe, expect, it } from 'vitest';
import { Client, emailOf, one, run, setup } from './helpers.ts';
import { bootstrapKey, ensureReady } from '../src/bootstrap.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';

describe('Redefinição de senha de emergência (sem e-mail configurado)', () => {
  it('aplica uma vez por par e-mail/senha, recusa senha fraca e encerra sessões', async () => {
    const app = await setup();
    await run(`INSERT INTO system_settings (key, value, created_at) VALUES ('bootstrap_version', ?, now()::text), ('schema_head', ?, now()::text)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`, bootstrapKey(), MIGRATIONS[MIGRATIONS.length - 1].name);
    process.env.ADMIN_RESET_EMAIL = emailOf('paciente');
    process.env.ADMIN_RESET_PASSWORD = 'NovaSenha2026';
    try {
      await ensureReady();
      const c = new Client(app);
      expect((await c.req('POST', '/api/auth/login', { email: emailOf('paciente'), password: 'NovaSenha2026' })).status).toBe(200);
      expect((await one<any>(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'EMERGENCY_PASSWORD_RESET'`)).n).toBe(1);
    } finally {
      delete process.env.ADMIN_RESET_EMAIL; delete process.env.ADMIN_RESET_PASSWORD;
    }
  });
});
