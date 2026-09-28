import crypto from 'node:crypto';

export const uid = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();
export const sha256 = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** Protocolo legível: PRE-AAAAMMDD-XXXXXX */
export function protocol(prefix: string) {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const r = crypto.randomBytes(4).readUInt32BE(0).toString(36).toUpperCase().padStart(7, '0').slice(0, 7);
  return `${prefix}-${d}-${r}`;
}

/** Soma meses preservando o dia quando possível (ciclo mensal). */
export function addMonths(iso: string, months: number) {
  const d = new Date(iso);
  const day = d.getUTCDate();
  const r = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, last));
  return r.toISOString();
}
export const addDays = (iso: string, days: number) => new Date(new Date(iso).getTime() + days * 86400000).toISOString();
export const addHours = (iso: string, h: number) => new Date(new Date(iso).getTime() + h * 3600000).toISOString();

/** Formatação BRL para textos de confirmação gerados no servidor. */
export const brl = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/ /g, ' ');

export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as any)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
export const hashObj = (v: unknown) => sha256(stableJson(v));

export function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
