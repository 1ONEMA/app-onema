# Dependências externas e custos

## Nesta entrega: custo zero

Nenhum serviço pago foi contratado nem acionado. Nenhuma chamada externa é feita em tempo de execução (sem analytics, rastreadores, CDNs, fontes remotas ou IA). A política CSP do servidor restringe tudo a `'self'`.

## Dependências de software (npm, licenças permissivas)

| Pacote | Uso |
|---|---|
| fastify, @fastify/cookie, @fastify/static, @fastify/multipart | servidor HTTP |
| pg, @netlify/neon, @netlify/blobs, @netlify/functions | Postgres, Netlify DB, armazenamento de mídia e tipagem das Functions |
| @electric-sql/pglite (+ pglite-socket em testes) | Postgres local em WASM para desenvolvimento e testes |
| zod | validação |
| qrcode | QR do certificado e do MFA (gerado localmente) |
| react, react-dom, react-router-dom | interface |
| vite, @vitejs/plugin-react, typescript, tsx | build/execução |
| vitest, @playwright/test, concurrently | testes/desenvolvimento |

## Custos futuros identificados (estimar com fornecedores escolhidos)

| Item | Necessário para | Observação |
|---|---|---|
| Netlify (site, Functions, Blobs, função agendada) | homologação/produção | plano gratuito cobre a homologação; verificar limites de invocações, banda e minutos de build |
| Netlify DB (Neon Postgres) | homologação/produção | plano gratuito da Neon para início; produção pode exigir plano pago (armazenamento, backups/PITR) |
| Domínio + certificado TLS | produção | TLS pode ser gratuito (Let's Encrypt) |
| Gateway de pagamento | PRIME e taxa Academy (P-009) | taxa por transação + possíveis mensalidades; tratar chargeback |
| Provedor de e-mail transacional | recuperação de senha, convites, avisos | custo por volume |
| WhatsApp Business API oficial | lembretes opcionais (quando autorizado) | custo por conversa; somente após integração validada |
| Armazenamento de vídeo/streaming com URL assinada (S3/R2 etc.) | aulas da Academy (vídeos > 6 MB não passam pela Function) | volume e tráfego dos vídeos (P-006) |
| Monitoramento/logs | observabilidade | opcional |
| Licença da fonte Swiss721 | identidade | verificar licença web |
| Lojas Android/iOS | apenas se empacotado como app nativo | fora do escopo desta entrega (PWA) |
