# Pagamentos reais com o Asaas

## Como funciona
- **Pedidos de cuidado e taxa da ONEMA Academy:** ao confirmar, o app cria a cobrança no Asaas e abre a **página segura do Asaas** (Pix, boleto ou cartão). Os dados de cartão não passam pela ONEMA.
- **ONEMA PRIME:** assinatura mensal no Asaas. *Cartão de crédito*: o Asaas guarda o cartão no 1º pagamento e renova sozinho. *Pix ou boleto*: o Asaas gera a cobrança de cada mês. O cancelamento no app interrompe as cobranças futuras no Asaas.
- **Confirmação:** só pelo **webhook** do Asaas (nunca pela tela de sucesso do navegador). Cada evento é processado uma vez; o valor pago é conferido com o pedido.
- **Estornos** aprovados pelo Financeiro (pedidos e PRIME) são enviados ao Asaas.
- **CPF:** pedido uma única vez, só para criar o cliente no Asaas (exigência do Asaas). A ONEMA guarda apenas o id do cliente.
- Cobrança vencida (Pix/boleto) mantém o pedido aguardando; desistência cancela a cobrança no Asaas e libera o desconto PRIME reservado.

## Configuração (uma vez)
1. **Asaas → Integrações → Chaves de API → Gerar chave.** Copie a chave.
2. **Netlify → Site configuration → Environment variables:**
   - `ASAAS_API_KEY` = a chave copiada;
   - `ASAAS_WEBHOOK_TOKEN` = uma senha longa inventada (≥ 20 caracteres, letras e números).
3. **Publique** (deploy). Confira em `/api/system/status` que `paymentProvider` está `ASAAS`.
4. **Asaas → Integrações → Webhooks → Adicionar webhook:**
   - Nome: `ONEMA SAÚDE`
   - URL: `https://onemasaude.com.br/api/payments/asaas/webhook`
   - E-mail: o de quem acompanha os pagamentos
   - Versão da API: `v3`
   - Token de autenticação: **o mesmo** valor de `ASAAS_WEBHOOK_TOKEN`
   - Fila de sincronização: ativada · Tipo de envio: sequencial
   - Eventos: **Cobranças** (no mínimo: criada, confirmada, recebida, vencida, removida, estornada)
5. **Teste com um valor real baixo** (ex.: a taxa da Academy) e confira: pagamento → pedido liberado no app → estorno pelo Financeiro.

## Observações
- Para testar sem dinheiro real, use uma conta do **sandbox do Asaas** (sandbox.asaas.com) e a chave `$aact_hmlg_...`.
- A conta do Asaas precisa estar **aprovada** (documentos da empresa) para receber em produção.
- Taxas do Asaas (Pix, boleto, cartão) são descontadas pelo Asaas no repasse à ONEMA; os preços ao paciente não mudam.
- Webhook com token errado recebe 403 e fica registrado na auditoria (`ASAAS_WEBHOOK_REJECTED`).

## Pacote financeiro v1.0 (04/11/2026) — repasses, reembolsos e contestações
O pacote técnico-financeiro autoriza **desenvolvimento e testes em Sandbox**. O que foi implementado:
- **Repasse à especialista por Pix externo** (conta única ONEMA; sem subconta, split ou escrow). Etapas: atendimento concluído e **assinado pelo paciente** → **validado** pela Central (Operador/RT) → **autorizado** pelo Financeiro (quem validou não autoriza; acima de `PAYOUT_DUAL_APPROVAL_CENTS`, padrão R$ 500, exige segunda aprovação de outra pessoa independente) → Pix enviado → confirmado pelo webhook ou pela conciliação, com tarifa e comprovante.
- **Prazo-alvo de 48 h** a partir da validação, com alertas ao Financeiro na validação (D+0), em 24 h (D+1) e perto de 48 h. É meta interna, não garantia bancária.
- **Nunca paga:** pedido não pago, estornado ou contestado; atendimento sem início, evolução assinada ou assinatura do paciente; chave Pix não verificada ou alterada há menos de 24 h; duplicidade (um repasse por atendimento, um id de transferência por repasse).
- **Timeout no envio:** o repasse fica "em verificação" e a conciliação procura a transferência pelo id interno antes de qualquer nova tentativa. Reprocessar uma falha exige pedido do Financeiro + aprovação do Administrador PRIME, e uma nova consulta ao Asaas.
- **Saldo insuficiente:** bloqueia, alerta e o Financeiro reenvia depois de recompor o saldo.
- **Chave Pix:** cadastrada pela especialista com a senha; guardada criptografada e exibida mascarada. Chave CPF igual à da candidatura é verificada na hora; outras chaves e trocas passam pela conferência do Financeiro. Troca de chave: bloqueio de 24 h, aviso no app e por e-mail, duas aprovações. Se o Asaas informar titular diferente do CPF, a chave é bloqueada e abre ocorrência.
- **Reembolso:** solicitação → análise → valor definido → devolução solicitada ao Asaas → **dinheiro devolvido** (confirmado pelo webhook). Antes do início: integral e automático. Com atos realizados (ou atendimento remoto já aceito): análise do Financeiro com memória de cálculo. Tarifas absorvidas pela ONEMA.
- **Chargeback:** abre ocorrência, bloqueia repasses pendentes e registra o valor já repassado a recuperar. "Revertida" só é aceita se o Asaas mostrar o pagamento como recebido.
- **Conciliação de hora em hora** (mesma rotina do PRIME): cobranças de cuidado pendentes (recupera webhook perdido), transferências enviadas/incertas e alertas de prazo. Também pode ser disparada em Central › Repasses.
- **Modo manual:** enquanto as transferências pelo Asaas estiverem desligadas, o Financeiro paga o Pix pelo banco e registra o identificador (E2E) no app.

### Trava de produção (Portão D)
Transferências pelo Asaas só ligam com `ASAAS_TRANSFERS_ENABLED=true` **e** chave de Sandbox (`$aact_hmlg_`), ou chave de produção com `ASAAS_PRODUCTION_APPROVED=true`. Este último só deve ser definido após a aprovação expressa do responsável administrativo e do RT (pacote, doc. 06).

### Configuração adicional no Asaas
- Webhook: incluir os eventos de **Transferências** (criada, pendente, em processamento, bloqueada, efetivada, falhou, cancelada) e de **Cobranças**: estorno parcial, estorno em andamento e chargeback (solicitado, em disputa, aguardando reversão).
- A chave de API precisa da permissão de **transferências/saque** para o modo automático (somente no Sandbox até o Portão D).
- Conferir na documentação atual do Asaas (docs.asaas.com/docs/transferencias) os campos de `POST /v3/transfers` e o filtro de listagem usados aqui.

### Pendências do pacote (dependem da ONEMA)
- Tabela contratual de remuneração (bruto, retenções e líquido): hoje retenções = 0 até definição do contador.
- NFS-e: emissão independente dos repasses, depende da configuração fiscal com o contador (o reembolso já guarda o campo de situação da nota).
- Tarifas, limites e liquidez da conta Asaas; validação jurídica da política de prazo; testes T13 (NFS-e) e evidências dos testes T01–T16 no Sandbox.
