export const ROLES = [
  'PACIENTE', 'ESPECIALISTA', 'SUPORTE_ACADEMY', 'GESTOR_CONTEUDO', 'AVALIADOR_RT',
  'ADMIN_ACADEMY', 'CREDENCIAMENTO', 'FINANCEIRO', 'AUDITOR', 'OPERADOR_CENTRAL', 'ADMIN_PRIME',
] as const;
export type Role = (typeof ROLES)[number];

/** Perfis administrativos: exigem MFA (Documento Mestre Academy 11.1). */
export const ADMIN_ROLES: Role[] = ROLES.filter((r) => r !== 'PACIENTE' && r !== 'ESPECIALISTA');

/** Quem pode atribuir quais perfis (segregação de funções). */
export const ROLE_GRANTORS: Record<Role, Role[]> = {
  PACIENTE: [],
  ESPECIALISTA: ['ADMIN_ACADEMY'],
  SUPORTE_ACADEMY: ['ADMIN_ACADEMY'],
  GESTOR_CONTEUDO: ['ADMIN_ACADEMY'],
  AVALIADOR_RT: ['ADMIN_ACADEMY'],
  ADMIN_ACADEMY: ['ADMIN_ACADEMY'],
  CREDENCIAMENTO: ['ADMIN_ACADEMY'],
  AUDITOR: ['ADMIN_ACADEMY', 'ADMIN_PRIME'],
  FINANCEIRO: ['ADMIN_ACADEMY', 'ADMIN_PRIME'],
  OPERADOR_CENTRAL: ['ADMIN_PRIME'],
  ADMIN_PRIME: ['ADMIN_PRIME'],
};

export const ROLE_LABELS: Record<Role, string> = {
  PACIENTE: 'Paciente / titular',
  ESPECIALISTA: 'Especialista (Enfermeiro parceiro)',
  SUPORTE_ACADEMY: 'Suporte Academy',
  GESTOR_CONTEUDO: 'Gestor de conteúdo',
  AVALIADOR_RT: 'Avaliador / RT',
  ADMIN_ACADEMY: 'Administrador Academy',
  CREDENCIAMENTO: 'Credenciamento',
  FINANCEIRO: 'Financeiro',
  AUDITOR: 'Auditor',
  OPERADOR_CENTRAL: 'Operador da Central',
  ADMIN_PRIME: 'Administrador PRIME',
};
