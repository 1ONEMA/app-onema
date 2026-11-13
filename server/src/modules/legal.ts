/**
 * Documentos institucionais publicados no app (Política de Privacidade v1.1, Termo LGPD do Especialista v1.0,
 * Termos de Uso v1.2 por perfil e Política de Cancelamento). Versões imutáveis; aceite registra versão e hash.
 * Campos societários ainda não informados pela ONEMA aparecem marcados como "a preencher".
 */
import { all, one, run } from '../db/db.ts';
import { nowIso, sha256, uid } from '../lib/util.ts';
import LEGAL from '../db/content/legal-2026-11.json';

export const PUBLIC_LEGAL_CODES = ['T1', 'T2', 'PRIV', 'TERMO_ESPECIALISTA', 'TERMOS_PACIENTE', 'TERMOS_ESPECIALISTA', 'TERMOS_ACADEMY', 'TERMOS_PRIME', 'CANCELAMENTO'] as const;

export async function loadLegalTexts() {
  const now = nowIso();
  let n = 0;
  for (const t of (LEGAL as any).texts) {
    const body = JSON.stringify({ title: t.title, sections: t.sections, source: (LEGAL as any).source });
    n += (await run(`INSERT INTO legal_texts (id, code, version, title, body, content_hash, rt_approved_at, legal_review, created_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT (code, version) DO NOTHING`, uid(), t.code, t.version, t.title, body, sha256(body), null, 'PENDENTE', now)).changes;
  }
  return n;
}

export async function recordAcceptance(userId: string, code: string, context: string) {
  const t = await one<any>('SELECT version, content_hash FROM legal_texts WHERE code = ? ORDER BY created_at DESC, version DESC LIMIT 1', code);
  if (!t) return null;
  await run('INSERT INTO legal_acceptances (id, user_id, code, version, content_hash, context, accepted_at) VALUES (?,?,?,?,?,?,?)', uid(), userId, code, t.version, t.content_hash, context, nowIso());
  return t.version;
}

export async function acceptancesOf(userId: string) {
  return await all<any>('SELECT code, version, context, accepted_at FROM legal_acceptances WHERE user_id = ? ORDER BY accepted_at DESC', userId);
}
