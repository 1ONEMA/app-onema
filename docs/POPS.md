# Biblioteca institucional de POPs (v1.0)

Base: `POPS_65_PACOTE_V1_0_CORRIGIDO.zip` — 65 PDFs (ONEMA-POP-001 a 065), vigência administrativa 09/11/2026.

## Como funciona
- PDFs gravados no banco com **versão imutável** e SHA-256 (conferido no carregamento e a cada abertura). Nunca em pasta pública; o visualizador HTML do pacote não foi publicado (ele embute os PDFs).
- **Bloqueados por padrão.** O RT libera (todos ou selecionados) em Gestão › POPs após a homologação, com justificativa auditada; também pode suspender.
- **Acesso**: RT sempre; especialistas ONEMA ONE credenciadas, somente POPs liberados. Busca por código ou assunto. Cada abertura fica na auditoria.
- **No atendimento**: POPs candidatos pelo serviço contratado (sugestão, não diagnóstico) + busca na biblioteca. A enfermeira escolhe e justifica. O vínculo guarda atendimento, paciente, profissional, código, versão, hash, horário e justificativa; não pode ser alterado nem apagado.
- **Carteira do paciente**: lista "Protocolos usados no seu cuidado" (código, título, versão, data, profissional). O POP não substitui evolução nem prescrição.

## Associação proposta ao catálogo (a confirmar pelo RT)
| Chave do pacote | Itens do catálogo do app |
|---|---|
| avaliacao_enfermagem | CAT-01, CONT-02 |
| curativo_simples | CAT-02A, PAC-04 |
| curativo_complexo | CAT-02B |
| avaliacao_dispositivos | CAT-04 (sondas e cateteres) |
| avaliacao_testes | CAT-07 (diabetes e hipertensão) |
| monitoramento | CAT-08, PAC-05, CONT-01 |
| programas | CAT-05, CAT-06, PAC-01 a PAC-03, PAC-06 a PAC-08 |
| cuidados_respiratorios | sem item correspondente no catálogo atual |
CAT-03 (medicamentos avulsos) ficou sem sugestões; a enfermeira usa a busca.

## Observações da conferência
- Os 65 PDFs batem com `INVENTARIO_65.csv`. O `pops_manifest.json` traz hashes de uma versão anterior dos arquivos (não conferem) — usado o inventário.
- A aprovação do RT foi declarada no pacote; não equivale a auditoria científica independente.
