# Auditoria de segurança — ONEMA SAÚDE

Protocolo seguido: **PMG Technology — Auditoria e Hardening de Segurança com IA v1.0** e **Guia de Vulnerabilidades Web & Defesas para SaaS** (OWASP Top 10, ASVS 5.0, API Security Top 10, NIST SSDF).
Data: 27/10/2026. Esta auditoria reduz risco dentro do escopo observado e **não é garantia absoluta** de ausência de vulnerabilidades (regra do próprio protocolo).

## A. Resumo executivo
- **Resultado:** P0: 0 · P1: 2 corrigidos · P2: 5 corrigidos · P3: 6 corrigidos/registrados. 3 itens pendentes para o lançamento com pacientes reais (ver G).
- **Status de publicação:** **APTO COM RISCOS** para homologação; **CONDICIONAL** para produção com pacientes reais (pagamento real e desligamento da demonstração — ver H).
- **Principais correções:** contas de equipe de demonstração (senha pública) bloqueadas no ambiente publicado; link de redefinição de senha fora dos logs; código 2FA não reutilizável e segredo 2FA criptografado; CPF criptografado (AES-256-GCM); conteúdo real dos arquivos validado no upload; senha com scrypt no padrão OWASP; isolamento da demonstração em pedidos reais; RLS ligado em todas as tabelas; cabeçalhos endurecidos; dependências sem vulnerabilidade conhecida.

## B. Escopo e acessos realmente utilizados
- Código completo (repositório `1ONEMA/app-onema`), testes automatizados, build.
- Banco de produção/homologação no Supabase (`flbtammifgfjihoighkf`): **somente leitura** (advisors, papéis, privilégios, RLS). Nenhum dado real alterado.
- **Não verificado:** painel do Netlify (equipe, MFA da conta, variáveis por contexto), painel do Supabase (MFA da conta, backups automáticos), DNS/TLS externo e cabeçalhos efetivos no domínio (o ambiente de auditoria não acessa o site publicado).

## C. Arquitetura e superfícies
Navegador (PWA React) → `/api/*` (Netlify Function com Fastify) → Postgres (Supabase, papel `onema_app`, schema `onema`) + Netlify Blobs (mídia e documentos privados).
- 166 rotas de API inventariadas. Públicas apenas: login, cadastro, recuperação de senha, `me`, catálogo **sem preços**, Café, Kary, termos, verificação de certificado e webhooks (assinatura HMAC). Mídia da Academy por URL assinada com validade.
- Perfis: PACIENTE, ESPECIALISTA, CREDENCIAMENTO, ADMIN_ACADEMY, ADMIN_PRIME, OPERADOR_CENTRAL, FINANCEIRO, AUDITOR, AVALIADOR_RT, GESTOR_CONTEUDO, SUPORTE_ACADEMY. Autorização sempre no servidor (`requireRoles`), MFA obrigatório para perfis administrativos.
- Dados sensíveis: CPF/COREN e documentos de candidatas, dados de solicitação de cuidado (nome, telefone, bairro), pagamentos (sandbox).

