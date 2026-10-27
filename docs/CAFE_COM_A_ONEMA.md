# Café com a ONEMA — devocional diário

Adendo oficial v7 (Marcos Alves, out/2026).

## Regras implementadas
- **Um devocional por dia**: versículo, referência bíblica e **1 parágrafo autoral** de reflexão, encerrado por “A Ele toda honra e toda glória.”
- **Virada automática** na data local do aparelho, sem atualizar o app (o card também troca sozinho se ficar aberto na meia-noite).
- **Ações**: somente “Ler mensagem” e “Recolher mensagem”. Removidos “Ocultar por hoje”, “Não mostrar mais” e “Fechar mensagem”.
- **Posição**: na página inicial, logo após o bloco principal (hero). A Kary encolhe enquanto o texto aberto está na tela, para não cobri-lo.
- **Tipografia** (tokens do adendo): título 19 px/650 (21 px no desktop), corpo 15–16 px/400 com linha 1,5–1,55, microtítulo 10,5 px/700, ações 14 px/600 com área de toque ≥ 44 px, ícone de livro em quadrado azul de 42 px, card branco com raio 16 px, largura máxima 960 px.

## Conteúdo
- **Biblioteca anual**: 366 devocionais autorais (inclui 29/02), um por dia do ano, sem repetir versículo, alternando Salmos, Provérbios, Antigo Testamento, Evangelhos e Epístolas. Arquivo: `server/src/modules/cafe/library.ts`. Carga idempotente no banco (`devotionals`), inclusive em bancos já em uso.
- Estilo acolhedor inspirado no formato de leitura diária de “Café com Deus Pai”, **sem reproduzir** textos da obra.
- Versículos citados no estilo Almeida Revista e Corrigida — **revisão da ONEMA pendente (PR-5)**.

## Gestão (sem deploy)
Gestão → **Café com a ONEMA** (perfis GESTOR_CONTEUDO, ADMIN_PRIME, ADMIN_ACADEMY; AUDITOR só lê): mostra os próximos 14 dias e permite publicar outro texto para qualquer data ou voltar ao da biblioteca. Cada publicação é auditada (`CAFE_PUBLICADO` / `CAFE_REMOVIDO`).

## API
- `GET /api/public/cafe?date=AAAA-MM-DD` — devocional da data (público).
- `GET /api/admin/cafe?from=AAAA-MM-DD`, `PUT|DELETE /api/admin/cafe/:date` — gestão.
