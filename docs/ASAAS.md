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
