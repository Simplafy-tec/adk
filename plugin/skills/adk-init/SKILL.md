---
name: adk-init
description: Use quando for criar um componente novo do ADK (tool, mcp, app ou team) — o esqueleto de arquivos, e o que rodar logo em seguida conforme o kind.
---

# adk-init

```sh
adk init <kind> <nome> [--dir <caminho>] [--runtime <python|node>]
```

`<kind>` é `tool`, `mcp`, `app` ou `team` (pacote de time, ADR-290). `--dir` é a **raiz** do componente (mesma
semântica de `--dir` em `build`/`dev`/`test`); sem `--dir`, nasce em
`./<slug-do-nome>`.

- Pasta já existe: `A pasta … já existe — escolha outro nome ou apague antes.`,
  exit **1**.
- `<kind>` fora de `tool|mcp|app|team`: exit **2**.
- `--runtime` (default `python`) escolhe o COMO o componente é escrito — só
  `kind: mcp` aceita `--runtime node`; qualquer outra combinação, ou um valor
  fora de `python|node`, sai com exit **2** sem criar a pasta. O
  `manifest.yaml` gerado é **idêntico** nos dois runtimes (`kind: mcp`
  chapado); o runtime não é campo do manifesto.

O esqueleto `mcp` (nos dois runtimes) nasce servindo HTTP em `0.0.0.0:8000`
(`BIND_ADDRESS`/`PORT` sobrescrevem), exigindo Bearer igual a `MCP_TOKEN` em
`POST /mcp` (503 sem o token configurado, 401 sem Bearer correto), com
`GET /health` sempre 200, um `Dockerfile` não-root e um teste que chama a tool
de exemplo.

O esqueleto nasce **sem CLAUDE.md** de propósito — quem dá o contexto ao
agente é este plugin, não um arquivo por componente.

## Depois do `init`, por kind

- **`team`**: `adk init team <slug>` cria `team.yaml` (um time amplo, não liberado, com um
  membro principal e nenhuma peça) e um `README.md` com os dois formatos de peça. Passa no
  `adk build` sem edição. O time **não** sobe por `adk deploy`: entra no Hub por PR no
  catálogo (`apps/api/src/times/catalogo/<slug>/`).

- **`tool` / `mcp` (Python)**: o próximo passo é `adk build` e depois `adk
  test` (skills `adk-build` e `adk-test`).
- **`app`**: `adk init app <nome>` gera um projeto npm — **rode `npm install`
  antes de qualquer `adk dev`**, senão o `adk dev` falha com "Vite não
  encontrado" (ver skill `adk-dev`):

  ```sh
  adk init app <nome>
  cd <nome>
  npm install
  adk dev
  ```

  Alternativa equivalente para começar um app: `npm init @simpla.fy/app <nome>`.
- **`mcp --runtime node`**: gera `package.json`, `tsconfig.json`,
  `src/server.ts`, `test/server.test.ts`, `Dockerfile` e `.dockerignore`. Rode
  `npm install` antes de qualquer `adk dev`/`adk test` — sem `node_modules/`
  os dois saem com exit **2** antes de spawnar nada. `adk build`, ao
  contrário, passa **antes** do `npm install` (checagem estática):

  ```sh
  adk init mcp --runtime node meu-satelite
  cd meu-satelite
  npm install
  MCP_TOKEN=dev adk dev
  ```

## Onde o artefato mora no repositório de configuração

O `adk init` cria a pasta do componente; quem publica é o `adk deploy`, e ele
só encontra o arquivo se ele estiver na pasta do kind, dentro da organização:

| kind | caminho |
|---|---|
| `tool` | `orgs/<org>/tools/<slug>/manifest.yaml` (ou `.yaml` solto) |
| `mcp` | `orgs/<org>/mcp/<slug>/manifest.yaml` |
| `app` | `orgs/<org>/apps/<slug>/manifest.yaml` |
| `table` | `orgs/<org>/tabelas/<slug>.yaml` |
| `agent` | `orgs/<org>/agentes/<slug>.yaml` |
| `journey` | `orgs/<org>/jornadas/<slug>.yaml` |

Os três kinds do `init` **aplicam** pelo `adk deploy`. Fora da pasta
certa o `deploy` simplesmente não vê o arquivo — e não há erro para ler.

## Recuperação rápida

| Sintoma | Ação |
|---|---|
| `A pasta … já existe` (exit 1) | escolha outro nome ou apague a pasta antes de rodar de novo |
| kind desconhecido (exit 2) | use exatamente `tool`, `mcp` ou `app` |
| `adk dev` falha em app recém-criado | rode `npm install` na pasta do app primeiro |
| `adk deploy` não menciona o seu artefato | ele não está em `orgs/<org>/<pasta do kind>/` — veja a tabela acima |
