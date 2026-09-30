# Implantação, backup e restauração

> Nenhum deploy foi realizado. Esta seção prepara a publicação para quando for autorizada. **Produção exige os gates G6–G8 (ver `PENDENCIAS.md`)**; a própria interface administrativa (Gestão › PRIME) mostra “Produção bloqueada” enquanto houver gate pendente.

## Netlify (PWA + API + banco) — caminho recomendado

Arquitetura publicada:

| Parte | Onde roda |
|---|---|
| PWA (interface) | arquivos estáticos da Netlify (`web/dist`) |
| API | Netlify Function `netlify/functions/api.mts` na rota `/api/*` (mesmo app Fastify do servidor local) |
| Banco | **Netlify DB** (Postgres gerenciado pela Neon) — variável `NETLIFY_DATABASE_URL` criada pela Netlify |
| Mídia privada da Academy | **Netlify Blobs** (store `academy-media`), servida só por URL assinada |
| Motor de ciclos PRIME | função agendada `netlify/functions/billing.mts` (a cada hora) |

A inicialização do banco (migrations, seed oficial, segredos internos gerados e guardados no banco se `APP_SECRET`/`PAYMENT_WEBHOOK_SECRET` não forem informados, administrador inicial e, opcionalmente, dados de demonstração) roda **na etapa de build** (`npm run netlify:init`), sem o limite de 10 s das Functions. A API, ao iniciar, só confirma a versão da inicialização (2–3 consultas). Se o banco não estiver acessível no build, a própria API inicializa no primeiro acesso (≈6 s com 60 ms de latência até o banco).

**Diagnóstico:** em *Logs → Functions → api* aparecem as linhas `[bootstrap] ...` com o tempo de cada etapa e `[api] falha na inicialização ...` em caso de erro; o log do deploy mostra `[netlify-init] Banco pronto` ou o aviso correspondente.

### Passo a passo

1. **Repositório:** o site já importado do GitHub (`1ONEMA/app-onema`, branch `claude/ecstatic-einstein-iew0xj` ou `main` após merge). Build e publish vêm do `netlify.toml`.
2. **Banco (Netlify DB):** o pacote `@netlify/neon` no projeto faz a Netlify provisionar o banco no deploy. Se o painel não mostrar o banco, crie em *Extensions → Neon / Netlify DB* (ou `npx netlify db init`). Confirme que a variável `NETLIFY_DATABASE_URL` aparece em *Site configuration → Environment variables*. **Importante:** bancos criados automaticamente precisam ser “reivindicados” (*claim*) na conta Neon dentro do prazo indicado no painel; caso contrário podem ser removidos.
3. **Variáveis de ambiente** (*Site configuration → Environment variables*; marque como segredo quando houver a opção):

| Variável | Obrigatória | Valor |
|---|---|---|
| `NETLIFY_DATABASE_URL` | sim | criada pelo Netlify DB (ou use `DATABASE_URL` de outro Postgres) |
| `BOOTSTRAP_ADMIN_EMAIL` | sim (1º acesso) | e-mail do administrador inicial |
| `BOOTSTRAP_ADMIN_PASSWORD` | sim (1º acesso) | senha (≥ 10 caracteres, letras e números). Só é usada se a conta ainda não existir |
| `BOOTSTRAP_ADMIN_NAME` | não | nome exibido |
| `BOOTSTRAP_ADMIN_ROLES` | não | padrão `ADMIN_ACADEMY,ADMIN_PRIME` |
| `SEED_DEMO` | não | `true` para criar as contas e dados **fictícios** de demonstração (bloqueado quando `APP_ENV=production`) |
| `APP_ENV` | não | padrão `homologacao` (exibe o aviso de ambiente de testes) |
| `APP_SECRET`, `PAYMENT_WEBHOOK_SECRET` | não | se ausentes, são gerados aleatoriamente e guardados no banco |
| `REQUIRE_ADMIN_MFA`, `WHATSAPP_ENABLED`, `ACADEMY_REQUIRE_PAYMENT` | não | mesmos significados do `.env.example` |

   Após o primeiro login do administrador, **remova `BOOTSTRAP_ADMIN_PASSWORD`** do painel (a conta já existe; a variável não altera senhas existentes).
4. **Deploy:** *Deploys → Trigger deploy*. Depois, abra o site, entre com o administrador e configure o segundo fator (MFA).
5. **Evitar deploys sucessivos:** em *Build & deploy → Branches and deploy contexts*, desative *Deploy Previews* e *Branch deploys*.

### Limites conhecidos na Netlify

- Requisições e respostas de Functions têm limite de ~6 MB: **vídeos das aulas precisam de armazenamento externo com URL assinada** (ex.: S3/R2) quando forem entregues (P-006). Legendas, transcrições e imagens funcionam via Blobs.
- Tempo máximo de execução padrão de uma Function: 10 s (a API responde em milissegundos; a primeira partida com banco vazio levou ~0,7 s em teste).
- Rate limit é compartilhado entre instâncias pela tabela `rate_limits`.

### Backup (servidor próprio)

```bash
pg_dump "$DATABASE_URL" > onema-$(date +%F).sql     # backup físico do Postgres
npm run db:backup /caminho/seguro/backups           # exportação lógica (JSON por tabela), também para o banco local PGlite
tar czf media-$(date +%F).tgz data/media             # mídia privada (quando em disco)
```

Recomendações: backup diário + retenção conforme política a definir (P-012), armazenamento criptografado e fora do servidor, teste de restauração mensal.

## Restauração

1. Pare o serviço (ou coloque o site em manutenção).
2. Restaure o dump em um banco novo (`psql "$NOVO_URL" < backup.sql`) e aponte `DATABASE_URL`/`NETLIFY_DATABASE_URL` para ele; restaure a mídia.
3. Inicie o serviço: as migrations pendentes são aplicadas automaticamente.
4. Confira: `GET /api/health`, login administrativo, Gestão › Auditoria (sequência contínua), verificação pública de um certificado (hash deve coincidir), mídia abre sem erro de integridade.

## Rollback

Versão de código: reimplante a tag anterior (o banco é compatível para frente; migrations são somente aditivas nesta versão). Em caso de migration problemática, restaure o backup feito imediatamente antes da atualização.

## Diagnóstico na Netlify (erros 502/503)

- `GET /api/health` responde **sem** inicializar a aplicação e informa: `databaseConfigured` (variável `NETLIFY_DATABASE_URL`/`DATABASE_URL` presente), `dbLatencyMs`, `initialized` e `bootstrapVersion`. Não expõe segredos nem dados pessoais.
- A inicialização (migrations, seed oficial, administrador inicial, demonstração) é **retomável**: cada requisição executa só as etapas que cabem no tempo da Function (orçamento de 8 s) e grava o progresso no banco (`system_settings.bootstrap_progress`). Enquanto não termina, a API responde `503 INITIALIZING` e o PWA tenta novamente de forma automática a cada 5 s.
- Em geral a inicialização já é concluída no build (`npm run netlify:init`) quando o banco está disponível nessa etapa.
- Se persistir erro: Netlify › Logs › Functions › `api` — as mensagens de inicialização e de requisições lentas aparecem ali (sem conteúdo sensível).
