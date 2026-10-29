/**
 * Jornada "Solicitar cuidado" (Comando de Precificação, seção 5) e área do especialista.
 * Ordem: necessidade → atendimento → materiais → valores → onde e quando → revisão/orçamento → confirmar e pagar → comprovante.
 * Preencher a solicitação não contrata nem autoriza cobrança; a reserva do desconto PRIME acontece
 * somente em "Confirmar e pagar".
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.ts';
import { all, one, run, tx } from '../../db/db.ts';
import { NEEDS } from '../../db/content/pricing-v1.ts';
import { audit } from '../../lib/audit.ts';
import { idempotent, parse, requireRoles } from '../../lib/context.ts';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors.ts';
import { hmac, safeEqual } from '../../lib/security.ts';
import { nowIso, protocol, randomToken, uid } from '../../lib/util.ts';
import { PAYMENT_METHOD_KEYS, SANDBOX_METHODS, quote } from '../prime/core.ts';
import { cancelPayment } from '../../lib/asaas.ts';
import { newVisitCode } from './visit.ts';
import { cpfSchema } from '../../lib/cpf.ts';
import { currentVersion, offerByCode, publicOffer } from './catalog.ts';
import { applyPaymentEvent, buildQuote, patientOrderView, placeOrder } from './core.ts';

const patient = (req: any) => requireRoles(req, ['PACIENTE']);
const idParam = z.object({ id: z.string().uuid() });
const methodSchema = z.enum(PAYMENT_METHOD_KEYS);

const requestSchema = z.object({
  need: z.string().min(2).max(40),
  itemCode: z.string().min(2).max(40),
  infoText: z.string().trim().max(600).optional().default(''),
  materials: z.enum(['SIM', 'NAO', 'NAO_SEI']),
  materialsDetail: z.string().trim().max(400).optional().default(''),
  materialsSupplyRequested: z.boolean().default(false),
  patientName: z.string().trim().min(3, 'Informe o nome do paciente.').max(120),
  phone: z.string().trim().regex(/^[0-9()+\-\s]{10,20}$/, 'Informe um telefone com DDD.'),
  location: z.string().trim().min(3, 'Informe o bairro ou CEP.').max(120),
  whenPref: z.enum(['AGORA', 'HOJE', 'PROXIMOS_DIAS', 'AGENDAR']),
  whenDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().trim().max(600).optional().default(''),
  forSelf: z.boolean(),
  responsibleAuthorized: z.boolean(),
}).refine((b) => b.forSelf || b.responsibleAuthorized, { message: 'Confirme que você é responsável autorizado pelo paciente.', path: ['responsibleAuthorized'] })
  .refine((b) => b.whenPref !== 'AGENDAR' || !!b.whenDate, { message: 'Escolha a data desejada.', path: ['whenDate'] });
type RequestBody = z.infer<typeof requestSchema>;

/** Campos que alteram o orçamento: se mudarem, o aceite anterior é invalidado (P09). */
const QUOTE_FIELDS = ['need', 'itemCode', 'materials', 'materialsSupplyRequested'] as const;

