# Guia rápido do ADK da Simplafy

Do zero ao primeiro apply numa organização que já existe no Hub. Você só
precisa do seu e-mail e da sua senha do Hub; tudo aqui acontece em
**produção**, que é o ambiente padrão. Não há URL nem variável para configurar.

## 1. Instale a CLI

Requer Node.js com npm. A CLI também usa `uv`, Python e git; o passo seguinte
confere tudo.

```sh
npm install -g @simpla.fy/adk
adk doctor
```

Para experimentar sem instalar: `npx @simpla.fy/adk doctor`. O plugin do
Claude Code, porém, precisa do comando `adk` instalado no PATH.

## 2. Instale o plugin no Claude Code

```
/plugin marketplace add Simplafy-tec/simplafy-adk-plugin
/plugin install simplafy-adk@simplafy-adk
```

O plugin traz as skills que ensinam o ADK ao agente, o servidor MCP
`simplafy-adk` e um hook que pede a sua confirmação antes de qualquer apply em
produção. A skill `adk-comecar` repete estes passos para o agente.

## 3. Entre no Hub

```sh
adk login
```

O comando mostra um endereço e abre o navegador. Entre com e-mail e senha e
mantenha ligado **"Conceder permissão de ADK"**. Se o navegador não abrir,
copie o endereço impresso e abra-o à mão. Para autorizar uma organização só:
`adk login --org <orgId>`.

Confira:

```sh
adk whoami    # quem está autenticado
adk orgs      # organizações que o seu login alcança, com o seu papel
```

## 4. Traga a organização para arquivos

Numa pasta vazia, que você vai versionar com git:

```sh
adk init org                  # lista as suas organizações e pergunta qual
adk init org --org <orgId>    # direto, sem pergunta
```

Isso cria `orgs/<pasta>/org.yaml` e baixa do Hub, em YAML, os agentes, tools e
jornadas que a organização já tem.

## 5. Veja o que mudaria

```sh
adk plan --org <orgId>
```

O `plan` só lê. Logo depois do `init org` ele deve mostrar "sem alteração".
Edite um arquivo, rode de novo e confira cada mudança. Se aparecer `blocking`
ou `pending`, corrija antes de seguir.

## 6. Aplique

```sh
adk apply --org <orgId>
```

O apply grava em produção e não tem comando de desfazer. Por isso a CLI pede
que você digite o id da organização (ou o nome da pasta em `orgs/`) para
confirmar. Depois, rode `adk plan --org <orgId>` de novo: o esperado é "sem
alteração".

Em CI, onde não há terminal para responder, use `--yes`:

```sh
adk apply --org <orgId> --yes
```

Use `--yes` só em pipeline, depois de revisar o `plan`. Para desfazer uma
mudança, volte o arquivo ao estado anterior (o git tem o histórico) e aplique
de novo.

## Erros comuns

| Mensagem | Código | O que fazer |
|---|---|---|
| `Apply em produção (org …) sem terminal para confirmar: passe --yes …` | exit 2 | você rodou o apply fora de um terminal (CI, script, agente). Revise o `plan` e repita com `--yes`, ou rode num terminal |
| `A resposta não confere com a organização — nada foi aplicado.` | exit 1 | digite exatamente o id da org ou o nome da pasta em `orgs/` |
| `--env … diverge do perfil …` | exit 2 | o `--env` informado é divergente do ambiente do perfil. Não passe `--env`: o ambiente já vem do perfil (produção) |
| `--env … diverge de ADK_HUB_URL …` ou `… contradiz ADK_HUB_URL …` | exit 2 | há um `ADK_HUB_URL` definido no seu shell apontando para outro Hub. Remova-o (`unset ADK_HUB_URL`) |
| `Informe --org <id da organização>.` | exit 2 | passe `--org <orgId>` (veja os ids com `adk orgs`) |
| `Sem credencial …` | — | rode `adk login` |
| `O seu login não alcança a organização …` | exit 2 | confira o id em `adk orgs`; se você fez login com `--org`, refaça sem ele |
| `Nenhuma pasta de organização declara "<id>" …` | — | rode o comando na raiz da pasta criada pelo `init org` |
| `invalid_scope` no login | — | refaça o login com "Conceder permissão de ADK" ligado |
| `Defina ADK_HUB_URL …` | exit 2 | CLI antiga: `npm install -g @simpla.fy/adk` para atualizar |

## E depois?

- Criar tools, servidores MCP e apps: skills `adk-init`, `adk-dev`,
  `adk-build` e `adk-test`.
- Algumas peças são ligadas pela Simplafy (execução de tools `runtime:
  script`, hospedagem de servidor MCP, adoção de apps): veja a seção "O que
  depende da Simplafy" na skill `adk-deploy`.
