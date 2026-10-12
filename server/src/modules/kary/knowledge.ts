/**
 * Kary — base de conhecimento de ORIENTAÇÃO da plataforma (não clínica).
 * Escopo: navegação, como solicitar cuidado, valores públicos do catálogo, PRIME, Academy e
 * área do especialista. Kary não faz diagnóstico, não prescreve e não substitui atendimento.
 * Conteúdo editorial: revisar e aprovar pela ONEMA (pendência E-3) antes de uso com pacientes reais.
 */
export interface KaryLink { label: string; to: string }
export interface KaryAnswer { text: string; links?: KaryLink[]; kind: 'URGENCIA' | 'FAQ' | 'PRECO' | 'FORA_DO_ESCOPO' | 'SAUDACAO' }

/** Sinais de urgência: resposta fixa (nunca passa por IA). */
export const URGENCY = /(falta de ar|n[ãa]o consigo respirar|dor no peito|dor forte no peito|desmai|perd(a|eu) (de )?consci[êe]ncia|convuls|sangramento (intenso|forte)|avc|derrame|infarto|engasg|suic[íi]d|me matar|overdose|intoxica[çc][ãa]o|emerg[êe]ncia|urg[êe]ncia|socorro)/i;
export const URGENCY_ANSWER: KaryAnswer = {
  kind: 'URGENCIA',
  text: 'Isto pode ser uma urgência. A ONEMA não atende urgências por este canal. Ligue agora para o SAMU 192 (ou 193, Bombeiros). Se houver risco imediato, procure o pronto-socorro mais próximo.',
  links: [{ label: 'Ligar para o SAMU 192', to: 'tel:192' }],
};

/** Pedidos clínicos (diagnóstico, dose, medicação): orientar sem responder clinicamente. */
export const CLINICAL = /(qual (rem[ée]dio|medicamento)|posso tomar|dose|dosagem|quantos mg|diagn[óo]stic|[ée] grave\??|o que (eu )?tenho|sintoma|tratamento para)/i;
export const CLINICAL_ANSWER: KaryAnswer = {
  kind: 'FORA_DO_ESCOPO',
  text: 'Não posso orientar diagnóstico, remédios ou doses: isso exige avaliação de um profissional. Posso ajudar você a solicitar uma Avaliação de Enfermagem ou uma Orientação on-line com um enfermeiro validado. Em sinais de gravidade, ligue 192.',
  links: [{ label: 'Solicitar cuidado', to: '/solicitar' }],
};

const L = (label: string, to: string): KaryLink => ({ label, to });

