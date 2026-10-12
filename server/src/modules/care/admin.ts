/**
 * Central Operacional / RT / Financeiro: tabela comercial completa (com repasses), novas versões
 * com RBAC + motivo + vigência + auditoria, conciliação, estorno e autoteste da precificação.
 * Repasses e margens só aparecem aqui (perfis autorizados) — nunca em rotas públicas ou do paciente.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, one, tx } from '../../db/db.ts';
import { EXPECTED_PAYOUT, PRICING_SOURCE, PRICING_V1, REPORT_PARAMS, SECTION7_REFERENCE } from '../../db/content/pricing-v1.ts';
import { audit } from '../../lib/audit.ts';
import { parse, requireRoles } from '../../lib/context.ts';
import { conflict, notFound, unprocessable } from '../../lib/errors.ts';
import { brl, nowIso, uid } from '../../lib/util.ts';
import { currentParams, discountFor } from '../prime/core.ts';
import { components, currentVersion, insertVersion, syncItemSummary } from './catalog.ts';
import { applyPaymentEvent, contribution } from './core.ts';

const VIEW_PRICING = ['ADMIN_PRIME', 'FINANCEIRO', 'AVALIADOR_RT', 'AUDITOR'] as const;
const EDIT_PRICING = ['ADMIN_PRIME', 'FINANCEIRO'] as const;
const VIEW_OPS = ['OPERADOR_CENTRAL', 'ADMIN_PRIME', 'FINANCEIRO', 'AVALIADOR_RT', 'AUDITOR'] as const;

const versionSchema = z.object({
  priceCents: z.number().int().min(1),
  primeEligible: z.boolean(),
  actsLabel: z.string().trim().min(2).max(120),
  periodDays: z.number().int().min(1).max(366).nullable(),
  recurring: z.enum(['MENSAL']).nullable(),
  inclusions: z.array(z.string().trim().min(2).max(300)).max(20),
  exclusions: z.array(z.string().trim().min(2).max(300)).max(20),
  validFrom: z.string().datetime(),
  reason: z.string().trim().min(10, 'Descreva o motivo da nova versão (mínimo 10 caracteres).').max(500),
  components: z.array(z.object({
    act: z.string().trim().regex(/^[A-Z_]{3,40}$/), label: z.string().trim().min(2).max(120), modality: z.enum(['PRESENCIAL', 'REMOTO']),
    qty: z.number().int().min(1).max(60), unit: z.number().int().min(0), unitLabels: z.array(z.string().trim().min(2).max(80)).nullable().optional(),
  })).min(1).max(10),
});

export async function careAdminRoutes(app: FastifyInstance) {
  // ---------- Tabela comercial completa ----------
  app.get('/api/admin/care/catalog', async (req) => {
    requireRoles(req, [...VIEW_PRICING]);
    const now = nowIso();
    const params = await currentParams();
    const items = await all<any>('SELECT * FROM catalog_items WHERE need IS NOT NULL ORDER BY sort_order, code');
    const out = [];
    for (const it of items) {
      const versions = await all<any>(`SELECT v.*, u.name AS created_by_name FROM catalog_item_versions v LEFT JOIN users u ON u.id = v.created_by
        WHERE v.catalog_item_id = ? ORDER BY v.version DESC`, it.id);
      const cur = await currentVersion(it.id, now);
      const discount = cur?.prime_eligible ? discountFor(cur.price_cents, params.discount_bps, params.discount_cap_cents) : 0;
      out.push({
        id: it.id, code: it.code, name: it.name, kind: it.kind, need: it.need, canonicalCode: it.canonical_code, active: !!it.active,
        current: cur ? {
          versionNo: cur.version, priceCents: cur.price_cents, payoutTotalCents: cur.payout_total_cents, actsTotal: cur.acts_total, actsLabel: cur.acts_label,
          primeEligible: !!cur.prime_eligible, periodDays: cur.period_days, recurring: cur.recurring, validFrom: cur.valid_from,
          inclusions: JSON.parse(cur.inclusions_json), exclusions: JSON.parse(cur.exclusions_json), components: await components(cur.id),
          primeDiscountCents: discount, primeTotalCents: cur.price_cents - discount,
          contributionFull: contribution(cur.price_cents, cur.payout_total_cents, cur.acts_total),
          contributionPrime: contribution(cur.price_cents - discount, cur.payout_total_cents, cur.acts_total),
        } : null,
        versions: versions.map((v) => ({
          versionNo: v.version, priceCents: v.price_cents, payoutTotalCents: v.payout_total_cents, actsTotal: v.acts_total, primeEligible: !!v.prime_eligible,
          validFrom: v.valid_from, reason: v.reason, source: v.source, createdBy: v.created_by_name ?? 'Carga oficial', createdAt: v.created_at,
          state: cur?.id === v.id ? 'VIGENTE' : v.valid_from > now ? 'AGENDADA' : 'SUBSTITUIDA',
        })),
      });
    }
    return { items: out, reportParams: REPORT_PARAMS, prime: { monthlyPriceCents: params.monthly_price_cents, discountBps: params.discount_bps, capCents: params.discount_cap_cents, usesPerCycle: params.uses_per_cycle } };
  });

  /** Nova versão: não altera pedidos já contratados (cada pedido guarda sua cópia). */
  app.post('/api/admin/care/catalog/:code/versions', async (req) => {
    const a = requireRoles(req, [...EDIT_PRICING]);
    const { code } = parse(z.object({ code: z.string().regex(/^[A-Z0-9-]{2,40}$/) }), req.params);
    const b = parse(versionSchema, req.body);
    return await tx(async () => {
      const item = await one<any>('SELECT * FROM catalog_items WHERE code = ? FOR UPDATE', code);
      if (!item || !item.need) throw notFound('Registro comercial não encontrado.');
      const cur = await currentVersion(item.id);
      if (b.validFrom < nowIso() && cur && b.validFrom < cur.valid_from) throw unprocessable('INVALID_VALIDITY', 'A vigência não pode ser anterior à versão atual.');
      // CAT-08 e PAC-05: mesma oferta comercial — preço e repasse precisam permanecer idênticos entre as visões.
      const twins = await all<any>('SELECT * FROM catalog_items WHERE canonical_code = ? AND id <> ?', item.canonical_code, item.id);
      const r = await insertVersion(item.id, { ...b, recurring: b.recurring, components: b.components.map((c) => ({ ...c, unitLabels: c.unitLabels ?? null })) }, a.userId);
      for (const t of twins) {
        const tv = await currentVersion(t.id, b.validFrom);
        if (tv && (tv.price_cents !== b.priceCents || tv.payout_total_cents !== r.payoutTotalCents)) {
          throw conflict('CANONICAL_MISMATCH', `${code} e ${t.code} são a mesma oferta comercial: cadastre a mesma versão nas duas visões (preço e repasse idênticos).`, { twin: t.code });
        }
      }
      await syncItemSummary(item.id);
      await audit({ actorId: a.userId, action: 'PRICE_VERSION_CREATED', subjectType: 'catalog_item', subjectId: item.id, correlationId: req.correlationId,
        before: cur ? { price: cur.price_cents, payout: cur.payout_total_cents, eligible: cur.prime_eligible } : null,
        after: { price: b.priceCents, payout: r.payoutTotalCents, eligible: b.primeEligible },
        meta: { code, version: r.version, validFrom: b.validFrom, reason: b.reason } });
      return { version: r.version, payoutTotalCents: r.payoutTotalCents, actsTotal: r.actsTotal };
    });
  });

  /** Mesma versão nas duas visões da oferta canônica (CAT-08/PAC-05) numa única transação. */
  app.post('/api/admin/care/canonical/:canonical/versions', async (req) => {
    const a = requireRoles(req, [...EDIT_PRICING]);
    const { canonical } = parse(z.object({ canonical: z.string().regex(/^[A-Z0-9-]{2,60}$/) }), req.params);
    const b = parse(versionSchema, req.body);
    return await tx(async () => {
      const items = await all<any>('SELECT * FROM catalog_items WHERE canonical_code = ? ORDER BY code FOR UPDATE', canonical);
      if (items.length < 2) throw notFound('Oferta canônica não encontrada.');
      const out = [];
      for (const it of items) {
        const r = await insertVersion(it.id, { ...b, components: b.components.map((c) => ({ ...c, unitLabels: c.unitLabels ?? null })) }, a.userId);
        await syncItemSummary(it.id);
        out.push({ code: it.code, version: r.version });
        await audit({ actorId: a.userId, action: 'PRICE_VERSION_CREATED', subjectType: 'catalog_item', subjectId: it.id, correlationId: req.correlationId,
          after: { price: b.priceCents, payout: r.payoutTotalCents }, meta: { code: it.code, version: r.version, canonical, reason: b.reason } });
      }
      return { versions: out };
    });
  });

  // ---------- Operação ----------
  app.get('/api/admin/care/overview', async (req) => {
    const a = requireRoles(req, [...VIEW_OPS]);
    const finance = a.roles.some((r) => (VIEW_PRICING as readonly string[]).includes(r));
    const requests = await all<any>(`SELECT r.id, r.protocol, r.status, r.need, r.item_code, r.location, r.when_pref, r.when_date, r.materials, r.materials_supply_requested,
        r.quote_version, r.accepted_version, r.created_at, u.name AS requester_name FROM care_requests r JOIN users u ON u.id = r.requester_id ORDER BY r.created_at DESC LIMIT 200`);
    const orders = await all<any>(`SELECT o.id, o.item_code, o.item_name, o.version_no, o.status, o.full_price_cents, o.discount_cents, o.final_price_cents, o.payout_total_cents,
        o.acts_total, o.billing_period, o.provider_ref, o.created_at, o.paid_at, o.refunded_at, u.name AS patient_name,
        (SELECT COUNT(*) FROM care_events e WHERE e.order_id = o.id) AS events,
        (SELECT COUNT(*) FROM care_events e WHERE e.order_id = o.id AND e.status = 'CONCLUIDO') AS events_done
        FROM service_orders o JOIN users u ON u.id = o.patient_id ORDER BY o.created_at DESC LIMIT 200`);
    const events = await all<any>(`SELECT e.id, e.label, e.modality, e.status, e.region, e.unit_payout_cents, o.item_code, s.name AS specialist_name, e.accepted_at, e.completed_at
        FROM care_events e JOIN service_orders o ON o.id = e.order_id LEFT JOIN users s ON s.id = e.specialist_id ORDER BY e.created_at DESC, e.seq LIMIT 300`);
    const ratings = await all<any>(`SELECT u.name, COUNT(r.id) AS n, ROUND(AVG(r.stars)::numeric, 1) AS avg FROM specialist_reviews r JOIN users u ON u.id = r.specialist_id GROUP BY u.name ORDER BY u.name`);
    const counts = await one<any>(`SELECT
        (SELECT COUNT(*) FROM care_requests WHERE status IN ('ORCADO','ACEITO')) AS open_requests,
        (SELECT COUNT(*) FROM care_requests WHERE status = 'ORCAMENTO_PENDENTE') AS pending_quotes,
        (SELECT COUNT(*) FROM service_orders WHERE status = 'PAID') AS paid_orders,
        (SELECT COUNT(*) FROM care_events WHERE status = 'DISPONIVEL') AS open_events,
        (SELECT COUNT(*) FROM care_events WHERE status = 'ACEITO') AS scheduled_events`);
    return {
      counts, requests, events: finance ? events : events.map(({ unit_payout_cents, ...e }) => e), ratings,
      orders: finance ? orders : orders.map(({ payout_total_cents, ...o }) => o),
    };
  });

  /** Conciliação (P14): serviço, desconto, repasse, estorno e assinatura separados; sem duplicidade. */
  app.get('/api/admin/care/reconciliation', async (req) => {
    requireRoles(req, [...VIEW_PRICING]);
    const orders = await all<any>(`SELECT o.*, u.name AS patient_name,
        (SELECT COUNT(*) FROM care_payment_events p WHERE p.order_id = o.id) AS provider_events,
        (SELECT COUNT(*) FROM care_payment_events p WHERE p.order_id = o.id AND p.applied = 0) AS ignored_events,
        (SELECT COALESCE(SUM(amount_cents),0) FROM payout_entries p WHERE p.order_id = o.id AND p.status <> 'CANCELADO') AS payout_active_cents,
        (SELECT COUNT(*) FROM payout_entries p WHERE p.order_id = o.id) AS payout_rows,
        (SELECT COUNT(*) FROM care_events e WHERE e.order_id = o.id) AS event_rows,
        (SELECT status FROM discount_reservations d WHERE d.order_id = o.id ORDER BY d.created_at DESC LIMIT 1) AS discount_status
        FROM service_orders o JOIN users u ON u.id = o.patient_id WHERE o.version_id IS NOT NULL ORDER BY o.created_at DESC LIMIT 500`);
    const rows = orders.map((o) => {
      const received = o.status === 'PAID' ? o.final_price_cents : 0;
      const c = contribution(received, o.status === 'PAID' ? o.payout_total_cents : 0, o.status === 'PAID' ? o.acts_total : 0);
      return {
        id: o.id, patient: o.patient_name, item: o.item_code, version: o.version_no, status: o.status, basePriceCents: o.full_price_cents,
        discountCents: o.discount_cents, receivedCents: received, payoutTotalCents: o.payout_total_cents, payoutActiveCents: o.payout_active_cents,
        acts: o.acts_total, events: o.event_rows, payoutRows: o.payout_rows, providerEvents: o.provider_events, ignoredEvents: o.ignored_events,
        discountStatus: o.discount_status, refundedCents: o.status === 'REFUNDED' ? o.final_price_cents : 0,
        contribution: o.status === 'PAID' ? c : null,
        checks: {
          payoutEqualsComposition: o.status !== 'PAID' || o.payout_active_cents === o.payout_total_cents,
          oneEventPerAct: o.event_rows === o.acts_total,
          noDuplicatePayout: o.payout_rows <= o.acts_total,
        },
      };
    });
    const subs = await one<any>(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS total FROM charges WHERE status = 'CONFIRMED'`);
    const paid = rows.filter((r) => r.status === 'PAID');
    return {
      rows,
      totals: {
        servicesReceivedCents: paid.reduce((s, r) => s + r.receivedCents, 0),
        discountsCents: paid.reduce((s, r) => s + r.discountCents, 0),
        payoutsCents: paid.reduce((s, r) => s + r.payoutActiveCents, 0),
        refundsCents: rows.reduce((s, r) => s + r.refundedCents, 0),
        primeSubscriptionCents: subs.total, primeSubscriptionCharges: subs.n,
      },
      fiscal: { connector: 'SIMULADO', note: 'Emissão fiscal e split não configurados neste ambiente (credenciais do provedor e do emissor fiscal pendentes). Nenhuma taxa de nota fiscal é criada.' },
      formula: `contribuição = valor recebido − repasse − arredondar(valor recebido × ${REPORT_PARAMS.rateBps / 100}%) − atos × R$ ${(REPORT_PARAMS.opCostPerActCents / 100).toFixed(2).replace('.', ',')}. Não é lucro líquido.`,
    };
  });

  /** Estorno total pelo Financeiro (simulado): mesmo caminho do evento do provedor (P06). */
  app.post('/api/admin/care/orders/:id/refund', async (req) => {
    const a = requireRoles(req, ['FINANCEIRO', 'ADMIN_PRIME']);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(300) }), req.body);
    return await tx(async () => {
      const o = await one<any>('SELECT status FROM service_orders WHERE id = ?', id);
      if (!o) throw notFound('Pedido não encontrado.');
      if (o.status !== 'PAID') throw conflict('NOT_REFUNDABLE', 'Somente pedidos pagos podem ser estornados.');
      const r = await applyPaymentEvent({ eventId: `refund_${id}`, orderId: id, type: 'PAYMENT_REFUNDED', actorId: a.userId }, req.correlationId);
      await audit({ actorId: a.userId, action: 'REFUND_REQUESTED', subjectType: 'service_order', subjectId: id, correlationId: req.correlationId, meta: { reason } });
      return r;
    });
  });

  /** Autoteste ao vivo da configuração vigente (P01–P04) para conferência do RT na própria Central. */
  app.get('/api/admin/care/selfcheck', async (req) => {
    requireRoles(req, [...VIEW_PRICING]);
    const params = await currentParams();
    const items = await all<any>('SELECT * FROM catalog_items WHERE need IS NOT NULL AND active = 1');
    const results: { id: string; title: string; pass: boolean; details: string[] }[] = [];
    const cur = new Map<string, any>();
    for (const it of items) cur.set(it.code, { item: it, v: await currentVersion(it.id) });
    const serv = items.filter((i) => i.kind === 'SERVICO').length, pac = items.filter((i) => i.kind === 'PACOTE').length;
    const canon = new Set(items.filter((i) => i.code === 'CAT-08' || i.code === 'PAC-05').map((i) => i.canonical_code));
    const priceDiffs = PRICING_V1.filter((d) => cur.get(d.code)?.v?.price_cents !== d.price).map((d) => `${d.code}: preço vigente ${brl(cur.get(d.code)?.v?.price_cents ?? 0)} ≠ comando ${brl(d.price)} (versão nova registrada pelo painel)`);
    results.push({ id: 'P01', title: 'Carga dos registros (11 serviços + 8 pacotes; monitoramento canônico)', pass: serv === 11 && pac === 8 && canon.size === 1 && !priceDiffs.length,
      details: [`Serviços/continuidade: ${serv}`, `Pacotes: ${pac}`, `CAT-08/PAC-05 → identidade única: ${[...canon].join(', ')}`, ...priceDiffs] });
    const p2: string[] = [];
    for (const code of ['PAC-01', 'PAC-02', 'PAC-03']) {
      const v = cur.get(code)?.v; const [payout, acts] = EXPECTED_PAYOUT[code];
      p2.push(`${code}: ${v?.acts_total} atos, repasse ${brl(v?.payout_total_cents ?? 0)} (esperado ${acts} atos / ${brl(payout)})`);
      if (!v || v.acts_total !== acts || v.payout_total_cents !== payout) p2.push(`DIVERGENTE: ${code}`);
    }
    results.push({ id: 'P02', title: 'Pós-alta 7/14/30 dias: 2/4/6 atos; R$ 220/440/660', pass: !p2.some((d) => d.startsWith('DIVERGENTE')), details: p2 });
    const p3: string[] = [];
    for (const [code, x] of cur) {
      if (!x.v) { p3.push(`${code}: sem versão vigente`); continue; }
      const comps = await components(x.v.id);
      const payout = comps.reduce((s: number, c: any) => s + c.qty * c.unit, 0), acts = comps.reduce((s: number, c: any) => s + c.qty, 0);
      const [ep, ea] = EXPECTED_PAYOUT[code] ?? [payout, acts];
      if (payout !== x.v.payout_total_cents || acts !== x.v.acts_total) p3.push(`${code}: soma da composição diverge do total gravado`);
      if (ep !== payout || ea !== acts) p3.push(`${code}: composição vigente difere do comando (${acts} atos / ${payout}) — esperado ${ea} / ${ep}`);
    }
    results.push({ id: 'P03', title: 'Composição: soma de quantidades e repasses exata', pass: !p3.length, details: p3.length ? p3 : ['19 registros conferidos.'] });
    const p4: string[] = [];
    for (const [code, [full, disc, fin]] of Object.entries(SECTION7_REFERENCE)) {
      const v = cur.get(code)?.v;
      const d = v?.prime_eligible ? discountFor(v.price_cents, params.discount_bps, params.discount_cap_cents) : 0;
      if (!v || v.price_cents !== full || d !== disc || v.price_cents - d !== fin) p4.push(`${code}: calculado ${brl(v?.price_cents ?? 0)} − ${brl(d)} = ${brl((v?.price_cents ?? 0) - d)} ≠ referência ${brl(full)} − ${brl(disc)} = ${brl(fin)}`);
    }
    results.push({ id: 'P04', title: 'Descontos da seção 7 (5%, teto R$ 20, centavos)', pass: !p4.length, details: p4.length ? p4 : ['19 exemplos conferidos.'] });
    return { checkedAt: nowIso(), source: PRICING_SOURCE, results, runId: uid() };
  });
}
