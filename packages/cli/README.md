# @simpla.fy/adk

CLI do ADK da Simplafy. Node ≥ 20, sem `postinstall`.

```sh
npx @simpla.fy/adk <comando>
```

## Comandos

| Comando                                | O que faz                                                                                             |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `doctor`                               | Confere node/python 3.12/uv/git contra `GET /api/v1/adk/policy` (fallback embutido)                   |
| `login` · `whoami` · `orgs` · `logout` | OAuth do Hub: DCR, PKCE S256, callback em `127.0.0.1`                                                 |
| `init tool\|mcp\|app <nome>`           | Esqueleto do componente (`manifest.yaml`, `tools/<nome>.py`, `pyproject.toml` uv, testes)             |
| `init org [pasta]`                     | Pasta de uma org que já existe no Hub: `orgs/<pasta>/org.yaml` + `export` (ver abaixo)                |
| `build`                                | Contrato + `scanLeaks` + `uv lock` + `ruff check` + tamanho ≤ política. Saída JSON `{issues, checks}` |
| `test` · `dev`                         | `uv run pytest` · watch que revalida e executa o handler com `dev/sample-input.json`                  |
| `validate`                             | Valida os artefatos localmente, **sem** falar com o Hub                                               |
| `plan` · `deploy` (`apply`)            | `POST /api/v1/adk/{tools\|agents\|journeys}/{plan\|apply}?orgId=`                                     |
| `status`                               | `GET /api/v1/adk/pendencies?orgId=` — pendências ABERTAS da organização                              |
| `export`                               | `GET /api/v1/adk/{agents\|tools\|journeys}/export?orgId=` — traz do Hub o que já existe             |
| `publish`                              | `kind: mcp`: `docker build` + push com o token do Hub; grava `image: <registry>/simplafy-tec/<slug>@sha256:…` |
| `mcp-server`                           | stdio: `list_components`, `get_contract`, `get_policy`, `validate`, `plan`                            |

### `init org` e `login --org`

```sh
adk login --org <orgId>          # consentimento só desta org (sem: todas em que você é ADMIN)
adk init org --org <orgId>       # cria orgs/<pasta>/org.yaml e roda o export
adk plan --org <orgId>           # confere: só lê, nada é gravado
```

- `adk init org` lista as orgs do token (as mesmas do `adk orgs`). Sem `--org`,
  num terminal pergunta qual (número ou id); fora de terminal sai com código 2
  pedindo `--org`. Um `--org` que o token não alcança sai com 2, lista as orgs
  disponíveis e sugere `adk login` de novo (org nova não entra num token antigo).
- O `org.yaml` nasce com `environments.<ambiente do perfil>: <id>` — no perfil
  `prod`, `production`. `--dir` é a **raiz do repositório de clientes** (onde
  fica `orgs/`, default `.`), não a pasta da org. A pasta é o argumento
  `[pasta]`; sem ele, o nome da org em kebab-case (ou o id, quando o token não
  traz o nome).
- Recusa (código 1) se outra pasta já declara aquele id no ambiente — aí o
  comando certo é `adk export` — ou se `orgs/<pasta>` já existe.

### `status` e `export`

`status` lista o que ficou pendente: referência declarada que não resolveu não
aborta o apply — vira pendência, por desenho. **Pendência não é erro**: o exit
code é 0 mesmo com pendências, para não reprovar um CI cuja pendência é
legítima.

Tool `runtime: script` volta como **pasta de pacote** (`<slug>/manifest.yaml` +
código + `uv.lock`), que é o formato do `adk init` e o que o `deploy` reconhece:
sem o pacote o arquivo descreveria a organização sem poder reproduzi-la, porque
`hash` e `lock` nascem do build sobre o código. Pacote com segredo não volta —
aí a omissão é declarada no cabeçalho e o autor traz o código à mão.

`export` é a porta de entrada de quem já está no ar. A pasta de destino é
resolvida pelo `environments.<ambiente>` do `org.yaml`, escreve **por cima** dos
arquivos daquela org (o diff do git é a revisão) e **preserva o que não tem par
no Hub**, inclusive pastas que não são kind do ADK. Campo com identificador
interno, segredo ou PII não vem: sai como comentário `# omitido:` no topo do
arquivo. Entidade cujo próprio nome carregaria PII não é escrita — é reportada
com o slug mascarado.

