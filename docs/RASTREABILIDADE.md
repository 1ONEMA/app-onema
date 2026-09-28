# Rastreabilidade: requisito → fonte → implementação → teste

Legenda de fontes: **DM** = Documento Mestre Academy v1.0; **PR** = ONEMA PRIME v2.0 (HTML, decisão RT 28/09/2026); **IV** = Manual de Identidade Visual; **PED** = pedido de desenvolvimento.
Testes: `auth.test.ts`, `academy.test.ts`, `prime.test.ts` (Vitest/API) e `e2e/*.spec.ts` (Playwright).
Situação: ✅ implementado e testado · 🟡 implementado, dependente de definição/integração · ⛔ não implementado (motivo).

## ONEMA Academy — telas (DM §4)

| ID | Tela | Implementação | Teste | Sit. |
|---|---|---|---|---|
| ACA-001 | Entrada | `web/src/pages/academy/AcademyHome.tsx` | e2e academy | ✅ |
| ACA-002 | Minha Jornada | `AcademyHome.tsx`, `GET /api/academy/journey` | academy.test “matrícula é idempotente…”; e2e | ✅ |
| ACA-003 | Detalhe do curso | `CoursePage.tsx`, `GET /api/academy/courses/:code` | e2e | ✅ |
| ACA-004 | Player da aula | `LessonPage.tsx` (texto/vídeo, legenda, transcrição, conclusão controlada) | academy.test progresso; e2e | 🟡 conteúdo/mídia oficiais pendentes (P-006) |
| ACA-005 | Atividade integradora | `ActivityPage.tsx`, APIs de tentativa/decisão | academy.test ACA-T011/T012; e2e | 🟡 roteiros C02/C04 pendentes (P-003) |
| ACA-006 | Avaliação final | `AssessmentPage.tsx` | academy.test T013–T022; e2e | 🟡 C02/C03/C04 pendentes (P-001/P-002) |
| ACA-007 | Resultado | `AssessmentPage.tsx` (regras atendidas, sem gabarito) | e2e | ✅ |
| ACA-008 | Histórico educacional | `HistoryPage.tsx`, `GET /history`, exportação JSON | academy.test T037 | ✅ |
| ACA-009 | Certificados | `CertificatesPage.tsx`, `VerifyCertificatePage.tsx` | academy.test T023–T026; e2e verificação | 🟡 modelo final pendente (P-008) |
| ACA-010 | Pagamento da jornada | `AcademyHome.tsx` (sandbox) | academy.test T004–T006 | 🟡 gateway real não autorizado (P-009) |
| ACA-011 | Dossiê do parceiro | Histórico + projeção de capacitação | academy.test T043/T044 | ✅ |
| ACA-012 | Catálogo de cursos | `admin/Content.tsx` | academy.test T039/T040 | ✅ |
| ACA-013 | Gestão de conteúdo e mídia | `admin/Content.tsx`, `admin/Media.tsx` | academy.test T032/T041/T042 | ✅ |
| ACA-014 | Banco de questões | `AssessmentEditor` | academy.test T020 | ✅ |
| ACA-015 | Auditoria e relatórios | `admin/System.tsx` (auditoria), `AcademyOps.tsx` (relatórios) | academy.test T027/T028; e2e | ✅ |

## ONEMA Academy — casos de teste de referência (DM §14)

| Caso | Cobertura |
|---|---|
| T001 acesso não autenticado | auth.test “401 nas APIs protegidas” ✅ |
| T002 somente dados próprios | academy.test matrícula/jornada; T035 ✅ |
| T003/T038 segregação clínica | academy.test “segregação” ✅ (tabelas separadas) |
| T004/T005/T006 comercial e webhook repetido | academy.test ✅ |
| T007 versão preservada | academy.test “publicação exige aprovação RT…” ✅ |
| T008/T009/T010 progresso | academy.test ✅ |
| T011/T012 atividade C01 | academy.test ✅ |
| T013/T014/T015/T016 avaliação C01 | academy.test ✅ |
| T017/T018/T019 C04 críticas | academy.test (fixture de teste com limite de tentativas **fictício**, isolado no banco de teste) ✅ |
| T020 gabarito pela API | academy.test ✅ |
| T021/T022 replay e sessões concorrentes | academy.test ✅ |
| T023/T024/T025/T026 certificado | academy.test ✅ |
| T027/T028 auditoria | academy.test ✅ |
| T029/T030 Kary | ⛔ IA não implementada (não autorizada nesta execução) |
| T031 teclado | Parcial: foco visível, skip link, rótulos, diálogos com Esc; sem auditoria WCAG formal ⚠️ |
| T032 vídeo sem legenda/transcrição | academy.test ✅ |
| T033 responsividade | e2e em Pixel 7 e 1366×900 + revisão visual ✅ (tablet não testado isoladamente) |
| T034 perda de rede na avaliação | Idempotency-Key reaproveitada após falha de rede; sem aprovação local (código) — sem teste automatizado de rede instável ⚠️ |
| T035 IDOR | academy.test ✅ |
| T036 CSRF/replay | auth.test (CSRF/Origin), idempotência ✅ |
| T037 exportação | academy.test ✅ |
| T039/T040 publicação/edição | academy.test ✅ |
| T041/T042 mídia | academy.test ✅ |
| T043/T044 integração credenciamento | academy.test ✅ |
| T045 restore | Procedimento documentado; não executado em teste automatizado ⚠️ |
| T046 observabilidade | correlation id em respostas/logs/auditoria; logs com redação de cookies ✅ (sem stack de observabilidade externa) |
| T047 carga | ⛔ não executado (SLO não definido) |
| T048 desativação de curso | academy.test ✅ |

