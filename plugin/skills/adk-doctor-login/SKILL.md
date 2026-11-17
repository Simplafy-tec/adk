---
name: adk-doctor-login
description: Use quando for começar a trabalhar com o ADK numa máquina nova, quando precisar confirmar se o ambiente atende aos requisitos da plataforma, ou quando precisar autenticar (login/logout/whoami/orgs) para falar com o Hub.
---

# adk-doctor-login

Primeiro passo de qualquer sessão com o ADK: confirmar a máquina, depois
autenticar. Nenhum comando abaixo precisa de contexto além do que está aqui.

## 1. `adk doctor` — a máquina atende à política?

```sh
adk doctor
```

A primeira linha diz de onde veio a política:

- `Política da plataforma: vinda do Hub.` — normal.
- `Política da plataforma: política embutida (fallback — <motivo>).` — o
  `GET /api/v1/adk/policy` não respondeu. **Fallback não significa máquina
  ruim**: significa que a rota pode ainda não existir neste Hub. Continue.

Depois, uma linha `✓`/`✗` por requisito: `node`, `python`, `uv`, `git`.

- Exit **0**: tudo passou.
- Exit **1**: imprime `N requisito(s) não atendido(s): <lista>` — instale o
  que falta e rode `adk doctor` de novo.

**`python3` fora da versão exigida não é veredito final.** O `doctor` dá uma
segunda chance via `uv python find` antes de marcar `✗` — e é o `uv`, não o
`python3` do sistema, que o `adk build`/`adk test` de fato usam. Se `python3`
falhar mas `uv` estiver instalado, confira se o `✗` persiste antes de agir.

**Nunca cite um número de versão fixo aqui** (nem de node, nem de python, nem
de uv): a versão exigida vem da política e muda sem tocar neste plugin. Para
saber o que a máquina precisa agora, rode `adk doctor` (a fonte viva) ou chame
a tool MCP `get_policy`.

## 2. `adk login` — autoriza esta máquina no Hub

Sem configuração nenhuma, o login vai para o Hub de **produção** (o perfil
padrão da CLI é `prod`). Não há URL para definir: basta o seu e-mail e a sua
senha do Hub.

```sh
adk login                        # produção
adk login --org <orgId>          # consentimento só para essa organização
```

Quem também tiver acesso de staging usa `adk login --profile staging`. A
credencial fica guardada por Hub, então o login de um ambiente não serve para
o outro.

O `adk login` imprime a URL de autorização e fica esperando o retorno em
`http://127.0.0.1:<porta>/callback`. Em servidor sem sessão gráfica o
navegador não abre sozinho — **a URL já impressa é o caminho**: copie-a e abra
manualmente onde houver navegador.

Na tela de autorização, o interruptor **"Conceder permissão de ADK"** é o que
emite a credencial: sem ele o login termina em `invalid_scope` e não há
credencial nenhuma. Ele nasce ligado; se aparecer desligado, ligue antes de
autorizar. Negar a permissão é o mesmo que cancelar o login — para isso existe
o botão **Negar**.

`ADK_HUB_URL` (base da API do Hub) e `ADK_AUTH_URL` (servidor de autorização)
só existem para apontar a CLI a um Hub fora dos ambientes conhecidos — por
exemplo, `http://localhost:3001` num ambiente de desenvolvimento. Quando
definidas, ganham do perfil. No uso normal, deixe as duas em branco.

## 3. Depois de autenticado

```sh
adk whoami   # Hub, usuário, audience e scope do token atual
adk orgs     # organizações do token, com o papel (role) em cada uma
adk logout   # revoga a credencial no Hub e SÓ DEPOIS apaga o arquivo local
```

## 4. Headless / CI: `ADK_TOKEN`

Em ambiente sem `adk login` interativo (CI, agente headless), defina
`ADK_TOKEN` no ambiente do processo — **`ADK_TOKEN` ganha sobre o login**
salvo em disco. A credencial de `adk login` fica em
`~/.config/simplafy-adk/credentials.json` (permissão `0600`). Este plugin
**nunca lê, imprime nem copia** esse arquivo — se precisar confirmar a
identidade, use `adk whoami`.

## Tools MCP do servidor `simplafy-adk`

O servidor MCP declarado em `.mcp.json` expõe 5 tools read-only (nenhuma
escreve, exceto a última, que só planeja):

- `list_components` — kinds de componente, templates do `adk init` e um
  resumo da política.
- `get_contract` — JSON Schema do spec de um kind (`agent`/`tool`/`journey`).
- `get_policy` — a mesma política que o `adk doctor` consulta (com fallback
  embutido quando o Hub não responde).
- `validate` — valida um YAML de spec sem precisar dele em disco; não exige
  login.
- `plan` — mostra o que mudaria numa organização; a tool `plan` exige login
  (ou `ADK_TOKEN`) e nunca aplica nada.

Prefira essas tools a reler arquivo de código quando quiser saber "o que o
ADK aceita agora" — é a mesma fonte viva que o `adk doctor` consulta.

## Recuperação rápida

| Sintoma | Ação |
|---|---|
| `doctor` exit 1 | leia a lista de requisitos não atendidos e instale um por um; rode `adk doctor` de novo |
| `invalid_scope` no login | refaça o login com "Conceder permissão de ADK" ligado |
| `login` exit 2 pedindo `ADK_HUB_URL` | versão antiga da CLI: atualize o `@simpla.fy/adk` |
| navegador não abre depois do `login` | copie a URL impressa e abra manualmente |
| `whoami`/`orgs` reclamam de credencial | rode `adk login` ou defina `ADK_TOKEN` |
