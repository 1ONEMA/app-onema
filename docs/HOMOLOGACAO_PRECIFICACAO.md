# Homologação técnica — Precificação no PWA/App

Resposta ao **"ONEMA SAÚDE — Comando Oficial de Implantação da Precificação no PWA/App"** (Enf. Marcos Alves, RT, 30/09/2026), seção 9.
Ambiente: **homologação**, dados fictícios, pagamentos **simulados (sandbox)**. Nenhuma cobrança real foi ativada.

## 1. Resumo

| Item | Situação |
|---|---|
| 19 registros comerciais (11 serviços/continuidade + 8 pacotes) | Carregados como **versão 1**, vigência 30/09/2026, valores em centavos |
| Pós-Alta 7/14/30 dias | **2/4/6 atos**, repasses **R$ 220/440/660**, composição por componente |
| PRIME v1 | 5% em um pedido por ciclo, teto R$ 20, mensalidade R$ 34,90 separada; **repasse integral** |
| Monitoramento CAT-08 / PAC-05 | Identidade canônica única `OF-MONITORAMENTO-MENSAL`; aparece uma vez ao paciente; segunda contratação no mesmo mês é recusada |
| Painel administrativo | Nova versão com RBAC, motivo, vigência e trilha de auditoria; pedidos antigos preservados |
| Jornada do paciente | Necessidade → atendimento → materiais → **valores** → onde e quando → revisão/orçamento → confirmar e pagar → comprovante |
| Casos P01–P15 | **15/15 PASS** (testes automatizados `server/test/care.test.ts`) + jornada E2E em celular e desktop (`e2e/care.spec.ts`) |

## 2. Tabela de parâmetros implantada

Fonte única: banco (`catalog_items`, `catalog_item_versions`, `catalog_item_components`). Carga inicial em `server/src/db/content/pricing-v1.ts` (idempotente). Nenhum preço fica fixo na interface.

| Código | Registro | Preço | Repasse | Atos | Composição |
|---|---|---:|---:|---:|---|
| CAT-01 | Avaliação de Enfermagem | 269,90 | 170,00 | 1 | 1 × R$ 170 |
| CAT-02A | Curativo simples | 309,90 | 200,00 | 1 | 1 × R$ 200 |
| CAT-02B | Curativo complexo | 459,90 | 300,00 | 1 | 1 × R$ 300 |
| CAT-03 | Administração de medicamentos avulsa | 289,90 | 180,00 | 1 | 1 × R$ 180 |
| CAT-04 | Sondas e cateteres | 449,90 | 240,00 | 1 | 1 × R$ 240 |
| CAT-05 | Pós-alta hospitalar avulso | 319,90 | 180,00 | 1 | 1 × R$ 180 |
| CAT-06 | Pós-operatório avulso | 349,90 | 200,00 | 1 | 1 × R$ 200 |
| CAT-07 | Diabetes e Hipertensão (registro único) | 359,90 | 230,00 | 1 | 1 × R$ 230 |
| CAT-08 | Monitoramento ONEMA mensal | 379,90 | 200,00 | 4 | 4 remotos × R$ 50 |
| CONT-01 | Orientação on-line | 89,90 | 50,00 | 1 | 1 remoto × R$ 50 |
| CONT-02 | Reavaliação de Enfermagem | 249,90 | 160,00 | 1 | 1 × R$ 160 |
| PAC-01 | Pós-Alta 7 dias | 449,90 | 220,00 | 2 | 1 aval. × 170 + 1 remoto × 50 |
| PAC-02 | Pós-Alta 14 dias | 729,90 | 440,00 | 4 | 2 aval. × 170 + 2 remotos × 50 |
| PAC-03 | Pós-Alta 30 dias | 1.089,90 | 660,00 | 6 | 3 aval. × 170 + 3 remotos × 50 |
| PAC-04 | Curativo simples — 4 sessões | 1.229,90 | 800,00 | 4 | 4 × R$ 200 |
| PAC-05 | Monitoramento mensal (= CAT-08) | 379,90 | 200,00 | 4 | 4 remotos × R$ 50 |
| PAC-06 | Medicamentos 7 dias | 1.949,90 | 1.260,00 | 7 | 7 × R$ 180 |
| PAC-07 | Medicamentos 14 dias | 3.799,90 | 2.520,00 | 14 | 14 × R$ 180 |
| PAC-08 | Medicamentos 21 dias | 5.899,90 | 3.780,00 | 21 | 21 × R$ 180 |

Todos elegíveis ao PRIME v1. Desconto no servidor: `min(floor((preço × 5 + 50) / 100), 2000)` centavos. Rótulos dos atos de pós-alta: inicial / (intermediária) / final.

## 3. Mapa de telas

