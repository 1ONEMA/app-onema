/**
 * Solicitação de cuidado — complementos da jornada (ONEMA-JOR-001 e ajustes de 05/11/2026):
 *  - Anexos do paciente/responsável (pedido médico, exame): armazenamento privado; a especialista só vê
 *    depois de aceitar o atendimento, somente leitura, com acesso auditado.
 *  - Orientação de materiais: o paciente pede orientação (sem cotação, sem bloquear pagamento); a especialista
 *    designada ou a Central envia lista e links; o paciente confirma que providenciou (estados separados).
 */
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, one, run } from '../../db/db.ts';
import { audit } from '../../lib/audit.ts';
import { hasRole, parse, requireRoles } from '../../lib/context.ts';
import { AppError, badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.ts';
import { getObject, putObject } from '../../lib/storage.ts';
import { rateLimit } from '../../lib/security.ts';
import { nowIso, sha256, uid } from '../../lib/util.ts';
import { notify } from '../prime/core.ts';
import { sniffDocMime } from '../specialist/routes.ts';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_DOCS = 10;
const idParam = z.object({ id: z.string().uuid() });
const docParam = z.object({ id: z.string().uuid(), docId: z.string().uuid() });
export const DOC_KIND_LABEL: Record<string, string> = { PEDIDO_MEDICO: 'Pedido médico / prescrição', EXAME: 'Exame', OUTRO: 'Outro documento' };

export async function requestDocuments(requestId: string) {
  return await all<any>(`SELECT id, kind, filename, mime, size_bytes, created_at FROM care_request_documents WHERE request_id = ? AND deleted_at IS NULL ORDER BY created_at`, requestId);
}

function sendDoc(reply: any, d: any, buf: Buffer) {
  reply.header('Content-Type', d.mime).header('Content-Disposition', `inline; filename="${encodeURIComponent(d.filename)}"`)
    .header('Cache-Control', 'private, no-store').header('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  return reply.send(buf);
}

async function readDoc(d: any) {
  const buf = await getObject(d.storage_key);
  if (!buf || sha256(buf) !== d.sha256) throw conflict('DOCUMENT_INTEGRITY', 'O arquivo armazenado não confere com o enviado. Peça um novo envio.');
  return buf;
}

export async function requestExtrasRoutes(app: FastifyInstance) {
  // ---------- Paciente / responsável (quem fez a solicitação) ----------
  async function ownRequest(req: any, id: string) {
    const a = requireRoles(req, ['PACIENTE']);
    const r = await one<any>('SELECT * FROM care_requests WHERE id = ?', id);
    if (!r || r.requester_id !== a.userId) throw notFound('Solicitação não encontrada.');
    return { a, r };
  }

  app.get('/api/care/requests/:id/documents', async (req) => {
    const { id } = parse(idParam, req.params);
    await ownRequest(req, id);
    return { documents: await requestDocuments(id) };
  });

  app.post('/api/care/requests/:id/documents', async (req) => {
    const { id } = parse(idParam, req.params);
    const { a, r } = await ownRequest(req, id);
    if (r.status === 'DESISTENCIA') throw conflict('REQUEST_CLOSED', 'Esta solicitação foi encerrada.');
    if (!await rateLimit(`care-doc:${a.userId}`, 30, 3600_000)) throw new AppError(429, 'RATE_LIMIT', 'Muitos envios em pouco tempo. Aguarde um pouco.');
    const fields: Record<string, string> = {};
    let file: { filename: string; buf: Buffer } | null = null;
    for await (const p of req.parts({ limits: { fileSize: MAX_BYTES + 1, files: 1 } })) {
      if (p.type === 'file') file = { filename: p.filename, buf: await p.toBuffer() };
      else fields[p.fieldname] = String(p.value);
    }
    const { kind } = parse(z.object({ kind: z.enum(['PEDIDO_MEDICO', 'EXAME', 'OUTRO']).default('PEDIDO_MEDICO') }), fields);
    if (!file || !file.buf.length) throw badRequest('FILE_REQUIRED', 'Selecione um arquivo.');
    if (file.buf.length > MAX_BYTES) throw badRequest('FILE_TOO_LARGE', 'O arquivo deve ter no máximo 5 MB.');
    const mime = sniffDocMime(file.buf);
    if (!mime) throw badRequest('FILE_TYPE', 'Envie PDF, JPG, PNG ou WEBP (foto do pedido serve).');
    if ((await requestDocuments(id)).length >= MAX_DOCS) throw unprocessable('TOO_MANY_DOCUMENTS', `Limite de ${MAX_DOCS} documentos por solicitação.`);
    const docId = uid(), key = `care-request-doc-${docId}`;
    await putObject(key, file.buf);
    await run(`INSERT INTO care_request_documents (id, request_id, uploaded_by, kind, filename, mime, size_bytes, sha256, storage_key, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      docId, id, a.userId, kind, path.basename(file.filename).slice(0, 150), mime, file.buf.length, sha256(file.buf), key, nowIso());
    await audit({ actorId: a.userId, action: 'CARE_REQUEST_DOCUMENT_UPLOADED', subjectType: 'care_request', subjectId: id, correlationId: req.correlationId, meta: { kind } });
    return { documents: await requestDocuments(id) };
  });

  app.get('/api/care/requests/:id/documents/:docId', async (req, reply) => {
    const { id, docId } = parse(docParam, req.params);
    await ownRequest(req, id);
    const d = await one<any>('SELECT * FROM care_request_documents WHERE id = ? AND request_id = ? AND deleted_at IS NULL', docId, id);
    if (!d) throw notFound('Documento não encontrado.');
    return sendDoc(reply, d, await readDoc(d));
  });

  /** Remover só antes de o pedido ser gerado (depois, o documento faz parte do registro do atendimento). */
  app.delete('/api/care/requests/:id/documents/:docId', async (req) => {
    const { id, docId } = parse(docParam, req.params);
    const { a, r } = await ownRequest(req, id);
    if (r.status === 'PEDIDO_GERADO') throw conflict('REQUEST_LOCKED', 'Depois do pagamento o documento fica no registro do atendimento. Fale com a Central para corrigir.');
    const res = await run('UPDATE care_request_documents SET deleted_at = ? WHERE id = ? AND request_id = ? AND deleted_at IS NULL', nowIso(), docId, id);
    if (!res.changes) throw notFound('Documento não encontrado.');
    await audit({ actorId: a.userId, action: 'CARE_REQUEST_DOCUMENT_REMOVED', subjectType: 'care_request', subjectId: id, correlationId: req.correlationId });
    return { documents: await requestDocuments(id) };
  });

  app.post('/api/care/requests/:id/materials-confirmed', async (req) => {
    const { id } = parse(idParam, req.params);
    const { a, r } = await ownRequest(req, id);
    if (r.guidance_status === 'NAO_APLICAVEL') throw conflict('NO_GUIDANCE', 'Esta solicitação não tem orientação de materiais.');
    await run(`UPDATE care_requests SET guidance_status = 'MATERIAIS_CONFIRMADOS', materials_confirmed_at = ?, updated_at = ? WHERE id = ?`, nowIso(), nowIso(), id);
    await audit({ actorId: a.userId, action: 'CARE_MATERIALS_CONFIRMED', subjectType: 'care_request', subjectId: id, correlationId: req.correlationId });
    return { ok: true };
  });

  // ---------- Especialista (só depois do aceite) ----------
  async function acceptedEvent(req: any, eventId: string) {
    const a = requireRoles(req, ['ESPECIALISTA']);
    const e = await one<any>(`SELECT e.id, e.status, o.request_id FROM care_events e JOIN service_orders o ON o.id = e.order_id
      WHERE e.id = ? AND e.specialist_id = ? AND e.status IN ('ACEITO','CONCLUIDO')`, eventId, a.userId);
    if (!e || !e.request_id) throw notFound('Atendimento não encontrado.');
    return { a, e };
  }

  app.get('/api/care/specialist/events/:id/documents', async (req) => {
    const { id } = parse(idParam, req.params);
    const { e } = await acceptedEvent(req, id);
    const r = (await one<any>('SELECT guidance_status, guidance_text, guidance_at, materials, materials_detail, materials_confirmed_at FROM care_requests WHERE id = ?', e.request_id))!;
    return { requestId: e.request_id, documents: await requestDocuments(e.request_id), guidance: { status: r.guidance_status, text: r.guidance_text, at: r.guidance_at, materialsConfirmedAt: r.materials_confirmed_at, materials: r.materials, materialsDetail: r.materials_detail } };
  });

  app.get('/api/care/specialist/events/:id/documents/:docId', async (req, reply) => {
    const { id, docId } = parse(docParam, req.params);
    const { a, e } = await acceptedEvent(req, id);
    const d = await one<any>('SELECT * FROM care_request_documents WHERE id = ? AND request_id = ? AND deleted_at IS NULL', docId, e.request_id);
    if (!d) throw notFound('Documento não encontrado.');
    await audit({ actorId: a.userId, action: 'CARE_REQUEST_DOCUMENT_VIEWED', subjectType: 'care_request', subjectId: e.request_id, correlationId: req.correlationId, meta: { kind: d.kind } });
    return sendDoc(reply, d, await readDoc(d));
  });

  /** Orientação de materiais: especialista designada (atendimento aceito) ou Central. */
  app.post('/api/care/requests/:id/guidance', async (req) => {
    const a = requireRoles(req, ['ESPECIALISTA', 'OPERADOR_CENTRAL', 'AVALIADOR_RT']);
    const { id } = parse(idParam, req.params);
    const { text } = parse(z.object({ text: z.string().trim().min(10, 'Escreva a lista de materiais e, se quiser, links para compra.').max(3000) }), req.body);
    const r = await one<any>('SELECT * FROM care_requests WHERE id = ?', id);
    if (!r) throw notFound('Solicitação não encontrada.');
    if (!hasRole(a, 'OPERADOR_CENTRAL') && !hasRole(a, 'AVALIADOR_RT')) {
      const ok = await one(`SELECT 1 AS ok FROM care_events e JOIN service_orders o ON o.id = e.order_id WHERE o.request_id = ? AND e.specialist_id = ? AND e.status IN ('ACEITO','CONCLUIDO')`, id, a.userId);
      if (!ok) throw forbidden('A orientação é enviada pela especialista que aceitou o atendimento ou pela Central.');
    }
    if (r.guidance_status === 'NAO_APLICAVEL') throw conflict('NO_GUIDANCE', 'Esta solicitação não pediu orientação de materiais.');
    const now = nowIso();
    await run(`UPDATE care_requests SET guidance_status = CASE WHEN guidance_status = 'MATERIAIS_CONFIRMADOS' THEN guidance_status ELSE 'ENVIADA' END,
      guidance_text = ?, guidance_by = ?, guidance_at = ?, updated_at = ? WHERE id = ?`, text, a.userId, now, now, id);
    await notify(r.requester_id, 'ESSENCIAL', 'Orientação de materiais', 'A ONEMA enviou a lista de materiais para o seu atendimento. Veja em Meus pedidos e confirme quando tiver providenciado.');
    await audit({ actorId: a.userId, action: 'CARE_GUIDANCE_SENT', subjectType: 'care_request', subjectId: id, correlationId: req.correlationId });
    return { ok: true };
  });

  /** Central: pedidos com orientação de materiais pendente (tarefa com responsável). */
  app.get('/api/admin/care/guidance', async (req) => {
    requireRoles(req, ['OPERADOR_CENTRAL', 'AVALIADOR_RT', 'ADMIN_PRIME', 'AUDITOR']);
    const rows = await all<any>(`SELECT r.id, r.protocol, r.item_code, r.materials, r.materials_detail, r.guidance_status, r.guidance_at, r.created_at, r.when_pref, r.when_date, r.time_window,
        (SELECT u.name FROM care_events e JOIN service_orders o ON o.id = e.order_id JOIN users u ON u.id = e.specialist_id WHERE o.request_id = r.id AND e.status IN ('ACEITO','CONCLUIDO') LIMIT 1) AS specialist
      FROM care_requests r WHERE r.guidance_status IN ('SOLICITADA','ENVIADA') AND r.status IN ('ACEITO','PEDIDO_GERADO') ORDER BY r.created_at LIMIT 200`);
    return { requests: rows };
  });
}
