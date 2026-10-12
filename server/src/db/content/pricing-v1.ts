/**
 * Precificação oficial v1 — "ONEMA SAÚDE — Comando Oficial de Implantação da Precificação no PWA/App"
 * (Enf. Marcos Alves, RT, emissão 30/09/2026). Valores em centavos.
 *
 * Este arquivo é apenas a CARGA INICIAL (seed idempotente). Depois de carregada, a tabela vigente
 * vive no banco (catalog_items + catalog_item_versions + catalog_item_components) e é alterada
 * somente por nova versão no painel da Central (RBAC, motivo, vigência e trilha de auditoria).
 */
export const PRICING_SOURCE = 'Comando Oficial de Implantação da Precificação no PWA/App — RT Marcos Alves — 30/09/2026';
/** Início de vigência da versão 1 (30/09/2026 00:00 em São Paulo). */
export const PRICING_V1_FROM = '2026-09-30T03:00:00.000Z';

/** Identidade comercial canônica do monitoramento: CAT-08 e PAC-05 são duas visões da MESMA oferta. */
export const CANONICAL_MONITORING = 'OF-MONITORAMENTO-MENSAL';

export interface ComponentDef { act: string; label: string; modality: 'PRESENCIAL' | 'REMOTO'; qty: number; unit: number; unitLabels?: string[] }
export interface ItemDef {
  code: string; name: string; kind: 'SERVICO' | 'PACOTE'; need: string; price: number; summary: string;
  modality: 'PRESENCIAL' | 'REMOTO' | 'MISTO'; periodDays: number | null; recurring?: 'MENSAL';
  canonical?: string; actsLabel: string; components: ComponentDef[]; inclusions: string[]; extraExclusions?: string[];
}

/** Necessidades exibidas ao paciente (pictogramas e textos do protótipo v5). */
export const NEEDS = [
  { key: 'AVALIACAO', title: 'Avaliação de Enfermagem', subtitle: 'Avaliação clínica e plano inicial', icon: 'chat' },
  { key: 'CURATIVOS', title: 'Curativos', subtitle: 'Avaliação e cuidado de feridas', icon: 'shield' },
  { key: 'MEDICAMENTOS', title: 'Medicamentos', subtitle: 'Administração conforme prescrição válida', icon: 'pill' },
  { key: 'SONDAS', title: 'Sondas e Cateteres', subtitle: 'Cuidados, troca e orientação', icon: 'tube' },
  { key: 'POS_ALTA', title: 'Pós-alta Hospitalar', subtitle: 'Continuidade segura em casa', icon: 'hospital' },
  { key: 'POS_OPERATORIO', title: 'Pós-operatório', subtitle: 'Acompanhamento após o procedimento', icon: 'nurse' },
  { key: 'CRONICOS', title: 'Diabetes e Hipertensão', subtitle: 'Monitoramento e orientação', icon: 'heart' },
  { key: 'MONITORAMENTO', title: 'Monitoramento ONEMA', subtitle: 'Acompanhamento planejado de saúde', icon: 'doc' },
] as const;

/** Exclusões comuns (seção 3 — "Exclusões"). */
export const COMMON_EXCLUSIONS = [
  'Medicamentos, dispositivos e materiais especiais não estão incluídos automaticamente.',
  'Estacionamento, pedágio e deslocamento excepcional seguem a política comercial expressa.',
  'Atos ou interações além dos previstos exigem nova indicação e nova contratação.',
];

const R = (reais: number) => Math.round(reais * 100);
const visit = (act: string, label: string, unit: number, qty = 1, unitLabels?: string[]): ComponentDef =>
  ({ act, label, modality: 'PRESENCIAL', qty, unit: R(unit), unitLabels });
const remote = (label: string, qty: number, unitLabels?: string[]): ComponentDef =>
  ({ act: 'MONITORAMENTO_REMOTO', label, modality: 'REMOTO', qty, unit: R(50), unitLabels });

const MED_TEXT = [
  'Uma visita presencial por dia, com prescrição válida.',
  'Avaliação pertinente a cada evento e administração quando cabível.',
  'Troca do curativo do dispositivo utilizado quando necessária e tecnicamente cabível durante a visita.',
  'Registro, continuidade digital e evolução consolidada.',
];
const MED_EXCL = [
  'A troca do curativo do dispositivo não é obrigatória, não gera visita adicional gratuita nem fornecimento automático de materiais especiais.',
  'Frequência maior que uma visita diária exige nova composição comercial antes de contratar.',
];
const POS_ALTA_TEXT = 'Plano pós-atendimento, Carteira Digital e relatório do período.';

