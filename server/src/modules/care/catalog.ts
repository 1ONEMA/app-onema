/**
 * Catálogo comercial versionado (Comando Oficial de Precificação, seções 2, 3 e 6.1).
 *  - catalog_items: identidade do registro (código, nome, tipo, necessidade, identidade canônica)
 *  - catalog_item_versions: preço, repasse total, atos, elegibilidade PRIME, vigência — imutáveis
 *  - catalog_item_components: composição profissional (tipo do ato, quantidade, repasse unitário)
 * A versão vigente é a de maior número com valid_from <= agora. Repasse total e atos SEMPRE
 * são a soma da composição (validado na gravação).
 */
import { all, insertMany, one, run, tx } from '../../db/db.ts';
import { audit } from '../../lib/audit.ts';
import { unprocessable } from '../../lib/errors.ts';
import { nowIso, uid } from '../../lib/util.ts';
import {
  COMMON_EXCLUSIONS, PRICING_SOURCE, PRICING_V1, PRICING_V1_FROM, type ComponentDef,
} from '../../db/content/pricing-v1.ts';

export interface VersionInput {
  priceCents: number; primeEligible: boolean; actsLabel: string; periodDays: number | null; recurring: 'MENSAL' | null;
  inclusions: string[]; exclusions: string[]; validFrom: string; reason: string; source?: string | null;
  components: { act: string; label: string; modality: 'PRESENCIAL' | 'REMOTO'; qty: number; unit: number; unitLabels?: string[] | null }[];
}

export function sumComposition(components: VersionInput['components']) {
  return {
    payoutTotalCents: components.reduce((s, c) => s + c.qty * c.unit, 0),
    actsTotal: components.reduce((s, c) => s + c.qty, 0),
  };
}

