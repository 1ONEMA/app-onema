/**
 * Rede ONEMA ONE — candidatura do especialista e análise pelo Credenciamento.
 * Fluxo: RASCUNHO → ENVIADA → (APROVADA | PENDENCIA → ENVIADA | RECUSADA).
 * Aprovar a candidatura libera a ONEMA Academy (perfil ESPECIALISTA). Receber ofertas de
 * atendimento continua exigindo a decisão humana de credenciamento APTO, depois da Academy concluída.
 * Documentos ficam em armazenamento privado e só são baixados por perfis autorizados (com auditoria).
 */
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, one, run, tx } from '../../db/db.ts';
import { NEEDS } from '../../db/content/pricing-v1.ts';
import { audit } from '../../lib/audit.ts';
import { parse, requireRoles, requireUser } from '../../lib/context.ts';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.ts';
import { deleteObjects, getObject, putObject } from '../../lib/storage.ts';
import { nowIso, sha256, uid } from '../../lib/util.ts';
import { notify } from '../prime/core.ts';

export const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'] as const;
const DOC_KINDS = ['IDENTIDADE', 'COREN', 'COMPROVANTE_ENDERECO', 'OUTRO'] as const;
const MAX_DOC_BYTES = 5 * 1024 * 1024;
/** Tipo real pelo conteúdo do arquivo (assinatura), não pelo que o navegador declara. */
export function sniffDocMime(b: Buffer): string | null {
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** Validação dos dígitos verificadores do CPF. */
export function validCpf(raw: string) {
  const d = raw.replace(/\D/g, '');
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const calc = (len: number) => {
    let s = 0;
    for (let i = 0; i < len; i++) s += Number(d[i]) * (len + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
}
const maskCpf = (cpf: string) => `***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-**`;

const appSchema = z.object({
  fullName: z.string().trim().min(5, 'Informe o nome completo.').max(150),
  cpf: z.string().trim().refine(validCpf, 'CPF inválido.').transform((v) => v.replace(/\D/g, '')),
  corenNumber: z.string().trim().regex(/^[0-9]{3,9}(-?[A-Z]{2,4})?$/i, 'Informe o número do COREN (somente números, com a categoria se houver).'),
  corenUf: z.enum(UFS),
  phone: z.string().trim().regex(/^[0-9()+\-\s]{10,20}$/, 'Informe um telefone com DDD.'),
  regions: z.string().trim().min(3, 'Informe as regiões ou bairros em que pode atender.').max(300),
  needs: z.array(z.enum(NEEDS.map((n) => n.key) as [string, ...string[]])).min(1, 'Escolha ao menos uma área de atendimento.'),
  availability: z.string().trim().max(400).optional().default(''),
  consent: z.literal(true, { message: 'Confirme a declaração e a ciência do tratamento dos dados.' }),
});

async function docsOf(appId: string) {
  return await all<any>('SELECT id, kind, filename, mime, size_bytes, created_at FROM specialist_documents WHERE application_id = ? ORDER BY created_at', appId);
}
function ownView(a: any, docs: any[]) {
  return {
    id: a.id, status: a.status, fullName: a.full_name, cpfMasked: maskCpf(a.cpf), corenNumber: a.coren_number, corenUf: a.coren_uf, phone: a.phone,
    regions: a.regions, needs: JSON.parse(a.needs_json), availability: a.availability, submittedAt: a.submitted_at, decisionNote: a.decision_note,
    decidedAt: a.decided_at, documents: docs, missingDocuments: (['IDENTIDADE', 'COREN'] as const).filter((k) => !docs.some((d) => d.kind === k)),
  };
}
const EDITABLE = ['RASCUNHO', 'PENDENCIA'];

export async function specialistRoutes(app: FastifyInstance) {
  app.get('/api/specialist/application', async (req) => {
    const a = requireUser(req);
    const row = await one<any>('SELECT * FROM specialist_applications WHERE user_id = ?', a.userId);
    return { application: row ? ownView(row, await docsOf(row.id)) : null, needs: NEEDS.map((n) => ({ key: n.key, title: n.title })), ufs: UFS };
  });

  app.put('/api/specialist/application', async (req) => {
    const a = requireUser(req);
    const b = parse(appSchema, req.body);
    return await tx(async () => {
      const now = nowIso();
      const cur = await one<any>('SELECT * FROM specialist_applications WHERE user_id = ? FOR UPDATE', a.userId);
      if (cur && !EDITABLE.includes(cur.status)) throw conflict('APPLICATION_LOCKED', 'Sua candidatura já foi enviada e está em análise pela Central ONEMA.');
      if (await one(`SELECT 1 FROM specialist_applications WHERE cpf = ? AND user_id <> ? AND status <> 'RECUSADA'`, b.cpf, a.userId)) {
        throw conflict('CPF_IN_USE', 'Já existe uma candidatura com este CPF. Fale com a Central ONEMA.');
      }
      if (cur) {
        await run(`UPDATE specialist_applications SET full_name = ?, cpf = ?, coren_number = ?, coren_uf = ?, phone = ?, regions = ?, needs_json = ?, availability = ?, updated_at = ? WHERE id = ?`,
          b.fullName, b.cpf, b.corenNumber.toUpperCase(), b.corenUf, b.phone, b.regions, JSON.stringify(b.needs), b.availability, now, cur.id);
      } else {
        await run(`INSERT INTO specialist_applications (id, user_id, full_name, cpf, coren_number, coren_uf, phone, regions, needs_json, availability, status, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, uid(), a.userId, b.fullName, b.cpf, b.corenNumber.toUpperCase(), b.corenUf, b.phone, b.regions, JSON.stringify(b.needs),
          b.availability, 'RASCUNHO', now, now);
      }
      await audit({ actorId: a.userId, action: 'SPECIALIST_APPLICATION_SAVED', subjectType: 'specialist_application', subjectId: a.userId, correlationId: req.correlationId });
      const row = (await one<any>('SELECT * FROM specialist_applications WHERE user_id = ?', a.userId))!;
      return { application: ownView(row, await docsOf(row.id)) };
    });
  });

  /** Envio de documento (PDF/JPG/PNG/WEBP até 5 MB), armazenado de forma privada. */
  app.post('/api/specialist/application/documents', async (req) => {
    const a = requireUser(req);
    const row = await one<any>('SELECT * FROM specialist_applications WHERE user_id = ?', a.userId);
    if (!row) throw unprocessable('APPLICATION_REQUIRED', 'Preencha e salve seus dados antes de enviar documentos.');
    if (!EDITABLE.includes(row.status)) throw conflict('APPLICATION_LOCKED', 'Sua candidatura já foi enviada e está em análise.');
    const fields: Record<string, string> = {};
    let file: { filename: string; mime: string; buf: Buffer } | null = null;
    for await (const p of req.parts({ limits: { fileSize: MAX_DOC_BYTES + 1, files: 1 } })) {
      if (p.type === 'file') file = { filename: p.filename, mime: p.mimetype, buf: await p.toBuffer() };
      else fields[p.fieldname] = String(p.value);
    }
    const { kind } = parse(z.object({ kind: z.enum(DOC_KINDS) }), fields);
    if (!file || !file.buf.length) throw badRequest('FILE_REQUIRED', 'Selecione um arquivo.');
    if (file.buf.length > MAX_DOC_BYTES) throw badRequest('FILE_TOO_LARGE', 'O arquivo deve ter no máximo 5 MB.');
    const mime = sniffDocMime(file.buf);
    if (!mime) throw badRequest('FILE_TYPE', 'Envie PDF, JPG, PNG ou WEBP.');
    file.mime = mime;
    const id = uid(), key = `specialist-doc-${id}`;
    await putObject(key, file.buf);
    await run(`INSERT INTO specialist_documents (id, application_id, kind, filename, mime, size_bytes, sha256, storage_key, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      id, row.id, kind, path.basename(file.filename).slice(0, 150), file.mime, file.buf.length, sha256(file.buf), key, nowIso());
    await audit({ actorId: a.userId, action: 'SPECIALIST_DOCUMENT_UPLOADED', subjectType: 'specialist_application', subjectId: row.id, correlationId: req.correlationId, meta: { kind } });
    return { application: ownView(row, await docsOf(row.id)) };
  });

  app.delete('/api/specialist/application/documents/:id', async (req) => {
    const a = requireUser(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const row = await one<any>('SELECT * FROM specialist_applications WHERE user_id = ?', a.userId);
    if (!row) throw notFound();
    if (!EDITABLE.includes(row.status)) throw conflict('APPLICATION_LOCKED', 'Sua candidatura já foi enviada e está em análise.');
    const doc = await one<any>('SELECT storage_key FROM specialist_documents WHERE id = ? AND application_id = ?', id, row.id);
    if (!doc) throw notFound('Documento não encontrado.');
    await run('DELETE FROM specialist_documents WHERE id = ?', id);
    await deleteObjects(doc.storage_key, 0);
    return { application: ownView(row, await docsOf(row.id)) };
  });

  app.post('/api/specialist/application/submit', async (req) => {
    const a = requireUser(req);
    return await tx(async () => {
      const row = await one<any>('SELECT * FROM specialist_applications WHERE user_id = ? FOR UPDATE', a.userId);
      if (!row) throw unprocessable('APPLICATION_REQUIRED', 'Preencha seus dados antes de enviar.');
      if (!EDITABLE.includes(row.status)) throw conflict('APPLICATION_LOCKED', 'Sua candidatura já foi enviada.');
      const docs = await docsOf(row.id);
      const missing = (['IDENTIDADE', 'COREN'] as const).filter((k) => !docs.some((d) => d.kind === k));
      if (missing.length) throw unprocessable('DOCUMENTS_REQUIRED', `Envie os documentos obrigatórios: ${missing.map((m) => (m === 'COREN' ? 'carteira do COREN' : 'documento de identidade')).join(' e ')}.`);
      const now = nowIso();
      await run(`UPDATE specialist_applications SET status = 'ENVIADA', submitted_at = ?, updated_at = ? WHERE id = ?`, now, now, row.id);
      await audit({ actorId: a.userId, action: 'SPECIALIST_APPLICATION_SUBMITTED', subjectType: 'specialist_application', subjectId: row.id, correlationId: req.correlationId });
      await notify(a.userId, 'ESSENCIAL', 'Candidatura ONEMA ONE recebida', 'Recebemos sua candidatura. A Central ONEMA vai conferir identidade, COREN e documentos e avisará você por aqui.');
      return { application: ownView((await one<any>('SELECT * FROM specialist_applications WHERE id = ?', row.id))!, docs) };
    });
  });

  // ---------- Credenciamento ----------
  const REVIEW = ['CREDENCIAMENTO', 'ADMIN_ACADEMY', 'AUDITOR'] as const;
  app.get('/api/admin/specialist-applications', async (req) => {
    const a = requireRoles(req, [...REVIEW]);
    const fullCpf = a.roles.includes('CREDENCIAMENTO');
    const rows = await all<any>(`SELECT s.*, u.email FROM specialist_applications s JOIN users u ON u.id = s.user_id WHERE s.status <> 'RASCUNHO' ORDER BY s.submitted_at DESC NULLS LAST LIMIT 300`);
    const out = [];
    for (const r of rows) {
      out.push({
        id: r.id, userId: r.user_id, email: r.email, status: r.status, fullName: r.full_name, cpf: fullCpf ? r.cpf : maskCpf(r.cpf),
        corenNumber: r.coren_number, corenUf: r.coren_uf, phone: r.phone, regions: r.regions, needs: JSON.parse(r.needs_json), availability: r.availability,
        submittedAt: r.submitted_at, decisionNote: r.decision_note, decidedAt: r.decided_at, documents: await docsOf(r.id),
      });
    }
    return { applications: out };
  });

  app.get('/api/admin/specialist-applications/:id/documents/:docId', async (req, reply) => {
    const a = requireRoles(req, ['CREDENCIAMENTO', 'ADMIN_ACADEMY']);
    const { id, docId } = parse(z.object({ id: z.string().uuid(), docId: z.string().uuid() }), req.params);
    const d = await one<any>('SELECT * FROM specialist_documents WHERE id = ? AND application_id = ?', docId, id);
    if (!d) throw notFound('Documento não encontrado.');
    const buf = await getObject(d.storage_key);
    if (!buf || sha256(buf) !== d.sha256) throw conflict('DOCUMENT_INTEGRITY', 'O arquivo armazenado não confere com o enviado. Peça um novo envio.');
    await audit({ actorId: a.userId, action: 'SPECIALIST_DOCUMENT_VIEWED', subjectType: 'specialist_application', subjectId: id, correlationId: req.correlationId, meta: { kind: d.kind } });
    reply.header('Content-Type', d.mime);
    reply.header('Content-Disposition', `inline; filename="${encodeURIComponent(d.filename)}"`);
    reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    reply.header('Cache-Control', 'no-store');
    return reply.send(buf);
  });

  app.post('/api/admin/specialist-applications/:id/decision', async (req) => {
    const a = requireRoles(req, ['CREDENCIAMENTO']);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const b = parse(z.object({
      decision: z.enum(['APROVADA', 'PENDENCIA', 'RECUSADA']),
      note: z.string().trim().min(10, 'Registre a justificativa (mínimo 10 caracteres).').max(2000),
      identityAndCorenVerified: z.boolean(),
    }), req.body);
    return await tx(async () => {
      const row = await one<any>('SELECT * FROM specialist_applications WHERE id = ? FOR UPDATE', id);
      if (!row) throw notFound('Candidatura não encontrada.');
      if (row.status !== 'ENVIADA') throw conflict('NOT_PENDING', 'Esta candidatura não está aguardando análise.');
      if (b.decision === 'APROVADA' && !b.identityAndCorenVerified) {
        throw unprocessable('VERIFICATION_REQUIRED', 'Confirme que identidade, COREN ativo e documentos foram conferidos.');
      }
      if (row.user_id === a.userId) throw forbidden('Não é permitido analisar a própria candidatura.');
      const now = nowIso();
      await run('UPDATE specialist_applications SET status = ?, decision_note = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?',
        b.decision, b.note, a.userId, now, now, id);
      if (b.decision === 'APROVADA') {
        await run(`INSERT INTO user_roles (user_id, role, granted_by, granted_at) VALUES (?, 'ESPECIALISTA', ?, ?) ON CONFLICT DO NOTHING`, row.user_id, a.userId, now);
        await run('UPDATE users SET academy_eligible = 1, updated_at = ? WHERE id = ?', now, row.user_id);
        await run(`INSERT INTO partner_training_status (partner_id, journey_state, updated_at) VALUES (?,?,?) ON CONFLICT (partner_id) DO NOTHING`, row.user_id, 'NAO_INICIADA', now);
      }
      await audit({ actorId: a.userId, action: 'SPECIALIST_APPLICATION_DECIDED', subjectType: 'specialist_application', subjectId: id, correlationId: req.correlationId, meta: { decision: b.decision } });
      const msg = {
        APROVADA: ['Candidatura aprovada', 'Seus documentos foram validados. A ONEMA Academy está liberada: conclua a Jornada de Integração para seguir ao credenciamento final.'],
        PENDENCIA: ['Candidatura com pendência', `A Central ONEMA pediu ajustes: ${b.note}`],
        RECUSADA: ['Candidatura não aprovada', `A Central ONEMA não aprovou a candidatura neste momento. Motivo: ${b.note}`],
      }[b.decision]!;
      await notify(row.user_id, 'ESSENCIAL', msg[0], msg[1]);
      return { ok: true };
    });
  });
}
