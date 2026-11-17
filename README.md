# simplafy-adk

Ferramentas públicas do **ADK da Simplafy**: o contrato de especificação e a CLI
que cria, valida e publica agentes, tools e jornadas no Hub.

| Pacote                                          | npm                             | Papel                                                                                                                                             |
| ----------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contract`                             | `@simpla.fy/adk-contract`    | Validadores puros, `SpecIssueCode`, `scanLeaks`, política                                                                                         |
| `packages/cli`                                  | `@simpla.fy/adk` (bin `adk`) | `doctor`, `login`, `init`, `export`, `build`, `plan`, `deploy`, `mcp-server`                                                                      |
| `plugin/`                                       | —                               | Plugin de harness (skills + MCP + hook) — `/plugin marketplace add Simplafy-tec/simplafy-adk-plugin` (espelhado por `scripts/espelhar-plugin.sh`) |
| `packages/app-kit` · `services/` · `templates/` | —                               | Vazios nesta rodada (donos: N19 / N7)                                                                                                             |

```sh
npx @simpla.fy/adk doctor
npx @simpla.fy/adk login --org <orgId>          # consentimento só desta org
npx @simpla.fy/adk init org --org <orgId>       # orgs/<pasta>/org.yaml + export do que já está no ar
npx @simpla.fy/adk plan --org <orgId>           # só lê
npx @simpla.fy/adk apply --org <orgId>          # produção: pede o id da org (CI: --yes)
```

Para criar um componente: `adk init tool minha-tool`, `adk build` e o `apply`
acima.

Sem configurar nada, a CLI fala com o Hub de **produção** (perfil `prod`), e
todo `apply` em produção pede confirmação — digitar o id da org num terminal,
ou `--yes` fora dele. A equipe interna usa staging com `--profile staging` ou
`ADK_PROFILE=staging`; `ADK_HUB_URL`/`ADK_AUTH_URL` seguem como override, e um
`ADK_HUB_URL` de host conhecido (API de produção ou de staging) já diz o
ambiente. O `--env` de `plan`/`deploy` vem do perfil (ou do host) — detalhes em
[`packages/cli/README.md`](packages/cli/README.md#ambiente).

## Por que dois pacotes

O contrato é o MESMO motor dos dois lados da fronteira: o `adk build` reprova
localmente exatamente o que o `POST /api/v1/adk/*/apply` reprovaria no servidor,
com o mesmo `code` e o mesmo `path`. Duas implementações da mesma regra é como
os dois lados passam a discordar sobre o que o arquivo significa — o `contract`
existe para que isso não aconteça, e o CI tem um **canário** (`ci.yml`) que
semeia um segredo e exige a reprovação: um validador que nunca reprovou é
indistinguível de um que não roda.

## Desenvolvimento

```sh
pnpm install
pnpm build        # tsc por pacote (a CLI resolve o contrato por dist/)
pnpm test         # vitest (constrói os pacotes antes, no globalSetup)
pnpm lint && pnpm typecheck && pnpm format
```

Node ≥ 20 e pnpm 9. Nenhum pacote tem `postinstall`.

## Publicação

Por tag `v*` (`.github/workflows/publish.yml`), em runner hospedado pelo
GitHub, na ordem contrato → CLI → app-kit → template, com `pnpm publish` — é o
pnpm que reescreve a dependência `workspace:*` para a versão publicada; com o
publish do npm o tarball subiria com um range que o instalador rejeita. Versão
que já está no registry é pulada, então re-rodar depois de falha parcial é seguro.

- **Autenticação:** _trusted publishing_ (OIDC, `id-token: write`) com o
  publicador confiável configurado em cada pacote no npmjs (repo
  `Simplafy-tec/adk`, workflow `publish.yml`); na falta dele, o segredo
  `NPM_TOKEN` do repositório. Sem nenhum dos dois o registry responde
  `404 Not Found - PUT`.
- **Hoje (17/11/2026):** o publicador confiável ainda não está configurado no
  npm (exige o 2FA interativo da conta dona). A versão sai por tag `vX.Y.Z`,
  o `pack.yml` gera os `.tgz` + `SHA256SUMS` e a Simplafy publica com o token
  da conta, **sem provenance**. O `publish.yml` fica só com disparo manual até
  o publicador confiável existir.
- **Provenance:** só quando o repositório for público — o npm não aceita
  atestado de origem de repositório privado.

## O que NÃO está aqui

O lado do Hub desta fatia é a parte 2: o scope OAuth `adk` (`aud=adk`), o
`GET /api/v1/adk/policy`, a dependência do hub-v2 no `adk-contract` e a
migração do CI do `simplafy-clientes`. Enquanto o endpoint de política não
existe, o `adk doctor` cai para a política embutida e diz que caiu.
