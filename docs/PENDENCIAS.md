# Pendências reais e materiais necessários

Nenhuma destas pendências foi preenchida por suposição. O sistema exibe a pendência onde ela bloqueia um fluxo.

## Escopo

| # | Pendência | Impacto | Necessário |
|---|---|---|---|
| E-1 | **Anexo I — Escopo Funcional Contratado** não enviado | Não é possível afirmar que o implementado corresponde ao contratado | Enviar o Anexo I para conferência item a item com `RASTREABILIDADE.md` |
| E-2 | Pacote técnico citado no LEIA-ME (POPs65, laboratório, JSON/CSVs, hashes) não enviado | Nada de POPs65/motor foi reaproveitado | Enviar, se fizer parte do escopo |
| E-3 | Kary (assistente) | Implementada em homologação com base de respostas própria versionada (`KARY-BASE-v1`): orientação da plataforma e da Academy (cita aula/curso), recusa prescrição/dose, gabarito e aptidão com escalonamento ao RT; urgência → SAMU 192. IA opcional por `KARY_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` | Aprovação do texto da base pela ONEMA; decisão sobre provedor de IA e política de dados |

## ONEMA Academy (DM §15)

| # | Pendência | Estado no sistema |
|---|---|---|
| P-001 | Banco, nota, tentativas e feedback de C02 e C03 | Avaliações C02/C03 em rascunho sem regra; cursos não concluíveis |
| P-002 | Limite de tentativas/cooldown/banco C04 (8/10 e críticas mantidas) | Regra 8/10 + gate crítico cadastrados; avaliação não abre sem limite |
| P-003 | Roteiros e regras das atividades C02 e C04 | Rascunhos sem decisões; cursos bloqueados na atividade |
| P-004 | Divergência de atividade no C03 | Seguido Comando Mestre (sem atividade) — confirmar |
| P-005 | Cargas horárias | Certificado exibe “[VALIDAR]” |
| P-006 | Conteúdo das 17 aulas, vídeos, legendas, transcrições, direitos e checksums | Aulas sem conteúdo; C01 da demonstração usa texto fictício |
| P-007 | Rótulos internos C04-A03/A04 | Nota registrada na versão |
| P-008 | Modelo final do certificado, signatários, revogação, dados do QR | Emissão bloqueada até aprovação do modelo; QR mostra nome mascarado (a confirmar) |
| P-009 | Provedor de pagamento, fiscal, reembolso, chargeback; política de acesso com pagamento PENDENTE | Somente sandbox; matrícula exige PAGO (configurável) |
| P-010 | Regra formal de credenciamento | **Parcial:** candidatura com CPF/COREN/documentos (`/especialista/candidatura`) e conferência pelo Credenciamento implantadas; ofertas só para perfil APTO. Falta o RT definir a regra formal dos “demais gates” (hoje decisão humana) |
| P-011 | Conteúdo offline | Offline não disponibiliza dados; tela de indisponibilidade |
| P-012 | Prazos de retenção | Sem expurgo automático |
| A-1 | Integração ONEMA ONE (identidade/elegibilidade) | Elegibilidade registrada manualmente pelo ADMIN_ACADEMY |
| A-2 | Consentimentos Academy (`AcademyConsentRecord`) | Não implementado — textos não fornecidos |

## ONEMA PRIME

| # | Pendência | Estado |
|---|---|---|
| R-1 | ~~Catálogo oficial~~ | Resolvido: 19 registros do Comando de Precificação (30/09/2026) versionados; itens fictícios retirados (ver HOMOLOGACAO_PRECIFICACAO.md) |
| R-2 | Gate G6: identificação do fornecedor (razão social, CNPJ, endereço, canal) e revisão jurídica T1–T3/Aviso de Privacidade | Produção bloqueada; cadastro disponível em Gestão › PRIME |
| R-3 | Gateway de pagamento real + webhooks | Sandbox |
| R-4 | Provedores de e-mail e WhatsApp oficial | Mensagens ficam na fila como “não enviado — sem provedor”; WhatsApp desabilitado |
| R-5 | Integração com Carteira Digital, agenda (Central Operacional) e registros assinados do profissional | Minha ONEMA, “documentos” e “agenda” do responsável mostram “integração pendente” |
| R-6 | Frequências dos lembretes | Valores provisórios: semanal, quinzenal, mensal — confirmar |
| R-7 | Validade do convite do responsável | 7 dias (provisório, configurável) |
| R-8 | Efeito do fim do PRIME sobre um responsável já verificado | Acesso mantido até revogação pelo titular — confirmar |
| R-9 | Espaçamento das novas tentativas de cobrança | Distribuídas igualmente na janela de 7 dias — confirmar |
| R-10 | Campanhas incompatíveis com o desconto | Não modeladas (nenhuma campanha definida) |
| R-11 | Repasse ao profissional | Repasse integral por componente reservado no pagamento e “a liquidar” na conclusão; liquidação efetiva depende do provedor/split |
| R-12 | Gates G7/G8 (aceites finais e decisão de produção) | Registro formal fora do sistema |

## Precificação (Comando RT 30/09/2026)

| # | Pendência |
|---|---|
| PR-1 | Confirmar se estorno total antes de qualquer ato devolve o uso PRIME do ciclo (hoje: não devolve) |
| PR-2 | Validade do orçamento (não definida; hoje não expira) |
| PR-3 | Margens com PRIME abaixo do aviso de 17%: CAT-02A, CONT-01, CONT-02 (apenas sinalizado) |
| PR-4 | Credenciais Asaas (CNPJ), webhook real, split e emissor fiscal |
| PR-5 | Café com a ONEMA: revisar os 366 devocionais autorais e conferir a redação dos versículos (citados no estilo Almeida Revista e Corrigida) com a edição bíblica que a ONEMA adotar; textos podem ser trocados por data no painel (Gestão → Café com a ONEMA) |
| PR-6 | Termos ONEMA PRIME (T1, página pública /institucional/termos) citam a mensalidade e o teto do desconto em reais. A regra “nenhuma cifra em páginas públicas” (Adendo v7) vale também para os termos? Hoje mantidos por serem texto jurídico aprovado |

## Identidade visual

| # | Pendência |
|---|---|
| V-1 | ~~Fonte~~ — adotada Inter (licença OFL, hospedada no app), igual ao site de referência do cliente; Swiss721 só se a ONEMA enviar o arquivo licenciado |
| V-2 | ~~Logotipo~~ — logotipo oficial horizontal e ícone do app enviados pelo cliente (out/2026) aplicados; versão em vetor (SVG) ainda desejável |
| V-3 | Confirmar grafia do slogan (“ORGÂNIZADA”) no manual |

## Infraestrutura (Netlify)

| # | Pendência |
|---|---|
| I-1 | ~~Vídeos das aulas acima de 6 MB~~ — resolvido: envio e reprodução em partes (ver IMPLANTACAO.md) |
| I-2 | Banco no Supabase (plano gratuito, sem backup PITR): definir plano/backup antes de dados reais; manter banco e Function na mesma região |
| I-3 | Remover `BOOTSTRAP_ADMIN_PASSWORD` do painel após o primeiro acesso |
| I-4 | E-mail implementado (Resend), desligado até criar a conta e definir `RESEND_API_KEY`/`EMAIL_FROM` na Netlify |

## Validações que dependem da ONEMA SAÚDE

Validação clínica, jurídica (CDC art. 49, Decreto 7.962/2013, LGPD, Resoluções Cofen citadas), de privacidade (DPO), acessibilidade WCAG formal, testes de carga/SLO, pentest e testes em dispositivos reais iOS/Android.
