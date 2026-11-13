# Telenfermagem — homologação (POP-ONEMA-TELE-001 v1.0)

**Status: APENAS HOMOLOGAÇÃO. PROIBIDO USO CLÍNICO REAL.** Sem `TELE_REAL_USE_APPROVED=1`, só pacientes com e-mail `@exemplo.test` podem ter episódios.

## Fluxo
SOLICITADO → TRIAGEM → OFERTADO → ACEITO → AGENDADO → EM_ATENDIMENTO → AGUARDANDO_REGISTRO → ASSINADO → CONCLUIDO
Desvios: INELEGIVEL, RECUSADO, EXPIRADO, CANCELADO, NAO_COMPARECEU, FALHA_TECNICA, ENCAMINHADO_PRESENCIAL, URGENCIA_ENCAMINHADA.

- Indicação: enfermeira (a partir de atendimento presencial concluído) ou Central/RT (`/admin/telenfermagem`).
- Elegibilidade: Central/RT; define a regra comercial versionada (retorno até 30 dias do presencial = incluído; demais = cobrado, valores de homologação). Nenhuma cobrança automática.
- Consentimento do paciente (append-only), com aceite explícito do preço quando cobrado.
- Oferta: preferência à enfermeira de origem por 12 h, depois a rede; Central redistribui.
- Sala: token pessoal de 10 min (só hash guardado). Com `DAILY_API_KEY`, vídeo real no Daily (sala privada por episódio, nome opaco, sem gravação, token de reunião emitido só após conferência, sala encerrada no fim da chamada); sem a chave, sala SIMULADA.
- Registro: rascunho (Kary só sugere), assinatura humana com hash, um registro por episódio, adendos versionados; aparece na Carteira Digital.
- Encerrar a chamada não gera cobrança nem repasse. Life Score não é recalculado.

## Matriz T01–T20
Coberta em `server/test/tele.test.ts` (API) e `e2e/tele.spec.ts` (jornada na tela).

## Pendências para produção
Fornecedor WebRTC (contrato, DPA, residência de dados), assinatura eletrônica aplicável, SLA, retenção, tabela de preços real e integração de cobrança, consentimento revisado pelo jurídico, aprovação formal do RT.
