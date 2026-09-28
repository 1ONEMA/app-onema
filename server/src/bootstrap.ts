/**
 * Inicialização idempotente do banco (executada no primeiro uso de cada instância):
 * migrations, seed oficial, administrador inicial por variáveis de ambiente e, opcionalmente, dados de demonstração.
 */
import { config } from './config.ts';
import { one, run, tx } from './db/db.ts';
import { migrate } from './db/migrate.ts';
import { seedDemo, seedOfficial } from './db/seed.ts';
import { ROLES, type Role } from './lib/roles.ts';
import { hashPassword } from './lib/security.ts';
import { nowIso, randomToken, uid } from './lib/util.ts';
import { passwordSchema } from './modules/auth/routes.ts';

let ready: Promise<string[]> | null = null;

/** Versão da inicialização: quando igual à gravada no banco, a partida da Function só faz 3–4 consultas. */
const BOOTSTRAP_VERSION = '2026-09-29.1';
const bootstrapKey = () => `${BOOTSTRAP_VERSION}${process.env.SEED_DEMO === 'true' ? '+demo' : ''}`;

export function ensureReady(): Promise<string[]> {
  if (!ready) {
    ready = (async () => {
      const t0 = Date.now();
      const step = (name: string) => console.log(`[bootstrap] ${name} em ${Date.now() - t0} ms`);
      // Caminho rápido: banco já inicializado nesta versão.
      try {
        const v = await one<{ value: string }>(`SELECT value FROM system_settings WHERE key = 'bootstrap_version'`);
        if (v?.value === bootstrapKey()) {
          await loadSecrets();
          await bootstrapAdmin();
          step('caminho rápido concluído');
          return [];
        }
      } catch (e: any) {
        if (e?.code !== '42P01') throw e; // 42P01 = tabela ainda não existe (banco vazio)
      }
      const applied = await migrate(); step(`migrations (${applied.join(', ') || 'nenhuma nova'})`);
      await loadSecrets();
      await seedOfficial(); step('seed oficial');
      await bootstrapAdmin(); step('administrador inicial');
      if (process.env.SEED_DEMO === 'true') {
        if (config.appEnv === 'production') console.warn('SEED_DEMO ignorado em produção.');
        else { await seedDemo(); step('dados de demonstração'); }
      }
      await run(`INSERT INTO system_settings (key, value, created_at) VALUES ('bootstrap_version', ?, ?)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value`, bootstrapKey(), nowIso());
      step('inicialização completa');
      return applied;
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/**
 * Administrador inicial: BOOTSTRAP_ADMIN_EMAIL / _NAME / _PASSWORD / _ROLES (segredos no painel da hospedagem).
 * Só cria se o e-mail ainda não existir — nunca altera senha ou perfis de conta existente.
 */
async function bootstrapAdmin() {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) return;
  if (await one('SELECT 1 FROM users WHERE email = ?', email)) return;
  const ok = passwordSchema.safeParse(password);
  if (!ok.success) { console.error('BOOTSTRAP_ADMIN_PASSWORD não atende à política de senha; administrador não criado.'); return; }
  const roles = (process.env.BOOTSTRAP_ADMIN_ROLES ?? 'ADMIN_ACADEMY,ADMIN_PRIME').split(',').map((r) => r.trim()).filter((r) => ROLES.includes(r as Role));
  const name = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || 'Administrador ONEMA';
  await tx(async () => {
    if (await one('SELECT 1 FROM users WHERE email = ?', email)) return;
    const id = uid(), now = nowIso();
    await run('INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?,?,?,?,?,?)', id, email, name, hashPassword(password), now, now);
    for (const r of roles) await run('INSERT INTO user_roles (user_id, role, granted_at) VALUES (?,?,?)', id, r, now);
    await run(`INSERT INTO audit_events (id, actor_id, action, subject_type, subject_id, occurred_at, meta_json) VALUES (?,?,?,?,?,?,?)`,
      uid(), null, 'BOOTSTRAP_ADMIN_CREATED', 'user', id, now, JSON.stringify({ roles }));
  });
}

/** APP_SECRET / PAYMENT_WEBHOOK_SECRET: variável de ambiente ou valor aleatório persistido no banco (gerado uma única vez). */
async function loadSecrets() {
  const get = async (key: string) => {
    await run('INSERT INTO system_settings (key, value, created_at) VALUES (?,?,?) ON CONFLICT (key) DO NOTHING', key, randomToken(48), nowIso());
    return (await one<{ value: string }>('SELECT value FROM system_settings WHERE key = ?', key))!.value;
  };
  if (!process.env.APP_SECRET) config.appSecret = await get('app_secret');
  if (!process.env.PAYMENT_WEBHOOK_SECRET) config.paymentWebhookSecret = await get('payment_webhook_secret');
}
