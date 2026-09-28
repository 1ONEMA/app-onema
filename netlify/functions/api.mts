/**
 * ONEMA SAÚDE — API como Netlify Function (v2).
 * Reaproveita o mesmo app Fastify do servidor local; cada requisição é repassada via `fastify.inject`.
 * Banco: Netlify DB (Neon Postgres) em NETLIFY_DATABASE_URL (ou DATABASE_URL). Mídia: Netlify Blobs.
 */
import type { Config, Context } from '@netlify/functions';
import type { FastifyInstance } from 'fastify';

let appPromise: Promise<FastifyInstance> | null = null;

async function getApp(siteUrl: string | undefined) {
  if (!appPromise) {
    appPromise = (async () => {
      // Padrões seguros para o ambiente publicado (valores do painel da Netlify têm precedência).
      process.env.APP_ENV ??= 'homologacao';
      if (siteUrl) process.env.PUBLIC_ORIGIN ??= siteUrl;
      const { ensureReady } = await import('../../server/src/bootstrap.ts');
      const { assertProductionConfig } = await import('../../server/src/config.ts');
      const { buildApp } = await import('../../server/src/app.ts');
      await ensureReady();
      assertProductionConfig();
      const app = await buildApp({ trustProxy: false });
      await app.ready();
      return app;
    })().catch((e) => { appPromise = null; throw e; });
  }
  return appPromise;
}

export default async (req: Request, context: Context) => {
  let app: FastifyInstance;
  try {
    app = await getApp(context.site?.url);
  } catch (e: any) {
    console.error('Falha ao inicializar a API:', e?.message);
    const noDb = !process.env.NETLIFY_DATABASE_URL && !process.env.DATABASE_URL;
    return Response.json({ error: {
      code: noDb ? 'DATABASE_NOT_CONFIGURED' : 'API_INIT_FAILED',
      message: noDb
        ? 'O banco de dados ainda não foi configurado neste site (Netlify DB). A API não pode operar sem persistência.'
        : 'Não foi possível iniciar a API. Tente novamente em instantes.',
    } }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
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
  return new Response(req.method === 'HEAD' || res.statusCode === 204 ? null : new Uint8Array(res.rawPayload), { status: res.statusCode, headers: out });
};

export const config: Config = { path: '/api/*' };
