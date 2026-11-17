---
name: adk-test
description: Use quando for rodar a suíte de testes de um componente do ADK (tool ou mcp) antes do deploy.
---

# adk-test

```sh
adk test [--dir <caminho>]
```

Para `kind: mcp` com runtime Node (`package.json`, sem `server.py`): roda o
harness do próprio componente (`npm test`) e espelha o exit code. Sem
`node_modules/`: exit **2** citando `npm install`, sem disparar nada.

Para todo o resto (Python): equivale a `uv run pytest` na raiz do componente.
Exit **1** se a suíte falhar; exit **0** se passar. A saída impressa é o texto
real do pytest.

O teste que o `adk init mcp` gera (nos dois runtimes) **chama** a tool de
exemplo, não só importa o servidor: dependência nativa carregada em runtime
(ex.: pango do WeasyPrint) passa no import e só quebra na chamada. Ao trocar a
tool de exemplo pela sua, mantenha um teste que a chame.

## Ressalva: `kind: app` não usa `adk test`

**Não use `adk test` para `kind: app`** — ele dispara pytest num pacote que
não tem nenhuma linha de Python, e a falha resultante não diz nada sobre a
tela. O teste de um `app` é o do próprio projeto npm (os scripts declarados em
`package.json`, ex.: `npm test`, se o app tiver algum).

## Falhas típicas

| Sintoma | Ação |
|---|---|
| `uv` não encontrado | confira `adk doctor` — o `test` depende do `uv`, não do `python3` do sistema |
| sem `pyproject.toml`/`tests/` | o `adk init tool\|mcp` já cria os dois; confira se você está na raiz certa do componente |
| suíte vermelha | leia a saída do pytest — é texto real, sem reformatação |
