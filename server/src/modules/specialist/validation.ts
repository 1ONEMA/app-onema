/**
 * Validação documental de parceiros (Guia ONEMA v1.0, 12/10/2026) — regra de liberação.
 * Ativo para atendimento SOMENTE com: cadastro APROVADO (identidade + prova viva + inscrição conferidas), revalidação em dia,
 * Jornada Academy (quatro cursos) concluída e decisão de credenciamento APTO. Cursos e documentação são controles separados:
 * nenhum deles, isoladamente, libera o parceiro. O bloqueio vale no servidor (ofertas, aceite, visita, telenfermagem).
 */
import { one } from '../../db/db.ts';

export const PARTNER_STATES = ['CADASTRO_INCOMPLETO', 'EM_ANALISE', 'CORRECAO_SOLICITADA', 'DOCUMENTACAO_APROVADA', 'INTEGRACAO_PENDENTE',
  'ATIVO', 'SUSPENSO_REVALIDAR', 'REPROVADO'] as const;
export type PartnerState = (typeof PARTNER_STATES)[number];
export const PARTNER_STATE_LABEL: Record<PartnerState, string> = {
  CADASTRO_INCOMPLETO: 'Cadastro incompleto', EM_ANALISE: 'Em análise', CORRECAO_SOLICITADA: 'Correção solicitada', DOCUMENTACAO_APROVADA: 'Documentação aprovada',
  INTEGRACAO_PENDENTE: 'Integração pendente', ATIVO: 'Ativo para atendimento', SUSPENSO_REVALIDAR: 'Suspenso / revalidar', REPROVADO: 'Reprovado',
};

/** Checagens que precisam estar CONFERIDAS (última conferência de cada tipo) para aprovar a documentação. */
export const REQUIRED_CHECKS = ['PROVA_VIVA', 'IDENTIDADE', 'INSCRICAO'] as const;

/** Regra do RT (13/11/2026): revalidar quando o parceiro fica 180 dias sem realizar atendimentos. */
export const revalidationDays = () => Math.max(7, Number(process.env.PARTNER_REVALIDATION_DAYS ?? 180));

/** Última atividade: aprovação do cadastro ou o atendimento (presencial ou remoto) mais recente. */
export async function lastActivityAt(userId: string, decidedAt: string | null): Promise<string | null> {
  const r = await one<any>(`SELECT GREATEST(
      (SELECT MAX(GREATEST(COALESCE(completed_at, ''), COALESCE(accepted_at, ''))) FROM care_events WHERE specialist_id = ?),
      (SELECT MAX(GREATEST(COALESCE(closed_at, ''), COALESCE(accepted_at, ''))) FROM tele_episodes WHERE professional_id = ?)) AS last`, userId, userId);
  const cands = [decidedAt, r?.last || null].filter(Boolean) as string[];
  return cands.length ? cands.sort().at(-1)! : null;
}
/** Prazo de revalidação: última atividade + 180 dias. */
export async function revalidationDueAt(app: any): Promise<string | null> {
  const last = await lastActivityAt(app.user_id, app.decided_at);
  return last ? new Date(new Date(last).getTime() + revalidationDays() * 86400000).toISOString() : null;
}

const overdue = (iso: string | null | undefined) => !!iso && new Date(iso).getTime() < Date.now();

export async function partnerState(userId: string): Promise<{ state: PartnerState; application: any | null; training: any | null }> {
  const app = await one<any>('SELECT * FROM specialist_applications WHERE user_id = ?', userId);
  const training = await one<any>('SELECT journey_state, credentialing_decision FROM partner_training_status WHERE partner_id = ?', userId);
  let state: PartnerState;
  if (!app || app.status === 'RASCUNHO') state = 'CADASTRO_INCOMPLETO';
  else if (app.status === 'ENVIADA') state = 'EM_ANALISE';
  else if (app.status === 'PENDENCIA') state = 'CORRECAO_SOLICITADA';
  else if (app.status === 'RECUSADA') state = 'REPROVADO';
  else if (app.status === 'SUSPENSA' || (app.status === 'APROVADA' && overdue(await revalidationDueAt(app)))) state = 'SUSPENSO_REVALIDAR';
  else if (training?.journey_state !== 'CONCLUIDA' && training?.credentialing_decision !== 'APTO') state = 'INTEGRACAO_PENDENTE';
  else if (training?.credentialing_decision === 'APTO') state = 'ATIVO';
  else state = 'DOCUMENTACAO_APROVADA';
  return { state, application: app, training };
}

/**
 * Pode receber e aceitar atendimentos? Contas de demonstração (@exemplo.test) sem candidatura seguem a regra antiga
 * (somente credenciamento APTO), para a homologação continuar funcionando com dados fictícios.
 */
export async function partnerActive(userId: string): Promise<boolean> {
  const { state, application, training } = await partnerState(userId);
  if (state === 'ATIVO') return true;
  if (!application && training?.credentialing_decision === 'APTO') {
    const u = await one<any>('SELECT email FROM users WHERE id = ?', userId);
    return !!u && /@exemplo\.test$/i.test(u.email);
  }
  return false;
}