## D. Registro de achados
| ID | Sev. | Status | Categoria | Evidência | Impacto | Correção | Reteste |
|---|---|---|---|---|---|---|---|
| SEC-01 | P1 | Corrigido | Autenticação / demo | Contas `*@exemplo.test` de equipe com senha pública; MFA configurado por quem entra primeiro | Acesso administrativo (CPF/documentos de candidatas, auditoria, financeiro) | Bloqueio no ambiente publicado (`config.blockDemoStaff`), também para sessões antigas; liberação só com `ALLOW_DEMO_STAFF_LOGIN=true` | `auth.test.ts` (DEMO_STAFF_DISABLED; sessão antiga invalidada) |
| SEC-02 | P1 | Corrigido | Controle de acesso / negócio | Especialista de demonstração (senha pública) aceitava eventos de pacientes reais | Sequestro de atendimentos reais | No ambiente publicado, conta de demonstração só vê/aceita pedidos de pacientes de demonstração | `care.test.ts` (isolamento) |
| SEC-03 | P2 | Corrigido | Segredos em log | `auth/routes.ts`: link de redefinição gravado no log quando e-mail não configurado e `NODE_ENV` ≠ production (caso do Netlify) | Quem lê logs troca senha de qualquer conta | Log só em desenvolvimento local HTTP | revisão de código + testes de reset |
| SEC-04 | P2 | Corrigido | MFA | `verifyTotp` aceitava o mesmo código por ~90 s | Replay de código capturado | Último passo TOTP gravado (`mfa_last_step`); código igual/anterior recusado | `auth.test.ts` (replay → 400) |
| SEC-05 | P2 | Corrigido | Criptografia | scrypt N=16384 (abaixo do mínimo OWASP 2^17) | Quebra offline mais rápida se o banco vazar | N=2^17, r=8, p=1; rehash automático no próximo login | testes de login/cadastro |
| SEC-06 | P2 | Corrigido | Upload | Tipo do arquivo confiado ao `Content-Type` do navegador | HTML/script disfarçado de PDF | Validação pelos bytes iniciais (PDF/JPG/PNG/WEBP); download com CSP `sandbox`; limite de 10 documentos | `specialist.test.ts` (HTML como PDF → FILE_TYPE) |
| SEC-07 | P2 | Corrigido | Dependências | `npm audit`: fastify (moderada), zod (alta) | DoS/bypass de validação | Atualizados; `npm audit` = 0 | build + 91 testes + 28 e2e |
| SEC-08 | P3 | Corrigido | Dados sensíveis | CPF e segredo 2FA em texto puro no banco | Exposição em backup/dump | AES-256-GCM (`sealField`) + hash para unicidade (`cpf_hash`) | `specialist.test.ts`, `auth.test.ts` |
| SEC-09 | P3 | Corrigido | Banco | Supabase advisor 0011 (search_path mutável em 2 funções); RLS desligado | Defesa em profundidade | `search_path` fixo; RLS ligado em todas as tabelas (sem políticas: só o dono acessa) | migration 009 + advisors |
| SEC-10 | P3 | Corrigido | Cabeçalhos | CSP sem `object-src`; sem COOP/CORP; HSTS 1 ano | Defesa em profundidade | `object-src 'none'`, `upgrade-insecure-requests`, COOP/CORP `same-origin`, HSTS 2 anos | `netlify.toml`, `app.ts` |
| SEC-11 | P3 | Corrigido | Exposição de info | `/api/health` mostrava versão do Node e nomes de variáveis | Reconhecimento | Detalhes só quando há falha | revisão |
| SEC-12 | P3 | Corrigido | Privacidade no aparelho | Rascunho da solicitação (nome/telefone/endereço) ficava no `sessionStorage` após sair | Outro usuário do aparelho vê dados | Limpo no logout e na sessão expirada | revisão + e2e |
| SEC-13 | P3 | Risco aceito | Enumeração | Cadastro informa "e-mail já cadastrado" | Descobrir se um e-mail tem conta | Mantido por usabilidade; limitado a 10 cadastros/h por IP. Remover exige verificação de e-mail no cadastro | — |
| SEC-14 | P3 | Corrigido | Força bruta distribuída | Limite só por IP+e-mail | Tentativas de muitos IPs na mesma conta | Limite adicional por conta (32/15 min) | revisão de código |
| SEC-15 | — | Corrigido (anterior) | Origem/CSRF | Login bloqueado no domínio próprio | Indisponibilidade | Origin = endereço acessado; outros sites seguem bloqueados | `auth.test.ts` |

Controles verificados **sem falha**: SQL 100% parametrizado; sem `dangerouslySetInnerHTML`/`eval`; e-mails com escape; redirecionamentos internos validados; CSRF (SameSite=Strict + token + Origin); cookie de sessão HttpOnly/Secure/Strict, regenerado no login e revogado no logout/troca de senha; reset de senha com token único de 30 min (só o hash é guardado); respostas genéricas no login e na recuperação; preço sempre recalculado no servidor; webhooks com HMAC e idempotência; trilha de auditoria append-only (gatilhos); service worker não guarda nada de `/api`; sem segredos no repositório, histórico ou bundle; sem source maps publicados; papel do banco sem superusuário/bypass RLS; chaves públicas do Supabase sem acesso ao schema do app; todas as listagens com limite.