/** Grava nova versão (imutável). Retorna o id. Deve rodar dentro de transação. */
export async function insertVersion(itemId: string, v: VersionInput, actorId: string | null) {
  if (!v.components.length) throw unprocessable('COMPOSITION_REQUIRED', 'Informe a composição profissional (ao menos um ato).');
  for (const c of v.components) {
    if (c.unitLabels && c.unitLabels.length > c.qty) throw unprocessable('COMPOSITION_INVALID', `Rótulos a mais que a quantidade em "${c.label}".`);
  }
  const { payoutTotalCents, actsTotal } = sumComposition(v.components);
  const last = await one<any>('SELECT MAX(version) AS v FROM catalog_item_versions WHERE catalog_item_id = ?', itemId);
  const version = (last?.v ?? 0) + 1;
  const id = uid(), now = nowIso();
  await run(`INSERT INTO catalog_item_versions (id, catalog_item_id, version, price_cents, payout_total_cents, acts_total, acts_label, prime_eligible,
       period_days, recurring, inclusions_json, exclusions_json, valid_from, reason, source, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, itemId, version, v.priceCents, payoutTotalCents, actsTotal, v.actsLabel, v.primeEligible ? 1 : 0, v.periodDays, v.recurring,
    JSON.stringify(v.inclusions), JSON.stringify(v.exclusions), v.validFrom, v.reason, v.source ?? null, actorId, now);
  await insertMany('catalog_item_components', ['id', 'version_id', 'seq', 'act_type', 'label', 'modality', 'quantity', 'unit_payout_cents', 'unit_labels_json'],
    v.components.map((c, i) => [uid(), id, i + 1, c.act, c.label, c.modality, c.qty, c.unit, c.unitLabels?.length ? JSON.stringify(c.unitLabels) : null]));
  return { id, version, payoutTotalCents, actsTotal };
}

/** Mantém os campos-resumo do item (usados por telas antigas) iguais à versão vigente. */
export async function syncItemSummary(itemId: string, now = nowIso()) {
  const v = await currentVersion(itemId, now);
  if (v) await run('UPDATE catalog_items SET price_cents = ?, prime_eligible = ?, updated_at = ? WHERE id = ?', v.price_cents, v.prime_eligible, now, itemId);
}

export async function currentVersion(itemId: string, now = nowIso()) {
  return await one<any>(`SELECT * FROM catalog_item_versions WHERE catalog_item_id = ? AND valid_from <= ? ORDER BY version DESC LIMIT 1`, itemId, now);
}
export async function components(versionId: string) {
  return (await all<any>('SELECT * FROM catalog_item_components WHERE version_id = ? ORDER BY seq', versionId)).map((c) => ({
    seq: c.seq, act: c.act_type, label: c.label, modality: c.modality, qty: c.quantity, unit: c.unit_payout_cents,
    unitLabels: c.unit_labels_json ? JSON.parse(c.unit_labels_json) : null,
  }));
}

/** Oferta completa (uso interno/administrativo). */
export async function offerByCode(code: string, now = nowIso()) {
  const item = await one<any>('SELECT * FROM catalog_items WHERE code = ?', code);
  if (!item) return null;
  const v = await currentVersion(item.id, now);
  if (!v) return null;
  return { item, version: v, components: await components(v.id) };
}

/** Versão do comando para o paciente: sem repasses, margens ou composição de repasse. */
export function publicOffer(o: { item: any; version: any }) {
  const { item, version: v } = o;
  return {
    code: item.code, name: item.name, kind: item.kind, need: item.need, summary: item.summary, modality: item.modality,
    canonicalCode: item.canonical_code, priceCents: v.price_cents, primeEligible: !!v.prime_eligible, actsTotal: v.acts_total,
    actsLabel: v.acts_label, periodDays: v.period_days, recurring: v.recurring, inclusions: JSON.parse(v.inclusions_json),
    exclusions: JSON.parse(v.exclusions_json), versionNo: v.version,
  };
}

const toInput = (d: (typeof PRICING_V1)[number]): VersionInput => ({
  priceCents: d.price, primeEligible: true, actsLabel: d.actsLabel, periodDays: d.periodDays, recurring: d.recurring ?? null,
  inclusions: d.inclusions, exclusions: [...COMMON_EXCLUSIONS, ...(d.extraExclusions ?? [])], validFrom: PRICING_V1_FROM,
  reason: 'Carga inicial dos preços oficiais aprovados (versão 1).', source: PRICING_SOURCE,
  components: d.components.map((c: ComponentDef) => ({ ...c, unitLabels: c.unitLabels ?? null })),
});

/**
 * Carga idempotente da tabela oficial v1 (P01/P15): reexecutar não duplica itens nem versões.
 * Retorna divergências encontradas entre dados já existentes e o comando (para sinalizar ao RT).
 */
export async function seedPricingV1() {
  return await tx(async () => {
    const now = nowIso();
    const divergences: string[] = [];
    let created = 0;
    for (const [i, d] of PRICING_V1.entries()) {
      let item = await one<any>('SELECT * FROM catalog_items WHERE code = ?', d.code);
      if (!item) {
        const id = uid();
        await run(`INSERT INTO catalog_items (id, code, name, kind, price_cents, prime_eligible, active, is_demo, canonical_code, need, modality, summary, sort_order, created_at, updated_at)
             VALUES (?,?,?,?,?,1,1,0,?,?,?,?,?,?,?)`, id, d.code, d.name, d.kind, d.price, d.canonical ?? d.code, d.need, d.modality, d.summary, i + 1, now, now);
        item = { id, price_cents: d.price };
        created++;
      } else if (!item.need) {
        if (item.price_cents !== d.price) divergences.push(`${d.code}: preço anterior ${item.price_cents} ≠ comando ${d.price} (substituído pela versão 1).`);
        await run(`UPDATE catalog_items SET name = ?, kind = ?, canonical_code = ?, need = ?, modality = ?, summary = ?, sort_order = ?, active = 1, is_demo = 0, updated_at = ? WHERE id = ?`,
          d.name, d.kind, d.canonical ?? d.code, d.need, d.modality, d.summary, i + 1, now, item.id);
      }
      if (!(await one('SELECT 1 FROM catalog_item_versions WHERE catalog_item_id = ?', item.id))) {
        await insertVersion(item.id, toInput(d), null);
        await syncItemSummary(item.id, now > PRICING_V1_FROM ? now : PRICING_V1_FROM);
      }
    }
    if (created) await audit({ actorId: null, action: 'PRICING_V1_LOADED', subjectType: 'catalog', meta: { created, source: PRICING_SOURCE } });
    return { created, divergences };
  });
}
