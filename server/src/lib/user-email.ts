/**
 * E-mail transacional para um usuário (link de acesso, sem conteúdo clínico). Registrado na fila de saída;
 * sem provedor configurado, fica registrado como não enviado e o aviso continua no app.
 */
import { one, run } from '../db/db.ts';
import { config } from '../config.ts';
import { emailConfigured, layout, sendEmail } from './email.ts';
import { nowIso, uid } from './util.ts';

export async function emailUser(userId: string, template: string, subject: string, paragraphs: string[], cta: { label: string; path: string }) {
  const u = await one<any>('SELECT email, name FROM users WHERE id = ?', userId);
  if (!u?.email) return { sent: false };
  const id = uid();
  await run(`INSERT INTO outbox_messages (id, channel, purpose, recipient_user_id, recipient_address, template, payload_json, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    id, 'EMAIL', 'ESSENCIAL', userId, u.email, template, JSON.stringify({ path: cta.path }), emailConfigured() ? 'PENDENTE' : 'NAO_ENVIADO_SEM_PROVEDOR', nowIso());
  if (!emailConfigured()) return { sent: false };
  const m = layout(subject, [`Olá, ${String(u.name ?? '').split(' ')[0] || 'tudo bem'}.`, ...paragraphs], { label: cta.label, url: `${config.publicOrigin}${cta.path}` });
  const r = await sendEmail({ to: u.email, subject: `ONEMA SAÚDE · ${subject}`, ...m });
  await run('UPDATE outbox_messages SET status = ? WHERE id = ?', r.sent ? 'ENVIADO' : `FALHA_${r.error}`, id);
  return r;
}