export const PRICING_V1: ItemDef[] = [
  // ---- Seção 2: serviços e continuidade (11) ----
  { code: 'CAT-01', name: 'Avaliação de Enfermagem', kind: 'SERVICO', need: 'AVALIACAO', price: R(269.9), modality: 'PRESENCIAL', periodDays: null,
    summary: 'Avaliação clínica presencial e plano inicial de cuidado.', actsLabel: '1 avaliação presencial',
    components: [visit('AVALIACAO_PRESENCIAL', 'Avaliação de Enfermagem presencial', 170)], inclusions: ['Avaliação presencial e plano inicial de cuidado.', 'Registro do atendimento.'] },
  { code: 'CAT-02A', name: 'Curativo simples', kind: 'SERVICO', need: 'CURATIVOS', price: R(309.9), modality: 'PRESENCIAL', periodDays: null,
    summary: 'Avaliação e realização de curativo simples.', actsLabel: '1 sessão presencial',
    components: [visit('CURATIVO_SIMPLES', 'Curativo simples', 200)], inclusions: ['Avaliação da ferida e realização do curativo simples.', 'Registro do atendimento.'] },
  { code: 'CAT-02B', name: 'Curativo complexo', kind: 'SERVICO', need: 'CURATIVOS', price: R(459.9), modality: 'PRESENCIAL', periodDays: null,
    summary: 'Avaliação e realização de curativo complexo.', actsLabel: '1 sessão presencial',
    components: [visit('CURATIVO_COMPLEXO', 'Curativo complexo', 300)], inclusions: ['Avaliação da ferida e realização do curativo complexo.', 'Registro do atendimento.'] },
  { code: 'CAT-03', name: 'Administração de medicamentos avulsa', kind: 'SERVICO', need: 'MEDICAMENTOS', price: R(289.9), modality: 'PRESENCIAL', periodDays: null,
    summary: 'Uma visita para administração conforme prescrição válida.', actsLabel: '1 visita presencial',
    components: [visit('ADMIN_MEDICAMENTO', 'Visita para administração de medicamento', 180)], inclusions: ['Avaliação pertinente e administração conforme prescrição válida.', 'Registro do atendimento.'] },
  { code: 'CAT-04', name: 'Sondas e cateteres', kind: 'SERVICO', need: 'SONDAS', price: R(449.9), modality: 'PRESENCIAL', periodDays: null,
    summary: 'Cuidados, troca e orientação de sondas e cateteres.', actsLabel: '1 atendimento presencial',
    components: [visit('SONDAS_CATETERES', 'Cuidado de sonda ou cateter', 240)], inclusions: ['Cuidados, troca quando indicada e orientação.', 'Registro do atendimento.'] },
  { code: 'CAT-05', name: 'Pós-alta hospitalar avulso', kind: 'SERVICO', need: 'POS_ALTA', price: R(319.9), modality: 'PRESENCIAL', periodDays: null,
    summary: 'Uma visita para continuidade segura em casa após a alta.', actsLabel: '1 visita presencial',
    components: [visit('POS_ALTA_VISITA', 'Visita pós-alta', 180)], inclusions: ['Avaliação presencial pós-alta e orientação.', 'Registro do atendimento.'] },
  { code: 'CAT-06', name: 'Pós-operatório avulso', kind: 'SERVICO', need: 'POS_OPERATORIO', price: R(349.9), modality: 'PRESENCIAL', periodDays: null,
    summary: 'Uma visita de acompanhamento após o procedimento.', actsLabel: '1 visita presencial',
    components: [visit('POS_OPERATORIO_VISITA', 'Visita pós-operatória', 200)], inclusions: ['Avaliação presencial pós-operatória e orientação.', 'Registro do atendimento.'] },
  { code: 'CAT-07', name: 'Diabetes e Hipertensão', kind: 'SERVICO', need: 'CRONICOS', price: R(359.9), modality: 'PRESENCIAL', periodDays: null,
    summary: 'Um único registro comercial para monitoramento e orientação de diabetes e hipertensão.', actsLabel: '1 atendimento presencial',
    components: [visit('DIABETES_HIPERTENSAO', 'Atendimento Diabetes e Hipertensão', 230)], inclusions: ['Avaliação, monitoramento e orientação.', 'Registro do atendimento.'] },
  { code: 'CAT-08', name: 'Monitoramento ONEMA mensal', kind: 'SERVICO', need: 'MONITORAMENTO', price: R(379.9), modality: 'REMOTO', periodDays: 30, recurring: 'MENSAL',
    canonical: CANONICAL_MONITORING, summary: 'Acompanhamento planejado com 4 interações remotas no mês.', actsLabel: '4 interações remotas',
    components: [remote('Interação remota de monitoramento', 4)], inclusions: ['4 interações remotas de monitoramento no ciclo mensal.', 'Registro e continuidade digital.'] },
  { code: 'CONT-01', name: 'Orientação on-line', kind: 'SERVICO', need: 'MONITORAMENTO', price: R(89.9), modality: 'REMOTO', periodDays: null,
    summary: 'Uma orientação de enfermagem on-line.', actsLabel: '1 orientação remota',
    components: [{ act: 'ORIENTACAO_ONLINE', label: 'Orientação on-line', modality: 'REMOTO', qty: 1, unit: R(50) }], inclusions: ['Uma orientação remota com registro.'] },
  { code: 'CONT-02', name: 'Reavaliação de Enfermagem', kind: 'SERVICO', need: 'AVALIACAO', price: R(249.9), modality: 'PRESENCIAL', periodDays: null,
    summary: 'Reavaliação presencial para quem já tem plano de cuidado.', actsLabel: '1 reavaliação presencial',
    components: [visit('REAVALIACAO', 'Reavaliação de Enfermagem presencial', 160)], inclusions: ['Reavaliação presencial e atualização do plano.', 'Registro do atendimento.'] },

  // ---- Seção 3: pacotes (8) ----
  { code: 'PAC-01', name: 'Pós-Alta 7 dias', kind: 'PACOTE', need: 'POS_ALTA', price: R(449.9), modality: 'MISTO', periodDays: 7,
    summary: 'Avaliação inicial e um monitoramento remoto em 7 dias.', actsLabel: '2 atos (1 presencial + 1 remoto)',
    components: [visit('AVALIACAO_PRESENCIAL', 'Avaliação presencial', 170, 1, ['Avaliação inicial']), remote('Monitoramento remoto', 1)],
    inclusions: ['Avaliação inicial presencial.', 'Um monitoramento remoto.', POS_ALTA_TEXT] },
  { code: 'PAC-02', name: 'Pós-Alta 14 dias', kind: 'PACOTE', need: 'POS_ALTA', price: R(729.9), modality: 'MISTO', periodDays: 14,
    summary: 'Avaliações inicial e final e dois monitoramentos remotos em 14 dias.', actsLabel: '4 atos (2 presenciais + 2 remotos)',
    components: [visit('AVALIACAO_PRESENCIAL', 'Avaliação presencial', 170, 2, ['Avaliação inicial', 'Avaliação final']), remote('Monitoramento remoto', 2)],
    inclusions: ['Avaliações presenciais inicial e final.', 'Dois monitoramentos remotos.', POS_ALTA_TEXT] },
  { code: 'PAC-03', name: 'Pós-Alta 30 dias', kind: 'PACOTE', need: 'POS_ALTA', price: R(1089.9), modality: 'MISTO', periodDays: 30,
    summary: 'Avaliações inicial, intermediária e final e três monitoramentos remotos em 30 dias.', actsLabel: '6 atos (3 presenciais + 3 remotos)',
    components: [visit('AVALIACAO_PRESENCIAL', 'Avaliação presencial', 170, 3, ['Avaliação inicial', 'Avaliação intermediária', 'Avaliação final']), remote('Monitoramento remoto', 3)],
    inclusions: ['Avaliações presenciais inicial, intermediária e final.', 'Três monitoramentos remotos.', POS_ALTA_TEXT] },
  { code: 'PAC-04', name: 'Curativo simples — 4 sessões', kind: 'PACOTE', need: 'CURATIVOS', price: R(1229.9), modality: 'PRESENCIAL', periodDays: null,
    summary: 'Quatro sessões presenciais de curativo simples.', actsLabel: '4 sessões presenciais',
    components: [visit('CURATIVO_SIMPLES', 'Sessão de curativo simples', 200, 4)], inclusions: ['Quatro sessões presenciais de curativo simples.', 'Registro de cada sessão.'] },
  { code: 'PAC-05', name: 'Monitoramento mensal', kind: 'PACOTE', need: 'MONITORAMENTO', price: R(379.9), modality: 'REMOTO', periodDays: 30, recurring: 'MENSAL',
    canonical: CANONICAL_MONITORING, summary: 'Mesma oferta do Monitoramento ONEMA mensal (CAT-08), vista como pacote.', actsLabel: '4 monitoramentos remotos',
    components: [remote('Monitoramento remoto', 4)], inclusions: ['4 monitoramentos remotos no ciclo mensal.', 'Registro e continuidade digital.'] },
  { code: 'PAC-06', name: 'Medicamentos 7 dias', kind: 'PACOTE', need: 'MEDICAMENTOS', price: R(1949.9), modality: 'PRESENCIAL', periodDays: 7,
    summary: 'Uma visita presencial por dia durante 7 dias.', actsLabel: '7 visitas presenciais',
    components: [visit('ADMIN_MEDICAMENTO', 'Visita diária de medicamentos', 180, 7)], inclusions: MED_TEXT, extraExclusions: MED_EXCL },
  { code: 'PAC-07', name: 'Medicamentos 14 dias', kind: 'PACOTE', need: 'MEDICAMENTOS', price: R(3799.9), modality: 'PRESENCIAL', periodDays: 14,
    summary: 'Uma visita presencial por dia durante 14 dias.', actsLabel: '14 visitas presenciais',
    components: [visit('ADMIN_MEDICAMENTO', 'Visita diária de medicamentos', 180, 14)], inclusions: MED_TEXT, extraExclusions: MED_EXCL },
  { code: 'PAC-08', name: 'Medicamentos 21 dias', kind: 'PACOTE', need: 'MEDICAMENTOS', price: R(5899.9), modality: 'PRESENCIAL', periodDays: 21,
    summary: 'Uma visita presencial por dia durante 21 dias.', actsLabel: '21 visitas presenciais',
    components: [visit('ADMIN_MEDICAMENTO', 'Visita diária de medicamentos', 180, 21)], inclusions: MED_TEXT, extraExclusions: MED_EXCL },
];