## ONEMA PRIME — critérios de aceite (PR “Critérios verificáveis”)

| ID | Implementação | Teste | Sit. |
|---|---|---|---|
| A01 acesso sem PRIME/após cancelamento | Minha ONEMA independente da assinatura | prime.test A01; e2e | ✅ (Carteira/prontuário: integração pendente) |
| A02 adesão sem marketing/convite | `PrimeSubscribePage.tsx`, `POST /api/prime/subscriptions` | prime.test A02; e2e | ✅ |
| A03 elegibilidade do catálogo | `catalog_items.prime_eligible` (padrão elegível) | prime.test | 🟡 catálogo oficial v3 não fornecido |
| A04 5%, centavos, teto R$ 20, pacote uma vez | `discountFor`, `quote` | prime.test A04 (8990→450; 26990→1350; 44990→2000; 72990→2000) ✅ |
| A05 checkouts paralelos, duplo clique, webhook | índice único por ciclo + idempotência + confirmação de preço | prime.test A05 ✅ (webhook de pagamento PRIME real: futuro) |
| A06 responsável só agenda, revogar | `share_*`, verificação pelo Operador | prime.test A06; e2e ✅ |
| A07 WhatsApp só lembretes, sem ofertas | canal desabilitado até integração oficial | prime.test A07 ✅ |
| A08 desligar resumo e mudar frequência | `preference_events` | prime.test A08; e2e ✅ |
| A09 cancelar e arrepender-se | protocolo, bloqueio de renovação, estorno com trilha | prime.test A09; e2e ✅ |
| A10 tarefa não registrada não aparece | Minha ONEMA mostra só eventos reais | prime.test A10 ✅ |
| A11 fornecedor sem CNPJ bloqueia produção | `productionGates()` | prime.test A11 ✅ |
| A12 métricas por coorte do piloto | ⛔ piloto com pacientes reais não autorizado; painel mostra contagens agregadas reais | — |

## PRIME — rotas funcionais (PR “Rotas e conteúdo da interface”)

| Rota do documento | Implementação |
|---|---|
| Catálogo → cartão PRIME | `/prime` |
| PRIME → adesão | `/prime/adesao` (T1+T2 integrais, aceite obrigatório T3, opcionais separados, prévia de datas do servidor) |
| PRIME → minha assinatura | `/prime/assinatura` |
| Minha ONEMA → continuidade | `/minha-onema` (integrações pendentes explícitas) |
| PRIME → preferências | `/prime/preferencias` |
| PRIME → responsável | `/prime/responsavel`, `/convites`, `/apoio/:id` |
| Checkout de serviço/pacote | `/servicos` |
| PRIME → cancelar / arrepender-se | `/prime/assinatura` (diálogos) |

## Eventos de estado PRIME (PR “Fluxo e eventos”)

ASSINATURA_SOLICITADA, PRIME_ACTIVE, DESCONTO_RESERVADO/USADO(/LIBERADO), PAYMENT_PENDING, PRIME_SUSPENDED, CANCEL_SCHEDULED/CANCELLED, REFUND_PENDING/REFUNDED, SHARE_GRANTED/SHARE_REVOKED, OPT_IN/OPT_OUT — todos gravados em `audit_events` (ou `preference_events`) por `server/src/modules/prime/*`, cobertos em `prime.test.ts`.

## Requisitos transversais (PED)

| Requisito | Implementação | Teste |
|---|---|---|
| Login, saída, recuperação | `modules/auth` | auth.test; e2e ✅ (envio de e-mail pendente de provedor) |
| MFA administrativo | TOTP | auth.test; e2e ✅ |
| Persistência após recarregar | SQLite | e2e (reload) ✅ |
| Rotas diretas | fallback SPA no servidor | e2e ✅ |
| Manifest/ícones/SW/offline | `web/public/manifest.webmanifest`, `sw-template.js` | e2e pwa ✅ |
| Estratégia de atualização | banner “Nova versão disponível” + SKIP_WAITING | manual (código) |
| Sem cache de dados de saúde | SW ignora `/api/*`; `Cache-Control: no-store` | e2e pwa ✅ |
