import { one, run } from '../db/db.ts';
import { hashObj, nowIso, uid } from './util.ts';

export interface AuditInput {
  actorId: string | null;
  action: string;
  subjectType: string;
  subjectId?: string | null;
  before?: unknown;
  after?: unknown;
  correlationId?: string | null;
  /** Metadados mínimos: nunca incluir respostas, gabarito, senha ou conteúdo clínico. */
  meta?: Record<string, unknown>;
}

export function audit(e: AuditInput) {
  const seq = (one<{ s: number }>('SELECT COALESCE(MAX(seq),0)+1 AS s FROM audit_events')!).s;
  run(
    `INSERT INTO audit_events (id, seq, actor_id, action, subject_type, subject_id, before_hash, after_hash, correlation_id, meta_json, occurred_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    uid(), seq, e.actorId, e.action, e.subjectType, e.subjectId ?? null,
    e.before === undefined ? null : hashObj(e.before),
    e.after === undefined ? null : hashObj(e.after),
    e.correlationId ?? null,
    e.meta ? JSON.stringify(e.meta) : null,
    nowIso(),
  );
}
