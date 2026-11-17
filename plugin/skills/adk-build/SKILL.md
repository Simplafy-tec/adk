---
name: adk-build
description: Use quando for validar um componente do ADK antes do deploy, ou quando o `adk build` reprovar e você precisar entender o código de erro (secret_literal, pii_in_config, internal_id, ui_adherence) e como corrigir.
---

# adk-build

```sh
adk build [--dir <caminho>]
```

Roda dentro da pasta do componente e imprime **JSON** no formato
`{ "issues": [...], "checks": [...] }` — e, para `mcp`, `app` e `table`, mais
`"contrato": { "parcial": true, "julgado_por": "apply do Hub",
"campos_obrigatorios": [...], "nota": "..." }`. Esses três kinds
NÃO são julgados pelo contrato público: `issues: []` neles significa "o gate
local não olhou", não "o Hub aceitaria". Os campos que o apply exige estão no
próprio `contrato`. Exit **1** se houver qualquer `issue`
ou `check` falho; exit **0** quando limpo.

## Pacote de time (`team.yaml`, ADR-290)

Numa pasta com `team.yaml` (e sem `manifest.yaml`) o `adk build` julga `kind: team` pelo
contrato: estrutura, vazamento em todo arquivo do pacote e os arquivos que uma peça `spec:`
aponta. Mesmo `code` e `path` do servidor. Códigos próprios do time:
`duplicate_team_key`, `invalid_team_piece`, `invalid_piece_reference` (a referência
`${peca:x.id}` só aponta para peça **anterior**), `undo_reason_missing` (`desfazer: null` exige
`semDesfazer`), `released_team_with_em_breve`, `team_without_principal`,
`agent_piece_without_member`, `unknown_team_piece`, `invalid_team_inheritance`, e, locais da
CLI, `team_piece_file_missing` / `team_piece_file_outside_package` (o arquivo de uma peça
`spec:` não existe, ou fica fora do pacote, inclusive por atalho). `slug_filename_mismatch`
vale também: o slug tem que ser o nome da pasta.

O que o build **não** confere, e diz no `checks[]`: a função de uma peça `call:` existir no
catálogo do MCP completo ("só é conferida no servidor") e a soma de um especialista com o
amplo ("só é conferida onde o pacote do amplo está — no Hub"). `adk validate --dir <pasta>`
faz o mesmo no pacote da pasta, ou em cada subpasta com `team.yaml` (o catálogo do Hub).

## Ordem do portão

1. **Contrato** — estrutura do `manifest.yaml` contra o schema do `kind`.
2. **Vazamento** — segredo, PII, identificador interno em qualquer arquivo do
   pacote.
3. **Runtime** — `uv lock` e `ruff check` quando existe `pyproject.toml`; para
   `kind: mcp` com `package.json` (runtime Node), uma checagem estática de
   dependências declaradas: varre todo `.ts`/`.js` do pacote, e import (inclusive
   `import()` dinâmico) de pacote ausente do `package.json` reprova, com o nome
   no `detalhe`. Comentário não conta; `#…` vale se declarado em `imports`;
   `package.json` malformado reprova como `package.json inválido`. Roda mesmo
   antes do `npm install`.
4. **Política** — tamanho do pacote e, para `kind: app`, aderência ao design
   system.

O `adk build` reprova **localmente o mesmo que o apply do Hub reprovaria**,
com o mesmo `code` e o mesmo `path` no `issues[]` — é o mesmo motor
(`@simpla.fy/adk-contract`) dos dois lados.

## Códigos que você vai encontrar

| `code` | O que significa | O que fazer |
|---|---|---|
| `invalid_document` | não achou/não leu `manifest.yaml` | rode `adk build` dentro da pasta certa do componente |
| `secret_literal` | valor com cara de segredo escrito no código | tire o valor do arquivo; segredo **local** vai em `.env*` (não é versionado, fica **fora** da varredura); credencial de **produção** é referenciada por nome e resolvida pelo Hub |
| `pii_in_config` | dado pessoal literal em config | mesma correção do `secret_literal`: tire do código |
| `internal_id` | identificador interno (não sintético) exposto | troque por um valor de exemplo/sintético |
| `ui_adherence` (só `kind: app`) | cor literal, fonte fora do token ou logo solto | cor literal → `var(--color-*)`; fonte fora do token → `var(--font-sans)`; logo solto → `<Brand/>` |

## Não copie limite nem versão daqui

**Não fixe** tamanho máximo de pacote, allowlist de registry nem versão de
runtime num prompt ou anotação — esses valores vêm da política da plataforma e
mudam sem tocar neste plugin. Para saber o limite vigente, consulte
`get_policy` (tool MCP) ou rode `adk doctor`.

## Recuperação rápida

| Sintoma | Ação |
|---|---|
| `invalid_document` | confira se está na raiz do componente (onde fica `manifest.yaml`) |
| `secret_literal`/`pii_in_config`/`internal_id` | mova o valor para `.env*` (local) ou referencie por nome (produção) |
| `ui_adherence` | troque cor/fonte/logo literais pelos tokens do design system |
| `uv lock`/`ruff check` falhou | leia o `detalhe` do check no JSON — é a saída real da ferramenta |