| Perfil | Tela | Rota | Evidência |
|---|---|---|---|
| Público | Início (Café com a ONEMA, hero, necessidades) | `/` | `evidencias/*-evid-01-inicio.png` |
| Público | Kary (assistente) | botão flutuante | `*-evid-02-kary.png` |
| Paciente | Atendimento da necessidade | `/solicitar` | `*-evid-03-atendimento.png` |
| Paciente | **Valores logo após materiais** (sem login) | `/solicitar` | `*-evid-04-valores-visitante.png` |
| Paciente | Onde e quando | `/solicitar` | `*-evid-05-onde-e-quando.png` |
| Paciente | Revisão: escopo, logística, orçamento completo | `/solicitar` | `*-evid-06-revisao-orcamento.png` |
| Paciente | Confirmar e pagar R$ [TOTAL] | `/solicitar` | `*-evid-07-pagamento.png` |
| Paciente | Comprovante e próximos passos, estrelas | `/solicitacoes/:id` | `*-evid-08-comprovante.png` |
| Paciente | Meus pedidos | `/servicos` | — |
| Especialista | Ofertas com repasse integral | `/especialista` | `desktop-evid-09-especialista-ofertas.png` |
| Especialista | Meus atendimentos, repasse a liquidar | `/especialista` | `desktop-evid-10-especialista-atendimentos.png` |
| Central | Operação (pedidos, solicitações, atendimentos, avaliações) | `/central` | `desktop-evid-11-central-operacao.png` |
| Central | Precificação (tabela completa, versões, margens) | `/central?aba=precos` | `desktop-evid-12-central-precificacao.png` |
| Central | Conciliação e estorno | `/central?aba=conciliacao` | `desktop-evid-13-central-conciliacao.png` |
| Central | Autoteste P01–P04 ao vivo | `/central?aba=autoteste` | `desktop-evid-14-central-autoteste.png` |

## 4. API

| Método e rota | Perfil | Função |
|---|---|---|
| `GET /api/care/needs` | público | Catálogo informativo (sem repasses) |
| `GET /api/care/price?itemCode=` | público / paciente | Etapa "Valores": preço + desconto PRIME aplicável |
| `POST /api/care/requests` | paciente | Cria solicitação e orçamento v1 (idempotente) |
| `PUT /api/care/requests/:id` | paciente | Edita; se afetar valores, nova versão e aceite invalidado |
| `POST /api/care/requests/:id/accept` | paciente | Aceite da versão exata do orçamento |
| `POST /api/care/requests/:id/checkout` | paciente | Confirmar e pagar (reserva + consumo do desconto, idempotente) |
| `POST /api/care/requests/:id/cancel` | paciente | Desistência sem cobrança |
| `POST /api/care/events/:id/review` | paciente | Estrelas do atendimento concluído |
| `GET /api/care/specialist/offers`, `.../events/:id/accept`, `.../complete`, `/summary` | especialista validado | Ofertas, aceite, conclusão, repasses e avaliações |
| `POST /api/care/payment-webhooks` | provedor (HMAC) | Eventos de pagamento, idempotentes por `eventId` |
| `GET /api/admin/care/catalog` | ADMIN_PRIME, FINANCEIRO, AVALIADOR_RT, AUDITOR | Tabela completa, versões, margens |
| `POST /api/admin/care/catalog/:code/versions` | ADMIN_PRIME, FINANCEIRO | Nova versão (motivo, vigência) |
| `POST /api/admin/care/canonical/:canonical/versions` | ADMIN_PRIME, FINANCEIRO | Mesma versão para CAT-08 e PAC-05 |
| `GET /api/admin/care/overview` | + OPERADOR_CENTRAL (sem repasses) | Operação |
| `GET /api/admin/care/reconciliation` | ADMIN_PRIME, FINANCEIRO, AVALIADOR_RT, AUDITOR | Conciliação |
| `POST /api/admin/care/orders/:id/refund` | FINANCEIRO, ADMIN_PRIME | Estorno (simulado) |
| `GET /api/admin/care/selfcheck` | idem catálogo | Autoteste P01–P04 |

## 5. Migração, modelos e registros

- Migração `006_care_pricing` (`server/src/db/migrations.ts`): versões e composição do catálogo, solicitações (`care_requests`, com versão e aceite do orçamento), colunas de cópia no pedido (`service_orders.snapshot_json`, versão, repasse, atos, período), eventos filhos (`care_events`), repasses (`payout_entries`, **um por evento**), eventos do provedor (`care_payment_events`, **id único**) e avaliações (`specialist_reviews`).
- Garantias no banco: um desconto ativo por ciclo (`uq_discount_cycle`, já existente), um pedido aberto/pago por solicitação, uma contratação do monitoramento por paciente e mês (`uq_order_canonical_period`), um repasse por evento.
- Logs: trilha `audit_events` (ORDER_CREATED, DESCONTO_RESERVADO/USADO/LIBERADO, ORDER_PAID, ORDER_REFUNDED, PAYMENT_EVENT_IGNORED, PRICE_VERSION_CREATED com motivo e autor, CARE_QUOTE_REISSUED…).

