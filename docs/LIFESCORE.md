# ONEMA Life Score — modelo OLS-8-HOM-0.1 (especificação v0.4)

Homologação. Índice descritivo 0–100; não é percentual de saúde, risco ou prognóstico; não define conduta, urgência ou retorno.

- **Modelo** (`server/src/modules/lifescore/model8.ts`): 4 domínios × 2 itens (C 30, A 20, S 30, K 20). R3 = 1, R2 = 2/3, R1 = 1/3, R0 = 0; contribuição = peso ÷ 2 × fração; domínio = média das frações × 100. Precisão interna; exibição com 2 casas.
- **Bloqueios**: não avaliado, desconhecido, recusa, informação inadequada, contexto ausente (tarefa A1, atividades A2, objetos S1, ferida S2, executor K1) e R0 sem fundamento bloqueiam o global (nunca zero). Domínios completos aparecem como parciais.
- **Revisão**: R0 em C1/C2/S1/S2 destaca pendência para revisão profissional, sem diagnóstico automático.
- **Segurança**: registro independente (descrição, prioridade imediata/prioritária/rotina, ação, responsável, situação), salvo sem score.
- **Telas**: especialista (domínio 1 de 4, sem pré-seleção, legenda recolhível só nas telas profissionais, revisar e publicar com confirmação), paciente (card "Meu acompanhamento" com o texto institucional exato; "Seu próximo cuidado" com Solicitar atendimento, Lembrar depois, Já agendei, Não quero retornar), RT (Gestão › Life Score: filtros, continuidade, providências, registros de teste esperado × observado, liberação separada).
- **Guardian**: −7/0/+7 às 9h (São Paulo), máx. 3 contatos, só PRIME e canal autorizado; contratação confirmada não é sobrescrita; limite sem resposta vira pendência operacional.
- **Modelo anterior (24 itens)**: arquivado; registros antigos (se houver) aparecem separados, sem recálculo. A Gestão mostra a contagem.
- Testes: `server/test/lifescore.test.ts` (gabaritos SIM8-01 a SIM8-08 e fluxos).
