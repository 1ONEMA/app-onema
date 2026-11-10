# ONEMA Life Score v1.6 — integração no app

Base: pacote `ONEMA_LifeScore_v1_6_Pacote_Desenvolvimento.zip` e "Comando de integração, telas e homologação" (Marcos Alves, RT, 09/11/2026).
Modelo ativo **OLS-DESC-ITEM24-1.0**, tabela de 24 itens sem alterações (SHA-256 `c14a255e…d4fa90`, conferido em teste).
Índice **descritivo** de 0 a 100 a partir das respostas confirmadas pela enfermeira. Não é percentual de saúde, diagnóstico, risco ou prognóstico.

## O que foi implementado
- **Núcleo** (`server/src/modules/lifescore/core.ts`): porte fiel de `core.mjs`/`release.mjs`. Bateria oficial: FIC01 = 100,00; FIC02 = 63,75; FIC03 = não calculável com prioridade preservada; FIC01 com D07-I04 em L3 = 99,06.
- **Especialista** (atendimento › Life Score): 24 itens com descrições L0–L4, "não avaliado", "qualidade inadequada", "recusado", "desconhecido" e "não se aplica" (só D03-I02, D03-I03, D04-I03, com justificativa). Evolução do atendimento visível como fonte; nada preenchido automaticamente. "Salvar rascunho" ≠ "Finalizar e publicar". Prévia com número e domínios. Interpretação profissional, resumo ao paciente e plano (retorno com data — atalhos 30/60/90 dias ou data livre, sem pré-seleção; sem retorno; definir depois com justificativa). Encerrar sem score com justificativa. Controle de concorrência e publicação idempotente.
- **Preocupação de segurança**: botão próprio, salva na hora (independe do formulário e do score) e avisa RT e Central.
- **Paciente**: card "Meu acompanhamento" na Carteira e página com domínios, histórico, comparação só entre avaliações equivalentes, próximo passo e "Solicitar atendimento". Antes da primeira avaliação: "Seu acompanhamento estará disponível após uma avaliação de enfermagem finalizada." Rascunho e prévia nunca aparecem.
- **Responsável autorizado** (permissão "Documentos"): vê o mesmo acompanhamento publicado.
- **Central/RT** (Gestão › Life Score): filtros (situação, paciente/profissional, período), em andamento/publicadas/pendentes há +24 h, retornos, preocupações de segurança abertas com registro de tratamento, lembretes e falhas. Operação/Admin/Auditor veem só estados; o conteúdo clínico é do RT (acesso auditado).
- **Retificação**: nova versão com motivo; a original fica no histórico como "retificada". Publicada é imutável no banco.
- **Lembretes PRIME**: até 3 contatos (D-7, D e D+7) às 9h de São Paulo; sem retroativos; no próprio dia após 9h usa o próximo horário (até 18h). Rechecagem antes de cada envio: PRIME ativo, lembretes ativos nas preferências, plano vigente, sem pedido pago depois do plano e sem recusa. Mensagem discreta, sem pontuação. Até 3 retentativas técnicas em 24 h. Estados: programado, em processamento, enviado, falhou, pulado, cancelado.
- **Suspensão** (RT): cálculo e/ou lembretes, com justificativa. Avaliações anteriores continuam acessíveis; assistência e preocupações seguem.

## Liberação operacional (antes de usar com pacientes reais)
- Contas fictícias (`@exemplo.test`) rodam em **homologação** e calculam normalmente.
- Pacientes reais só têm número calculado depois que o RT registra a **liberação operacional** (Gestão › Life Score › Registrar liberação), com a referência do relatório de homologação e da aprovação do RT. O registro é assinado no servidor (HMAC) e vale para este modelo e esta versão do módulo; pode ser revogado.

## Decisões de implementação para o RT confirmar
- **Lembretes**: segui o Comando de 09/11 (D-7, D, D+7 às 9h). O pacote v1.6 descrevia D-3, D, D+3 às 10h.
- **Comparação**: "episódio" = acompanhamento contínuo do paciente na ONEMA; contexto de medida = domiciliar ou remoto; conjunto de tarefas = 24 itens v1. Comparação numérica só com mesma composição de itens aplicáveis e mesmo contexto.
- **Agendamento** que encerra os lembretes = pedido pago após a publicação do plano.
- Canais: notificação no app e e-mail (se configurado). WhatsApp segue desligado.

## Homologação sugerida (Marcos)
U01–U16 do pacote com contas fictícias: paciente, responsável, especialista, RT e operador. Registrar ID, resultado esperado/obtido, evidência e versão. Propor ativação controlada nos primeiros 30 atendimentos.
