/**
 * Kary · organização da evolução de enfermagem ditada pela enfermeira após a avaliação clínica.
 * A IA só reorganiza o que foi dito em seções fixas — não diagnostica, não sugere conduta e não inventa dados.
 * A enfermeira revisa, corrige e assina: o registro clínico é dela.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

export const EVOLUTION_MODEL = process.env.KARY_MODEL || 'claude-opus-5-5';
export const evolutionAiEnabled = () => !!process.env.ANTHROPIC_API_KEY;

/** Seções da evolução (mesma estrutura no ditado organizado pela IA e no preenchimento manual). */
export const EvolutionSchema = z.object({
  relato: z.string().describe('Relato do paciente/familiar e queixas, como ditado.'),
  sinaisVitais: z.string().describe('Sinais vitais e medidas citados (PA, FC, FR, T, SpO2, glicemia, dor). "Não informado no ditado." se ausentes.'),
  avaliacao: z.string().describe('Achados da avaliação de enfermagem descritos pela enfermeira (pele, ferida, dispositivos, estado geral...).'),
  procedimentos: z.string().describe('Procedimentos realizados na visita, materiais usados e intercorrências.'),
  orientacoes: z.string().describe('Orientações dadas ao paciente/cuidador.'),
  plano: z.string().describe('Plano e próximos passos ditos pela enfermeira (retorno, encaminhamento, reavaliação).'),
  observacoes: z.string().describe('Outras informações ditas que não se encaixam acima. Vazio se não houver.'),
  pendencias: z.array(z.string()).describe('Itens habituais de uma evolução que NÃO foram ditos e que a enfermeira deve conferir antes de assinar.'),
});
export type Evolution = z.infer<typeof EvolutionSchema>;

export const EMPTY_EVOLUTION: Evolution = {
  relato: '', sinaisVitais: '', avaliacao: '', procedimentos: '', orientacoes: '', plano: '', observacoes: '', pendencias: [],
};

const SYSTEM = `Você é a Kary, assistente de documentação da ONEMA SAÚDE (enfermagem domiciliar em São Paulo).
Uma enfermeira ditou, por voz, a evolução de um atendimento que acabou de realizar. O texto veio do reconhecimento de voz do celular e pode ter erros de transcrição.
Sua tarefa é ORGANIZAR o ditado nas seções da evolução de enfermagem, em português do Brasil, em linguagem técnica de enfermagem, clara e objetiva, na terceira pessoa ("Paciente refere...", "Realizado...").
Regras obrigatórias:
- Use somente informações presentes no ditado. Nunca invente sinais vitais, medidas, medicamentos, doses, horários ou achados.
- Não faça diagnóstico, não sugira conduta, tratamento ou medicamento e não acrescente recomendações que a enfermeira não disse.
- Quando uma seção não tiver informação no ditado, escreva exatamente "Não informado no ditado.".
- Corrija apenas erros evidentes de transcrição de termos técnicos; se houver dúvida sobre um número ou termo, mantenha como foi dito e registre a dúvida em "pendencias".
- Em "pendencias", liste o que uma evolução de enfermagem normalmente contém e não foi dito (ex.: sinais vitais, avaliação da dor, aspecto da ferida), para a enfermeira conferir antes de assinar.
- Não inclua nomes completos, CPF, endereço ou telefone, mesmo que tenham sido ditos.`;

let client: Anthropic | null = null;

/** Motivo de falha mostrado à enfermeira e à equipe (sem detalhes técnicos sensíveis). */
export type OrganizeFailure = 'NAO_CONFIGURADA' | 'SEM_CREDITO' | 'CHAVE_INVALIDA' | 'TEMPO_ESGOTADO' | 'RECUSA' | 'LIMITE' | 'INDISPONIVEL';
export const FAILURE_TEXT: Record<OrganizeFailure, string> = {
  NAO_CONFIGURADA: 'Organização por IA ainda não configurada (falta a chave ANTHROPIC_API_KEY no servidor).',
  SEM_CREDITO: 'A conta da IA (Anthropic) está sem créditos. Adicione créditos em console.anthropic.com → Billing.',
  CHAVE_INVALIDA: 'A chave da IA (ANTHROPIC_API_KEY) é inválida ou foi revogada. Gere uma nova em console.anthropic.com.',
  TEMPO_ESGOTADO: 'A IA demorou mais que o permitido para responder. Tente de novo; se repetir, preencha manualmente.',
  RECUSA: 'A IA não organizou este ditado. Preencha as seções manualmente.',
  LIMITE: 'Limite de uso da IA atingido no momento. Tente de novo em alguns minutos.',
  INDISPONIVEL: 'O serviço de IA está indisponível agora. Tente de novo em alguns minutos.',
};

/** Organiza o ditado em seções. Devolve a evolução ou o motivo da falha. */
export async function organizeDictation(dictation: string, context: { act: string; modality: string }): Promise<{ evolution: Evolution } | { failure: OrganizeFailure }> {
  if (!evolutionAiEnabled()) return { failure: 'NAO_CONFIGURADA' };
  // Executado em segundo plano (a tela acompanha), então cabe um tempo maior que o de uma requisição comum.
  client ??= new Anthropic({ timeout: 25_000, maxRetries: 1 });
  try {
    const res = await client.beta.messages.parse({
      model: EVOLUTION_MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: betaZodOutputFormat(EvolutionSchema) },
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `Atendimento: ${context.act} (${context.modality.toLowerCase()}).\n\nDitado da enfermeira:\n"""\n${dictation}\n"""` }],
    });
    if (res.stop_reason === 'refusal') return { failure: 'RECUSA' };
    if (!res.parsed_output) return { failure: 'INDISPONIVEL' };
    return { evolution: res.parsed_output };
  } catch (e: any) {
    const failure: OrganizeFailure =
      e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError ? 'CHAVE_INVALIDA'
      : e instanceof Anthropic.APIConnectionTimeoutError ? 'TEMPO_ESGOTADO'
      : e instanceof Anthropic.RateLimitError ? 'LIMITE'
      : e instanceof Anthropic.BadRequestError && /credit balance/i.test(String(e.message)) ? 'SEM_CREDITO'
      : 'INDISPONIVEL';
    console.error('Kary evolução: falha', failure, e instanceof Anthropic.APIError ? e.status : '', String(e?.message ?? '').slice(0, 300));
    return { failure };
  }
}
