/**
 * Biblioteca institucional de POPs ONEMA (v1.0, 65 documentos, vigência administrativa 09/11/2026).
 *
 * - Os PDFs ficam no banco (versão imutável + SHA-256); nunca em pasta pública.
 * - Publicação negada por padrão: o RT libera para as especialistas após a homologação (e pode suspender).
 * - Consulta: RT (sempre) e especialistas ONEMA ONE credenciadas (somente versões publicadas). Toda abertura é auditada.
 * - No atendimento, os POPs do serviço aparecem como CANDIDATOS. A enfermeira escolhe após avaliar e justifica;
 *   nada é inferido ou executado automaticamente. O vínculo guarda a versão exata e aparece na Carteira do paciente.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, one, run, tx } from '../../db/db.ts';
import { audit } from '../../lib/audit.ts';
import { hasRole, parse, requireRoles } from '../../lib/context.ts';
import { AppError, conflict, forbidden, notFound } from '../../lib/errors.ts';
import { rateLimit } from '../../lib/security.ts';
import { nowIso, uid } from '../../lib/util.ts';

const POP_DIR = () => path.resolve(process.env.POPS_DIR ?? path.join(process.cwd(), 'server/content/pops'));
export const POP_LIBRARY_VERSION = '1.0';
const codeSchema = z.string().regex(/^ONEMA-POP-\d{3}$/, 'Código inválido.');

/**
 * Carga idempotente (etapa de build): insere só código+versão ausentes, conferindo o SHA-256 do inventário.
 * Na Function publicada os arquivos não existem — a carga é feita no build, onde estão no repositório.
 */
export async function loadPops(opts: { force?: boolean } = {}) {
  if (process.env.POPS_DISABLED === '1' && !opts.force) return { inserted: 0, skipped: 'desligado' };
  const dir = POP_DIR();
  const manifestFile = path.join(dir, 'pops.json');
  if (!fs.existsSync(manifestFile)) return { inserted: 0, skipped: 'arquivos indisponíveis neste ambiente' };
  const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const have = new Set((await all<any>('SELECT code FROM pop_documents WHERE version = ?', m.version)).map((r) => r.code));
  let inserted = 0;
  const now = nowIso();
  for (const p of m.pops) {
    if (have.has(p.code)) continue;
    const buf = fs.readFileSync(path.join(dir, `${p.code}.pdf`));
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (sha !== p.sha256 || buf.subarray(0, 5).toString() !== '%PDF-') throw new Error(`POP ${p.code}: arquivo diverge do inventário (integridade).`);
    await run(`INSERT INTO pop_documents (id, code, version, title, sha256, size_bytes, content, review_status, publication_status, effective_from, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (code, version) DO NOTHING`,
      uid(), p.code, m.version, p.title, sha, buf.length, buf, m.reviewStatus, 'BLOQUEADO', m.effectiveFrom, now);
    inserted++;
  }
  for (const r of m.candidateRules) {
    for (const item of r.itemCodes) for (const code of r.popCodes) {
      await run(`INSERT INTO pop_catalog_candidates (item_code, pop_code, package_key, mapping_status) VALUES (?,?,?,?) ON CONFLICT DO NOTHING`, item, code, r.packageKey, m.mappingStatus);
    }
  }
  return { inserted };
}

/** Quem pode consultar: RT sempre; especialista só credenciada (APTO) e só documentos publicados. */
async function viewer(req: any) {
  const a = requireRoles(req, ['AVALIADOR_RT', 'ESPECIALISTA']);
  if (hasRole(a, 'AVALIADOR_RT')) return { a, rt: true };
  const t = await one<any>('SELECT credentialing_decision FROM partner_training_status WHERE partner_id = ?', a.userId);
  if (t?.credentialing_decision !== 'APTO') throw forbidden('A biblioteca de POPs é liberada para especialistas ONEMA ONE credenciadas.', 'NOT_CREDENTIALED');
  return { a, rt: false };
}

