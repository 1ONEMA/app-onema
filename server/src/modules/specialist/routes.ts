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
import { getObject, putObject } from '../../lib/storage.ts';
import { lookupHash, openField, sealField } from '../../lib/security.ts';
import { validCpf } from '../../lib/cpf.ts';
import { recordAcceptance } from '../legal.ts';
import { nowIso, sha256, uid } from '../../lib/util.ts';
import { notify } from '../prime/core.ts';
import { PARTNER_STATE_LABEL, REQUIRED_CHECKS, partnerState, revalidationDays } from './validation.ts';

export const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'] as const;
const DOC_KINDS = ['FOTO', 'PROVA_VIVA', 'IDENTIDADE', 'COREN', 'DIPLOMA_FRENTE', 'DIPLOMA_VERSO', 'CERTIFICADO', 'COMPROVANTE_ENDERECO', 'OUTRO'] as const;
/** Obrigatórios para enviar a candidatura (ajustes após testes, 04/11/2026). Certificados e comprovante são opcionais. */
// Validação de parceiros (12/10/2026): foto de prova viva (segurando o mesmo documento ao lado do rosto) também é obrigatória.
export const REQUIRED_DOCS = ['FOTO', 'PROVA_VIVA', 'IDENTIDADE', 'COREN', 'DIPLOMA_FRENTE', 'DIPLOMA_VERSO'] as const;
export const CATEGORIES = ['ENFERMEIRO', 'TECNICO_ENFERMAGEM'] as const;
const DOC_LABEL: Record<string, string> = {
  FOTO: 'foto', PROVA_VIVA: 'foto de prova viva (você segurando o documento)', IDENTIDADE: 'identidade com CPF', COREN: 'carteira do COREN', DIPLOMA_FRENTE: 'diploma (frente)', DIPLOMA_VERSO: 'diploma (verso)',
};
const MAX_DOC_BYTES = 5 * 1024 * 1024;
/** Tipo real pelo conteúdo do arquivo (assinatura), não pelo que o navegador declara. */
export function sniffDocMime(b: Buffer): string | null {
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export { validCpf };
const maskCpf = (cpf: string) => `***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-**`;

const appSchema = z.object({
  fullName: z.string().trim().min(5, 'Informe o nome completo.').max(150),
  // Opcional ao atualizar: em branco mantém o CPF já salvo (a tela não reexibe o número completo).
  cpf: z.string().trim().refine(validCpf, 'CPF inválido.').transform((v) => v.replace(/\D/g, '')).optional(),
  corenNumber: z.string().trim().regex(/^[0-9]{3,9}(-?[A-Z]{2,4})?$/i, 'Informe o número do COREN (somente números, com a categoria se houver).'),
  corenUf: z.enum(UFS),
  professionalCategory: z.enum(CATEGORIES, { message: 'Informe a categoria profissional.' }),
  states: z.array(z.enum(UFS)).min(1, 'Informe ao menos um estado em que pretende atender.').max(27),
  phone: z.string().trim().regex(/^[0-9()+\-\s]{10,20}$/, 'Informe um telefone com DDD.'),
  regions: z.string().trim().min(3, 'Informe as regiões ou bairros em que pode atender.').max(300),
  needs: z.array(z.enum(NEEDS.map((n) => n.key) as [string, ...string[]])).min(1, 'Escolha ao menos uma área de atendimento.'),
  availability: z.string().trim().max(400).optional().default(''),
  // Ajustes 05/11/2026: duas caixas separadas, desmarcadas (veracidade do cadastro + Termo LGPD do especialista).
  consent: z.literal(true, { message: 'Confirme que as informações e os documentos são verdadeiros.' }),
  dataTerm: z.literal(true, { message: 'Leia e aceite o Termo de Proteção de Dados, Sigilo e Responsabilidades.' }),
});

/** Documentos vigentes (o parceiro só vê os atuais; versões substituídas/removidas ficam preservadas para a análise). */
async function docsOf(appId: string, withHistory = false) {
  return await all<any>(`SELECT id, kind, filename, mime, size_bytes, created_at${withHistory ? ', superseded_at, removed_at' : ''} FROM specialist_documents
    WHERE application_id = ? ${withHistory ? '' : 'AND superseded_at IS NULL AND removed_at IS NULL'} ORDER BY created_at`, appId);
}
async function event(applicationId: string, actorId: string | null, action: string, note: string | null, reason: string | null) {
  await run('INSERT INTO partner_application_events (id, application_id, actor_id, action, note, review_reason, created_at) VALUES (?,?,?,?,?,?,?)',
    uid(), applicationId, actorId, action, note, reason, nowIso());
}
const PRIVACY_NOTICE = 'Usamos seus documentos, a foto de prova viva e os dados profissionais somente para confirmar sua identidade e sua habilitação (inclusive em consultas aos registros oficiais do COFEN/COREN) e para manter o cadastro na rede ONEMA ONE. O acesso é restrito à equipe de credenciamento e ao Responsável Técnico, com registro de cada acesso. Os dados ficam guardados enquanto durar a parceria e pelo prazo definido na Política de Privacidade; você pode exercer seus direitos pelos canais da ONEMA. Não usamos reconhecimento facial automático.';
/** Visão do próprio parceiro: status em linguagem simples e o que corrigir. Sem conferências internas nem evidências. */
async function ownView(a: any, docs: any[]) {
  const ps = await partnerState(a.user_id);
  const history = await all<any>(`SELECT action, note, created_at FROM partner_application_events WHERE application_id = ? AND action IN ('ENVIADA','CORRECAO_SOLICITADA','APROVADA','RECUSADA','SUSPENSA','REABERTA')
    ORDER BY created_at DESC LIMIT 30`, a.id);
  return {
    id: a.id, status: a.status, fullName: a.full_name, cpfMasked: maskCpf(openField(a.cpf)), corenNumber: a.coren_number, corenUf: a.coren_uf, phone: a.phone,
    professionalCategory: a.professional_category, states: a.states_json ? JSON.parse(a.states_json) : [],
    regions: a.regions, needs: JSON.parse(a.needs_json), availability: a.availability, submittedAt: a.submitted_at, decisionNote: a.decision_note,
    decidedAt: a.decided_at, documents: docs, missingDocuments: REQUIRED_DOCS.filter((k) => !docs.some((d) => d.kind === k)),
    partnerState: ps.state, partnerStateLabel: PARTNER_STATE_LABEL[ps.state], reviewReason: a.review_reason, nextRevalidationAt: a.next_revalidation_at,
    suspendedReason: a.suspended_reason, history, privacyNotice: PRIVACY_NOTICE,
  };
}
const EDITABLE = ['RASCUNHO', 'PENDENCIA'];

export async function specialistRoutes(app: FastifyInstance) {
  app.get('/api/specialist/application', async (req) => {
    const a = requireUser(req);
    const row = await one<any>('SELECT * FROM specialist_applications WHERE user_id = ?', a.userId);
    return { application: row ? await ownView(row, await docsOf(row.id)) : null, needs: NEEDS.map((n) => ({ key: n.key, title: n.title })), ufs: UFS, privacyNotice: PRIVACY_NOTICE };
  });

  app.put('/api/specialist/application', async (req) => {
    const a = requireUser(req);
    const b = parse(appSchema, req.body);
    return await tx(async () => {
      const now = nowIso();
      const cur = await one<any>('SELECT * FROM specialist_applications WHERE user_id = ? FOR UPDATE', a.userId);
      if (cur && !EDITABLE.includes(cur.status)) throw conflict('APPLICATION_LOCKED', 'Sua candidatura já foi enviada e está em análise pela Central ONEMA.');
      const cpf = b.cpf ?? (cur ? openField(cur.cpf) : undefined);
      if (!cpf) throw badRequest('VALIDATION', 'Dados inválidos. Revise os campos destacados.', [{ path: 'cpf', message: 'Informe o CPF.' }]);
      const cpfHash = lookupHash('cpf', cpf);
      if (await one(`SELECT 1 FROM specialist_applications WHERE (cpf_hash = ? OR cpf = ?) AND user_id <> ? AND status <> 'RECUSADA'`, cpfHash, cpf, a.userId)) {
        throw conflict('CPF_IN_USE', 'Já existe uma candidatura com este CPF. Fale com a Central ONEMA.');
      }
      if (cur) {
        await run(`UPDATE specialist_applications SET full_name = ?, cpf = ?, cpf_hash = ?, coren_number = ?, coren_uf = ?, professional_category = ?, states_json = ?, phone = ?, regions = ?, needs_json = ?, availability = ?, updated_at = ? WHERE id = ?`,
          b.fullName, sealField(cpf), cpfHash, b.corenNumber.toUpperCase(), b.corenUf, b.professionalCategory, JSON.stringify(b.states), b.phone, b.regions, JSON.stringify(b.needs), b.availability, now, cur.id);
      } else {
        await run(`INSERT INTO specialist_applications (id, user_id, full_name, cpf, cpf_hash, coren_number, coren_uf, professional_category, states_json, phone, regions, needs_json, availability, status, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, uid(), a.userId, b.fullName, sealField(cpf), cpfHash, b.corenNumber.toUpperCase(), b.corenUf, b.professionalCategory, JSON.stringify(b.states),
          b.phone, b.regions, JSON.stringify(b.needs), b.availability, 'RASCUNHO', now, now);
      }
      // Aceite do Termo LGPD do especialista: versão e hash do texto vigente (só registra de novo se a versão mudou).
      const term = await one<any>(`SELECT version FROM legal_texts WHERE code = 'TERMO_ESPECIALISTA' ORDER BY created_at DESC LIMIT 1`);
      if (term && !(await one(`SELECT 1 AS ok FROM legal_acceptances WHERE user_id = ? AND code = 'TERMO_ESPECIALISTA' AND version = ?`, a.userId, term.version))) {
        await recordAcceptance(a.userId, 'TERMO_ESPECIALISTA', 'CANDIDATURA_ONEMA_ONE');
      }
      await audit({ actorId: a.userId, action: 'SPECIALIST_APPLICATION_SAVED', subjectType: 'specialist_application', subjectId: a.userId, correlationId: req.correlationId });
      const row = (await one<any>('SELECT * FROM specialist_applications WHERE user_id = ?', a.userId))!;
      return { application: await ownView(row, await docsOf(row.id)) };
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
    if ((await docsOf(row.id)).length >= 20) throw unprocessable('TOO_MANY_DOCUMENTS', 'Limite de 20 documentos por candidatura. Remova um arquivo antes de enviar outro.');
    const mime = sniffDocMime(file.buf);
    if (!mime) throw badRequest('FILE_TYPE', 'Envie PDF, JPG, PNG ou WEBP.');
    file.mime = mime;
    const id = uid(), key = `specialist-doc-${id}`;
    await putObject(key, file.buf);
    // Documento único (foto, identidade, COREN, diploma…): o novo arquivo substitui o anterior, que fica preservado
    // como versão anterior para a análise (histórico sem sobrescrever). Certificados acumulam.
    if (kind !== 'CERTIFICADO' && kind !== 'OUTRO') {
      const r = await run('UPDATE specialist_documents SET superseded_at = ? WHERE application_id = ? AND kind = ? AND superseded_at IS NULL AND removed_at IS NULL', nowIso(), row.id, kind);
      if (r.changes) await audit({ actorId: a.userId, action: 'SPECIALIST_DOCUMENT_REPLACED', subjectType: 'specialist_application', subjectId: row.id, correlationId: req.correlationId, meta: { kind } });
    }
    await run(`INSERT INTO specialist_documents (id, application_id, kind, filename, mime, size_bytes, sha256, storage_key, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      id, row.id, kind, path.basename(file.filename).slice(0, 150), file.mime, file.buf.length, sha256(file.buf), key, nowIso());
    await audit({ actorId: a.userId, action: 'SPECIALIST_DOCUMENT_UPLOADED', subjectType: 'specialist_application', subjectId: row.id, correlationId: req.correlationId, meta: { kind } });
    return { application: await ownView(row, await docsOf(row.id)) };
  });

  app.delete('/api/specialist/application/documents/:id', async (req) => {
    const a = requireUser(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const row = await one<any>('SELECT * FROM specialist_applications WHERE user_id = ?', a.userId);
    if (!row) throw notFound();
    if (!EDITABLE.includes(row.status)) throw conflict('APPLICATION_LOCKED', 'Sua candidatura já foi enviada e está em análise.');
    const doc = await one<any>('SELECT id FROM specialist_documents WHERE id = ? AND application_id = ? AND removed_at IS NULL AND superseded_at IS NULL', id, row.id);
    if (!doc) throw notFound('Documento não encontrado.');
    // Remoção lógica: o arquivo sai do cadastro, mas a versão fica preservada no histórico da análise.
    await run('UPDATE specialist_documents SET removed_at = ? WHERE id = ?', nowIso(), id);
    await audit({ actorId: a.userId, action: 'SPECIALIST_DOCUMENT_REMOVED', subjectType: 'specialist_application', subjectId: row.id, correlationId: req.correlationId });
    return { application: await ownView(row, await docsOf(row.id)) };
  });

  app.post('/api/specialist/application/submit', async (req) => {
    const a = requireUser(req);
    return await tx(async () => {
      const row = await one<any>('SELECT * FROM specialist_applications WHERE user_id = ? FOR UPDATE', a.userId);
      if (!row) throw unprocessable('APPLICATION_REQUIRED', 'Preencha seus dados antes de enviar.');
      if (!EDITABLE.includes(row.status)) throw conflict('APPLICATION_LOCKED', 'Sua candidatura já foi enviada.');
      const docs = await docsOf(row.id);
      const missing = REQUIRED_DOCS.filter((k) => !docs.some((d) => d.kind === k));
      if (missing.length) throw unprocessable('DOCUMENTS_REQUIRED', `Envie os documentos obrigatórios: ${missing.map((m) => DOC_LABEL[m]).join(', ')}.`);
      const now = nowIso();
      if (!row.professional_category || !row.states_json) throw unprocessable('PROFESSIONAL_DATA_REQUIRED', 'Informe a categoria profissional e os estados em que pretende atender e salve os dados.');
      await run(`UPDATE specialist_applications SET status = 'ENVIADA', submitted_at = ?, updated_at = ? WHERE id = ?`, now, now, row.id);
      await event(row.id, a.userId, 'ENVIADA', null, row.review_reason);
      await audit({ actorId: a.userId, action: 'SPECIALIST_APPLICATION_SUBMITTED', subjectType: 'specialist_application', subjectId: row.id, correlationId: req.correlationId });
      await notify(a.userId, 'ESSENCIAL', 'Candidatura ONEMA ONE recebida', 'Recebemos sua candidatura. A Central ONEMA vai conferir identidade, COREN e documentos e avisará você por aqui.');
      return { application: await ownView((await one<any>('SELECT * FROM specialist_applications WHERE id = ?', row.id))!, docs) };
    });
  });

  /**
   * Atualizar dados profissionais (mudança de nome, categoria, COREN ou UF) ou responder à revalidação: o cadastro volta para
   * correção e passa por nova análise. Enquanto isso, novos atendimentos ficam bloqueados.
   */
  app.post('/api/specialist/application/reopen', async (req) => {
    const a = requireUser(req);
    const b = parse(z.object({ reason: z.enum(['MUDANCA_DADOS', 'REVALIDACAO']) }), req.body ?? {});
    return await tx(async () => {
      const row = await one<any>('SELECT * FROM specialist_applications WHERE user_id = ? FOR UPDATE', a.userId);
      if (!row || !['APROVADA', 'SUSPENSA'].includes(row.status)) throw conflict('APPLICATION_NOT_APPROVED', 'Só é possível atualizar um cadastro aprovado ou suspenso para revalidação.');
      const now = nowIso();
      await run(`UPDATE specialist_applications SET status = 'PENDENCIA', review_reason = ?, decision_note = ?, updated_at = ? WHERE id = ?`, b.reason,
        b.reason === 'MUDANCA_DADOS' ? 'Atualização de dados profissionais: revise os dados, troque os documentos que mudaram e envie para nova análise.'
          : 'Revalidação periódica: confira seus dados, envie documentos atualizados se necessário e envie para nova análise.', now, row.id);
      await event(row.id, a.userId, 'REABERTA', null, b.reason);
      await audit({ actorId: a.userId, action: 'SPECIALIST_APPLICATION_REOPENED', subjectType: 'specialist_application', subjectId: row.id, correlationId: req.correlationId, meta: { reason: b.reason } });
      const r2 = (await one<any>('SELECT * FROM specialist_applications WHERE id = ?', row.id))!;
      return { application: await ownView(r2, await docsOf(row.id)) };
    });
  });

  // ---------- Credenciamento ----------
  const REVIEW = ['CREDENCIAMENTO', 'ADMIN_ACADEMY', 'AUDITOR'] as const;
  /** Foto da especialista para o paciente do atendimento identificá-la (somente quem contratou aquele atendimento). */
  app.get('/api/care/events/:id/specialist-photo', async (req, reply) => {
    const a = requireRoles(req, ['PACIENTE']);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const d = await one<any>(`SELECT d.* FROM care_events e JOIN service_orders o ON o.id = e.order_id
      JOIN specialist_applications sa ON sa.user_id = e.specialist_id AND sa.status = 'APROVADA'
      JOIN specialist_documents d ON d.application_id = sa.id AND d.kind = 'FOTO'
      WHERE e.id = ? AND o.patient_id = ? AND e.status IN ('ACEITO','CONCLUIDO') ORDER BY d.created_at DESC LIMIT 1`, id, a.userId);
    if (!d || !d.mime.startsWith('image/')) throw notFound('Foto não disponível.');
    const buf = await getObject(d.storage_key);
    if (!buf || sha256(buf) !== d.sha256) throw notFound('Foto não disponível.');
    reply.header('Content-Type', d.mime);
    reply.header('Cache-Control', 'private, no-store');
    reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox");
    return reply.send(buf);
  });

  /** Perfis internos autorizados a ver conferências e evidências (o parceiro nunca vê). */
  const EVIDENCE_ROLES = ['CREDENCIAMENTO', 'AVALIADOR_RT', 'ADMIN_ACADEMY', 'AUDITOR'] as const;
  const DECIDE_ROLES = ['CREDENCIAMENTO', 'AVALIADOR_RT', 'ADMIN_ACADEMY'] as const;

  async function latestChecks(appId: string) {
    const rows = await all<any>(`SELECT v.*, u.name AS actor_name FROM partner_verifications v JOIN users u ON u.id = v.actor_id WHERE v.application_id = ? ORDER BY v.created_at DESC, v.id DESC`, appId);
    const latest: Record<string, any> = {};
    for (const r of rows) latest[r.check_kind] ??= r;
    return { rows, latest };
  }

  /** Fila: novos cadastros e revalidações (com conferências, evidências e histórico — só perfis internos). */
  app.get('/api/admin/specialist-applications', async (req) => {
    const a = requireRoles(req, [...REVIEW, 'AVALIADOR_RT']);
    const fullCpf = a.roles.includes('CREDENCIAMENTO');
    const rows = await all<any>(`SELECT s.*, u.email FROM specialist_applications s JOIN users u ON u.id = s.user_id WHERE s.status <> 'RASCUNHO' ORDER BY s.submitted_at DESC NULLS LAST LIMIT 300`);
    const out = [];
    for (const r of rows) {
      const { rows: checks, latest } = await latestChecks(r.id);
      const evidence = await all<any>(`SELECT e.id, e.verification_id, e.filename, e.size_bytes, e.created_at, u.name AS uploaded_by FROM partner_verification_evidence e JOIN users u ON u.id = e.uploaded_by
        WHERE e.application_id = ? ORDER BY e.created_at`, r.id);
      const ps = await partnerState(r.user_id);
      out.push({
        id: r.id, userId: r.user_id, email: r.email, status: r.status, fullName: r.full_name, cpf: fullCpf ? openField(r.cpf) : maskCpf(openField(r.cpf)),
        corenNumber: r.coren_number, corenUf: r.coren_uf, professionalCategory: r.professional_category, states: r.states_json ? JSON.parse(r.states_json) : [],
        phone: r.phone, regions: r.regions, needs: JSON.parse(r.needs_json), availability: r.availability,
        submittedAt: r.submitted_at, decisionNote: r.decision_note, decidedAt: r.decided_at, reviewReason: r.review_reason, nextRevalidationAt: r.next_revalidation_at,
        suspendedReason: r.suspended_reason, partnerState: ps.state, partnerStateLabel: PARTNER_STATE_LABEL[ps.state],
        queue: r.status === 'ENVIADA' ? (r.review_reason === 'INICIAL' ? 'NOVO' : 'REVALIDACAO') : r.status === 'SUSPENSA' ? 'REVALIDACAO' : null,
        documents: await docsOf(r.id, true),
        checks: checks.map((c) => ({ id: c.id, kind: c.check_kind, result: c.result, source: c.source, sourceUrl: c.source_url, corenNumber: c.coren_number, corenUf: c.coren_uf,
          consultedAt: c.consulted_at, note: c.note, reason: c.review_reason, actor: c.actor_name, createdAt: c.created_at, evidence: evidence.filter((e) => e.verification_id === c.id) })),
        requiredChecks: REQUIRED_CHECKS.map((k) => ({ kind: k, result: latest[k]?.result ?? 'PENDENTE' })),
        history: await all<any>(`SELECT ev.action, ev.note, ev.review_reason, ev.created_at, u.name AS actor FROM partner_application_events ev LEFT JOIN users u ON u.id = ev.actor_id
          WHERE ev.application_id = ? ORDER BY ev.created_at DESC`, r.id),
      });
    }
    await audit({ actorId: a.userId, action: 'PARTNER_QUEUE_VIEWED', subjectType: 'specialist_application', subjectId: null, correlationId: req.correlationId });
    return { applications: out, revalidationDays: revalidationDays(),
      officialSources: [{ name: 'COFEN — Consulta de profissionais', url: 'https://www.cofen.gov.br/' }, { name: 'COREN-SP — Consulta de profissionais', url: 'https://portal.coren-sp.gov.br/' },
        { name: 'ITI VALIDAR (assinaturas digitais)', url: 'https://validar.iti.gov.br/' }] };
  });

  app.get('/api/admin/specialist-applications/:id/documents/:docId', async (req, reply) => {
    const a = requireRoles(req, ['CREDENCIAMENTO', 'ADMIN_ACADEMY', 'AVALIADOR_RT']);
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

  /**
   * Conferência humana (append-only): prova viva, identidade, inscrição COREN/COFEN, categoria e autenticidade documental.
   * Sem automação por raspagem nem reconhecimento facial: quem conferiu registra fonte, data/hora, resultado e justificativa.
   */
  app.post('/api/admin/specialist-applications/:id/verifications', async (req) => {
    const a = requireRoles(req, [...DECIDE_ROLES]);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const b = parse(z.object({
      checkKind: z.enum(['PROVA_VIVA', 'IDENTIDADE', 'INSCRICAO', 'CATEGORIA', 'AUTENTICIDADE']),
      result: z.enum(['CONFERIDA', 'PENDENTE', 'DIVERGENTE', 'INDISPONIVEL', 'NAO_ENCONTRADA', 'NAO_AUTENTICAVEL']),
      source: z.string().trim().max(200).optional(),
      sourceUrl: z.string().trim().url('Informe a URL consultada.').max(500).optional().or(z.literal('')),
      consultedAt: z.string().datetime({ offset: true }).optional(),
      note: z.string().trim().max(2000).optional().default(''),
    }), req.body);
    if (b.result !== 'CONFERIDA' && b.note.length < 5) throw badRequest('VALIDATION', 'Dados inválidos. Revise os campos destacados.', [{ path: 'note', message: 'Registre a justificativa.' }]);
    if (['INSCRICAO', 'CATEGORIA', 'AUTENTICIDADE'].includes(b.checkKind) && !b.source) {
      throw badRequest('VALIDATION', 'Dados inválidos. Revise os campos destacados.', [{ path: 'source', message: 'Informe a fonte oficial consultada.' }]);
    }
    const row = await one<any>('SELECT * FROM specialist_applications WHERE id = ?', id);
    if (!row) throw notFound('Cadastro não encontrado.');
    if (row.user_id === a.userId) throw forbidden('Não é permitido conferir o próprio cadastro.');
    const vid = uid(), now = nowIso();
    await run(`INSERT INTO partner_verifications (id, application_id, check_kind, result, source, source_url, coren_number, coren_uf, consulted_at, note, review_reason, actor_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, vid, id, b.checkKind, b.result, b.source ?? null, b.sourceUrl || null,
      b.checkKind === 'INSCRICAO' ? row.coren_number : null, b.checkKind === 'INSCRICAO' ? row.coren_uf : null, b.consultedAt ? new Date(b.consultedAt).toISOString() : now, b.note || null, row.review_reason, a.userId, now);
    await audit({ actorId: a.userId, action: 'PARTNER_CHECK_RECORDED', subjectType: 'specialist_application', subjectId: id, correlationId: req.correlationId, meta: { kind: b.checkKind, result: b.result } });
    return { ok: true, id: vid };
  });

  /** Print da consulta oficial COREN/COFEN anexado pelo RT ou usuário formalmente autorizado, vinculado à conferência. */
  app.post('/api/admin/specialist-applications/:id/verifications/:vid/evidence', async (req) => {
    const a = requireRoles(req, ['AVALIADOR_RT', 'CREDENCIAMENTO']);
    const { id, vid } = parse(z.object({ id: z.string().uuid(), vid: z.string().uuid() }), req.params);
    const v = await one<any>('SELECT * FROM partner_verifications WHERE id = ? AND application_id = ?', vid, id);
    if (!v) throw notFound('Conferência não encontrada.');
    let file: { filename: string; buf: Buffer } | null = null;
    for await (const p of req.parts({ limits: { fileSize: MAX_DOC_BYTES + 1, files: 1 } })) {
      if (p.type === 'file') file = { filename: p.filename, buf: await p.toBuffer() };
    }
    if (!file || !file.buf.length) throw badRequest('FILE_REQUIRED', 'Selecione o arquivo da captura.');
    if (file.buf.length > MAX_DOC_BYTES) throw badRequest('FILE_TOO_LARGE', 'O arquivo deve ter no máximo 5 MB.');
    const mime = sniffDocMime(file.buf);
    if (!mime) throw badRequest('FILE_TYPE', 'Envie PDF, JPG, PNG ou WEBP.');
    const eid = uid(), key = `partner-evidence-${eid}`;
    await putObject(key, file.buf);
    await run(`INSERT INTO partner_verification_evidence (id, verification_id, application_id, filename, mime, size_bytes, sha256, storage_key, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      eid, vid, id, path.basename(file.filename).slice(0, 150), mime, file.buf.length, sha256(file.buf), key, a.userId, nowIso());
    await audit({ actorId: a.userId, action: 'PARTNER_EVIDENCE_ATTACHED', subjectType: 'specialist_application', subjectId: id, correlationId: req.correlationId, meta: { verification: vid } });
    return { ok: true, id: eid };
  });

  app.get('/api/admin/specialist-applications/:id/evidence/:eid', async (req, reply) => {
    const a = requireRoles(req, [...EVIDENCE_ROLES]);
    const { id, eid } = parse(z.object({ id: z.string().uuid(), eid: z.string().uuid() }), req.params);
    const e = await one<any>('SELECT * FROM partner_verification_evidence WHERE id = ? AND application_id = ?', eid, id);
    if (!e) throw notFound('Evidência não encontrada.');
    const buf = await getObject(e.storage_key);
    if (!buf || sha256(buf) !== e.sha256) throw conflict('DOCUMENT_INTEGRITY', 'O arquivo armazenado não confere com o anexado.');
    await audit({ actorId: a.userId, action: 'PARTNER_EVIDENCE_VIEWED', subjectType: 'specialist_application', subjectId: id, correlationId: req.correlationId });
    reply.header('Content-Type', e.mime);
    reply.header('Content-Disposition', `inline; filename="${encodeURIComponent(e.filename)}"`);
    reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    reply.header('Cache-Control', 'no-store');
    return reply.send(buf);
  });

  /**
   * Decisão (aprovar, solicitar correção, reprovar, suspender). Aprovar exige a última conferência de prova viva,
   * identidade e inscrição como CONFERIDA. Aprovar a documentação, isoladamente, não libera atendimentos.
   */
  app.post('/api/admin/specialist-applications/:id/decision', async (req) => {
    const a = requireRoles(req, [...DECIDE_ROLES]);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const b = parse(z.object({
      decision: z.enum(['APROVADA', 'PENDENCIA', 'RECUSADA', 'SUSPENSA']),
      note: z.string().trim().min(10, 'Registre a justificativa (mínimo 10 caracteres).').max(2000),
    }).passthrough(), req.body);
    return await tx(async () => {
      const row = await one<any>('SELECT * FROM specialist_applications WHERE id = ? FOR UPDATE', id);
      if (!row) throw notFound('Candidatura não encontrada.');
      if (row.user_id === a.userId) throw forbidden('Não é permitido analisar a própria candidatura.');
      if (b.decision === 'SUSPENSA') {
        if (row.status !== 'APROVADA') throw conflict('NOT_APPROVED', 'Só é possível suspender um cadastro aprovado.');
      } else if (row.status !== 'ENVIADA') throw conflict('NOT_PENDING', 'Esta candidatura não está aguardando análise.');
      if (b.decision === 'APROVADA') {
        const { latest } = await latestChecks(id);
        const missing = REQUIRED_CHECKS.filter((k) => latest[k]?.result !== 'CONFERIDA');
        if (missing.length) throw unprocessable('VERIFICATION_REQUIRED', 'Registre como "conferida" a prova viva, a identidade e a inscrição no COREN antes de aprovar.', { missing });
        const docs = await docsOf(id);
        if (REQUIRED_DOCS.some((k) => !docs.some((d) => d.kind === k))) throw unprocessable('DOCUMENTS_REQUIRED', 'Faltam documentos obrigatórios no cadastro.');
      }
      const now = nowIso();
      const next = b.decision === 'APROVADA' ? new Date(Date.now() + revalidationDays() * 86400000).toISOString() : row.next_revalidation_at;
      await run(`UPDATE specialist_applications SET status = ?, decision_note = ?, decided_by = ?, decided_at = ?, next_revalidation_at = ?, revalidation_notified_at = ?,
        suspended_reason = ?, review_reason = ?, updated_at = ? WHERE id = ?`,
        b.decision, b.note, a.userId, now, next, b.decision === 'APROVADA' ? null : row.revalidation_notified_at, b.decision === 'SUSPENSA' ? b.note : null,
        b.decision === 'APROVADA' ? 'REVALIDACAO' : row.review_reason, now, id);
      if (b.decision === 'APROVADA') {
        await run(`INSERT INTO user_roles (user_id, role, granted_by, granted_at) VALUES (?, 'ESPECIALISTA', ?, ?) ON CONFLICT DO NOTHING`, row.user_id, a.userId, now);
        await run('UPDATE users SET academy_eligible = 1, updated_at = ? WHERE id = ?', now, row.user_id);
        await run(`INSERT INTO partner_training_status (partner_id, journey_state, updated_at) VALUES (?,?,?) ON CONFLICT (partner_id) DO NOTHING`, row.user_id, 'NAO_INICIADA', now);
      }
      const action = { APROVADA: 'APROVADA', PENDENCIA: 'CORRECAO_SOLICITADA', RECUSADA: 'RECUSADA', SUSPENSA: 'SUSPENSA' }[b.decision];
      await event(id, a.userId, action, b.note, row.review_reason);
      await audit({ actorId: a.userId, action: 'SPECIALIST_APPLICATION_DECIDED', subjectType: 'specialist_application', subjectId: id, correlationId: req.correlationId, meta: { decision: b.decision } });
      const revalidation = row.review_reason !== 'INICIAL';
      const msg = {
        APROVADA: revalidation ? ['Cadastro revalidado', 'Seus dados e documentos foram conferidos novamente. Cadastro em dia.']
          : ['Candidatura aprovada', 'Seus documentos foram validados. A ONEMA Academy está liberada: conclua a Jornada de Integração para seguir ao credenciamento final.'],
        PENDENCIA: ['Cadastro com correção solicitada', `A Central ONEMA pediu ajustes: ${b.note}`],
        RECUSADA: ['Candidatura não aprovada', `A Central ONEMA não aprovou a candidatura neste momento. Motivo: ${b.note}`],
        SUSPENSA: ['Cadastro suspenso', `Seu cadastro foi suspenso e novos atendimentos estão bloqueados até a revalidação. Motivo: ${b.note}`],
      }[b.decision]!;
      await notify(row.user_id, 'ESSENCIAL', msg[0], msg[1]);
      return { ok: true };
    });
  });
}

/**
 * Revalidação periódica (job diário): avisa 7 dias antes e suspende quando o prazo vence, bloqueando novos atendimentos.
 * O intervalo (90 dias) é proposta operacional: confirmar com RT/jurídico (PARTNER_REVALIDATION_DAYS).
 */
export async function runPartnerRevalidation(now = new Date()) {
  let suspended = 0, warned = 0;
  const soon = new Date(now.getTime() + 7 * 86400000).toISOString();
  for (const r of await all<any>(`SELECT id, user_id, next_revalidation_at FROM specialist_applications WHERE status = 'APROVADA' AND next_revalidation_at IS NOT NULL AND next_revalidation_at <= ?`, soon)) {
    if (new Date(r.next_revalidation_at) <= now) {
      const u = await run(`UPDATE specialist_applications SET status = 'SUSPENSA', suspended_reason = ?, updated_at = ? WHERE id = ? AND status = 'APROVADA'`,
        'Revalidação periódica vencida.', now.toISOString(), r.id);
      if (u.changes) {
        suspended++;
        await event(r.id, null, 'SUSPENSA', 'Revalidação periódica vencida (automático).', 'REVALIDACAO');
        await audit({ actorId: null, action: 'PARTNER_REVALIDATION_OVERDUE', subjectType: 'specialist_application', subjectId: r.id });
        await notify(r.user_id, 'ESSENCIAL', 'Revalide seu cadastro ONEMA ONE', 'O prazo de revalidação do seu cadastro venceu e novos atendimentos estão pausados. Abra "Candidatura" no app e envie para revalidação.');
      }
    } else {
      const u = await run(`UPDATE specialist_applications SET revalidation_notified_at = ? WHERE id = ? AND revalidation_notified_at IS NULL`, now.toISOString(), r.id);
      if (u.changes) {
        warned++;
        await notify(r.user_id, 'LEMBRETE', 'Revalidação do cadastro em breve', 'Seu cadastro ONEMA ONE precisa ser revalidado nos próximos dias. Confira seus dados e documentos em "Candidatura".');
      }
    }
  }
  return { suspended, warned };
}
