/**
 * Inicialização idempotente do banco (executada no primeiro uso de cada instância):
 * migrations, seed oficial, administrador inicial por variáveis de ambiente e, opcionalmente, dados de demonstração.
 */
import { config } from './config.ts';
import { all, one, run, tx } from './db/db.ts';
import { migrate, pendingMigrations } from './db/migrate.ts';
import { seedDemo, seedOfficial } from './db/seed.ts';
import { ROLES, type Role } from './lib/roles.ts';
import { hashPassword } from './lib/security.ts';
import { nowIso, randomToken, uid } from './lib/util.ts';
import { passwordSchema } from './modules/auth/routes.ts';

let ready: Promise<string[]> | null = null;

/** Versão da inicialização: quando igual à gravada no banco, a partida da Function só faz 3–4 consultas. */
const BOOTSTRAP_VERSION = '2026-09-29.1';
const bootstrapKey = () => `${BOOTSTRAP_VERSION}${process.env.SEED_DEMO === 'true' ? '+demo' : ''}`;

/** A inicialização ainda não terminou nesta requisição (o progresso fica salvo; a próxima continua). */
export class InitPendingError extends Error {
  constructor(public stepsDone: string[], public stepsLeft: string[]) {
    super(`Banco de dados em preparação (${stepsDone.length}/${stepsDone.length + stepsLeft.length} etapas).`);
  }
}

export interface ReadyOptions {
  /** Instante (ms epoch) em que a requisição precisa ter terminado. Sem valor: sem limite (build/CLI). */
  deadline?: number;
}

/** Custo estimado de cada etapa em idas e voltas ao banco (usado com a latência medida). */
const STEP_COST: Record<string, number> = {
  'migrations': 10, 'segredos': 5, 'seed oficial': 14, 'administrador inicial': 7,
  'demonstração: usuários e catálogo': 8, 'demonstração: Academy': 18,
};

export function ensureReady(opts: ReadyOptions = {}): Promise<string[]> {
  if (!ready) {
    ready = runInit(opts).catch((e) => { ready = null; throw e; });
  }
  return ready;
}

async function runInit(opts: ReadyOptions): Promise<string[]> {
  const t0 = Date.now();
  const log = (name: string) => console.log(`[bootstrap] ${name} em ${Date.now() - t0} ms`);
  // Uma consulta: versão concluída + progresso parcial (etapas já feitas em requisições anteriores).
  let settings = new Map<string, string>();
  try {
    settings = new Map((await all<any>(`SELECT key, value FROM system_settings WHERE key IN ('bootstrap_version', 'bootstrap_progress', 'app_secret', 'payment_webhook_secret')`))
      .map((r) => [r.key, r.value]));
  } catch (e: any) {
    if (e?.code !== '42P01') throw e; // 42P01 = tabela ainda não existe (banco vazio)
  }
  if (settings.get('bootstrap_version') === bootstrapKey()) {
    await loadSecrets(settings);
    await bootstrapAdmin();
    log('caminho rápido concluído');
    return [];
  }
  // Latência medida (1 ida e volta) para decidir se a próxima etapa cabe no tempo restante.
  const tr = Date.now(); await one('SELECT 1 AS ok'); const rtt = Math.max(5, Date.now() - tr);
  let doneThisRequest = 0;
  const fits = (name: string) => !opts.deadline || doneThisRequest === 0 || Date.now() + (STEP_COST[name] ?? 10) * rtt * 1.3 + 300 < opts.deadline;
  const canContinue = () => fits('migrations');
  const demo = process.env.SEED_DEMO === 'true' && config.appEnv !== 'production';
  if (process.env.SEED_DEMO === 'true' && !demo) console.warn('SEED_DEMO ignorado em produção.');
  let progress: string[] = [];
  try { const p = JSON.parse(settings.get('bootstrap_progress') ?? '{}'); if (p.key === bootstrapKey()) progress = p.done ?? []; } catch { /* ignora */ }
  const steps: [string, () => Promise<unknown>][] = [
    ['migrations', async () => {
      const applied = await migrate(canContinue);
      if ((await pendingMigrations()).length) throw new InitPendingError(['migrations parciais'], ['migrations']);
      return applied;
    }],
    ['segredos', () => loadSecrets(new Map())],
    ['seed oficial', seedOfficial],
    ['administrador inicial', bootstrapAdmin],
    ...(demo ? [['demonstração: usuários e catálogo', () => seedDemo('base')], ['demonstração: Academy', () => seedDemo('academy')]] as [string, () => Promise<unknown>][] : []),
  ];
  let applied: string[] = [];
  for (const [name, fn] of steps) {
    if (progress.includes(name)) {
      if (name === 'segredos') await loadSecrets(settings);
      continue;
    }
    if (!fits(name)) throw new InitPendingError(progress, steps.map(([n]) => n).filter((n) => !progress.includes(n)));
    const r = await fn();
    doneThisRequest++;
    if (name === 'migrations') applied = r as string[];
    progress.push(name);
    await run(`INSERT INTO system_settings (key, value, created_at) VALUES ('bootstrap_progress', ?, ?)
               ON CONFLICT (key) DO UPDATE SET value = excluded.value`, JSON.stringify({ key: bootstrapKey(), done: progress }), nowIso());
    log(name);
  }
  await run(`INSERT INTO system_settings (key, value, created_at) VALUES ('bootstrap_version', ?, ?)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value`, bootstrapKey(), nowIso());
  log('inicialização completa');
  return applied;
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
async function loadSecrets(known: Map<string, string>) {
  const get = async (key: string) => {
    if (known.get(key)) return known.get(key)!;
    await run('INSERT INTO system_settings (key, value, created_at) VALUES (?,?,?) ON CONFLICT (key) DO NOTHING', key, randomToken(48), nowIso());
    return (await one<{ value: string }>('SELECT value FROM system_settings WHERE key = ?', key))!.value;
  };
  if (!process.env.APP_SECRET) config.appSecret = await get('app_secret');
  if (!process.env.PAYMENT_WEBHOOK_SECRET) config.paymentWebhookSecret = await get('payment_webhook_secret');
}
