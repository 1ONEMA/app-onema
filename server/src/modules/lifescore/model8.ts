/**
 * ONEMA Life Score — modelo simplificado OLS-8-HOM-0.1 (especificação v0.4, concordância do RT).
 * Quatro domínios, oito itens, R3 = 1, R2 = 2/3, R1 = 1/3, R0 = 0. Contribuição = peso do domínio ÷ 2 × fração.
 * Índice DESCRITIVO 0–100: não é percentual de saúde, risco ou prognóstico; não determina conduta, urgência ou retorno.
 * Pesos e âncoras são convenções candidatas, pendentes de validação clínica em homologação.
 */
export const MODEL8 = {
  model_id: 'OLS-8-HOM-0.1',
  spec: 'ONEMA Life Score v0.4 (modelo simplificado de oito itens)',
  fractions: { R3: 1, R2: 2 / 3, R1: 1 / 3, R0: 0 } as Record<string, number>,
  domains: [
    { code: 'C', name: 'Condição atual', weight: 30, plain: 'Sintomas e necessidades atuais e se o plano de cuidado responde a elas.' },
    { code: 'A', name: 'Autonomia', weight: 20, plain: 'Quanta ajuda de outra pessoa é necessária para se movimentar e para o autocuidado.' },
    { code: 'S', name: 'Segurança do cuidado', weight: 30, plain: 'Segurança com medicamentos, dispositivos, pele, feridas e ambiente.' },
    { code: 'K', name: 'Continuidade e apoio', weight: 20, plain: 'Compreensão do plano e disponibilidade de apoio e recursos para segui-lo.' },
  ],
  items: [
    { item_id: 'C1', domain: 'C', name: 'Sintomas e necessidades atuais',
      question: 'Na avaliação atual, em que medida sintomas ou necessidades não atendidas interferem no cuidado e nas atividades pertinentes?',
      help: 'Considere queixas físicas e emocionais relevantes; registre achado/contexto. Não converta sinal vital isolado automaticamente em resposta. Sinal de alerta vai também ao registro de segurança.',
      anchors: {
        R3: 'Ausência de sintoma/necessidade não atendida, ou controle adequado sem interferência relevante.',
        R2: 'Interferência pequena; atividades e cuidados essenciais preservados.',
        R1: 'Interferência parcial que limita atividades ou cuidados essenciais.',
        R0: 'Interferência importante que impede atividades ou cuidados essenciais, ou necessidade intensa não controlada identificada pelo enfermeiro.' } },
    { item_id: 'C2', domain: 'C', name: 'Adequação do plano às necessidades atuais',
      question: 'O plano disponível contempla as necessidades identificadas nesta avaliação?',
      help: 'Não depende de visita anterior. Na primeira visita, avalie após o planejamento inicial; se ainda não concluído, mantenha o rascunho. Avalia cobertura do plano, não estabilidade clínica.',
      anchors: {
        R3: 'Necessidades contempladas, ações e responsáveis definidos, sem ajuste pendente relevante.',
        R2: 'Ajuste pontual pendente, sem comprometer ação essencial.',
        R1: 'Parte das necessidades essenciais ainda não contemplada; revisão do plano necessária.',
        R0: 'Necessidade essencial sem resposta no plano ou plano inviável para a situação atual, conforme avaliação profissional.' } },
    { item_id: 'A1', domain: 'A', name: 'Mobilidade pertinente', context: 'TASK',
      question: 'Qual ajuda humana é necessária para o deslocamento e as transferências pertinentes à rotina?',
      help: 'Registre a tarefa de referência (a de maior necessidade de ajuda). Dispositivo assistivo não reduz pontos por si só. Não infira risco de queda pelo score.',
      anchors: {
        R3: 'Realiza as tarefas pertinentes sem ajuda humana, com ou sem dispositivo.',
        R2: 'Precisa de supervisão ou orientação, sem ajuda física.',
        R1: 'Precisa de ajuda física parcial, participando da tarefa.',
        R0: 'Depende integralmente de outra pessoa para a tarefa.' } },
    { item_id: 'A2', domain: 'A', name: 'Autocuidado pertinente', context: 'ACTIVITIES',
      question: 'Qual ajuda humana é necessária para as atividades de autocuidado definidas como pertinentes nesta avaliação?',
      help: 'Registre quais atividades foram consideradas e quem as executa. Não exija que o paciente execute procedimento que compete ao profissional.',
      anchors: {
        R3: 'Executa as atividades pertinentes sem ajuda humana.',
        R2: 'Precisa de lembretes, orientação ou supervisão, sem ajuda física.',
        R1: 'Executa parte das atividades, com ajuda física parcial.',
        R0: 'Outra pessoa executa integralmente as atividades consideradas.' } },
    { item_id: 'S1', domain: 'S', name: 'Segurança de medicamentos e dispositivos', context: 'OBJECTS',
      question: 'Há pendências de segurança nos medicamentos ou dispositivos pertinentes?',
      help: 'Abra só os detalhes aplicáveis (medicamentos; sondas/cateteres; oxigênio e outros). Ausência confirmada de medicamento/dispositivo é R3 e é diferente de item não verificado. Com mais de uma pendência, use o nível mais desfavorável.',
      anchors: {
        R3: 'Verificação concluída sem pendência identificada; inclui ausência de medicamento/dispositivo pertinente confirmada pelo enfermeiro.',
        R2: 'Pendência pontual identificada, sem comprometimento de ação essencial ou exposição relevante reconhecida pelo enfermeiro.',
        R1: 'Pendência que compromete parte do uso seguro ou da execução prevista e requer correção profissional.',
        R0: 'Falha importante que compromete uso seguro essencial, ou situação de dano/exposição importante reconhecida pelo enfermeiro.' } },
    { item_id: 'S2', domain: 'S', name: 'Segurança da pele, feridas e ambiente', context: 'WOUND',
      question: 'Há necessidades de segurança não atendidas relativas à pele, feridas ou ambiente pertinente ao cuidado?',
      help: 'Pele e ambiente continuam pertinentes mesmo sem ferida. Existência de ferida não reduz pontos automaticamente. Suspeita de infecção é registrada e conduzida profissionalmente, independentemente da pontuação.',
      anchors: {
        R3: 'Avaliação concluída sem pendência relevante; inclui ferida com cuidado adequado e evolução compatível com o plano profissional, sem pendência identificada.',
        R2: 'Ajuste preventivo pontual pendente, sem comprometimento de proteção essencial.',
        R1: 'Necessidade de proteção/cuidado parcialmente não atendida ou risco ambiental relevante identificado pelo enfermeiro.',
        R0: 'Falha importante na proteção/cuidado ou situação de dano/exposição importante reconhecida pelo enfermeiro.' } },
    { item_id: 'K1', domain: 'K', name: 'Compreensão do plano por quem o executa', context: 'EXECUTOR',
      question: 'Quem executará as ações essenciais consegue explicar o que fazer e como buscar apoio?',
      help: 'Identifique paciente, responsável/cuidador ou ambos; use confirmação por retorno da explicação. Recusa informada é registro separado, não R0 automático. Apoio por cuidador executor não reduz a pontuação.',
      anchors: {
        R3: 'Explica corretamente as ações essenciais e como buscar ajuda.',
        R2: 'Apresenta lacuna pontual, com compreensão das ações essenciais preservada.',
        R1: 'Apresenta lacunas importantes em parte das ações essenciais, precisando de reforço.',
        R0: 'Não demonstra compreensão das ações essenciais após tentativa de comunicação adequada.' } },
    { item_id: 'K2', domain: 'K', name: 'Viabilidade de apoio e acesso',
      question: 'Estão disponíveis o apoio e os recursos necessários para executar o plano?',
      help: 'Considere só necessidades reais: cuidador quando necessário, insumos, acesso e contato com os serviços pertinentes. Com mais de uma barreira, considere a que mais limita. Registre recurso/barreira e responsável.',
      anchors: {
        R3: 'Recursos e apoio necessários disponíveis; inclui pessoa independente que não necessita de cuidador.',
        R2: 'Limitação pontual sem impedir ação essencial.',
        R1: 'Barreira que dificulta parte das ações essenciais, ainda que haja alternativa parcial.',
        R0: 'Barreira que impede ação essencial, sem alternativa viável identificada.' } },
  ],
  /** Itens cujo R0 exige fundamento e destaca pendência para revisão profissional (sem diagnóstico automático). */
  review_r0: ['C1', 'C2', 'S1', 'S2'],
  legend_note: 'R3, R2, R1 e R0 são códigos das alternativas descritas em cada item; não representam a mesma situação clínica em todos os itens. Zero é uma resposta avaliada, não ausência de dado.',
} as const;

/** Respostas que bloqueiam o cálculo (nunca viram zero). */
export const BLOCKING = { NAO_AVALIADO: 'Não avaliado', DESCONHECIDO: 'Desconhecido', RECUSA: 'Recusa de informação', QI: 'Informação inadequada' } as const;
