# simplafy-adk — plugin do ADK da Simplafy

Plugin para o Claude Code (skills + servidor MCP + hook) que ensina um agente
a trabalhar com o ADK da Simplafy: configurar agentes, tools e jornadas de uma
organização do Hub em arquivos versionados e aplicá-los com `plan` → `apply`.
O repositório onde você trabalha não precisa de um `CLAUDE.md` próprio: o
plugin já dá ao agente o mapa completo.

**Começando do zero? Leia o [QUICKSTART.md](QUICKSTART.md)** — instalação,
login, `init org`, `plan`, `apply` e os erros mais comuns, em poucos minutos.

## Instalar

```sh
npm install -g @simpla.fy/adk     # a CLI `adk`, que o plugin usa
```

No Claude Code:

```
/plugin marketplace add Simplafy-tec/simplafy-adk-plugin
/plugin install simplafy-adk@simplafy-adk
```

## O que vem no plugin

### 7 skills

| Skill | Cobre |
|---|---|
| `adk-comecar` | o primeiro uso numa org existente: login → init org → plan → apply (produção) |
| `adk-doctor-login` | conferir a máquina (`adk doctor`) e autenticar (`adk login`/`whoami`/`orgs`/`logout`) |
| `adk-init` | criar o esqueleto de um componente (`tool`, `mcp`, `app`) |
| `adk-dev` | desenvolvimento com recarga automática — comportamento por `kind` |
| `adk-build` | o portão local (contrato, vazamento, runtime, política) e os códigos de erro |
| `adk-test` | rodar a suíte do componente |
| `adk-deploy` | validar/planejar/aplicar a configuração de uma organização, e o que depende da Simplafy |

### Servidor MCP

O plugin declara o servidor `simplafy-adk` chamando o binário **`adk` já
instalado** (`adk mcp-server`), e não `npx -y @simpla.fy/adk`.

**Por que não `npx -y`:** o `-y` suprime o prompt e faria toda sessão baixar e
EXECUTAR a versão mais recente do pacote — na mesma máquina que mantém a
credencial do `adk login`. Usar o binário instalado deixa a versão sob
controle de quem instala.

Pré-requisito, portanto: ter a CLI no PATH. `adk doctor` confirma.

### Hook de confirmação

Antes de qualquer `adk apply`/`adk deploy` que possa gravar em produção, o
hook pede a confirmação do humano. `adk plan` nunca é interrompido: ele só lê.

## Licença

MIT.