## 6. Casos de teste P01–P15

Executar: `npm test` (API) e `npm run test:e2e` (telas). Resultado nesta entrega: **API 81/81 aprovados** e **E2E 26 aprovados, 3 ignorados por projeto** (celular, tablet e desktop, incluindo acessibilidade axe nas novas telas).

| ID | Teste | Resultado | Onde |
|---|---|---|---|
| P01 | Carga dos registros | PASS | `care.test.ts › P01`; autoteste da Central |
| P02 | Pós-alta 7/14/30 | PASS | `› P02` (sem textos 3/5/9 atos nem R$ 270/370/570) |
| P03 | Composição | PASS | `› P03` (PAC-08: 21 eventos, 21 repasses = R$ 3.780, um único desconto) |
| P04 | Descontos da seção 7 | PASS | `› P04` (19 exemplos pela fórmula e pelo motor) |
| P05 | Um uso por ciclo | PASS | `› P05` (duplo clique, 3 pedidos concorrentes, webhook repetido e assinatura inválida) |
| P06 | Falha / estorno | PASS | `› P06` (falha libera reserva; estorno cancela repasses não executados, mantém o executado, não devolve uso) |
| P07 | Jornada de valores | PASS | `› P07` + E2E `evid-04` |
| P08 | Materiais ausentes | PASS | `› P08` (sem taxa; cotação → orçamento pendente, pagamento bloqueado) |
| P09 | Editar solicitação cotada | PASS | `› P09` |
| P10 | PRIME opcional | PASS | `› P10` (sem assinatura silenciosa; repasse R$ 170 com e sem desconto) |
| P11 | Perfis | PASS | `› P11` (paciente/visitante sem repasses; operador sem repasses; especialista não validado bloqueado) |
| P12 | Estado da assinatura | PASS | `› P12` (pendente, suspensa, cancelamento agendado) + testes PRIME existentes |
| P13 | Alteração administrativa | PASS | `› P13` (RBAC, motivo, vigência futura, pedidos antigos intactos, CAT-08/PAC-05) |
| P14 | Conciliação | PASS | `› P14` (margens de referência 20,26 / 20,58 / 20,28 / 20,43%) |
| P15 | Release e rollback | PASS | `› P15` (carga reexecutável; backup/restauração reverte versão indevida) |

## 7. Divergências e pontos para decisão do RT

1. **Itens fictícios antigos** (`DEMO-SERV-A/B/C`, `DEMO-PACOTE`) existiam como catálogo de demonstração. Foram **retirados de venda** pela migração e substituídos pela tabela oficial. Não havia preço oficial anterior divergente no banco (`R-1` estava vazio no seed oficial).
2. **Regra de repasse** (pendência antiga R-11) passa a seguir o comando: repasse integral por componente, reservado na confirmação do pagamento e "a liquidar" na conclusão do evento. **A liquidação efetiva** (data, conta, split) depende do mecanismo aprovado na operação e do provedor — não foi criada regra nova.
3. **Margem abaixo do aviso de 17% com PRIME**: CAT-02A (16,99%), CONT-02 (16,55%) e CONT-01 (16,41%). O sistema apenas sinaliza na Central, sem alterar preço nem bloquear, conforme a seção 6.5.
4. **Estorno e uso do PRIME**: implementado como "não devolve uso ao ciclo" (o comando proíbe "novo uso arbitrário"). Confirmar se, em estorno total antes de qualquer ato, o uso deve ser devolvido.
5. **Validade do orçamento**: não foi definida no comando; o orçamento não expira (apenas é reemitido quando os dados mudam ou o PRIME muda).
6. **Orientação on-line (CONT-01)** foi agrupada na necessidade "Monitoramento ONEMA" e **Reavaliação (CONT-02)** em "Avaliação de Enfermagem" para a navegação do paciente. Ajustável sem mudar preços.

## 8. Configurações e credenciais ainda ausentes para produção

- Provedor de pagamento real (Asaas): CNPJ, chave de API, segredo de webhook (`PAYMENT_WEBHOOK_SECRET`), configuração de split.
- Emissor fiscal: credenciais e parametrização (hoje "SIMULADO" na conciliação; nenhuma taxa de nota é criada).
- Identificação do fornecedor (gate G6) e aceites finais (G7/G8).
- Kary com IA (opcional): `KARY_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`; sem isso a Kary usa somente a base de respostas própria.

## 9. Plano de reversão

1. Antes do release: `npm run db:backup`.
2. Erro de valor depois de publicado: registrar **nova versão** corrigida na Central (os pedidos já contratados não mudam).
3. Erro estrutural: `npm run db:restore -- arquivo.json.gz --confirmar` (faz backup de segurança antes) e reimplantar a versão anterior do app. A carga v1 é idempotente e pode ser reexecutada.
