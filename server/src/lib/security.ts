import crypto from 'node:crypto';
import { config } from '../config.ts';

// ---- Senhas (scrypt, parâmetros explícitos, sal por usuário) ----
// OWASP Password Storage: scrypt com N ≥ 2^17, r = 8, p = 1 (testes automatizados usam custo menor só por velocidade).
const N = config.isTest ? 16384 : 131072, r = 8, p = 1, KEYLEN = 64;
const MAXMEM = 256 * 1024 * 1024;
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, KEYLEN, { N, r, p, maxmem: MAXMEM });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, rr, pp, s, k] = parts;
  if (+n > 1048576 || +rr > 16 || +pp > 4) return false;
  const expected = Buffer.from(k, 'base64');
  const got = crypto.scryptSync(password, Buffer.from(s, 'base64'), expected.length, { N: +n, r: +rr, p: +pp, maxmem: MAXMEM });
  return crypto.timingSafeEqual(expected, got);
}
/** Hash gravado com custo abaixo do atual: é refeito no próximo login bem-sucedido. */
export const needsRehash = (stored: string) => Number(stored.split('$')[1] ?? 0) < N;
/** Hash fictício para equalizar tempo de resposta quando o e-mail não existe. */
export const DUMMY_HASH = hashPassword('dummy-password-for-timing');

// ---- TOTP (RFC 6238, SHA-1, 30s, 6 dígitos) para MFA administrativo ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string) {
  const clean = s.replace(/=+$/, '').toUpperCase();
  let bits = 0, value = 0; const out: number[] = [];
  for (const c of clean) {
    const idx = B32.indexOf(c); if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));
export function totp(secret: string, t = Date.now(), step = 30) {
  const counter = Math.floor(t / 1000 / step);
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
  return code;
}
export function verifyTotp(secret: string, code: string, t = Date.now()) {
  return totpStep(secret, code, t) >= 0;
}
/** Passo de tempo (janela de 30 s) que corresponde ao código, ou -1. Usado para impedir reuso do mesmo código. */
export function totpStep(secret: string, code: string, t = Date.now()) {
  if (!/^\d{6}$/.test(code)) return -1;
  for (const drift of [-1, 0, 1]) {
    const expected = totp(secret, t + drift * 30000);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return Math.floor((t + drift * 30000) / 30000);
  }
  return -1;
}

// ---- Assinaturas HMAC (URLs temporárias de mídia, webhook sandbox) ----
export function hmac(data: string, secret = config.appSecret) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}
// ---- Criptografia de campo (AES-256-GCM) para dados pessoais sensíveis, ex.: CPF ----
// Chave derivada do APP_SECRET (HKDF). Trocar o APP_SECRET exige recriptografar estes campos.
const fieldKey = () => Buffer.from(crypto.hkdfSync('sha256', config.appSecret, Buffer.alloc(0), 'onema-field-v1', 32));
export function sealField(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', fieldKey(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `enc1:${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${ct.toString('base64url')}`;
}
/** Abre um campo selado; valores antigos em texto puro são devolvidos como estão. */
export function openField(v: string): string {
  if (!v?.startsWith('enc1:')) return v;
  const [, iv, tag, ct] = v.split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', fieldKey(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
/** Índice de busca/unicidade sem guardar o valor (HMAC com finalidade própria). */
export const lookupHash = (purpose: string, v: string) => hmac(`${purpose}:${v}`);

export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// ---- Rate limit compartilhado (tabela rate_limits), válido entre instâncias serverless ----
import { run as dbRun, one as dbOne } from '../db/db.ts';
export async function rateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
  const now = Date.now();
  const start = now - (now % windowMs);
  await dbRun(`INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
    ON CONFLICT (key) DO UPDATE SET count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
    window_start = excluded.window_start`, key, start);
  const r = await dbOne<{ count: number }>('SELECT count FROM rate_limits WHERE key = ?', key);
  return (r?.count ?? 0) <= limit;
}
export async function resetRateLimits() { await dbRun('DELETE FROM rate_limits'); }
