/**
 * Kary — assistente da plataforma.
 * Modo padrão: base de conhecimento própria (determinística, sem enviar dados a terceiros).
 * Modo IA (opcional): KARY_PROVIDER=anthropic + ANTHROPIC_API_KEY. Mesmo assim, urgência e pedidos
 * clínicos são respondidos pela regra fixa, antes de qualquer chamada externa. Nada é gravado.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, one } from '../../db/db.ts';
import { AppError } from '../../lib/errors.ts';
import { parse } from '../../lib/context.ts';
import { rateLimit } from '../../lib/security.ts';
import { brl, nowIso } from '../../lib/util.ts';
import { currentVersion } from '../care/catalog.ts';
import { CLINICAL, CLINICAL_ANSWER, FALLBACK, FAQ, SYSTEM_PROMPT, URGENCY, URGENCY_ANSWER, type KaryAnswer } from './knowledge.ts';

const MODEL = process.env.KARY_MODEL || 'claude-opus-5-5';
export const karyLlmEnabled = () => process.env.KARY_PROVIDER === 'anthropic' && !!process.env.ANTHROPIC_API_KEY;

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Preços públicos (sem repasses) para responder "quanto custa ...". */
async function publicPrices() {
  const now = nowIso();
  const out: { code: string; name: string; priceCents: number; actsLabel: string }[] = [];
  for (const it of await all<any>('SELECT * FROM catalog_items WHERE active = 1 AND need IS NOT NULL ORDER BY sort_order')) {
    const v = await currentVersion(it.id, now);
    if (v) out.push({ code: it.code, name: it.name, priceCents: v.price_cents, actsLabel: v.acts_label });
  }
  return out;
}

async function priceAnswer(message: string): Promise<KaryAnswer | null> {
  if (!/(quanto|pre[çc]o|valor|custa|tabela)/i.test(message)) return null;
  const prices = await publicPrices();
  const m = norm(message);
  const hits = prices.filter((p) => {
    const words = norm(p.name).split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !['enfermagem', 'avulso', 'avulsa', 'sessoes', 'mensal'].includes(w));
    return words.length > 0 && words.every((w) => m.includes(w.slice(0, Math.max(5, w.length - 2))));
  }).slice(0, 4);
  if (!hits.length) {
    return { kind: 'PRECO', text: 'Os valores aparecem logo depois que você escolhe o atendimento e informa os materiais. Diga o nome do atendimento (ex.: "quanto custa curativo simples?") ou abra a solicitação.', links: [{ label: 'Ver valores', to: '/solicitar' }] };
  }
  const prime = await one<any>('SELECT discount_bps, discount_cap_cents FROM prime_parameters ORDER BY version DESC LIMIT 1');
  const lines = hits.map((p) => `${p.name}: ${brl(p.priceCents)} (${p.actsLabel})`);
  return {
    kind: 'PRECO',
    text: `${lines.join('. ')}. Assinantes ONEMA PRIME ativos têm ${prime ? prime.discount_bps / 100 : 5}% de desconto em um pedido por ciclo, até ${brl(prime?.discount_cap_cents ?? 2000)}.`,
    links: [{ label: 'Solicitar este cuidado', to: '/solicitar' }],
  };
}

function faqAnswer(message: string): KaryAnswer | null {
  return FAQ.find((f) => f.keywords.test(message))?.answer ?? null;
}

let client: Anthropic | null = null;
async function llmAnswer(message: string, history: { role: 'user' | 'assistant'; text: string }[]): Promise<KaryAnswer | null> {
  client ??= new Anthropic();
  const prices = await publicPrices();
  const catalog = prices.map((p) => `${p.code} ${p.name}: ${brl(p.priceCents)} — ${p.actsLabel}`).join('\n');
  const faq = FAQ.map((f) => `- ${f.answer.text}`).join('\n');
  try {
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 1024,
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: `${SYSTEM_PROMPT}\n\nCatálogo público vigente:\n${catalog}\n\nRespostas aprovadas da base:\n${faq}`, cache_control: { type: 'ephemeral' } }],
      messages: [
        ...history.slice(-8).map((h) => ({ role: h.role, content: h.text })),
        { role: 'user' as const, content: message },
      ],
    });
    if (res.stop_reason === 'refusal') return null;
    const text = res.content.filter((b) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
    return text ? { kind: 'FAQ', text } : null;
  } catch (e: any) {
    console.error('Kary: falha no provedor de IA', e?.status ?? '', e?.message ?? '');
    return null;
  }
}

export async function karyReply(message: string, history: { role: 'user' | 'assistant'; text: string }[] = []) {
  if (URGENCY.test(message)) return { ...URGENCY_ANSWER, source: 'regra' as const };
  if (CLINICAL.test(message)) return { ...CLINICAL_ANSWER, source: 'regra' as const };
  const price = await priceAnswer(message);
  if (price) return { ...price, source: 'base' as const };
  const faq = faqAnswer(message);
  if (faq) return { ...faq, source: 'base' as const };
  if (karyLlmEnabled()) {
    const ai = await llmAnswer(message, history);
    if (ai) return { ...ai, source: 'ia' as const };
  }
  return { ...FALLBACK, source: 'base' as const };
}

export async function karyRoutes(app: FastifyInstance) {
  app.get('/api/kary/info', async () => ({
    name: 'Kary', mode: karyLlmEnabled() ? 'IA' : 'BASE',
    disclaimer: 'A Kary orienta sobre a plataforma. Não faz diagnóstico nem substitui atendimento. Em urgência, ligue 192. Não envie dados de saúde detalhados.',
    suggestions: ['Como solicitar cuidado?', 'Quanto custa curativo simples?', 'O que é o ONEMA PRIME?', 'Sou enfermeiro, como entro na rede?'],
  }));

  app.post('/api/kary/chat', { config: { public: true } }, async (req) => {
    if (!await rateLimit(`kary:${req.ip}`, 30, 5 * 60_000)) throw new AppError(429, 'RATE_LIMIT', 'Muitas mensagens em pouco tempo. Aguarde um instante.');
    const b = parse(z.object({
      message: z.string().trim().min(1).max(500),
      history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(1500) })).max(12).optional().default([]),
    }), req.body);
    return await karyReply(b.message, b.history);
  });
}
