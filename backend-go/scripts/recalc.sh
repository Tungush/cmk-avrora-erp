#!/bin/bash
# Пересчёт себестоимости изделий (npm run recalc:costing).
# Конфиг берётся из backend/.env — так же, как в dev.sh: уже заданные
# переменные окружения не перекрываются, кавычки снимаются, $ не
# раскрывается. Аргументы уходят в команду: `npm run recalc:costing -- --active`.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="../backend/.env"
if [ -f "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in ''|\#*) continue ;; esac
    key="${line%%=*}"
    val="${line#*=}"
    key="${key#export }"
    key="${key//[[:space:]]/}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    if [[ "$val" == \"*\" && "$val" == *\" ]]; then val="${val:1:${#val}-2}"; fi
    if [[ "$val" == \'*\' && "$val" == *\' ]]; then val="${val:1:${#val}-2}"; fi
    if [ -z "${!key+x}" ]; then export "$key=$val"; fi
  done < "$ENV_FILE"
fi

exec go run ./cmd/recalc "$@"
