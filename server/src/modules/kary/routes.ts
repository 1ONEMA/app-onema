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
import { COURSES } from '../../db/seed.ts';
import { audit } from '../../lib/audit.ts';
import {
  APTIDAO, APTIDAO_ANSWER, CLINICAL, CLINICAL_ANSWER, FALLBACK, FAQ, GABARITO, GABARITO_ANSWER, KARY_BASE_VERSION, KARY_ESCALATION, KARY_LIMITS,
  SYSTEM_PROMPT, URGENCY, URGENCY_ANSWER, type KaryAnswer,
} from './knowledge.ts';

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

const STOP = new Set(['para', 'como', 'qual', 'quais', 'sobre', 'onde', 'aula', 'curso', 'tema', 'estudar', 'academy', 'onema', 'entre', 'seus', 'suas', 'mais', 'isso', 'esse', 'essa', 'tenho', 'duvida']);
const words = (s: string) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOP.has(w));

/**
 * Dúvida educacional: indica o módulo/aula oficial (títulos aprovados da Jornada, Documento Mestre §5).
 * Não responde conteúdo técnico nem questões de avaliação; orienta onde estudar.
 */
function academyAnswer(message: string): KaryAnswer | null {
  const m = norm(message);
  const asked = new Set(words(message));
  let best: { code: string; title: string; course: any; score: number } | null = null;
  for (const c of COURSES) {
    for (const [code, title] of c.lessons) {
      if (m.includes(norm(code))) return lessonAnswer(code, title, c);
      const score = words(title).filter((w) => [...asked].some((a) => a.startsWith(w.slice(0, 5)) || w.startsWith(a.slice(0, 5)))).length;
      if (score > (best?.score ?? 0)) best = { code, title, course: c, score };
    }
  }
  const academyContext = /(academy|aula|curso|m[óo]dulo|estudar|jornada|avalia[çc][ãa]o|prova|atividade)/i.test(message);
  if (best && (best.score >= 2 || (academyContext && best.score >= 1))) return lessonAnswer(best.code, best.title, best.course);
  return null;
}
function lessonAnswer(code: string, title: string, course: { code: string; title: string }): KaryAnswer {
  return {
    kind: 'ACADEMY',
    text: `Esse tema está na aula ${code} — ${title}, do curso ${course.code} · ${course.title}, na ONEMA Academy. Revise a aula e, se a dúvida continuar, leve-a ao Suporte ONEMA Academy ou ao RT. Eu oriento onde estudar; não respondo questões das avaliações nem defino conduta.`,
    links: [{ label: 'Abrir a ONEMA Academy', to: '/academy' }],
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

async function decide(message: string, history: { role: 'user' | 'assistant'; text: string }[]) {
  if (URGENCY.test(message)) return { ...URGENCY_ANSWER, source: 'regra' as const };
  if (GABARITO.test(message)) return { ...GABARITO_ANSWER, source: 'regra' as const };
  if (CLINICAL.test(message)) return { ...CLINICAL_ANSWER, source: 'regra' as const };
  if (APTIDAO.test(message)) return { ...APTIDAO_ANSWER, source: 'regra' as const };
  const price = await priceAnswer(message);
  if (price) return { ...price, source: 'base' as const };
  const academy = academyAnswer(message);
  if (academy) return { ...academy, source: 'base' as const };
  const faq = faqAnswer(message);
  if (faq) return { ...faq, source: 'base' as const };
  if (karyLlmEnabled()) {
    const ai = await llmAnswer(message, history);
    if (ai) return { ...ai, source: 'ia' as const };
  }
  return { ...FALLBACK, source: 'base' as const };
}

/** Toda resposta leva a versão da base, os limites e a rota de escalonamento (Documento Mestre Academy §12). */
export async function karyReply(message: string, history: { role: 'user' | 'assistant'; text: string }[] = []) {
  const r = await decide(message, history);
  return { ...r, baseVersion: KARY_BASE_VERSION, limits: KARY_LIMITS, escalation: KARY_ESCALATION };
}

export async function karyRoutes(app: FastifyInstance) {
  app.get('/api/kary/info', async () => ({
    name: 'Kary', mode: karyLlmEnabled() ? 'IA' : 'BASE', baseVersion: KARY_BASE_VERSION, limits: KARY_LIMITS, escalation: KARY_ESCALATION,
    disclaimer: 'A Kary orienta sobre a plataforma. Não faz diagnóstico nem substitui atendimento. Em urgência, ligue 192. Não envie dados de saúde detalhados.',
    suggestions: ['Como solicitar cuidado?', 'Quanto custa curativo simples?', 'O que é o ONEMA PRIME?', 'Sou enfermeiro, como entro na rede?'],
  }));

  app.post('/api/kary/chat', { config: { public: true } }, async (req) => {
    if (!await rateLimit(`kary:${req.ip}`, 30, 5 * 60_000)) throw new AppError(429, 'RATE_LIMIT', 'Muitas mensagens em pouco tempo. Aguarde um instante.');
    const b = parse(z.object({
      message: z.string().trim().min(1).max(500),
      history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(1500) })).max(12).optional().default([]),
    }), req.body);
    const r = await karyReply(b.message, b.history);
    // Registro sem o texto da conversa (minimização): tipo, origem e versão da base.
    await audit({ actorId: req.auth?.userId ?? null, action: 'KARY_RESPOSTA', subjectType: 'kary', correlationId: req.correlationId,
      meta: { kind: r.kind, source: r.source, baseVersion: r.baseVersion } });
    return r;
  });
}
