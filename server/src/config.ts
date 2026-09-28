import path from 'node:path';

function bool(v: string | undefined, def: boolean) {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

const env = process.env.NODE_ENV ?? 'development';
const isProd = env === 'production';

export const config = {
  env,
  isProd,
  isTest: env === 'test',
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '127.0.0.1',
  /** Caminho do banco SQLite. ":memory:" nos testes. */
  databasePath: process.env.DATABASE_PATH ?? path.resolve('data/onema.sqlite'),
  /** Armazenamento privado de mídia da Academy (fora da pasta pública). */
  mediaDir: process.env.MEDIA_DIR ?? path.resolve('data/media'),
  /** Origem pública do app (usada no QR do certificado e na checagem de Origin). */
  publicOrigin: process.env.PUBLIC_ORIGIN ?? 'http://localhost:5173',
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:8787,http://127.0.0.1:8787')
    .split(',').map((s) => s.trim()).filter(Boolean),
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 12),
  /** Segredo usado para assinar URLs temporárias de mídia e webhooks sandbox. Obrigatório em produção. */
  appSecret: process.env.APP_SECRET ?? (isProd ? '' : 'dev-only-secret-change-me'),
  /** Segredo do webhook de pagamento (provedor real ainda não definido - P-009). */
  paymentWebhookSecret: process.env.PAYMENT_WEBHOOK_SECRET ?? (isProd ? '' : 'dev-only-webhook-secret'),
  /** MFA obrigatório para perfis administrativos (Documento Mestre Academy 11.1). */
  requireAdminMfa: bool(process.env.REQUIRE_ADMIN_MFA, true),
  /** Pagamentos simulados. Única modalidade autorizada até os gates de produção. */
  paymentProvider: (process.env.PAYMENT_PROVIDER ?? 'SANDBOX') as 'SANDBOX',
  /** WhatsApp permanece desligado até integração oficial validada (PRIME T3). */
  whatsappEnabled: bool(process.env.WHATSAPP_ENABLED, false),
  /** Política comercial Academy: matrícula exige pedido PAGO (P-009 - confirmar). */
  academyRequirePayment: bool(process.env.ACADEMY_REQUIRE_PAYMENT, true),
  academyFeeCents: 1990,
  journeyVersion: 'JORNADA_INTEGRACAO_V1',
  /** Validade provisória do convite ao responsável (não definida na fonte). */
  shareInviteTtlDays: Number(process.env.SHARE_INVITE_TTL_DAYS ?? 7),
  passwordResetTtlMinutes: 30,
};

export function assertProductionConfig() {
  if (!config.isProd) return;
  const missing: string[] = [];
  if (!config.appSecret || config.appSecret.length < 32) missing.push('APP_SECRET (>=32 caracteres)');
  if (!config.paymentWebhookSecret) missing.push('PAYMENT_WEBHOOK_SECRET');
  if (missing.length) throw new Error(`Configuração de produção incompleta: ${missing.join(', ')}`);
}