const listView = (d: any) => ({ id: d.id, code: d.code, version: d.version, title: d.title, sha256: d.sha256, sizeBytes: d.size_bytes,
  status: d.publication_status, effectiveFrom: d.effective_from, statusNote: d.status_note, statusAt: d.status_at });

export async function popRoutes(app: FastifyInstance) {
  app.get('/api/pops', async (req) => {
    const { rt } = await viewer(req);
    const rows = await all<any>(`SELECT id, code, version, title, sha256, size_bytes, publication_status, effective_from, status_note, status_at FROM pop_documents
      ${rt ? '' : `WHERE publication_status = 'PUBLICADO'`} ORDER BY code, version`);
    return { pops: rows.map(listView), canManage: rt, libraryVersion: POP_LIBRARY_VERSION,
      notice: 'Documento institucional de apoio. A escolha do POP é da enfermeira após avaliação; não substitui evolução, prescrição ou protocolos de urgência.' };
  });

  /** PDF com integridade conferida. Sempre no-store e auditado. */
  app.get('/api/pops/:code/pdf', async (req, reply) => {
    const { a, rt } = await viewer(req);
    const { code } = parse(z.object({ code: codeSchema }), req.params);
    const { version } = parse(z.object({ version: z.string().max(20).optional() }), req.query);
    if (!await rateLimit(`pop-view:${a.userId}`, 120, 3600_000)) throw new AppError(429, 'RATE_LIMIT', 'Muitas consultas em pouco tempo. Aguarde alguns minutos.');
    const d = await one<any>(`SELECT * FROM pop_documents WHERE code = ? ${version ? 'AND version = ?' : ''} ORDER BY created_at DESC LIMIT 1`, ...(version ? [code, version] : [code]));
    // Especialista também acessa a versão exata já vinculada a um atendimento seu (mesmo se depois suspensa).
    const linked = d && !rt ? await one('SELECT 1 AS ok FROM care_event_pops WHERE pop_document_id = ? AND specialist_id = ?', d.id, a.userId) : null;
    if (!d || (!rt && d.publication_status !== 'PUBLICADO' && !linked)) throw notFound('POP não encontrado.');
    const buf = Buffer.from(d.content);
    if (crypto.createHash('sha256').update(buf).digest('hex') !== d.sha256) throw new AppError(500, 'INTEGRITY_ERROR', 'Falha de integridade do documento. A Central foi avisada.');
    await audit({ actorId: a.userId, action: 'POP_VIEWED', subjectType: 'pop_document', subjectId: d.id, correlationId: req.correlationId, meta: { code, version: d.version } });
    reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `inline; filename="${d.code}-v${d.version}.pdf"`)
      .header('Cache-Control', 'private, no-store').header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    return reply.send(buf);
  });

  /** RT: liberar (após homologação), suspender ou bloquear — por documento ou toda a versão. */
  app.post('/api/admin/pops/status', async (req) => {
    const a = requireRoles(req, ['AVALIADOR_RT']);
    const b = parse(z.object({
      codes: z.array(codeSchema).min(1).max(100).optional(), all: z.boolean().optional(),
      status: z.enum(['PUBLICADO', 'SUSPENSO', 'BLOQUEADO']),
      note: z.string().trim().min(10, 'Registre a justificativa (ex.: homologação concluída em …).').max(500),
    }).refine((x) => x.all || x.codes?.length, { message: 'Escolha os POPs ou marque todos.' }), req.body);
    return await tx(async () => {
      const now = nowIso();
      const codes = b.all ? (await all<any>('SELECT code FROM pop_documents WHERE version = ?', POP_LIBRARY_VERSION)).map((r) => r.code) : b.codes!;
      let n = 0;
      for (const code of codes) {
        n += (await run('UPDATE pop_documents SET publication_status = ?, status_note = ?, status_by = ?, status_at = ? WHERE code = ? AND version = ?', b.status, b.note, a.userId, now, code, POP_LIBRARY_VERSION)).changes;
      }
      await audit({ actorId: a.userId, action: `POP_${b.status}`, subjectType: 'pop_library', subjectId: POP_LIBRARY_VERSION, correlationId: req.correlationId, meta: { count: n, all: !!b.all, note: b.note } });
      return { updated: n };
    });
  });

  // ---------- No atendimento ----------
  async function ownEvent(req: any, id: string) {
    const a = requireRoles(req, ['ESPECIALISTA']);
    const e = await one<any>(`SELECT e.id, e.status, e.order_id, o.item_code, o.patient_id FROM care_events e JOIN service_orders o ON o.id = e.order_id WHERE e.id = ? AND e.specialist_id = ?`, id, a.userId);
    if (!e) throw notFound('Atendimento não encontrado.');
    await viewer(req);
    return { a, e };
  }

  app.get('/api/care/specialist/events/:id/pops', async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { e } = await ownEvent(req, id);
    const candidates = await all<any>(`SELECT d.id, d.code, d.version, d.title, d.sha256, d.size_bytes, d.publication_status, d.effective_from, d.status_note, d.status_at
      FROM pop_catalog_candidates c JOIN pop_documents d ON d.code = c.pop_code AND d.version = ? AND d.publication_status = 'PUBLICADO'
      WHERE c.item_code = ? ORDER BY d.code`, POP_LIBRARY_VERSION, e.item_code);
    const selected = await all<any>(`SELECT p.id, p.pop_code, p.pop_version, p.reason, p.created_at, d.title FROM care_event_pops p JOIN pop_documents d ON d.id = p.pop_document_id
      WHERE p.event_id = ? ORDER BY p.created_at`, id);
    return { candidates: candidates.map(listView), selected, mappingNote: 'Sugestões pelo tipo de serviço (associação proposta, a confirmar pelo RT). A escolha é sua, após a avaliação.' };
  });

  app.post('/api/care/specialist/events/:id/pops', async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const b = parse(z.object({ code: codeSchema, reason: z.string().trim().min(10, 'Justifique o uso do POP (mínimo 10 caracteres).').max(500) }), req.body);
    const { a, e } = await ownEvent(req, id);
    if (!['ACEITO', 'CONCLUIDO'].includes(e.status)) throw conflict('EVENT_NOT_ACTIVE', 'Vincule POPs apenas a atendimentos aceitos por você.');
    const d = await one<any>(`SELECT * FROM pop_documents WHERE code = ? AND version = ? AND publication_status = 'PUBLICADO'`, b.code, POP_LIBRARY_VERSION);
    if (!d) throw notFound('POP não publicado.');
    if (await one('SELECT 1 AS ok FROM care_event_pops WHERE event_id = ? AND pop_document_id = ?', id, d.id)) throw conflict('POP_ALREADY_LINKED', 'Este POP já está vinculado ao atendimento.');
    const linkId = uid();
    await run(`INSERT INTO care_event_pops (id, event_id, order_id, patient_id, specialist_id, pop_document_id, pop_code, pop_version, pop_sha256, reason, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, linkId, id, e.order_id, e.patient_id, a.userId, d.id, d.code, d.version, d.sha256, b.reason, nowIso());
    await audit({ actorId: a.userId, action: 'POP_LINKED', subjectType: 'care_event', subjectId: id, correlationId: req.correlationId, meta: { code: d.code, version: d.version } });
    return { ok: true, id: linkId };
  });
}

/** POPs vinculados aos atendimentos do paciente (Carteira): referência institucional, sem o PDF. */
export async function patientPops(patientId: string) {
  return await all<any>(`SELECT p.pop_code AS code, p.pop_version AS version, d.title, p.reason, p.created_at, e.label, u.name AS specialist
    FROM care_event_pops p JOIN pop_documents d ON d.id = p.pop_document_id JOIN care_events e ON e.id = p.event_id JOIN users u ON u.id = p.specialist_id
    WHERE p.patient_id = ? ORDER BY p.created_at DESC LIMIT 200`, patientId);
}
