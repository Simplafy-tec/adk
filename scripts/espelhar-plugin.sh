#!/usr/bin/env bash
# Espelha o plugin deste repositório num clone do repositório público
# Simplafy-tec/simplafy-adk-plugin.
#
# Uso: scripts/espelhar-plugin.sh <destino>
#
# O destino fica com exatamente: plugin/, .claude-plugin/marketplace.json,
# LICENSE e um README.md próprio do espelho. Tudo o mais no destino é apagado,
# exceto .git (o clone continua um clone). O script só copia: revisar, gravar
# o commit e publicar no repositório público são passos manuais, feitos depois.
set -euo pipefail

if [ "$#" -ne 1 ] || [ -z "${1:-}" ]; then
  echo "Uso: $0 <diretório destino (clone do repositório público)>" >&2
  exit 2
fi

ORIGEM="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESTINO="$1"

for item in plugin .claude-plugin/marketplace.json LICENSE; do
  if [ ! -e "$ORIGEM/$item" ]; then
    echo "Não encontrei $item em $ORIGEM." >&2
    exit 1
  fi
done

mkdir -p "$DESTINO"
DESTINO="$(cd "$DESTINO" && pwd)"

if [ "$DESTINO" = "$ORIGEM" ]; then
  echo "O destino não pode ser o próprio repositório de origem." >&2
  exit 2
fi

# Trava: só apaga o conteúdo de um destino vazio ou de um clone do repositório
# público (https ou ssh). Qualquer outra pasta fica intocada.
if [ -n "$(find "$DESTINO" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
  REMOTO=""
  if [ -e "$DESTINO/.git" ]; then
    REMOTO="$(git -C "$DESTINO" config --get remote.origin.url 2>/dev/null || true)"
  fi
  case "$REMOTO" in
    *simplafy-adk-plugin*) ;;
    *)
      echo "Recusado: $DESTINO não está vazio e não é um clone de Simplafy-tec/simplafy-adk-plugin" >&2
      echo "(remote.origin.url: ${REMOTO:-ausente}). Nada foi alterado." >&2
      echo "Use um diretório vazio, inexistente ou um clone do repositório público." >&2
      exit 2
      ;;
  esac
fi

# Espelho: limpa tudo no destino, menos o .git.
find "$DESTINO" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +

cp -R "$ORIGEM/plugin" "$DESTINO/plugin"
mkdir -p "$DESTINO/.claude-plugin"
cp "$ORIGEM/.claude-plugin/marketplace.json" "$DESTINO/.claude-plugin/marketplace.json"
cp "$ORIGEM/LICENSE" "$DESTINO/LICENSE"

cat > "$DESTINO/README.md" <<'README'
# simplafy-adk-plugin

Plugin do Claude Code para o ADK da Simplafy: skills, servidor MCP e um hook
de confirmação para configurar agentes, tools e jornadas de uma organização do
Hub em arquivos versionados.

## Instalar

```sh
npm install -g @simpla.fy/adk
```

No Claude Code:

```
/plugin marketplace add Simplafy-tec/simplafy-adk-plugin
/plugin install simplafy-adk@simplafy-adk
```

## Começar

Siga o [guia rápido](plugin/QUICKSTART.md): login, `init org`, `plan`, `apply`
e os erros mais comuns. O que o plugin traz está em [plugin/README.md](plugin/README.md).

Este repositório é gerado a partir do código do ADK; mudanças feitas aqui são
sobrescritas na próxima publicação.
README

echo "Plugin espelhado em $DESTINO. Revise com git status/diff no destino antes de publicar."
