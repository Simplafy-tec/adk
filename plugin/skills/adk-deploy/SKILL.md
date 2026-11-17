---
name: adk-deploy
description: Use quando for validar, planejar ou aplicar a configuração de uma organização (tools, agentes, jornadas) no Hub — o ciclo `adk validate` → `adk plan` → `adk deploy`, a confirmação de produção, o vínculo de tools e o que depende da Simplafy.
---

# adk-deploy

**A diferença que ninguém adivinha primeiro:** `adk validate`, `adk plan` e
`adk deploy` **não** operam na pasta de um componente (onde você rodou `adk
build`/`adk test`) — operam num **repositório de configuração**, com este
layout:

```
orgs/<pasta>/org.yaml
orgs/<pasta>/tools/*.yaml
orgs/<pasta>/agentes/*.yaml
orgs/<pasta>/jornadas/*.yaml
```

`orgs/<pasta>/org.yaml` declara `environments.<env>: <orgId>` — é essa
amarração que decide quais pastas participam de um `--org`/`--env`. Rodar
`adk deploy` de dentro da pasta de um componente devolve:

```
Nenhuma pasta de organização declara "<id>" no ambiente "<env>"
```

A mensagem final do `adk init` ("Próximo passo: `adk build` e, para tool,
`adk deploy …`") não avisa dessa mudança de pasta — é por isso que esta skill
existe. Para criar a pasta de uma org que já existe no Hub sem escrever o
`org.yaml` à mão, use `adk init org` (skill `adk-comecar`).

## O ciclo

```sh
adk validate                        # offline, mesmo motor do servidor
adk plan --org <id>                 # mostra o que mudaria — NUNCA grava
adk deploy --org <id>               # aplica (tool → agent → journey)
adk plan --org <id>                 # roda de novo: deve mostrar "sem alteração"
```

`adk apply` é o mesmo comando que `adk deploy`.

Ler o `blocking`/`pending` do `adk plan` antes de aplicar é o gate: se houver
qualquer entrada, corrija primeiro. A última linha (`adk plan` de novo, depois
do deploy) prova idempotência — se algo mudou de novo, o deploy não terminou
o que devia.

- **`--org` é obrigatório**: sem ele, `Informe --org <id da organização>.`,
  exit **2**. É o **id da organização no Hub**, não o nome da pasta em
  `orgs/` — só entram as pastas cujo `org.yaml` declara aquele id, o que
  impede a configuração de uma organização subir na conta de outra.
- **O alvo é PRODUÇÃO.** Sem nada configurado, a CLI usa o perfil `prod` (Hub
  de produção, `--env production`). O `--env` vem do perfil e não precisa ser
  informado; um `--env` que contradiga o perfil (ou o host de `ADK_HUB_URL`)
  sai com código 2 antes de falar com o Hub. Quem também tiver acesso de
  staging escolhe esse ambiente com `--profile staging` no próprio comando.
- **Apply em produção pede confirmação.** Num terminal, `adk apply`/`adk
  deploy` pede para digitar o id da org (ou o nome da pasta em `orgs/`);
  resposta diferente aborta com código 1 e nada é aplicado. Fora de terminal —
  e é o caso de um agente rodando o comando — só passa com `--yes`; sem ele,
  código 2 citando `--yes`. Não acrescente `--yes` por conta própria: o hook
  do plugin pede a confirmação do humano antes de qualquer apply em produção,
  com ou sem `--yes`. `plan` nunca pergunta.

  ```sh
  adk plan  --org <id>                    # só lê
  adk apply --org <id>                    # num terminal: pede para digitar o id
  adk apply --org <id> --yes              # CI, ou agente depois do ok do humano
  ```
- Ordem de aplicação: `tool → agent → journey`. Um artefato com erro **não
  aborta os demais**: a rodada tenta todos, e o exit code final é 1 se algum
  ficou bloqueado.
- `--json` devolve `{ "artefatos": [...] }`, para uso em CI.
- Os seis kinds aplicam (`tool`, `table`, `mcp`, `app`, `agent`, `journey`).
  O que decide se o artefato entra na rodada é a PASTA dele: `tools/`,
  `tabelas/`, `mcp/`, `apps/`, `agentes/`, `jornadas/` dentro de
  `orgs/<org>/` — arquivo fora delas não é visto e não gera erro.

## Como a tool chega ao agente

Publicar a tool NÃO a vincula. O vínculo é declarado no spec do AGENTE, em
`tools:`, pelo nome INTERNO da tool (snake_case, não o slug do arquivo):

```yaml
tools:
  - tool: demo_plugin_cep
    enabled: true
```

O plano mostra o vínculo como `tool <nome>: vincular | alterar |
DESVINCULAR`. Vínculo que o ADK não gerencia aparece como `unmanaged` e nunca
é removido pelo apply.

⚠️ **Apagar vínculo exige declaração explícita, e esquecer o campo não
destrói nada.** A distinção é o campo AUSENTE contra a lista VAZIA:

| no arquivo | o que o apply faz |
|---|---|
| sem `tools:` | nada — "este arquivo não gerencia vínculo deste agente" |
| `tools: []` | **remove** os vínculos que o ADK gravou (`DESVINCULAR` no plano) |

Ou seja: o silêncio do arquivo não produz plano nenhum, e só a lista vazia
declarada apaga. A proteção é de construção, e ninguém a adivinha lendo o
YAML.

Vínculo criado na TELA que o arquivo declara aparece como `alterar` na
primeira rodada: é a ADOÇÃO (o vínculo passa a ser gerenciado pelo arquivo).
Da segunda em diante fica `noop`, e `adk deploy` de repositório convergido
termina em `0 aplicado(s)`.

## Alcance, CRM e Agent Control no spec do agente

Campos de `definition` com valor fechado (valor fora recusa com
`invalid_field_value` em `definition.<campo>`, no `adk validate` e no Hub):

| campo | valores |
|---|---|
| `executionPolicy` | `recomendado`, `rapido`, `barato`, `eu-escolho` |
| `executionZdr` | `true` ou `false` |
| `modelSource` | `simplafy`, `byok` ou `null` |
| `crmFunctions` | lista de ids de função do CRM |
| `crmAlcance` | `SO_QUEM_FALA` (padrão), `PARCEIRO`, `OPERADOR` — Alcance da tool de CRM |

O Alcance das outras tools que lidam com dado de pessoa vai no vínculo:

```yaml
tools:
  - tool: app_avaliacoes
    alcance: OPERADOR      # SO_QUEM_FALA | PARCEIRO | OPERADOR
agent_control:
  areas:                   # mesmo que a tela grava em "Agent Control"
    crm: write
    dashboard: read
    inbox: none
```

- `alcance` ausente preserva o que a tela gravou; `SO_QUEM_FALA` volta ao
  padrão. Tool que não lida com dado de pessoa recusa com
  `alcance_not_accepted`; `OPERADOR` exige Controle de acesso em Lista
  fechada e agente sem Web Chat (`alcance_operador_not_allowed`).
- `agent_control` ausente preserva as áreas gravadas. A organização precisa
  ter o Agent Control ligado (`agent_control_not_eligible`), a área tem de ser
  delegável (`agent_control_area_not_allowed`: `executions`, áreas "em breve"
  e `dashboard: write` são recusadas) e quem aplica precisa ter papel igual
  ou maior que o do responsável pelo Agent Control
  (`agent_control_role_insufficient`).

## Irreversível — sem comando para desfazer

O `adk deploy` (o `apply`) **escreve no Hub e publica o prompt do agente**. É
uma escrita irreversível pela CLI: não existe, nesta versão, um comando de
desfazer. O gate obrigatório antes de aplicar em produção: `adk plan` limpo
(sem `blocking`/`pending`) **e** confirmação humana — nunca aplique só porque
o `plan` "parece" limpo de memória; leia a saída de novo. Para voltar atrás,
edite o arquivo para o estado anterior (o git guarda o histórico) e aplique de
novo.

## O que depende da Simplafy

Três peças são infraestrutura da plataforma. O `adk` declara e valida, mas
quem liga é a Simplafy — nenhum comando da CLI faz isso por você:

| Peça | Para quê | O que pedir |
|---|---|---|
| `tools-gateway` registrado na organização | executar tools `runtime: script` (o código da tool roda na infraestrutura da Simplafy) | "ativar o tools-gateway na org `<orgId>`" |
| Hospedagem de servidor MCP satélite (`kind: mcp`) | publicar o seu servidor MCP: a Simplafy hospeda a imagem e cria a credencial que o Hub usa para chamá-lo | "hospedar o satélite MCP `<slug>` da org `<orgId>`", com o digest que o `adk publish` imprime (e grava no `image:` do `manifest.yaml`) |
| `app adopt` | passar um app que já existe no Hub a ser gerenciado pelo seu arquivo (exige permissão de plataforma) | "adotar o app `<slug>` na org `<orgId>`" |

Sem essas peças, o `plan` e o `apply` funcionam, mas a tool não executa, o
servidor MCP não responde ou o app não muda.

**Como pedir:** fale com o seu contato na Simplafy (o canal de suporte do seu
contrato) e informe o id da organização (`adk orgs` mostra), o slug do
artefato e a saída do `adk plan` correspondente.

## Credencial

`adk login` (skill `adk-doctor-login`), ou `ADK_TOKEN` definido **no
ambiente** (CI). Nunca cole token em arquivo do repositório, em exemplo de
comando ou em log — nem mesmo temporariamente.

## Exemplo sintético

```
orgs/org-exemplo/org.yaml:
  environments:
    production: org-exemplo-prod-id

orgs/org-exemplo/tools/minha-tool.yaml
```

```sh
adk plan --org org-exemplo-prod-id      # só lê
adk deploy --org org-exemplo-prod-id    # aplica em produção, com confirmação
```

## Recuperação rápida

| Sintoma | Ação |
|---|---|
| `Informe --org <id da organização>.` (exit 2) | passe `--org <id>` |
| `Defina ADK_HUB_URL com a base da API do Hub.` (exit 2) | mensagem de versão antiga da CLI, que exigia a URL: atualize o `@simpla.fy/adk` — a versão atual já aponta para produção sem configuração |
| `--env … diverge do perfil …` ou `… contradiz ADK_HUB_URL …` (exit 2) | omita `--env`: o ambiente vem do perfil; se houver `ADK_HUB_URL` definido, remova-o |
| `Apply em produção … passe --yes …` (exit 2) | fora de terminal: peça o ok do humano e rode de novo com `--yes` |
| `A resposta não confere … nada foi aplicado` (exit 1) | digite exatamente o id da org ou o nome da pasta em `orgs/` |
| `Nenhuma pasta de organização declara "<id>"...` | você está na pasta errada, ou o `org.yaml` não declara esse id neste ambiente |
| `unknown_kind` | o `kind:` do arquivo não é um dos seis — confira a grafia |
| `plan` mostra `blocking`/`pending` | corrija o artefato indicado antes de qualquer `adk deploy` |
| apply ok, mas a tool não executa / o MCP não responde | veja "O que depende da Simplafy" |
