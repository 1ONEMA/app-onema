# Carteira Digital — plano de cuidados e alertas (homologação)

- **Plano**: a enfermeira cria tarefas a partir do atendimento com evolução **assinada** (VisitPage). Paciente vê e confirma na Carteira (com pergunta de acompanhamento opcional); recorrência gera a próxima tarefa.
- **Motor** (`server/src/modules/carteira/engine.ts`, job horário + botão na central): regras versionadas com a matriz mestre (gatilho, destinatário, mensagem, prioridade, dono/substituto, cobertura, prazos, escalonamento, canais, deduplicação, teste). Só regras APROVADAS disparam; regra incompleta não pode ser aprovada. Clínicas bloqueadas em produção até `CARTEIRA_CLINICAL_ALERTS_APPROVED=1`.
- Regras iniciais **fictícias**: LEM-PLANO-001 (lembrete), ADM-PLANO-ATRASO-001 (tarefa vencida → enfermeira, escalona ao RT), CLI-FICT-001 (rascunho), TEC-CANAL-001 (falha de canal).
- **Fila**: PENDENTE → RECONHECIDO → EM_TRATAMENTO → RESOLVIDO/ENCERRADO, com revisão (rev) para concorrência, trilha append-only, deduplicação, escalonamento por prazo. Entrega ≠ leitura; falha de push não encerra o alerta.
- Telas: Carteira do paciente, painel da especialista (pendências), `/admin/carteira` (RT/Central). Testes: `server/test/carteira.test.ts`.
