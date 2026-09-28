# ONEMA SAÚDE — PWA (homologação)

Aplicativo web responsivo e instalável (PWA) da ONEMA SAÚDE com dois módulos cujo escopo está documentado nos materiais recebidos:

| Módulo | Fonte | Público |
|---|---|---|
| **ONEMA Academy** (Área do Especialista › ONEMA ONE) | *Documento Mestre de Transferência Técnica — ONEMA Academy para PWA/App v1.0* (25/09/2026) | Enfermeiros parceiros e equipes internas |
| **ONEMA PRIME** + Minha ONEMA | *ONEMA PRIME · Documento oficial de implantação e experiência do cliente v2.0* (decisão RT 28/09/2026) | Pacientes/titulares e responsáveis autorizados |

> **Estado:** ambiente de homologação. Dados fictícios, pagamentos **simulados (sandbox)**, nenhum envio real de e-mail/WhatsApp. A publicação em produção está bloqueada pelos gates documentados (ver `docs/PENDENCIAS.md`). Nenhuma declaração de conformidade jurídica ou clínica é feita por esta implementação.

## Stack

- **Backend:** Node.js ≥ 22.13, Fastify 5, TypeScript (executado com `tsx`), validação com Zod.
- **Banco:** SQLite nativo do Node (`node:sqlite`), migrations SQL versionadas em `server/src/db/migrations`. Mesmo motor SQL do laboratório de referência (D1). O acesso está isolado em `server/src/db/db.ts` para futura troca por PostgreSQL.
- **Frontend:** React 19 + React Router 7 + Vite 8, CSS próprio com tokens da identidade visual. Service worker próprio (somente app shell).
- **Testes:** Vitest (API, 51 testes) e Playwright (E2E em celular e desktop, 9 cenários).

## Executar localmente

```bash
npm ci
cp .env.example .env            # ajuste se necessário (em dev local pode usar REQUIRE_ADMIN_MFA=false)
npm run db:seed:demo            # migrations + seed oficial + dados FICTÍCIOS de demonstração
npm run dev                     # API em :8787 e PWA em http://localhost:5173
```

Versão de revisão igual à de produção (API servindo o PWA compilado):

```bash
npm run build
PUBLIC_ORIGIN=http://127.0.0.1:8787 npx tsx server/src/index.ts   # http://127.0.0.1:8787
```

### Contas de demonstração (fictícias)

Senha de todas: `Onema-Demo-2026`

| E-mail | Perfil |
|---|---|
| paciente.demo@exemplo.test | Paciente/titular |
| responsavel.demo@exemplo.test | Paciente (usado como responsável convidado) |
| especialista.demo@exemplo.test | Especialista elegível |
| especialista2.demo@exemplo.test | Especialista **não** elegível |
| gestor.demo@exemplo.test | Gestor de conteúdo |
| rt.demo@exemplo.test | Avaliador/RT |
| admin.academy.demo@exemplo.test | Administrador Academy |
| credenciamento.demo@exemplo.test | Credenciamento |
| suporte.demo@exemplo.test | Suporte Academy |
| financeiro.demo@exemplo.test | Financeiro |
| auditor.demo@exemplo.test | Auditor |
| operador.demo@exemplo.test | Operador da Central |
| admin.prime.demo@exemplo.test | Administrador PRIME |

Perfis administrativos pedem MFA (TOTP) no primeiro acesso: a tela exibe QR code/chave para um app autenticador.

**O que a base de demonstração contém:** textos de aula e questões **neutros e marcados como “DEMONSTRAÇÃO FICTÍCIA”** para exercitar os fluxos sob as regras oficiais do C01 (6 decisões; 12 questões, mínimo 10, 3 tentativas). C02–C04 continuam com as pendências reais (regras não definidas), portanto a jornada completa e a emissão de certificado **não** são concluíveis na demonstração — esses fluxos estão cobertos por testes automatizados com fixtures isoladas. O catálogo contém 4 itens fictícios com os valores do critério de aceite A04.

## Testes e build

```bash
npm run typecheck     # TypeScript (servidor + web + testes)
npm test              # API: permissões, regras de negócio, idempotência, concorrência, auditoria
npm run build         # typecheck + build de produção do PWA (web/dist, inclui sw.js)
npm run test:e2e      # Playwright: sobe servidor com banco isolado em data/e2e (requer build)
npm run test:all      # tudo acima
```

Se o Playwright não encontrar o Chromium, defina `PW_CHROMIUM=/caminho/para/chrome`.

## Comandos operacionais

| Comando | Uso |
|---|---|
| `npm run db:migrate` | aplica migrations pendentes |
| `npm run db:seed` | seed **oficial** (somente conteúdo/regras documentados; sem usuários) |
| `npm run user:create -- email "Nome" ADMIN_ACADEMY,ADMIN_PRIME` | cria administrador (senha temporária exibida uma vez; ou defina `NEW_USER_PASSWORD='...'` antes do comando para usar uma senha escolhida — nunca versionar) |
| `npm run jobs:billing` | motor de ciclos PRIME (renovação, novas tentativas, suspensão, encerramento) — agendar a cada hora em produção |
| `npm run db:backup [dir]` | backup consistente do banco (`VACUUM INTO`) |

## Estrutura

```
server/src/
  config.ts                 configurações por ambiente
  db/                       conexão, migrations SQL, seeds, CLI
  lib/                      segurança (scrypt, TOTP, HMAC, rate limit), auditoria, contexto/RBAC, erros
  modules/auth              login, cadastro, recuperação, MFA, avisos
  modules/academy           core.ts (motor de estados), routes.ts (especialista), admin.ts (gestão)
  modules/prime             core.ts (regras comerciais/ciclos), routes.ts (paciente/responsável), admin.ts
  modules/admin             usuários, auditoria, status do sistema
server/test/                testes de API (Vitest)
web/                        PWA (React) — src/pages/{auth,academy,prime,admin,common}, ui/, lib/
e2e/                        testes Playwright
docs/                       diagnóstico, permissões, rastreabilidade, implantação, pendências, custos, design
```

## Documentação

- [`docs/DIAGNOSTICO.md`](docs/DIAGNOSTICO.md) — análise dos materiais, escopo, conflitos e decisões.
- [`docs/PERMISSOES.md`](docs/PERMISSOES.md) — perfis e permissões (servidor).
- [`docs/RASTREABILIDADE.md`](docs/RASTREABILIDADE.md) — requisito → fonte → implementação → teste.
- [`docs/IMPLANTACAO.md`](docs/IMPLANTACAO.md) — implantação, backup e restauração, segurança operacional.
- [`docs/PENDENCIAS.md`](docs/PENDENCIAS.md) — pendências reais e materiais necessários.
- [`docs/DEPENDENCIAS_E_CUSTOS.md`](docs/DEPENDENCIAS_E_CUSTOS.md) — dependências externas e custos.
- [`docs/DESIGN.md`](docs/DESIGN.md) — aplicação da identidade visual e acessibilidade.
