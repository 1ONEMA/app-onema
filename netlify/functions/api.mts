/**
 * ONEMA SAÚDE — API como Netlify Function (v2).
 * Reaproveita o mesmo app Fastify do servidor local; cada requisição é repassada via `fastify.inject`.
 * Banco: Netlify DB (Neon Postgres) em NETLIFY_DATABASE_URL (ou DATABASE_URL). Mídia: Netlify Blobs.
 */
import type { Config, Context } from '@netlify/functions';
import type { FastifyInstance } from 'fastify';

let appPromise: Promise<FastifyInstance> | null = null;
/** Orçamento da requisição (limite da Netlify: 10 s): etapas só começam se a estimativa couber até aqui. */
const INIT_BUDGET_MS = 8000;

function applyDefaults(siteUrl: string | undefined) {
  // Padrões seguros para o ambiente publicado (valores do painel da Netlify têm precedência).
  process.env.APP_ENV ??= 'homologacao';
  if (siteUrl) process.env.PUBLIC_ORIGIN ??= siteUrl;
  process.env.DB_CONNECT_TIMEOUT_MS ??= '4000';
}

async function getApp(siteUrl: string | undefined, started: number) {
  applyDefaults(siteUrl);
  const { ensureReady } = await import('../../server/src/bootstrap.ts');
  await ensureReady({ deadline: started + INIT_BUDGET_MS });
  if (!appPromise) {
    appPromise = (async () => {
      const { assertProductionConfig } = await import('../../server/src/config.ts');
      const { buildApp } = await import('../../server/src/app.ts');
      assertProductionConfig();
      const app = await buildApp({ trustProxy: false });
      await app.ready();
      return app;
    })().catch((e) => { appPromise = null; throw e; });
  }
  return appPromise;
}

/** Diagnóstico sem dados sensíveis: não depende da inicialização completa. */
async function health(siteUrl: string | undefined) {
  applyDefaults(siteUrl);
  const info: Record<string, unknown> = {
    ok: false,
    runtime: process.version,
    databaseConfigured: !!(process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL),
    adminBootstrapConfigured: !!(process.env.BOOTSTRAP_ADMIN_EMAIL && process.env.BOOTSTRAP_ADMIN_PASSWORD),
    seedDemo: process.env.SEED_DEMO === 'true',
  };
  if (!info.databaseConfigured) return Response.json({ ...info, problem: 'NETLIFY_DATABASE_URL não definida' }, { status: 503 });
  try {
    const { one } = await import('../../server/src/db/db.ts');
    const t = Date.now();
    await one('SELECT 1 AS ok');
    info.dbLatencyMs = Date.now() - t;
    try {
      const v = await one<any>(`SELECT value FROM system_settings WHERE key = 'bootstrap_version'`);
      info.initialized = !!v;
      info.bootstrapVersion = v?.value ?? null;
    } catch (e: any) {
      info.initialized = false;
      info.bootstrapVersion = e?.code === '42P01' ? 'banco vazio' : `erro ${e?.code ?? ''}`;
    }
    info.ok = true;
    return Response.json(info, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return Response.json({ ...info, problem: `falha ao conectar no banco: ${e?.code ?? ''} ${String(e?.message ?? '').slice(0, 200)}` }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}

const json = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status, headers: { 'Cache-Control': 'no-store' } });

function describeInitError(e: any) {
  const noDb = !process.env.NETLIFY_DATABASE_URL && !process.env.DATABASE_URL;
  if (noDb) return json(503, 'DATABASE_NOT_CONFIGURED', 'O banco de dados ainda não foi configurado neste site (Netlify DB). A API não pode operar sem persistência.');
  const msg = String(e?.message ?? '');
  if (/timeout|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|terminated|Connection/i.test(msg)) {
    return json(503, 'DATABASE_UNREACHABLE', 'Não foi possível conectar ao banco de dados agora. Aguarde alguns segundos e tente novamente.');
  }
  return json(503, 'API_INIT_FAILED', 'Não foi possível iniciar a API. Tente novamente em instantes.');
}

export default async (req: Request, context: Context) => {
  const started = Date.now();
  if (new URL(req.url).pathname === '/api/health') return health(context.site?.url);
  let app: FastifyInstance;
  try {
    app = await getApp(context.site?.url, started);
  } catch (e: any) {
    if (e?.name === 'InitPendingError' || e?.constructor?.name === 'InitPendingError' || /em preparação/.test(String(e?.message))) {
      console.warn(`[api] ${e.message} Próximas etapas: ${(e.stepsLeft ?? []).join(', ')}`);
      return json(503, 'INITIALIZING', `${e.message} Recarregue a página em alguns segundos.`);
    }
    console.error(`[api] falha na inicialização após ${Date.now() - started} ms:`, e?.code ?? '', e?.message, e?.stack);
    return describeInitError(e);
  }
  try {
    const url = new URL(req.url);
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k] = v; });
    const res = await app.inject({
      method: req.method as any,
      url: url.pathname + url.search,
      headers,
      payload: hasBody ? Buffer.from(await req.arrayBuffer()) : undefined,
      remoteAddress: context.ip,
    });
    const out = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      if (v == null || k === 'content-length' || k === 'transfer-encoding' || k === 'connection') continue;
      if (Array.isArray(v)) v.forEach((x) => out.append(k, String(x)));
      else out.set(k, String(v));
    }
    const ms = Date.now() - started;
    if (ms > 4000) console.warn(`[api] ${req.method} ${url.pathname} levou ${ms} ms`);
    return new Response(req.method === 'HEAD' || res.statusCode === 204 ? null : new Uint8Array(res.rawPayload), { status: res.statusCode, headers: out });
  } catch (e: any) {
    console.error('[api] erro não tratado:', e?.message, e?.stack);
    return json(500, 'INTERNAL', 'Erro inesperado. Tente novamente em instantes.');
  }
};

export const config: Config = { path: '/api/*' };
