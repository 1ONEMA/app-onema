# Diagnóstico dos materiais (28/09/2026)

## Materiais recebidos

| Arquivo | Natureza | Uso nesta entrega |
|---|---|---|
| `ONEMA_SAUDE_DOCUMENTO_MESTRE_ONEMA_ACADEMY_PWA_APP_v1.0.pdf` (12 p.) | Especificação técnica da ONEMA Academy: 4 cursos/17 aulas, estados, regras C01/C04, certificado, RBAC (8 perfis), modelo de dados, 17 APIs, 48 casos de teste, pendências P-001 a P-012 | Escopo e regras do módulo Academy |
| `ONEMA_PRIME_Oficial_Implantacao_Gabriella_Termos_Cliente_v2-1.html` | Documento oficial do PRIME v2.0 aprovado pelo RT em 28/09/2026: regras comerciais, textos integrais T1–T3, rotas, eventos, critérios A01–A12, gates | Escopo, regras, textos e referência visual do PRIME |
| `IDENTIDADE_VISUAL___ONEMA_SAU_DE.pdf` (16 p., imagens) | Manual de identidade (Agência Mibrand): logotipo, grid, tipografia Swiss721, paleta, ícones, grafismos, aplicações | Tokens de cor/tipografia, ícone do PWA, ícones e grafismo |
| `LEIA_ME_GABRIELLA.md` | Guia de um pacote de transferência (POPs65, código de laboratório, JSON, CSVs, testes) | Contexto e restrições (“não autorizado”) |

## Ausências

- **Anexo I — Escopo Funcional Contratado: não foi localizado entre os materiais.** Nenhuma funcionalidade foi tratada como “escopo contratual confirmado”. O que foi implementado deriva exclusivamente dos dois documentos de produto acima, que se declaram aprovados/para implementação pela ONEMA; isso precisa ser confirmado contra o Anexo I.
- O pacote descrito no `LEIA_ME` (pastas 01–07: POPs65, `laboratorio_pops65_grs6`, `site_publicado_v41`, JSON/CSVs, hashes) **não foi enviado**. Portanto nada sobre POPs65, guardas G-RS6, motor, Carteira Digital ou Central Operacional pôde ser reaproveitado.
- Fontes citadas pelos documentos e não enviadas: catálogo “Preços Oficiais v3”, *ONEMA Academy Plano Mestre*, pacote C01 (conteúdo e banco de 12 questões aprovados), roteiros de gravação, decks C02–C04, conteúdo programático do certificado, *Documento Mestre Aplicativo v1.0*, PRIME v1.0 e minutas.
- Arquivo da fonte Swiss721 (licenciada) não enviado.

## HTML existente

O único HTML é o documento PRIME. Ele contém uma **prévia interativa estática** (Oferta, Adesão, Minha ONEMA, Avisos, Responsável, Extrato, Cancelar) sem backend — explicitamente “não contrata, cobra, envia mensagem ou altera dados reais”. Foi usado como:

- referência de **conteúdo e composição** das telas do paciente (textos da oferta, ordem das informações, critério “nenhum aceite pré-marcado”);
- referência de **componentes** (superfícies com raio 18px, badges em pílula, callout com borda verde, blocos de cautela, abas em pílula) — reproduzidos com os tokens da identidade oficial.

Não havia versões concorrentes do HTML; a paleta do HTML (navy/teal) é próxima, mas distinta da paleta do manual. **Decisão:** usar a paleta do *Manual de Identidade Visual* (fonte específica de marca) e os padrões de componente do HTML.

## Stack

O repositório `app-onema` estava vazio (sem stack a preservar). O repositório `CRM-PMG-ACADEMY` é um produto diferente (CRM de vendas) e não foi alterado. Escolha justificada no README: Node/Fastify/TypeScript + SQLite nativo (mesmo motor do laboratório, zero serviço pago, backup por arquivo) + React/Vite, com camada de dados isolada para migração futura a PostgreSQL.

## Conflitos e divergências identificados

| # | Tema | Situação | Tratamento |
|---|---|---|---|
| D1 | C03 atividade integradora | Comando Mestre (vinculante): sem atividade; materiais de apoio divergem (P-004) | Seguido o Comando Mestre (`activity_required = 0`), divergência registrada na versão do curso |
| D2 | Paleta do HTML × manual | Tons diferentes | Manual prevalece; componentes do HTML mantidos |
| D3 | Cores do manual: HEX declarado × cor impressa na página | Ex.: Vivid Blue declarado `#1772FE`, página exibe tom mais escuro | Usado o HEX declarado; variações “strong” só para garantir contraste AA em texto |
| D4 | Assinatura do manual: “SUA SAÚDE ORGÂNIZADA…” | Acento em “ORGÂNIZADA” parece erro tipográfico | Logotipo usado no app é o arquivo embutido no HTML oficial (sem slogan); textos do app usam “organizada”. **Confirmar com a agência.** |
| D5 | Pagamento Academy PENDENTE | Doc: “acesso conforme política” (não definida) | Configurável (`ACADEMY_REQUIRE_PAYMENT=true` por padrão): matrícula exige PAGO. Confirmar (P-009) |
| D6 | PRIME “verificação pela ONEMA” do responsável | Quem verifica não é nomeado | Criado o perfil **OPERADOR_CENTRAL** (Central Operacional, citada no documento) |
| D7 | Parâmetros PRIME com RBAC | Perfil não nomeado | Criado **ADMIN_PRIME** |

## Classificação do que existe

| Item | Situação |
|---|---|
| Regras C01 (6 decisões; 12 questões, 10/12, 3 tentativas) | Documentadas como aprovadas → implementadas |
| Regra C04 (10 questões, 8/10, críticas 03/06/08/10 como gate) | Documentada → implementada; limite de tentativas pendente (P-002) → avaliação C04 não abre até definição |
| C02/C03 banco, nota, tentativas | Pendentes (P-001) → não inventadas; telas exibem a pendência |
| Conteúdo das 17 aulas, mídia, legendas, transcrições | Não entregues (P-006) → aulas com título oficial e conteúdo “pendente” |
| Cargas horárias | `[VALIDAR]` (P-005) → exibidas como “[VALIDAR]” no certificado |
| Modelo do certificado/signatários | Pendente (P-008) → emissão bloqueada até aprovação no sistema |
| PRIME: preço, desconto, teto, 1 uso/ciclo, 3 tentativas/7 dias, arrependimento 7 dias, T1–T3 | Aprovados pelo RT → implementados literalmente |
| Carteira Digital, agenda, plano de continuidade, prontuário | Sistemas existentes não fornecidos → telas informam “integração pendente”; nenhum dado inventado |
| Kary (IA educacional) | Consta no documento Academy, mas IA não foi autorizada por você nesta execução → **não implementada** |
| POPs65, prescrição, dose, decisão clínica | Explicitamente não autorizados → fora |