/**
 * Referências monetárias da seção 7 do comando (preço cheio → desconto PRIME → preço com PRIME).
 * Usadas nos testes P04 e no autoteste da Central; nunca para calcular preço.
 */
export const SECTION7_REFERENCE: Record<string, [number, number, number]> = {
  'CAT-01': [26990, 1350, 25640], 'CAT-02A': [30990, 1550, 29440], 'CAT-02B': [45990, 2000, 43990], 'CAT-03': [28990, 1450, 27540],
  'CAT-04': [44990, 2000, 42990], 'CAT-05': [31990, 1600, 30390], 'CAT-06': [34990, 1750, 33240], 'CAT-07': [35990, 1800, 34190],
  'CAT-08': [37990, 1900, 36090], 'CONT-01': [8990, 450, 8540], 'CONT-02': [24990, 1250, 23740],
  'PAC-01': [44990, 2000, 42990], 'PAC-02': [72990, 2000, 70990], 'PAC-03': [108990, 2000, 106990], 'PAC-04': [122990, 2000, 120990],
  'PAC-05': [37990, 1900, 36090], 'PAC-06': [194990, 2000, 192990], 'PAC-07': [379990, 2000, 377990], 'PAC-08': [589990, 2000, 587990],
};

/** Repasse total e atos esperados (seções 2 e 3) — conferência P01/P02/P03. */
export const EXPECTED_PAYOUT: Record<string, [number, number]> = {
  'CAT-01': [17000, 1], 'CAT-02A': [20000, 1], 'CAT-02B': [30000, 1], 'CAT-03': [18000, 1], 'CAT-04': [24000, 1], 'CAT-05': [18000, 1],
  'CAT-06': [20000, 1], 'CAT-07': [23000, 1], 'CAT-08': [20000, 4], 'CONT-01': [5000, 1], 'CONT-02': [16000, 1],
  'PAC-01': [22000, 2], 'PAC-02': [44000, 4], 'PAC-03': [66000, 6], 'PAC-04': [80000, 4], 'PAC-05': [20000, 4],
  'PAC-06': [126000, 7], 'PAC-07': [252000, 14], 'PAC-08': [378000, 21],
};

/**
 * Parâmetros do relatório gerencial (seção 6.5): gateway 3% + tributos 6% + reserva 2% = 11% do valor recebido,
 * e R$ 12 de operação por ato. Contribuição NÃO é lucro líquido e não substitui cálculo fiscal.
 */
export const REPORT_PARAMS = { rateBps: 1100, opCostPerActCents: 1200, warnBelowBps: 1700 };