function requestView(r: any, order?: any) {
  const q = JSON.parse(r.quote_json);
  return {
    id: r.id, protocol: r.protocol, status: r.status, need: r.need, itemCode: r.item_code, infoText: r.info_text,
    materials: r.materials, materialsDetail: r.materials_detail, materialsSupplyRequested: !!r.materials_supply_requested,
    patientName: r.patient_name, phone: r.phone, location: r.location, whenPref: r.when_pref, whenDate: r.when_date, notes: r.notes,
    forSelf: !!r.for_self, responsibleAuthorized: !!r.responsible_authorized,
    quote: q, quoteVersion: r.quote_version, quoteIssuedAt: r.quote_issued_at,
    acceptedVersion: r.accepted_version, acceptedAt: r.accepted_at, acceptanceValid: r.accepted_version === r.quote_version,
    order: order ? patientOrderView(order) : null, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

async function ownRequest(id: string, userId: string) {
  const r = await one<any>('SELECT * FROM care_requests WHERE id = ?', id);
  if (!r || r.requester_id !== userId) throw notFound('Solicitação não encontrada.');
  return r;
}

export async function careRoutes(app: FastifyInstance) {
  // ---------- Informativo (público): necessidades e ofertas SEM valores ----------
  // Regra comercial (Adendo v7): nenhuma cifra em páginas públicas. Preço só na etapa autorizada,
  // depois do cadastro e da qualificação da solicitação (/api/care/price exige paciente autenticado).
  app.get('/api/care/needs', async () => {
    const now = nowIso();
    const items = await all<any>('SELECT * FROM catalog_items WHERE active = 1 AND need IS NOT NULL ORDER BY sort_order, code');
    const offers: any[] = [];
    const seenCanonical = new Map<string, any>();
    for (const item of items) {
      const v = await currentVersion(item.id, now);
      if (!v) continue;
      const { priceCents: _p, primeEligible: _e, ...o } = publicOffer({ item, version: v });
      // CAT-08 e PAC-05: uma única oferta comercial mostrada uma vez, com os dois códigos.
      const prev = seenCanonical.get(o.canonicalCode);
      if (prev) { prev.alsoCodes.push(o.code); continue; }
      const entry = { ...o, alsoCodes: [] as string[] };
      seenCanonical.set(o.canonicalCode, entry);
      offers.push(entry);
    }
    return {
      needs: NEEDS.map((n) => ({ ...n, offers: offers.filter((o) => o.need === n.key) })),
      intro: 'Informe sua necessidade, escolha o atendimento e indique os materiais disponíveis. Em seguida, você verá os valores do atendimento e poderá revisar o escopo, a logística e o orçamento completo. Preencher esta solicitação não obriga você a contratar nem autoriza cobrança.',
    };
  });

  /** Etapa "Valores do atendimento": preço aprovado + desconto PRIME aplicável (logo após materiais). */
  app.get('/api/care/price', async (req) => {
    const a = patient(req);
    const { itemCode } = parse(z.object({ itemCode: z.string().min(2).max(40) }), req.query);
    const offer = await offerByCode(itemCode);
    if (!offer || !offer.item.active) throw notFound('Atendimento não disponível no catálogo.');
    const params = (await one<any>('SELECT * FROM prime_parameters ORDER BY version DESC LIMIT 1'))!;
    const pub = publicOffer(offer);
    const hypothetical = Math.min(Math.floor((pub.priceCents * params.discount_bps + 5000) / 10000), params.discount_cap_cents);
    const { _internal, ...q } = await quote(a.userId, itemCode);
    const personal = { primeActive: q.primeActive, discountCents: q.discountCents, totalCents: q.finalPriceCents, noDiscountReason: q.noDiscountReason, usesRemaining: q.usesRemaining };
    return {
      offer: pub,
      primeExample: pub.primeEligible ? { discountCents: hypothetical, totalCents: pub.priceCents - hypothetical } : null,
      prime: { monthlyPriceCents: params.monthly_price_cents, discountBps: params.discount_bps, capCents: params.discount_cap_cents },
      personal,
    };
  });

  // ---------- Paciente / titular ----------
  app.post('/api/care/requests', async (req, reply) => {
    const a = patient(req);
    const b = parse(requestSchema, req.body);
    return await idempotent(req, reply, 'care-request', async () => {
      const q = await buildQuote(a.userId, b, 1);
      const id = uid(), now = nowIso();
      await run(`INSERT INTO care_requests (id, protocol, requester_id, need, item_code, info_text, materials, materials_detail, materials_supply_requested,
           patient_name, phone, location, when_pref, when_date, notes, for_self, responsible_authorized, status, quote_version, quote_json, quote_issued_at, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, protocol('CUI'), a.userId, b.need, b.itemCode, b.infoText, b.materials, b.materialsDetail, b.materialsSupplyRequested ? 1 : 0,
        b.patientName, b.phone, b.location, b.whenPref, b.whenDate ?? null, b.notes, b.forSelf ? 1 : 0, b.responsibleAuthorized ? 1 : 0,
        q.pending ? 'ORCAMENTO_PENDENTE' : 'ORCADO', 1, JSON.stringify(q), now, now, now);
      await audit({ actorId: a.userId, action: 'CARE_REQUEST_CREATED', subjectType: 'care_request', subjectId: id, correlationId: req.correlationId, meta: { item: b.itemCode } });
      return { status: 201, body: { request: requestView((await one('SELECT * FROM care_requests WHERE id = ?', id))!) } };
    });
  });

  app.get('/api/care/requests', async (req) => {
    const a = patient(req);
    const rows = await all<any>('SELECT * FROM care_requests WHERE requester_id = ? ORDER BY created_at DESC LIMIT 100', a.userId);
    const orders = await all<any>('SELECT * FROM service_orders WHERE patient_id = ? ORDER BY created_at DESC LIMIT 200', a.userId);
    return {
      requests: rows.map((r) => requestView(r, orders.find((o) => o.request_id === r.id && o.status !== 'FAILED') ?? orders.find((o) => o.request_id === r.id))),
      orders: orders.map(patientOrderView),
    };
  });

  app.get('/api/care/requests/:id', async (req) => {
    const a = patient(req);
    const { id } = parse(idParam, req.params);
    const r = await ownRequest(id, a.userId);
    const orders = await all<any>('SELECT * FROM service_orders WHERE request_id = ? ORDER BY created_at DESC', id);
    const current = orders.find((o) => o.status !== 'FAILED') ?? orders[0];
    const events = current ? await all<any>(`SELECT e.id, e.seq, e.label, e.modality, e.status, e.completed_at, e.started_at, u.name AS specialist_name,
        CASE WHEN e.status = 'ACEITO' AND e.started_at IS NULL AND e.modality = 'PRESENCIAL' THEN e.visit_code END AS visit_code,
        (SELECT sa.coren_number || '-' || sa.coren_uf FROM specialist_applications sa WHERE sa.user_id = e.specialist_id AND sa.status = 'APROVADA') AS specialist_coren,
        (SELECT stars FROM specialist_reviews s WHERE s.event_id = e.id) AS my_stars,
        (SELECT ROUND(AVG(s.stars), 1) FROM specialist_reviews s WHERE s.specialist_id = e.specialist_id) AS specialist_rating,
        (SELECT COUNT(*) FROM specialist_reviews s WHERE s.specialist_id = e.specialist_id) AS specialist_reviews
        FROM care_events e LEFT JOIN users u ON u.id = e.specialist_id WHERE e.order_id = ? ORDER BY e.seq`, current.id) : [];
    return { request: requestView(r, current), attempts: orders.map(patientOrderView), events };
  });

  /** Edição: recalcula o orçamento; se mudou algo que afeta valores, nova versão e aceite invalidado (P09). */
  app.put('/api/care/requests/:id', async (req) => {
    const a = patient(req);
    const { id } = parse(idParam, req.params);
    const b = parse(requestSchema, req.body);
    return await tx(async () => {
      const r = await ownRequest(id, a.userId);
      if (['PEDIDO_GERADO', 'DESISTENCIA'].includes(r.status)) throw conflict('REQUEST_CLOSED', 'Esta solicitação não pode mais ser editada.');
      if (await one(`SELECT 1 AS ok FROM service_orders WHERE request_id = ? AND status = 'PENDING_PAYMENT'`, id)) {
        throw conflict('PAYMENT_PENDING', 'Há uma cobrança emitida para esta solicitação. Pague pelo link ou desista dela antes de alterar os dados.');
      }
      const prev: Record<string, any> = { need: r.need, itemCode: r.item_code, materials: r.materials, materialsSupplyRequested: !!r.materials_supply_requested };
      const affects = QUOTE_FIELDS.some((k) => prev[k] !== (b as any)[k]);
      const version = affects ? r.quote_version + 1 : r.quote_version;
      const q = await buildQuote(a.userId, b, version);
      const now = nowIso();
      await run(`UPDATE care_requests SET need = ?, item_code = ?, info_text = ?, materials = ?, materials_detail = ?, materials_supply_requested = ?, patient_name = ?, phone = ?,
           location = ?, when_pref = ?, when_date = ?, notes = ?, for_self = ?, responsible_authorized = ?, status = ?, quote_version = ?, quote_json = ?, quote_issued_at = ?,
           accepted_version = ?, accepted_at = ?, updated_at = ? WHERE id = ?`,
        b.need, b.itemCode, b.infoText, b.materials, b.materialsDetail, b.materialsSupplyRequested ? 1 : 0, b.patientName, b.phone, b.location, b.whenPref,
        b.whenDate ?? null, b.notes, b.forSelf ? 1 : 0, b.responsibleAuthorized ? 1 : 0, q.pending ? 'ORCAMENTO_PENDENTE' : 'ORCADO', version, JSON.stringify(q), now,
        null, null, now, id);
      await audit({ actorId: a.userId, action: affects ? 'CARE_QUOTE_REISSUED' : 'CARE_REQUEST_EDITED', subjectType: 'care_request', subjectId: id, correlationId: req.correlationId,
        meta: { quoteVersion: version, acceptanceInvalidated: r.accepted_version != null } });
      return { request: requestView((await one('SELECT * FROM care_requests WHERE id = ?', id))!), quoteReissued: affects, acceptanceInvalidated: r.accepted_version != null };
    });
  });

  /** Aceite do orçamento (versão exata). Não cobra nem reserva desconto. */
  app.post('/api/care/requests/:id/accept', async (req) => {
    const a = patient(req);
    const { id } = parse(idParam, req.params);
    const { quoteVersion } = parse(z.object({ quoteVersion: z.number().int().min(1) }), req.body);
    return await tx(async () => {
      const r = await ownRequest(id, a.userId);
      if (r.status === 'ORCAMENTO_PENDENTE') throw unprocessable('QUOTE_PENDING', 'O orçamento ainda está pendente. O pagamento fica bloqueado até o valor completo.');
      if (!['ORCADO', 'ACEITO'].includes(r.status)) throw conflict('REQUEST_CLOSED', 'Esta solicitação não aceita mais confirmação.');
      if (quoteVersion !== r.quote_version) throw conflict('QUOTE_OUTDATED', 'O orçamento foi atualizado. Revise os novos valores e confirme novamente.');
      const now = nowIso();
      await run(`UPDATE care_requests SET status = 'ACEITO', accepted_version = ?, accepted_at = ?, updated_at = ? WHERE id = ?`, quoteVersion, now, now, id);
      await audit({ actorId: a.userId, action: 'CARE_QUOTE_ACCEPTED', subjectType: 'care_request', subjectId: id, correlationId: req.correlationId, meta: { quoteVersion } });
      return { request: requestView((await one('SELECT * FROM care_requests WHERE id = ?', id))!) };
    });
  });

  /** "Confirmar e pagar R$ [TOTAL]": total recalculado no servidor; idempotente (duplo clique, dois aparelhos). */
  app.post('/api/care/requests/:id/checkout', async (req, reply) => {
    const a = patient(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ quoteVersion: z.number().int().min(1), paymentMethod: methodSchema, expectedTotalCents: z.number().int().min(0), payerCpf: cpfSchema.optional() }), req.body);
    return await idempotent(req, reply, `care-checkout:${id}`, async () => {
      const r = await one<any>('SELECT * FROM care_requests WHERE id = ? FOR UPDATE', id);
      if (!r || r.requester_id !== a.userId) throw notFound('Solicitação não encontrada.');
      if (r.status === 'PEDIDO_GERADO') throw conflict('ALREADY_PAID', 'Esta solicitação já tem pedido pago. Nenhuma nova cobrança foi feita.');
      // Cobrança do Asaas já emitida e ainda não paga: devolve o mesmo link (nunca cria segunda cobrança).
      const pending = await one<any>(`SELECT * FROM service_orders WHERE request_id = ? AND status = 'PENDING_PAYMENT'`, id);
      if (pending?.payment_url) {
        return { status: 200, body: { paid: false, pending: true, paymentUrl: pending.payment_url, order: patientOrderView(pending),
          message: 'Sua cobrança já foi emitida. Conclua o pagamento na página segura do Asaas.' } };
      }
      if (r.status === 'ORCAMENTO_PENDENTE') throw unprocessable('QUOTE_PENDING', 'Orçamento pendente: pagamento bloqueado até o valor completo.');
      if (r.status !== 'ACEITO' || r.accepted_version !== r.quote_version) throw conflict('ACCEPTANCE_REQUIRED', 'Confirme o orçamento atualizado antes de pagar.');
      if (b.quoteVersion !== r.quote_version) throw conflict('QUOTE_OUTDATED', 'O orçamento foi atualizado. Revise os novos valores e confirme novamente.');
      const accepted = JSON.parse(r.quote_json);
      const res = await placeOrder({
        patientId: a.userId, itemCode: r.item_code, paymentMethod: b.paymentMethod, expectedTotalCents: b.expectedTotalCents, payerCpf: b.payerCpf ?? null,
        request: { id, location: r.location, acceptedSnapshot: { protocol: r.protocol, quoteVersion: r.quote_version, acceptedAt: r.accepted_at, materials: r.materials, whenPref: r.when_pref, whenDate: r.when_date, totalCents: accepted.totalCents } },
        correlationId: req.correlationId,
      });
      return {
        status: 201, body: {
          paid: res.paid, pending: !!res.paymentUrl, paymentUrl: res.paymentUrl, order: patientOrderView(res.order),
          message: res.paymentUrl ? 'Cobrança emitida. Conclua o pagamento na página segura do Asaas (Pix, boleto ou cartão).'
            : res.paid ? 'Pagamento confirmado (simulação). Seu pedido foi registrado.' : 'Pagamento não confirmado. Nenhum valor foi cobrado e o desconto PRIME não foi consumido. Tente novamente.',
        },
      };
    });
  });

  app.post('/api/care/requests/:id/cancel', async (req) => {
    const a = patient(req);
    const { id } = parse(idParam, req.params);
    return await tx(async () => {
      const r = await ownRequest(id, a.userId);
      if (r.status === 'PEDIDO_GERADO') throw conflict('REQUEST_CLOSED', 'Pedido já pago: use a solicitação de estorno pela Central.');
      // Desistência com cobrança do Asaas em aberto: cancela a cobrança e libera o desconto PRIME reservado.
      const pending = await one<any>(`SELECT * FROM service_orders WHERE request_id = ? AND status = 'PENDING_PAYMENT'`, id);
      if (pending) {
        if (pending.provider === 'ASAAS' && pending.provider_ref) await cancelPayment(pending.provider_ref);
        await applyPaymentEvent({ eventId: `withdraw_${pending.id}`, orderId: pending.id, type: 'PAYMENT_DECLINED', actorId: a.userId }, req.correlationId);
      }
      await run(`UPDATE care_requests SET status = 'DESISTENCIA', updated_at = ? WHERE id = ?`, nowIso(), id);
      await audit({ actorId: a.userId, action: 'CARE_REQUEST_WITHDRAWN', subjectType: 'care_request', subjectId: id, correlationId: req.correlationId });
      return { ok: true };
    });
  });

  /**
   * Carteira Digital (visão do titular): somente eventos efetivamente registrados na plataforma —
   * próximos atendimentos, atendimentos realizados, pedidos e comprovantes. Sem inferência clínica;
   * documentos clínicos assinados dependem da integração com o sistema oficial da Carteira.
   */
  app.get('/api/care/wallet', async (req) => {
    const a = patient(req);
    const events = await all<any>(`SELECT e.id, e.label, e.modality, e.status, e.accepted_at, e.completed_at, o.item_code, o.item_name, o.id AS order_id,
        r.id AS request_id, r.when_pref, r.when_date, u.name AS specialist_name, (SELECT stars FROM specialist_reviews s WHERE s.event_id = e.id) AS my_stars
        FROM care_events e JOIN service_orders o ON o.id = e.order_id LEFT JOIN care_requests r ON r.id = o.request_id LEFT JOIN users u ON u.id = e.specialist_id
        WHERE o.patient_id = ? AND o.status IN ('PAID','REFUNDED') ORDER BY e.created_at DESC, e.seq LIMIT 300`, a.userId);
    const open = await all<any>(`SELECT id, protocol, status, item_code, quote_json, created_at FROM care_requests WHERE requester_id = ? AND status IN ('ORCADO','ORCAMENTO_PENDENTE','ACEITO') ORDER BY created_at DESC`, a.userId);
    const receipts = await all<any>('SELECT id, kind, protocol, text, created_at FROM prime_receipts WHERE patient_id = ? ORDER BY created_at DESC LIMIT 50', a.userId);
    return {
      upcoming: events.filter((e) => e.status === 'ACEITO' || e.status === 'DISPONIVEL'),
      done: events.filter((e) => e.status === 'CONCLUIDO'),
      pendingRequests: open.map((r) => ({ id: r.id, protocol: r.protocol, status: r.status, itemName: JSON.parse(r.quote_json).offer.name, createdAt: r.created_at })),
      receipts,
      // Evoluções de enfermagem assinadas pela especialista (registro clínico do titular).
      clinicalDocuments: (await all<any>(`SELECT v.id, v.signed_at, v.content_json, e.label, o.item_name, u.name AS specialist_name,
          (SELECT sa.coren_number || '-' || sa.coren_uf FROM specialist_applications sa WHERE sa.user_id = v.specialist_id AND sa.status = 'APROVADA') AS specialist_coren
          FROM care_evolutions v JOIN care_events e ON e.id = v.event_id JOIN service_orders o ON o.id = v.order_id JOIN users u ON u.id = v.specialist_id
          WHERE v.patient_id = ? AND v.status = 'ASSINADA' ORDER BY v.signed_at DESC LIMIT 100`, a.userId))
        .map((d) => ({ id: d.id, signedAt: d.signed_at, label: d.label, itemName: d.item_name, specialist: d.specialist_name, coren: d.specialist_coren, content: JSON.parse(d.content_json) })),
    };
  });

  /** Avaliação por estrelas do atendimento concluído (separada das notas da Academy). */
  app.post('/api/care/events/:id/review', async (req) => {
    const a = patient(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ stars: z.number().int().min(1).max(5), comment: z.string().trim().max(400).optional().default(''), nps: z.number().int().min(0).max(10).optional() }), req.body);
    return await tx(async () => {
      const e = await one<any>(`SELECT e.*, o.patient_id FROM care_events e JOIN service_orders o ON o.id = e.order_id WHERE e.id = ?`, id);
      if (!e || e.patient_id !== a.userId) throw notFound('Atendimento não encontrado.');
      if (e.status !== 'CONCLUIDO' || !e.specialist_id) throw unprocessable('NOT_COMPLETED', 'Só é possível avaliar atendimentos concluídos.');
      if (await one('SELECT 1 FROM specialist_reviews WHERE event_id = ?', id)) throw conflict('ALREADY_REVIEWED', 'Este atendimento já foi avaliado.');
      await run('INSERT INTO specialist_reviews (id, event_id, specialist_id, patient_id, stars, comment, created_at) VALUES (?,?,?,?,?,?,?)',
        uid(), id, e.specialist_id, a.userId, b.stars, b.comment, nowIso());
      // Recomendação da ONEMA (0 a 10), opcional e separada das estrelas da especialista.
      if (b.nps !== undefined) await run('INSERT INTO nps_responses (id, patient_id, event_id, score, created_at) VALUES (?,?,?,?,?) ON CONFLICT (event_id) DO NOTHING', uid(), a.userId, id, b.nps, nowIso());
      await audit({ actorId: a.userId, action: 'SPECIALIST_REVIEWED', subjectType: 'care_event', subjectId: id, correlationId: req.correlationId, meta: { stars: b.stars, nps: b.nps ?? null } });
      return { ok: true };
    });
  });

  /** Indicação: link pessoal do paciente para recomendar a ONEMA (sem benefício financeiro definido). */
  app.get('/api/care/referral', async (req) => {
    const a = patient(req);
    let u = (await one<any>('SELECT referral_code FROM users WHERE id = ?', a.userId))!;
    if (!u.referral_code) {
      for (let i = 0; i < 5 && !u.referral_code; i++) {
        const code = randomToken(6).replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase();
        if (code.length < 6) continue;
        try { await run('UPDATE users SET referral_code = ? WHERE id = ? AND referral_code IS NULL', code, a.userId); } catch { /* colisão: tenta outro */ }
        u = (await one<any>('SELECT referral_code FROM users WHERE id = ?', a.userId))!;
      }
    }
    const count = (await one<any>('SELECT COUNT(*) AS n FROM users WHERE referred_by = ?', a.userId))!.n;
    return { code: u.referral_code, link: `${config.publicOrigin}/?indicacao=${u.referral_code}`, referrals: Number(count) };
  });

  // ---------- Especialista (ONEMA ONE) ----------
  /** Ofertas só para especialista com decisão humana de credenciamento APTO (após a Academy e os demais requisitos). */
  const credentialed = async (userId: string) =>
    (await one<any>('SELECT credentialing_decision FROM partner_training_status WHERE partner_id = ?', userId))?.credentialing_decision === 'APTO';
  // Ambiente publicado: contas de demonstração (senha pública) só atendem pedidos de pacientes de demonstração.
  const demoOnly = (a: { email: string }) => config.blockDemoStaff && /@exemplo\.test$/i.test(a.email);
  const DEMO_PATIENT_SQL = `AND EXISTS (SELECT 1 FROM users pu WHERE pu.id = o.patient_id AND pu.email LIKE '%@exemplo.test')`;
  const specialist = async (req: any) => {
    const a = requireRoles(req, ['ESPECIALISTA']);
    if (!(await credentialed(a.userId))) throw forbidden('Seu perfil ainda não foi credenciado pela Central ONEMA para receber ofertas.', 'NOT_CREDENTIALED');
    return a;
  };

  app.get('/api/care/specialist/summary', async (req) => {
    const a = requireRoles(req, ['ESPECIALISTA']);
    const rating = await one<any>('SELECT COUNT(*) AS n, AVG(stars) AS avg FROM specialist_reviews WHERE specialist_id = ?', a.userId);
    const payouts = await all<any>(`SELECT status, COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS total FROM payout_entries WHERE specialist_id = ? GROUP BY status`, a.userId);
    const training = await one<any>('SELECT journey_state, credentialing_decision FROM partner_training_status WHERE partner_id = ?', a.userId);
    return {
      eligible: training?.credentialing_decision === 'APTO',
      journeyState: training?.journey_state ?? 'NAO_INICIADA',
      credentialing: training?.credentialing_decision ?? 'PENDENTE',
      rating: { count: rating?.n ?? 0, average: rating?.avg != null ? Math.round(Number(rating.avg) * 10) / 10 : null },
      payouts,
      note: 'Avaliações por estrelas são dos atendimentos e ficam separadas das notas da ONEMA Academy.',
    };
  });

  /** Ofertas: evento, ato, requisitos e repasse integral. Sem preço ao paciente, desconto ou margem. */
  app.get('/api/care/specialist/offers', async (req) => {
    const a = await specialist(req);
    const offers = await all<any>(`SELECT e.id, e.label, e.act_type, e.modality, e.unit_payout_cents, e.region, e.created_at, o.item_code, o.item_name,
        r.when_pref, r.when_date, r.materials FROM care_events e JOIN service_orders o ON o.id = e.order_id LEFT JOIN care_requests r ON r.id = o.request_id
        WHERE e.status = 'DISPONIVEL' AND o.status = 'PAID' ${demoOnly(a) ? DEMO_PATIENT_SQL : ''} ORDER BY e.created_at, e.seq LIMIT 100`);
    const mine = await all<any>(`SELECT e.id, e.label, e.modality, e.unit_payout_cents, e.region, e.status, e.accepted_at, e.completed_at, e.started_at, o.item_code, o.item_name,
        (SELECT v.status FROM care_evolutions v WHERE v.event_id = e.id) AS evolution_status,
        p.status AS payout_status, (SELECT stars FROM specialist_reviews s WHERE s.event_id = e.id) AS stars
        FROM care_events e JOIN service_orders o ON o.id = e.order_id LEFT JOIN payout_entries p ON p.event_id = e.id
        WHERE e.specialist_id = ? ORDER BY e.accepted_at DESC LIMIT 100`, a.userId);
    return { offers, mine, rule: 'Aceite livre e recusa sem penalidade. O mesmo enfermeiro não é obrigatório em todos os eventos do pacote.' };
  });

  app.post('/api/care/specialist/events/:id/accept', async (req) => {
    const a = await specialist(req);
    const { id } = parse(idParam, req.params);
    return await tx(async () => {
      const now = nowIso();
      if (demoOnly(a) && !(await one(`SELECT 1 AS ok FROM care_events e JOIN service_orders o ON o.id = e.order_id WHERE e.id = ? ${DEMO_PATIENT_SQL}`, id))) {
        throw conflict('OFFER_UNAVAILABLE', 'Esta oferta não está mais disponível.');
      }
      const r = await run(`UPDATE care_events SET status = 'ACEITO', specialist_id = ?, accepted_at = ?, visit_code = ?, updated_at = ? WHERE id = ? AND status = 'DISPONIVEL'`, a.userId, now, newVisitCode(), now, id);
      if (!r.changes) throw conflict('OFFER_UNAVAILABLE', 'Esta oferta não está mais disponível.');
      await run('UPDATE payout_entries SET specialist_id = ?, updated_at = ? WHERE event_id = ?', a.userId, now, id);
      await audit({ actorId: a.userId, action: 'CARE_EVENT_ACCEPTED', subjectType: 'care_event', subjectId: id, correlationId: req.correlationId });
      return { ok: true };
    });
  });

  app.post('/api/care/specialist/events/:id/complete', async (req) => {
    const a = await specialist(req);
    const { id } = parse(idParam, req.params);
    return await tx(async () => {
      const now = nowIso();
      const ev = await one<any>(`SELECT e.modality, e.started_at, (SELECT status FROM care_evolutions v WHERE v.event_id = e.id) AS evolution FROM care_events e WHERE e.id = ? AND e.specialist_id = ?`, id, a.userId);
      if (ev?.modality === 'PRESENCIAL' && !ev.started_at) throw unprocessable('VISIT_NOT_STARTED', 'Inicie o atendimento com o código do paciente antes de concluir.');
      if (ev && ev.evolution !== 'ASSINADA') throw unprocessable('EVOLUTION_REQUIRED', 'Registre e assine a evolução de enfermagem antes de concluir o atendimento.');
      const r = await run(`UPDATE care_events SET status = 'CONCLUIDO', completed_at = ?, updated_at = ? WHERE id = ? AND status = 'ACEITO' AND specialist_id = ?`, now, now, id, a.userId);
      if (!r.changes) throw conflict('EVENT_NOT_ACCEPTED', 'Só é possível concluir um atendimento aceito por você.');
      // Liquidação segue o mecanismo aprovado da operação: aqui o repasse fica "a liquidar" (sem nova regra).
      await run(`UPDATE payout_entries SET status = 'A_LIQUIDAR', updated_at = ? WHERE event_id = ? AND status = 'RESERVADO'`, now, id);
      await audit({ actorId: a.userId, action: 'CARE_EVENT_COMPLETED', subjectType: 'care_event', subjectId: id, correlationId: req.correlationId });
      return { ok: true };
    });
  });

  // ---------- Webhook do provedor (sandbox; contrato do provedor real — Asaas — pendente de CNPJ) ----------
  app.post('/api/care/payment-webhooks', { config: { public: true } }, async (req) => {
    const sig = String(req.headers['x-onema-signature'] ?? '');
    const raw = JSON.stringify(req.body ?? {});
    if (!config.paymentWebhookSecret || !safeEqual(hmac(raw, config.paymentWebhookSecret), sig)) throw forbidden('Assinatura inválida.', 'INVALID_SIGNATURE');
    const ev = parse(z.object({
      eventId: z.string().min(4).max(100), orderId: z.string().uuid(),
      type: z.enum(['PAYMENT_CONFIRMED', 'PAYMENT_DECLINED', 'PAYMENT_REFUNDED']),
    }), req.body);
    return await tx(async () => await applyPaymentEvent(ev, req.correlationId));
  });
}