export const FAQ: { id: string; keywords: RegExp; answer: KaryAnswer }[] = [
  { id: 'saudacao', keywords: /^(oi|ol[áa]|bom dia|boa tarde|boa noite|e a[íi]|hey)\b/i,
    answer: { kind: 'SAUDACAO', text: 'Olá! Eu sou a Kary, assistente da ONEMA SAÚDE. Posso explicar como solicitar cuidado, mostrar os valores dos atendimentos, falar do ONEMA PRIME, da Academy e da área do especialista. Como posso ajudar?',
      links: [L('Solicitar cuidado', '/solicitar'), L('Conhecer a plataforma', '/plataforma')] } },
  { id: 'solicitar', keywords: /(solicitar|pedir|contratar|agendar|marcar|preciso de (um )?(cuidado|enfermeir)|como funciona)/i,
    answer: { kind: 'FAQ', text: 'É simples: 1) escolha a necessidade; 2) escolha o atendimento; 3) diga se tem os materiais; 4) veja os valores na hora; 5) informe onde e quando; 6) revise o orçamento completo; 7) confirme e pague. Preencher a solicitação não obriga a contratar nem autoriza cobrança.',
      links: [L('Começar agora', '/solicitar')] } },
  { id: 'prime', keywords: /(prime|assinatura|mensalidade|desconto)/i,
    answer: { kind: 'FAQ', text: 'O ONEMA PRIME custa R$ 34,90 por ciclo mensal, com adesão separada e opcional. Assinantes ativos têm 5% de desconto em um pedido por ciclo, limitado a R$ 20. O desconto não reduz o repasse do especialista e nenhum atendimento está incluído na mensalidade.',
      links: [L('Ver o ONEMA PRIME', '/prime')] } },
  { id: 'materiais', keywords: /(material|materiais|insumo|curativo.*(trazer|comprar)|quem (leva|fornece))/i,
    answer: { kind: 'FAQ', text: 'Na solicitação você responde se tem os materiais (Sim, Não ou Não sei). A resposta não gera taxa automática. Medicamentos, dispositivos e materiais especiais não estão incluídos automaticamente; se pedir que a ONEMA cote os materiais, o orçamento fica pendente até haver valor aprovado, e o pagamento fica bloqueado até lá.' } },
  { id: 'pagamento', keywords: /(pagar|pagamento|pix|cart[ãa]o|boleto|cobran[çc]a|asaas)/i,
    answer: { kind: 'FAQ', text: 'O total final aparece antes de qualquer pagamento, no botão "Confirmar e pagar". Nesta versão de homologação os pagamentos são simulados — nenhum valor real é cobrado. A integração com o provedor real (Asaas) aguarda a liberação do CNPJ.' } },
  { id: 'cancelar', keywords: /(cancelar|desistir|estorno|reembolso|arrepend)/i,
    answer: { kind: 'FAQ', text: 'Antes de pagar você pode voltar, editar ou desistir a qualquer momento. Depois do pagamento, estornos são tratados pela Central ONEMA e conferidos pelo evento original do pagamento. O PRIME tem direito de arrependimento em 7 dias.',
      links: [L('Meus pedidos', '/servicos')] } },
  { id: 'pacotes', keywords: /(pacote|p[óo]s-?alta|medicamentos? \d+|7 dias|14 dias|30 dias|21 dias)/i,
    answer: { kind: 'FAQ', text: 'Os pacotes têm quantidade finita de atos. Pós-Alta: 7 dias (2 atos), 14 dias (4 atos) e 30 dias (6 atos), com avaliações presenciais e monitoramentos remotos. Medicamentos: 7, 14 ou 21 dias com uma visita presencial por dia. Atos além do pacote exigem nova contratação.',
      links: [L('Ver valores', '/solicitar')] } },
  { id: 'monitoramento', keywords: /(monitoramento|acompanhamento mensal)/i,
    answer: { kind: 'FAQ', text: 'O Monitoramento ONEMA mensal tem 4 interações remotas no mês, por R$ 379,90. Ele aparece como serviço (CAT-08) e como pacote (PAC-05), mas é a mesma oferta: uma única cobrança por mês.' } },
  { id: 'especialista', keywords: /(sou enfermeir|quero (trabalhar|atender|ser)|onema one|parceir|cadastro.*profission|repasse)/i,
    answer: { kind: 'FAQ', text: 'Enfermeiros entram na rede ONEMA ONE com CPF (sem exigência de CNPJ). Identidade, COREN, documentos e treinamento na ONEMA Academy são validados pela Central antes de receber ofertas. Você escolhe quando atender, recusa sem penalidade e recebe o repasse integral de cada atendimento.',
      links: [L('Área do especialista', '/especialista')] } },
  { id: 'academy', keywords: /(academy|curso|aula|certificado|prova|nota)/i,
    answer: { kind: 'FAQ', text: 'A ONEMA Academy é a formação dos especialistas: aulas, atividades, avaliações e certificado. As notas da Academy são separadas das avaliações por estrelas que os pacientes dão aos atendimentos.',
      links: [L('Abrir a Academy', '/academy')] } },
  { id: 'avaliacao', keywords: /(estrela|avaliar|avalia[çc][ãa]o do (atendimento|enfermeiro))/i,
    answer: { kind: 'FAQ', text: 'Depois que um atendimento é concluído, você pode avaliá-lo com estrelas em "Meus pedidos". A média e a quantidade de avaliações aparecem para o especialista e para a Central.' } },
  { id: 'lifescore', keywords: /(life ?score|carteira|pop|prontu[áa]rio|documento)/i,
    answer: { kind: 'FAQ', text: 'Life Score, Carteira Digital de Saúde e POPs oficiais estão em implantação. O Life Score só será usado clinicamente depois das etapas de validação e liberação previstas pela ONEMA.',
      links: [L('Conhecer a plataforma', '/plataforma')] } },
  { id: 'privacidade', keywords: /(privacidade|lgpd|meus dados|dados pessoais)/i,
    answer: { kind: 'FAQ', text: 'A ONEMA trata seus dados conforme a LGPD, apenas para a finalidade do atendimento. Evite enviar dados de saúde detalhados neste chat: a Kary não precisa deles para orientar você.' } },
  { id: 'urgencia_info', keywords: /(samu|192|pronto[- ]socorro)/i, answer: URGENCY_ANSWER },
];

export const FALLBACK: KaryAnswer = {
  kind: 'FAQ',
  text: 'Ainda não sei responder isso. Posso ajudar com: como solicitar cuidado, valores dos atendimentos, ONEMA PRIME, pagamentos, área do especialista e Academy. Se preferir, fale com a Central ONEMA.',
  links: [L('Solicitar cuidado', '/solicitar'), L('Conhecer a plataforma', '/plataforma')],
};

export const SYSTEM_PROMPT = `Você é a Kary, assistente virtual de ORIENTAÇÃO da plataforma ONEMA SAÚDE (enfermagem domiciliar em São Paulo).
Responda em português do Brasil, com frases curtas, acolhedoras e objetivas (até 5 frases).
Você ajuda com: como usar a plataforma, como solicitar cuidado, valores públicos do catálogo (fornecidos abaixo), ONEMA PRIME, pagamentos, área do especialista e ONEMA Academy.
Limites obrigatórios:
- Não faça diagnóstico, não indique remédios, doses ou condutas clínicas; sugira uma Avaliação de Enfermagem ou Orientação on-line.
- Em qualquer sinal de urgência, diga para ligar 192 (SAMU) imediatamente.
- Não peça nem repita dados pessoais ou de saúde. Não invente preços, prazos, taxas ou benefícios: use somente os dados abaixo; se não souber, diga que a Central ONEMA confirma.
- Nesta versão de homologação os pagamentos são simulados.
- Repasses aos especialistas e margens internas são confidenciais: não os informe a pacientes.`;
