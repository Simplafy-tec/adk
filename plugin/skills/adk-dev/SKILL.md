---
name: adk-dev
description: Use quando for desenvolver um componente do ADK com recarregamento automático — o comando muda de comportamento conforme o `kind` do manifest.yaml, então confira aqui antes de esperar o resultado errado.
---

# adk-dev

```sh
adk dev [--dir <caminho>] [--port <porta>]
```

**`adk dev` tem dois comportamentos, conforme o `kind` declarado em
`manifest.yaml`.** Não é o mesmo servidor para todo componente — saber isso
antes é o ponto desta skill.

## `kind: tool`

Observa `manifest.yaml` e `tools/**`; a cada save, revalida o spec e executa o
handler com o conteúdo de `dev/sample-input.json`.

- Sem `manifest.yaml` na pasta: `Não encontrei manifest.yaml — rode dentro da
  pasta do componente.`, exit **2** — rode de dentro da raiz do componente.
- Sem `dev/sample-input.json`: `! dev/sample-input.json não existe — sem
  entrada para executar.` — crie o arquivo com um JSON de exemplo (o `adk
  init` já cria um).

## `kind: mcp`

Ciclo PRÓPRIO: não há handler para executar, o que existe é
o servidor. O runtime é detectado pelo ARTEFATO presente na pasta, não por um
campo do manifesto — `server.py` é sempre o caminho Python; sem `server.py` e
com `package.json`, é o satélite Node (`adk init mcp --runtime node`).

| Runtime | Sobe | Reinicia a cada save de |
|---|---|---|
| Python (`server.py`) | `uv run python server.py` | `manifest.yaml`, `server.py`, `tools/**` |
| Node (`package.json`) | `npm run dev` (`tsx src/server.ts`, sem watcher próprio) | `manifest.yaml`, `package.json`, `src/**` |

O spec é revalidado antes de cada reinício. Os dois esqueletos servem **HTTP**
(nunca stdio) com o mesmo contrato:

- `PORT` (default **8000**, a porta do chart do satélite) e `BIND_ADDRESS`
  (default `0.0.0.0`) vêm do seu ambiente;
- `MCP_TOKEN` é o Bearer exigido em `POST /mcp`: sem ele (ou vazio) o servidor
  sobe e responde **503**; com ele, anônimo ou Bearer errado é **401**;
- `GET /health` responde **200** sempre — é a probe do chart.

`MCP_TOKEN`, `PORT` e `BIND_ADDRESS` são repassados NOMINALMENTE ao servidor;
`ADK_TOKEN` e `ADK_HUB_URL` continuam barrados, como em todo subprocesso da CLI.

```sh
MCP_TOKEN=dev PORT=8000 adk dev
```

- Sem `server.py` **nem** `package.json`: exit **2** citando os dois
  entrypoints possíveis — é o que `adk init mcp`/`adk init mcp --runtime node`
  geram.
- Node sem `node_modules/`: exit **2** ("rode `npm install`") **antes de
  qualquer spawn**.
- Servidor que cai **não** derruba o `adk dev`: erro de sintaxe, import
  faltando ou `kill` de fora viram um aviso `✗ servidor …`, e o próximo save é
  o conserto.
- `✗ o servidor encerrou assim que subiu` — ele nasceu e morreu; o erro dele
  está logo acima.
- `servidor de pé em http://<host>:<porta>` é a confirmação de que ele
  sobreviveu à subida.

## `kind: app`

Sobe **Vite (HMR)** + o Hub shell local, sempre em `127.0.0.1`. A saída é:

```
App:   http://127.0.0.1:<porta>/
Shell: http://127.0.0.1:<porta+1>/adk-dev/shell.html  ← abra esta
```

**Abra a URL do Shell, não a do App.** É o shell que embute a tela dentro do
`<iframe>` com a ponte real do Hub (`useHost()` de verdade); abrir a URL do
app direto mostra a tela fora do contexto que ela vai rodar em produção.

`--port` muda a porta do **app**; a porta do shell é sempre `--port + 1`.

Falha mais comum, ao rodar `adk dev` num app recém-criado sem instalar
dependências:

```
Vite não encontrado — rode `npm install` na pasta do app antes do `adk dev`.
```

Recuperação: `npm install` na pasta do app, depois `adk dev` de novo. Porta
ocupada também derruba o par app+shell (o Vite sobe com `--strictPort`) —
libere a porta ou use `--port` outra.

`adk-dev/` é uma pasta **gerada** pelo próprio `adk dev` (o shell) — não
versione, não edite (já está no `.gitignore` do template do `app`); o `adk
build` varre essa pasta de propósito, então nunca guarde segredo nela.

## Recuperação rápida

| Sintoma | Ação |
|---|---|
| `Não encontrei manifest.yaml` (exit 2) | rode dentro da raiz do componente |
| `! dev/sample-input.json não existe` | crie o arquivo com um JSON de exemplo |
| `Vite não encontrado` (exit 2) | `npm install` na pasta do app antes de `adk dev` |
| tela abre sem a ponte do Hub | você abriu a URL do App — abra a do **Shell** (`shell.html`) |
| `Limite de observadores do sistema atingido` (exit 1) | rode `adk dev --poll` (não exige privilégio) ou aumente `fs.inotify.max_user_watches` |
| salvou e nada aconteceu | máquina com IDE remoto costuma estourar o inotify — `adk dev --poll` |
