# Identidade visual e acessibilidade

## Fontes de referência

- **Manual de Identidade Visual** (Agência Mibrand): paleta, tipografia Swiss721, ícone, grid, ícones de linha, grafismo de semicírculos, aplicações (outdoor, app, redes).
- **HTML oficial PRIME v2.0**: componentes e composição da prévia do cliente (superfícies brancas com raio 18px e borda suave, badges em pílula, callout com borda verde, blocos de cautela âmbar, abas em pílula, cabeçalho em gradiente azul).

## Tokens (`web/src/styles.css`)

| Token | Valor | Origem | Uso |
|---|---|---|---|
| `--deep` | #00307E | Deep Blue | títulos, botões principais, navegação ativa |
| `--vivid` | #1772FE | Vivid Blue | gradientes, decorações, foco |
| `--vivid-strong` | #1466E3 | derivado | botão azul com texto branco (contraste 5,2:1; o #1772FE daria 4,3:1) |
| `--green` | #02C0A4 | Health Green | acentos, marcadores, botão verde com texto Deep Blue |
| `--green-text` | #00806D | derivado | texto verde sobre branco (4,9:1) |
| `--ice` | #E4EBF3 | Ice | fundos secundários, botões secundários |

Tipografia: `Swiss 721` quando instalada, senão Helvetica Neue/Helvetica/Arial (arquivo licenciado pendente).

## Ativos

- Ícone do PWA/favicon: recortado em alta resolução do ícone oficial (S azul/verde sobre Deep Blue) do manual; versões `any` (cantos arredondados) e `maskable` (sangria total).
- Logotipo do cabeçalho: arquivo oficial embutido no HTML PRIME, com fundo tornado transparente.
- Ícones de interface: redesenhados em SVG no estilo do manual (traço arredondado, detalhes em Health Green).
- Grafismo da tela de entrada: versão simplificada do padrão de semicírculos do manual.

## Acessibilidade aplicada

Link “pular para o conteúdo”, foco visível, rótulos associados (ajuda via `aria-describedby`), `aria-invalid` em erros, mensagens com `role="alert"/"status"`, diálogos modais com foco e Esc, barras de progresso com `aria-valuenow`, alvos de toque ≥ 44px, tabelas com rolagem horizontal no celular, legendas (`<track>`) e transcrição nas aulas com vídeo. Auditoria WCAG formal e testes com leitores de tela reais: pendentes.

## Visual v2 (out/2026) — site de referência do cliente

- Fonte **Inter** (variável, latin/latin-ext em `web/public/fonts`, licença OFL), títulos finos (400–500) em azul profundo `#0A2E7D`, acentos verdes `#00C2A8`/`#006E5E`.
- Logotipo oficial horizontal (`/icons/logo-onema-saude.png`) no cabeçalho, login e rodapé; ícone oficial do app (quadrado azul com o S) em todos os tamanhos do PWA, incluindo maskable e apple-touch.
- Abertura animada (`web/src/ui/Splash.tsx`) reproduz o vídeo do cliente: traço fino → contorno duplo → preenchimento azul/verde → ícone. Uma vez por sessão, toque para pular, versão curta com "reduzir movimento".
- Página inicial no modelo do site: catálogo com "Saber mais →", informações importantes, Carteira Digital com celular ilustrativo, recursos, Life Score (exemplo ilustrativo), como funciona, sobre nós, ONEMA PRIME e rodapé institucional; Kary como botão redondo "assistente virtual".
