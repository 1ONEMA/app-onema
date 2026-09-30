const TZ = 'America/Sao_Paulo';
export const money = (cents: number | null | undefined) =>
  cents == null ? '—' : (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('pt-BR', { timeZone: TZ }) : '—');
export const dateTime = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' }) : '—';
export const pct = (bps: number) => `${(bps / 100).toLocaleString('pt-BR')}%`;

export const COURSE_STATE: Record<string, { label: string; tone: string }> = {
  BLOQUEADO: { label: 'Bloqueado', tone: 'dark' },
  DISPONIVEL: { label: 'Disponível', tone: 'blue' },
  EM_ANDAMENTO: { label: 'Em andamento', tone: 'blue' },
  AGUARDANDO_AVALIACAO: { label: 'Aguardando avaliação', tone: 'orange' },
  APROVADO: { label: 'Aprovado', tone: '' },
  REPROVADO: { label: 'Reprovado', tone: 'red' },
};
export const SUB_STATUS: Record<string, { label: string; tone: string }> = {
  ASSINATURA_SOLICITADA: { label: 'Aguardando pagamento', tone: 'orange' },
  ACTIVE: { label: 'PRIME ativo', tone: '' },
  PAYMENT_PENDING: { label: 'Pagamento pendente', tone: 'orange' },
  SUSPENDED: { label: 'Benefícios suspensos', tone: 'red' },
  CANCEL_SCHEDULED: { label: 'Cancelamento agendado', tone: 'orange' },
  CANCELLED: { label: 'Cancelada', tone: 'dark' },
  REFUND_PENDING: { label: 'Estorno em análise', tone: 'orange' },
  REFUNDED: { label: 'Estornada', tone: 'dark' },
};
export const STATE_LABEL: Record<string, string> = {
  NAO_INICIADA: 'Não iniciada', EM_ANDAMENTO: 'Em andamento', CONCLUIDA: 'Concluída', SUSPENSA: 'Suspensa', CANCELADA: 'Cancelada',
  PENDENTE: 'Pendente', PAGO: 'Pago', RECUSADO: 'Recusado', CANCELADO: 'Cancelado', ESTORNADO: 'Estornado',
  APROVADA: 'Aprovada', REPROVADA: 'Reprovada', SUBMETIDA: 'Submetida', CRIADA: 'Criada', INVALIDADA: 'Invalidada',
  NAO_ELEGIVEL: 'Não elegível', ELEGIVEL: 'Elegível', EMITIDO: 'Emitido', REVOGADO: 'Revogado',
  DRAFT: 'Rascunho', IN_REVIEW: 'Em revisão', APPROVED: 'Aprovado', PUBLISHED: 'Publicado', ARCHIVED: 'Arquivado', RETIRED: 'Substituído',
  PENDING: 'Pendente', UPLOADING: 'Envio incompleto', BLOCKED: 'Bloqueado', ACTIVE: 'Ativo', INACTIVE: 'Inativo',
  CONFIRMED: 'Confirmada', FAILED: 'Não confirmada', REFUNDED: 'Estornado', PAID: 'Pago', PENDING_PAYMENT: 'Aguardando pagamento',
  REFUND_PENDING: 'Em análise', REJECTED: 'Não aprovado',
  INVITED: 'Convite enviado', ACCEPTED: 'Aceito — aguardando verificação ONEMA', VERIFIED: 'Verificado e ativo', REVOKED: 'Revogado', EXPIRED: 'Expirado',
  APTO: 'Apto', NAO_APTO: 'Não apto',
};
export const label = (s?: string | null) => (s ? STATE_LABEL[s] ?? s : '—');
