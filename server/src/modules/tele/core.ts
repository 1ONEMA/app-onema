/**
 * Telenfermagem (POP-ONEMA-TELE-001 v1.0) — regras do episódio remoto. MÓDULO EM HOMOLOGAÇÃO: PROIBIDO USO CLÍNICO REAL.
 * Enquanto TELE_REAL_USE_APPROVED não for ativado, só pacientes sintéticos (@exemplo.test) podem ter episódios.
 */
import { z } from 'zod';
import { EvolutionSchema } from '../care/evolution-ai.ts';

export const TELE_PROTOCOL_VERSION = 'POP-ONEMA-TELE-001 v1.0 · regras-homologacao-1';
export const TELE_CONSENT_VERSION = 'TCLE-TELE-1.0-HOMOLOGACAO';
export const TELE_CONSENT_PURPOSE = 'Atendimento de enfermagem por áudio/vídeo, sem gravação, com registro na Carteira Digital ONEMA.';

export const MODALITIES = ['RETORNO_ONLINE', 'MONITORAMENTO', 'CONSULTA_REMOTA'] as const;
export const MODALITY_LABEL: Record<(typeof MODALITIES)[number], string> = {
  RETORNO_ONLINE: 'Retorno online', MONITORAMENTO: 'Monitoramento digital', CONSULTA_REMOTA: 'Consulta de Enfermagem remota',
};

/**
 * Regra comercial versionada (produto + protocolo). Valores de HOMOLOGAÇÃO — a tabela real depende de aprovação.
 * Retorno online dentro da janela de um atendimento presencial concluído é incluído; os demais são cobrados,
 * sempre informados ao paciente antes da confirmação. Nenhuma cobrança é gerada automaticamente neste módulo.
 */
export const TELE_PRICES: Record<(typeof MODALITIES)[number], number> = { RETORNO_ONLINE: 7990, MONITORAMENTO: 5990, CONSULTA_REMOTA: 9990 };
export const RETURN_WINDOW_DAYS = 30;
export function pricingDecision(modality: (typeof MODALITIES)[number], origin: { completedAt: string | null } | null, at = Date.now()) {
  if (modality === 'RETORNO_ONLINE' && origin?.completedAt && at - new Date(origin.completedAt).getTime() <= RETURN_WINDOW_DAYS * 86400000) {
    return { rule: 'INCLUIDO' as const, priceCents: 0, reason: `Retorno incluído: até ${RETURN_WINDOW_DAYS} dias após o atendimento presencial de origem (${TELE_PROTOCOL_VERSION}).` };
  }
  return { rule: 'COBRADO' as const, priceCents: TELE_PRICES[modality],
    reason: modality === 'RETORNO_ONLINE' ? `Retorno fora da janela de ${RETURN_WINDOW_DAYS} dias ou sem atendimento de origem concluído.` : 'Serviço remoto avulso.' };
}

export const OFFER_HOURS = 12;          // prazo da oferta antes de redistribuir
export const TOKEN_TTL_MS = 10 * 60_000; // token de sala de curta duração
export const JOIN_EARLY_MS = 30 * 60_000;

/** Registro de telenfermagem: seções da evolução + origem do dado e limitações do atendimento remoto (RF07). */
export const TeleNoteSchema = EvolutionSchema.extend({
  origemDados: z.string().max(4000).describe('Origem das informações: relatado / observado por vídeo / medido pelo paciente.'),
  limitacoes: z.string().max(4000).describe('Limitações da avaliação remota.'),
});
export type TeleNote = z.infer<typeof TeleNoteSchema>;
export const EMPTY_TELE_NOTE: TeleNote = {
  relato: '', sinaisVitais: '', avaliacao: '', procedimentos: '', orientacoes: '', plano: '', observacoes: '', pendencias: [],
  origemDados: '', limitacoes: 'Avaliação remota, sem exame físico presencial. Dados relatados pelo paciente/cuidador e observados por vídeo.',
};

export const ACTIVE = ['SOLICITADO', 'TRIAGEM', 'OFERTADO', 'ACEITO', 'AGENDADO', 'EM_ATENDIMENTO', 'AGUARDANDO_REGISTRO', 'ASSINADO', 'FALHA_TECNICA'];
export const FINAL = ['CONCLUIDO', 'INELEGIVEL', 'RECUSADO', 'EXPIRADO', 'CANCELADO', 'NAO_COMPARECEU', 'ENCAMINHADO_PRESENCIAL', 'URGENCIA_ENCAMINHADA'];

export const STATUS_LABEL: Record<string, string> = {
  SOLICITADO: 'Solicitado', TRIAGEM: 'Aguardando consentimento', OFERTADO: 'Procurando enfermeira', ACEITO: 'Enfermeira confirmada',
  AGENDADO: 'Agendado', EM_ATENDIMENTO: 'Em atendimento', AGUARDANDO_REGISTRO: 'Aguardando registro', ASSINADO: 'Registro assinado', CONCLUIDO: 'Concluído',
  INELEGIVEL: 'Não elegível', RECUSADO: 'Consentimento recusado', EXPIRADO: 'Expirado', CANCELADO: 'Cancelado', NAO_COMPARECEU: 'Ausência registrada',
  FALHA_TECNICA: 'Falha técnica — reagendar', ENCAMINHADO_PRESENCIAL: 'Encaminhado ao presencial', URGENCIA_ENCAMINHADA: 'Urgência encaminhada',
};

export const URGENCY_GUIDANCE = 'Em caso de urgência ou emergência ligue 192 (SAMU) ou procure o pronto-socorro mais próximo. Não aguarde novo contato online.';
export const NO_SHOW_POLICY = 'Ausência registrada. O paciente pode solicitar novo horário pela Central ONEMA; ausências repetidas são avaliadas pela Central (sem cobrança automática em homologação).';
