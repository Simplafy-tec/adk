---
name: adk-comecar
description: Use quando for usar o ADK da Simplafy pela primeira vez numa organização que já existe no Hub — do login com e-mail e senha até o primeiro apply em produção (adk login → adk init org → adk plan → adk apply), com a confirmação que o apply em produção exige.
---

# adk-comecar

O caminho mais curto do zero ao primeiro apply. Tudo aqui é **produção**: é o
ambiente padrão da CLI e o único para o qual você tem login (e-mail e senha do
Hub). Não há URL para configurar.

Pré-requisito: a CLI instalada e no PATH.

```sh
npm install -g @simpla.fy/adk    # instala a CLI
adk doctor          # confere node, python, uv e git contra a política da plataforma
```

## 1. Entrar: `adk login`

```sh
adk login                     # abre a tela de login do Hub de produção
adk login --org <orgId>       # se você já sabe o id da org: autoriza só ela
```

O comando imprime um endereço e espera a autorização. Entre com seu e-mail e
senha do Hub e mantenha ligado o interruptor **"Conceder permissão de ADK"**
(sem ele não há credencial). Se o navegador não abrir sozinho, copie o endereço
impresso e abra-o à mão.

Confira com quem e onde você entrou:

```sh
adk whoami     # Hub, usuário e permissões do token
adk orgs       # organizações que o token alcança, com o seu papel em cada uma
```

## 2. Trazer a organização: `adk init org`

Numa pasta vazia (ou num repositório git novo), onde a configuração vai morar:

```sh
adk init org                  # lista as organizações do seu login e pergunta qual
adk init org --org <orgId>    # direto, sem pergunta (necessário fora de terminal)
```

Ele cria `orgs/<pasta>/org.yaml` com `environments.production: <orgId>` e já
traz do Hub, em arquivos YAML, o que existe na organização (agentes, tools,
jornadas). Versione essa pasta: a partir daqui o arquivo é a fonte da verdade.

## 3. Ver o que mudaria: `adk plan`

```sh
adk plan --org <orgId>
```

Só lê; nunca grava. Logo depois do `init org`, o plano deve vir sem alteração
(o arquivo acabou de sair do Hub). Edite um YAML, rode de novo e leia a saída:

- entradas `blocking` ou `pending` → corrija antes de seguir;
- o resto descreve, artefato por artefato, o que o apply faria.

## 4. Aplicar: `adk apply`

```sh
adk apply --org <orgId>
```

O apply **escreve em produção**, e não existe comando para desfazer. Por isso a
CLI pede confirmação: num terminal, ela mostra a organização e pede que você
digite o id da org (ou o nome da pasta em `orgs/`). Resposta diferente aborta
sem aplicar nada (código 1).

**`--yes` é só para CI.** Fora de terminal (pipeline, agente rodando o
comando), a CLI não tem como perguntar e sai com código 2 pedindo `--yes`.
Um agente nunca acrescenta `--yes` por conta própria: ele mostra o `plan` ao
humano, recebe o ok e só então roda `adk apply --org <orgId> --yes`. O hook
deste plugin pede essa confirmação de novo antes de qualquer apply em produção,
com ou sem `--yes`.

Depois do apply, rode `adk plan --org <orgId>` outra vez: o esperado é "sem
alteração". Se algo aparecer de novo, o apply não terminou o que devia.

## Daqui em diante

| Quero… | Skill |
|---|---|
| entender os gates do apply, vínculo de tools e a tabela de erros | `adk-deploy` |
| criar uma tool, um servidor MCP ou um app | `adk-init`, depois `adk-dev`, `adk-build`, `adk-test` |
| saber o que exige ação da Simplafy | seção "O que depende da Simplafy" em `adk-deploy` |

## Recuperação rápida

| Sintoma | Ação |
|---|---|
| navegador não abre no `login` | copie o endereço impresso e abra à mão |
| `invalid_scope` no login | refaça o login com "Conceder permissão de ADK" ligado |
| `Sem credencial` no `init org`/`plan` | rode `adk login` |
| `O seu login não alcança a organização …` | confira o id em `adk orgs`, ou refaça `adk login` sem `--org` |
| `Sem terminal para escolher` no `init org` | passe `--org <orgId>` |
| `Apply em produção … passe --yes` (código 2) | fora de terminal: peça o ok do humano e repita com `--yes` |
| `A resposta não confere …` (código 1) | digite exatamente o id da org ou o nome da pasta |
| `--env … diverge do perfil …` (código 2) | não passe `--env`: o ambiente vem do perfil (produção) |
