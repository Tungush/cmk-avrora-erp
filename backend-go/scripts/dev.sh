#!/bin/bash
# Локальный запуск Go-бэкенда для повседневной разработки: та же .env, что
# была у NestJS (backend/.env) — общая база, общий ONEC_BASE_URL.
#
# Как dotenv.config() у Nest: переменные, уже заданные в окружении, НЕ
# перекрываются — `ONEC_BASE_URL=http://localhost:8081 npm run dev` работает.
# Значения берутся буквально (без раскрытия $ и без eval), обрамляющие
# кавычки снимаются. ?schema=public в DATABASE_URL вырезает сам бэкенд
# (internal/db), так что URL из Prisma подходит как есть.
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

export GIN_MODE="${GIN_MODE:-release}"
export GO_PORT="${GO_PORT:-3100}"
export DEBUG_ERRORS="${DEBUG_ERRORS:-1}"

exec go run ./cmd/server