### `publish`

```sh
adk publish [--dir <componente>] [--registry <url>] [--platform <plataforma>]
```

Só para `kind: mcp`. Constrói a imagem (`docker build` + `docker save`, pelo
`docker` do PATH), pede ao Hub o token de push em `simplafy-tec/<slug>` e
empurra pela API do registry; o digest impresso é o que fica no `image:` do
`manifest.yaml` (o resto do arquivo não muda). Registry: `--registry` >
`ADK_REGISTRY_URL` > `https://registry.simplafy.com.br`. Só esse registry ou
um local (`127.0.0.1`, `[::1]`, `localhost`, o único caso em que http vale).
O topo também ganha a tag `adk-<AAAAMMDDhhmmss>` (UTC), que protege a imagem
da retenção; o `image:` continua por digest.

O build sai em `linux/amd64`, a arquitetura dos nós do cluster, mesmo num Mac
ARM; `--platform <plataforma>` troca o alvo (repassado ao `docker build
--platform`).

- Exige papel ADMIN (ou OWNER) na organização dona do componente: sem ele o
  Hub não libera o push e a CLI recusa antes do build.
- Registry que pede usuário e senha ainda não aceita o token do Hub: a CLI
  falha e não pede senha.
- A credencial do ADK só vai ao Hub (o realm do registry precisa ser a mesma
  origem); o `docker` recebe só o ambiente mínimo mais `DOCKER_HOST`,
  `DOCKER_CONTEXT`, `DOCKER_CONFIG`, `DOCKER_TLS_VERIFY` e `DOCKER_CERT_PATH`
  (daemon remoto por tcp com TLS).

## Ambiente

A CLI já sabe onde ficam os Hubs: escolhe-se o **perfil**, não a URL.

| Perfil            | API do Hub                                   | Servidor de autorização                   | `--env`      |
| ----------------- | -------------------------------------------- | ----------------------------------------- | ------------ |
| `prod` (padrão)   | `https://api-hub-v2.simplafy.com.br`         | `https://app.simplafy.com.br/hub`         | `production` |
| `staging`         | `https://api-hub-v2-staging.simplafy.com.br` | `https://app-staging.simplafy.com.br/hub` | `staging`    |

- `--profile <prod|staging>` (aceito antes ou depois do subcomando) ou
  `ADK_PROFILE` — `--profile` ganha. Sem nenhum dos dois, vale `prod`. Perfil
  desconhecido sai com código 2.
- **`--env` vem do perfil** em `plan`, `deploy`/`apply`, `export` e
  `init org`: não precisa ser informado. Informado e divergente do perfil (ex.:
  `--env staging` no perfil `prod`), a CLI recusa com código 2 antes de falar
  com o Hub — o ambiente escolhe o id do `org.yaml` e o perfil escolhe o Hub, e
  os dois discordando mandaria a configuração de um ambiente para o Hub do
  outro.

### Apply em produção pede confirmação

Quando o ambiente é `production`, `adk apply`/`adk deploy` pergunta antes de
qualquer chamada ao Hub (não existe `adk rollback`):

- **num terminal**, digite o id da org ou o nome da pasta em `orgs/`; resposta
  diferente (ou Enter vazio) sai com código 1 e "nada foi aplicado";
- **fora de terminal** (CI, agente, pipe), passe `--yes`; sem ele, código 2 e
  nada chega ao Hub;
- `staging` não pergunta, e `plan` nunca pergunta (não grava).

```sh
adk apply --org <orgId>          # terminal: pede o id da org
adk apply --org <orgId> --yes    # CI: sem pergunta
```

```sh
adk login                                  # produção
adk plan --org <orgId>                     # production, no Hub de produção
adk plan --profile staging --org <orgId>   # staging, no Hub de staging
ADK_PROFILE=staging adk deploy --org <orgId>
```

Overrides, com precedência sobre o perfil:

