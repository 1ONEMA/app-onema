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

/** Organiza o ditado. Devolve null quando a IA não está configurada, recusa ou não responde a tempo. */
export async function organizeDictation(dictation: string, context: { act: string; modality: string }): Promise<Evolution | null> {
  if (!evolutionAiEnabled()) return null;
  // Uma chamada por requisição, dentro do limite de tempo da Function; sem novas tentativas automáticas.
  client ??= new Anthropic({ timeout: 8_500, maxRetries: 0 });
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
    if (res.stop_reason === 'refusal' || !res.parsed_output) return null;
    return res.parsed_output;
  } catch (e: any) {
    if (e instanceof Anthropic.APIError) console.error('Kary evolução: erro do provedor de IA', e.status, e.message);
    else console.error('Kary evolução: falha', e?.name ?? '', e?.message ?? '');
    return null;
  }
}
