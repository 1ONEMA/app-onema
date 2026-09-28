# Perfis e permissões

Toda autorização é verificada **no servidor** (`requireRoles` em `server/src/lib/context.ts`); a interface apenas oculta o que o perfil não pode usar. Perfis administrativos exigem sessão com **MFA (TOTP) verificado** (`REQUIRE_ADMIN_MFA=true`). Mutações exigem cookie de sessão `httpOnly`/`SameSite=Strict`, token CSRF e Origin permitido; operações críticas exigem `Idempotency-Key`.

Fonte dos perfis Academy: Documento Mestre, seção 11. Perfis PRIME: derivados do documento PRIME v2.0 (titular, responsável, pagador, Central Operacional, parâmetros com RBAC).

## Perfis

| Perfil | Pode | Não pode (bloqueado no servidor) |
|---|---|---|
| **PACIENTE** (titular) | Minha ONEMA; aderir/cancelar/arrepender-se do PRIME; preferências; convidar e revogar responsável; ver histórico de acessos; catálogo e pedidos; aceitar convites de outros titulares | Academy; áreas administrativas; dados de outros pacientes |
| **Responsável** (paciente convidado) | Após aceite autenticado **e** verificação pela ONEMA: ver somente os escopos concedidos (agenda, documentos, cobranças). Cada acesso é registrado | Qualquer escopo não concedido ou revogado; acesso antes da verificação |
| **ESPECIALISTA** | Sua jornada, aulas, atividade, avaliação, histórico (e exportação), certificados, pedido da taxa | Gabarito, rascunhos, dados de outros parceiros, definir aptidão |
| **SUPORTE_ACADEMY** | Estado técnico do parceiro (estados, contagens), registrar/encerrar chamados | Notas, respostas, gabarito, alterar conclusão/aptidão |
| **GESTOR_CONTEUDO** | Criar rascunhos de versão, editar aulas, enviar mídia, rascunhos de atividade/questões (vê gabarito só em rascunho), rascunho de modelo de certificado | Aprovar (qualquer coisa), publicar, alterar regras de aprovação, ver gabarito aprovado |
| **AVALIADOR_RT** | Aprovar/devolver versões, aprovar mídia, atividades, avaliações e modelo de certificado; definir regras de aprovação; revogar certificado | Aprovar o que ele próprio elaborou (segregação); publicar; reescrever histórico |
| **ADMIN_ACADEMY** | Publicar versões aprovadas, ativar/desativar cursos, usuários Academy e elegibilidade ONEMA ONE, relatórios, auditoria, revogar certificado | Publicar sem aprovação RT; alterar evidência imutável; acessar prontuário |
| **CREDENCIAMENTO** | Ver projeção de capacitação, registrar decisão humana (APTO exige jornada concluída + confirmação dos demais gates) | Transformar pagamento/conclusão em aptidão automática |
| **FINANCEIRO** | Pedidos Academy, cobranças/pedidos/descontos PRIME, decidir estornos (sandbox) | Respostas, notas, conteúdo clínico |
| **AUDITOR** | Leitura de auditoria, catálogos, relatórios, filas | Qualquer escrita |
| **OPERADOR_CENTRAL** | Verificar (ou recusar) autorização do responsável | Verificar convite do qual participa; alterar escopos do titular |
| **ADMIN_PRIME** | Parâmetros comerciais (nova versão, sem retroagir), catálogo, identificação do fornecedor, registro de parecer jurídico, motor de ciclos, usuários PRIME | Alterar ciclos já contratados |

## Quem atribui cada perfil

| Perfil | Atribuído por |
|---|---|
| PACIENTE | Autocadastro |
| ESPECIALISTA, SUPORTE_ACADEMY, GESTOR_CONTEUDO, AVALIADOR_RT, ADMIN_ACADEMY, CREDENCIAMENTO | ADMIN_ACADEMY |
| OPERADOR_CENTRAL, ADMIN_PRIME | ADMIN_PRIME |
| FINANCEIRO, AUDITOR | ADMIN_ACADEMY ou ADMIN_PRIME |

Remover perfis revoga as sessões do usuário. Um administrador não pode remover o próprio perfil administrativo nem desativar a própria conta. O primeiro administrador é criado pelo CLI (`npm run user:create`).

## Controles transversais

- Sessões revogáveis (tabela `sessions`), expiração configurável, revogação em troca/redefinição de senha.
- Senhas com scrypt + sal; mensagem de erro de login idêntica para e-mail inexistente; rate limit em login, cadastro, recuperação, MFA e verificação pública.
- IDOR: tentativas, decisões, convites e certificados são sempre filtrados pelo dono (retorna 404).
- Gabarito nunca é serializado para o especialista; tentativa de acesso à rota administrativa é negada e auditada.
- Trilha `audit_events` append-only (triggers bloqueiam UPDATE/DELETE), com hashes antes/depois e correlation id, sem senhas, respostas ou conteúdo clínico. `preference_events` e `share_access_log` também são append-only; certificados emitidos têm evidência imutável.
- Dados educacionais, financeiros e (futuros) clínicos estão em tabelas separadas; a Academy não referencia paciente/prontuário.
