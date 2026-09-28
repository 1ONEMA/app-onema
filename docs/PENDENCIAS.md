# Pendências reais e materiais necessários

Nenhuma destas pendências foi preenchida por suposição. O sistema exibe a pendência onde ela bloqueia um fluxo.

## Escopo

| # | Pendência | Impacto | Necessário |
|---|---|---|---|
| E-1 | **Anexo I — Escopo Funcional Contratado** não enviado | Não é possível afirmar que o implementado corresponde ao contratado | Enviar o Anexo I para conferência item a item com `RASTREABILIDADE.md` |
| E-2 | Pacote técnico citado no LEIA-ME (POPs65, laboratório, JSON/CSVs, hashes) não enviado | Nada de POPs65/motor foi reaproveitado | Enviar, se fizer parte do escopo |
| E-3 | Kary (IA educacional) | Não implementada | Autorização expressa + base versionada aprovada + provedor/política de dados |

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
| P-010 | Regra formal de credenciamento | Decisão humana com confirmação manual dos “demais gates” |
| P-011 | Conteúdo offline | Offline não disponibiliza dados; tela de indisponibilidade |
| P-012 | Prazos de retenção | Sem expurgo automático |
| A-1 | Integração ONEMA ONE (identidade/elegibilidade) | Elegibilidade registrada manualmente pelo ADMIN_ACADEMY |
| A-2 | Consentimentos Academy (`AcademyConsentRecord`) | Não implementado — textos não fornecidos |

## ONEMA PRIME

| # | Pendência | Estado |
|---|---|---|
| R-1 | Catálogo oficial “Preços Oficiais v3” | Catálogo vazio no seed oficial; 4 itens fictícios só na demonstração |
| R-2 | Gate G6: identificação do fornecedor (razão social, CNPJ, endereço, canal) e revisão jurídica T1–T3/Aviso de Privacidade | Produção bloqueada; cadastro disponível em Gestão › PRIME |
| R-3 | Gateway de pagamento real + webhooks | Sandbox |
| R-4 | Provedores de e-mail e WhatsApp oficial | Mensagens ficam na fila como “não enviado — sem provedor”; WhatsApp desabilitado |
| R-5 | Integração com Carteira Digital, agenda (Central Operacional) e registros assinados do profissional | Minha ONEMA, “documentos” e “agenda” do responsável mostram “integração pendente” |
| R-6 | Frequências dos lembretes | Valores provisórios: semanal, quinzenal, mensal — confirmar |
| R-7 | Validade do convite do responsável | 7 dias (provisório, configurável) |
| R-8 | Efeito do fim do PRIME sobre um responsável já verificado | Acesso mantido até revogação pelo titular — confirmar |
| R-9 | Espaçamento das novas tentativas de cobrança | Distribuídas igualmente na janela de 7 dias — confirmar |
| R-10 | Campanhas incompatíveis com o desconto | Não modeladas (nenhuma campanha definida) |
| R-11 | Regra de repasse ao profissional | Pedido guarda “base de repasse = preço cheio”; cálculo do repasse não definido |
| R-12 | Gates G7/G8 (aceites finais e decisão de produção) | Registro formal fora do sistema |

## Identidade visual

| # | Pendência |
|---|---|
| V-1 | Arquivo licenciado da fonte Swiss721 (hoje: pilha Helvetica/Arial equivalente) |
| V-2 | Logotipo horizontal em vetor (SVG) com fundo transparente — o app usa o PNG embutido no HTML oficial e o ícone recortado do manual |
| V-3 | Confirmar grafia do slogan (“ORGÂNIZADA”) no manual |

## Validações que dependem da ONEMA SAÚDE

Validação clínica, jurídica (CDC art. 49, Decreto 7.962/2013, LGPD, Resoluções Cofen citadas), de privacidade (DPO), acessibilidade WCAG formal, testes de carga/SLO, pentest e testes em dispositivos reais iOS/Android.
