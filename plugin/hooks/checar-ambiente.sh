#!/bin/sh
# Repassa o payload do PreToolUse para o checador Node.
# O parsing de JSON fica no .js (portável e sem depender de jq no PATH).
exec node "$(dirname "$0")/checar-ambiente.js"