- `ADK_HUB_URL` — base da API do Hub (ex.: `http://localhost:3001`).
  - **Host conhecido diz o ambiente sozinho**: `https://api-hub-v2.simplafy.com.br`
    → `production`, `https://api-hub-v2-staging.simplafy.com.br` → `staging`
    (com ou sem barra final). Perfil (`--profile`/`ADK_PROFILE`) ou `--env` que
    contradiga o host sai com código 2, citando `ADK_HUB_URL`, antes de
    qualquer chamada. O perfil contraditório barra qualquer comando, inclusive
    `login`; o `--env`, os comandos que o aceitam (`plan`, `deploy`, `export`,
    `init org`).
  - **Host desconhecido e sem perfil**: o host não diz o ambiente, e
    `plan`/`deploy` e a tool `plan` do `mcp-server` exigem `--env` (só o
    `export` cai em `staging`). Com perfil, o `--env` continua vindo dele.
- `ADK_AUTH_URL` — base do servidor de autorização OAuth (`/api/oauth/*`), que é
  o `apps/web` do Hub, em outro host que a API. **Override**: quando definida,
  vale sempre. Sem ela e com `ADK_HUB_URL`, a CLI deriva do host conhecido:

  | `ADK_HUB_URL`                                 | AS derivado                               |
  | --------------------------------------------- | ----------------------------------------- |
  | `https://api-hub-v2-staging.simplafy.com.br`  | `https://app-staging.simplafy.com.br/hub` |
  | `https://api-hub-v2.simplafy.com.br`          | `https://app.simplafy.com.br/hub`         |
  | qualquer outro (ex.: `http://localhost:3001`) | o próprio `ADK_HUB_URL`                   |

  Hub em outro host (dev local com AS separado, ambiente novo): defina
  `ADK_AUTH_URL`. Se o registro do cliente tomar 404, o `adk login` diz para
  defini-la.

- `ADK_TOKEN` — modo headless (API key `sk_…` ou JWT). **Ganha do login**: o CI
  precisa ser previsível, e a credencial da máquina de quem rodou por último não
  pode vazar para dentro dele. Com `ADK_TOKEN`, `--org` é obrigatório.
  O token vale para **um Hub só**, o que o emitiu. O alvo continua vindo do
  perfil: sem configuração, a CLI fala com **produção**. Com um token de
  staging, exporte `ADK_PROFILE=staging` (ou `ADK_HUB_URL` de staging);
  senão a chamada vai para produção e falha na autenticação.
- `ADK_CONFIG_DIR` — sobrescreve `~/.config/simplafy-adk` (testes).

`adk login` grava `~/.config/simplafy-adk/credentials.json` com permissão
**0600**, indexado por URL do Hub, e renova o access token sozinho (60 s antes
do fim). `adk logout` **revoga** antes de apagar — apagar só o arquivo deixaria
um refresh token vivo por 30 dias do lado do servidor.

## Ordem e tolerância a falha no `deploy`

Os artefatos sobem na ordem **tool → agent → journey**: um agente pode
referenciar a tool que este mesmo apply cria, e a jornada pode acionar os dois.
Um artefato que falha **não aborta os demais** — o relatório sai completo e o
exit code é 1. Pendência de referência não é falha: o artefato é aplicado e o
exit code continua 0 (o `adk status` lista o que falta criar no Hub). `--json` emite `{artefatos: [{arquivo, kind, slug, action,
blocking, pending, applied}]}`.

Só entram as pastas cujo `orgs/<pasta>/org.yaml` declara o `--org` no ambiente
do perfil (`--env`, quando informado, precisa concordar com ele). Pasta sem `org.yaml` fica de fora: o silêncio nega.

## `init` e segredo

O template nasce com `.gitignore` cobrindo `.env*` e `.venv/`, e **sem**
`CLAUDE.md`. O `build` varre todo o pacote menos `.env*` — é o lugar certo do
segredo local, e escaneá-lo reprovaria o uso correto. Credencial de produção é
referenciada por nome e resolvida no Hub.

> Os seis kinds aplicam. O que decide se o `deploy` enxerga o artefato é a
> PASTA dele dentro de `orgs/<org>/`: `tools/`, `tabelas/`, `mcp/`, `apps/`,
> `agentes/`, `jornadas/`.
