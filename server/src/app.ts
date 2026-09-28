import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.ts';
import { loadSession, sendError } from './lib/context.ts';
import { AppError, forbidden } from './lib/errors.ts';
import { uid } from './lib/util.ts';
import { academyAdminRoutes } from './modules/academy/admin.ts';
import { academyRoutes } from './modules/academy/routes.ts';
import { adminRoutes } from './modules/admin/routes.ts';
import { authRoutes } from './modules/auth/routes.ts';
import { primeAdminRoutes } from './modules/prime/admin.ts';
import { primeRoutes } from './modules/prime/routes.ts';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp(opts: { serveWeb?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.isTest ? false : {
      level: config.isProd ? 'info' : 'debug',
      // Nunca registrar cookies, credenciais ou corpo de requisições (dados sensíveis)
      redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'],
    },
    trustProxy: config.isProd,
    bodyLimit: 1_000_000,
    genReqId: () => uid(),
  });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 500 * 1024 * 1024, files: 1 } });

  app.decorateRequest('auth', null);
  app.decorateRequest('correlationId', '');

  app.addHook('onRequest', async (req, reply) => {
    const incoming = String(req.headers['x-correlation-id'] ?? '');
    req.correlationId = /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : req.id;
    reply.header('X-Correlation-Id', req.correlationId);
    if (req.url.startsWith('/api/')) {
      req.auth = loadSession(req);
      reply.header('Cache-Control', 'no-store');
    }
  });

  // CSRF: Origin permitido + token de sessão em toda mutação autenticada (ACA-T036)
  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/') || !MUTATING.has(req.method)) return;
    const origin = req.headers.origin;
    if (origin && !config.allowedOrigins.includes(origin) && origin !== config.publicOrigin) {
      throw forbidden('Origem da requisição não permitida.', 'BAD_ORIGIN');
    }
    if (req.routeOptions.config?.public) return;
    if (req.auth) {
      const token = String(req.headers['x-csrf-token'] ?? '');
      if (!token || token !== req.auth.csrf) throw forbidden('Sessão inválida para esta operação. Recarregue a página.', 'CSRF');
    }
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (config.isProd) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    return payload;
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) return sendError(reply, err, req.correlationId);
    if (err?.statusCode && err.statusCode < 500) {
      return sendError(reply, new AppError(err.statusCode, err.code ?? 'BAD_REQUEST', 'Requisição inválida.'), req.correlationId);
    }
    req.log.error({ err: { message: err?.message, code: err?.code }, correlationId: req.correlationId }, 'unhandled error');
    return sendError(reply, new AppError(500, 'INTERNAL', 'Erro inesperado. Tente novamente em instantes.'), req.correlationId);
  });

  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(academyRoutes);
  await app.register(academyAdminRoutes);
  await app.register(primeRoutes);
  await app.register(primeAdminRoutes);

  app.get('/api/health', async () => ({ ok: true }));

  // Em produção o mesmo servidor entrega o PWA compilado (web/dist) com fallback SPA.
  const dist = path.resolve('web/dist');
  if (opts.serveWeb && fs.existsSync(dist)) {
    await app.register(fastifyStatic, {
      root: dist, wildcard: false, index: false, cacheControl: false,
      setHeaders: (res: any, file: string) => {
        const set = (k: string, v: string) => (typeof res.setHeader === 'function' ? res.setHeader(k, v) : res.header(k, v));
        if (file.endsWith('sw.js') || file.endsWith('.webmanifest') || file.endsWith('index.html')) set('Cache-Control', 'no-cache');
        else if (file.includes(`${path.sep}assets${path.sep}`)) set('Cache-Control', 'public, max-age=31536000, immutable');
        else set('Cache-Control', 'public, max-age=86400');
      },

    });
    const indexHtml = fs.readFileSync(path.join(dist, 'index.html'));
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return sendError(reply, new AppError(404, 'NOT_FOUND', 'Rota inexistente.'), req.correlationId);
      const file = path.join(dist, decodeURIComponent(req.url.split('?')[0]));
      if (file.startsWith(dist) && fs.existsSync(file) && fs.statSync(file).isFile()) return reply.sendFile(path.relative(dist, file));
      reply.header('Cache-Control', 'no-cache').type('text/html').send(indexHtml);
    });
  } else {
    app.setNotFoundHandler((req, reply) => sendError(reply, new AppError(404, 'NOT_FOUND', 'Rota inexistente.'), req.correlationId));
  }
  return app;
}