## E. Arquivos alterados
`server/src/lib/security.ts` (scrypt, TOTP anti-replay, criptografia de campo), `server/src/lib/context.ts` e `config.ts` (bloqueio de demo de equipe), `server/src/modules/auth/routes.ts`, `server/src/modules/care/routes.ts`, `server/src/modules/specialist/routes.ts`, `server/src/app.ts`, `netlify/functions/api.mts`, `netlify.toml`, `web/src/lib/auth.tsx`, migrations `009_security_hardening` e `010_cpf_criptografado`, testes em `server/test/*` e `e2e/helpers.ts`.
**Rollback:** reverter o merge no GitHub e publicar novamente. As migrations são aditivas (colunas novas e RLS sem políticas não afetam o app em versões anteriores).

## F. Testes executados
`npm run typecheck` ✔ · `npm run build` ✔ · Vitest **91/91** ✔ · Playwright **28/28** (celular, desktop, tablet, axe WCAG) ✔ · `npm audit` **0** ✔ · Supabase advisors (antes: 2 avisos; corrigidos pela migration 009).

## G. Riscos residuais e pendências
1. **Pagamentos simulados (P1 para produção):** qualquer paciente pode "pagar" escolhendo o cartão de teste. Correto para homologação; **antes de atender pacientes reais**, integrar o provedor (Asaas) com webhook assinado sobre o corpo bruto e desligar o modo sandbox.
2. **Demonstração no ar (P1 para produção):** no lançamento, definir `SEED_DEMO=false` e desativar as contas `*@exemplo.test`.
3. **E-mail transacional não configurado:** sem ele a recuperação de senha não chega ao usuário (nada vaza; só não funciona).
4. **Não verificado (fora do acesso):** MFA nas contas do Netlify, Supabase, GitHub e registro.br; quem tem acesso a essas contas; backups automáticos do Supabase; cabeçalhos efetivos no domínio (conferir em securityheaders.com após publicar).
5. **Recomendado:** pentest profissional independente antes de escalar (o próprio protocolo recomenda para sistemas de saúde); antivírus nos uploads; alertas automáticos (picos de falha de login, mudança de perfil); política de retenção LGPD (P-012).

## H. Checklist de publicação e rollback
- [ ] Publicar (merge) e abrir `https://onemasaude.com.br/api/health` → `"ok":true`.
- [ ] Login de paciente e da conta de administrador real; ativar 2FA.
- [ ] Conferir em https://securityheaders.com o domínio publicado.
- [ ] Ativar MFA nas contas Netlify, Supabase, GitHub e registro.br.
- [ ] Antes de pacientes reais: provedor de pagamento real, `SEED_DEMO=false`, e-mail transacional configurado.
- Rollback: GitHub → reverter o PR → merge (novo deploy).

## Adendo (29/10/2026) — pagamentos reais, IA e visita
| ID | Sev. | Status | Item | Controle |
|---|---|---|---|---|
| SEC-16 | P1 | Corrigido antes de publicar | Tentativas do código de início da visita eram desfeitas junto com o erro (limite nunca atingido) | Conferência e contagem fora da transação; 5 tentativas/15 min; auditoria `VISIT_CODE_INVALID` (teste `visit.test.ts`) |
| SEC-17 | — | Implementado | Webhook do Asaas | Token em tempo constante, evento único (`asaas_webhook_events`), conferência de valor, referência e id da cobrança; estado só pelo webhook |
| SEC-18 | — | Implementado | Dados de pagamento | Página hospedada do Asaas (cartão não passa pela ONEMA); CPF repassado ao Asaas e não guardado |
| SEC-19 | — | Implementado | Evolução de enfermagem | Assinada é imutável (gatilho no banco); só a especialista do atendimento acessa; ditado bruto não vai ao paciente |
| SEC-20 | P2 | Pendente (decisão) | IA com dado de saúde | O ditado vai à API da Anthropic para ser organizado. Exige base legal/aviso de privacidade (LGPD art. 11) e contrato com o fornecedor; a enfermeira é orientada a não ditar nome, CPF ou endereço |
| SEC-21 | P3 | Aceito | Ditado por voz do navegador | O reconhecimento de voz do celular pode enviar o áudio ao serviço do sistema (Google/Apple). Alternativa: digitar ou usar o microfone do teclado |
