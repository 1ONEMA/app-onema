# Implantação, backup e restauração

> Nenhum deploy foi realizado. Esta seção prepara a publicação para quando for autorizada. **Produção exige os gates G6–G8 (ver `PENDENCIAS.md`)**; a própria interface administrativa (Gestão › PRIME) mostra “Produção bloqueada” enquanto houver gate pendente.

## Netlify (somente o PWA — versão de visualização)

A Netlify hospeda apenas arquivos estáticos e funções sem disco persistente; **a API (Fastify + SQLite + mídia privada) não pode rodar lá sem perda de dados**. O arquivo `netlify.toml` publica somente a interface:

- build `npm run build`, pasta publicada `web/dist`, Node 22;
- fallback SPA (acesso direto a qualquer rota) e cabeçalhos de segurança/cache;
- `/api/*` responde **503** com JSON explicando que a API de homologação não foi publicada. A interface mostra “Versão de visualização”: não é possível entrar, cadastrar ou operar; nenhum dado é enviado ou armazenado.

Como conectar (feito pelo responsável pela conta Netlify):

1. Netlify → *Add new site* → *Import an existing project* → GitHub → `1ONEMA/app-onema`.
2. Branch: `claude/ecstatic-einstein-iew0xj` (ou `main`, quando houver merge). Build/publish são lidos do `netlify.toml`.
3. Recomendado para evitar deploys sucessivos: em *Site configuration → Build & deploy → Branches and deploy contexts*, desative *Deploy Previews* e *Branch deploys* (ou use *Stop builds* e publique manualmente).
4. O plano gratuito da Netlify cobre este uso (verifique limites de minutos de build/tráfego da conta).

Quando a API tiver hospedagem com disco persistente (Render, Fly.io, Railway, VPS…), troque o redirecionamento de `/api/*` pelo proxy comentado no `netlify.toml` e configure no backend `PUBLIC_ORIGIN`/`ALLOWED_ORIGINS` com o domínio da Netlify. O proxy mantém a mesma origem, então cookies `SameSite=Strict` e CSRF continuam funcionando sem alteração de código.

## Requisitos

- Node.js ≥ 22.13 (usa `node:sqlite`), 1 vCPU / 512 MB RAM são suficientes para homologação.
- Disco persistente para `DATABASE_PATH` e `MEDIA_DIR` (**fora** de diretórios públicos).
- HTTPS obrigatório (proxy reverso: Nginx, Caddy ou o balanceador do provedor). O servidor envia HSTS em produção.

## Passo a passo (servidor único)

```bash
git clone <repo> && cd app-onema
npm ci
cp .env.example .env
# edite .env: NODE_ENV=production, PUBLIC_ORIGIN=https://<domínio>, ALLOWED_ORIGINS=https://<domínio>,
# APP_SECRET e PAYMENT_WEBHOOK_SECRET com 32+ caracteres aleatórios (ex.: openssl rand -base64 48)
npm run build
npm run db:seed                         # migrations + conteúdo/regras oficiais (sem dados fictícios)
npm run user:create -- admin@<domínio> "Nome" ADMIN_ACADEMY,ADMIN_PRIME
npm start                               # escuta em HOST:PORT; coloque atrás do proxy HTTPS
```

- **Nunca** execute `db:seed:demo` em produção (o comando recusa com `NODE_ENV=production`).
- O servidor recusa iniciar em produção sem `APP_SECRET`/`PAYMENT_WEBHOOK_SECRET`.
- Agende `npm run jobs:billing` a cada hora (cron/systemd timer) para o motor de ciclos PRIME.
- Mantenha `REQUIRE_ADMIN_MFA=true`, `PAYMENT_PROVIDER=SANDBOX` e `WHATSAPP_ENABLED=false` até as integrações reais serem aprovadas.

Exemplo systemd:

```ini
[Service]
WorkingDirectory=/opt/app-onema
EnvironmentFile=/opt/app-onema/.env
ExecStart=/usr/bin/npm start
Restart=always
User=onema
```

## Separação de ambientes

| Item | Desenvolvimento/HML | Produção |
|---|---|---|
| Dados | fictícios (`db:seed:demo`) | somente reais após gates |
| Banner de ambiente | visível (“homologação…”) | oculto |
| Pagamento | SANDBOX | provedor real (não implementado) |
| Link de redefinição de senha | registrado no log do servidor (sem provedor de e-mail) | exige provedor de e-mail |
| Segredos | padrões de desenvolvimento | obrigatórios via ambiente/secret manager |

## Backup

```bash
npm run db:backup /caminho/seguro/backups     # VACUUM INTO: cópia consistente, com o app em execução
tar czf media-$(date +%F).tgz data/media       # mídia privada da Academy
```

Recomendações: backup diário + retenção conforme política a definir (P-012), armazenamento criptografado e fora do servidor, teste de restauração mensal.

## Restauração

1. Pare o serviço.
2. Substitua `DATABASE_PATH` pelo arquivo de backup (remova `-wal`/`-shm` antigos) e restaure `MEDIA_DIR`.
3. `npm run db:migrate` (aplica migrations mais novas, se houver).
4. Inicie o serviço e confira: `GET /api/health`, login administrativo, Gestão › Auditoria (sequência contínua), verificação pública de um certificado (hash deve coincidir), mídia abre sem erro de integridade.

## Rollback

Versão de código: reimplante a tag anterior (o banco é compatível para frente; migrations são somente aditivas nesta versão). Em caso de migration problemática, restaure o backup feito imediatamente antes da atualização.

## Migração futura para PostgreSQL

O SQL usa recursos portáveis (índices parciais, triggers, `ON CONFLICT`). A troca exige: novo driver em `server/src/db/db.ts` (mantendo `one/all/run/tx`), ajuste dos triggers para PL/pgSQL e revisão de `json_group_array`/`group_concat`.
