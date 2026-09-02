# Образ ERP ЦМК АВРОРА: Go-бэкенд + собранный фронтенд в одном контейнере.
# Собирать из КОРНЯ репозитория (нужны и backend-go/, и frontend/):
#   docker build -f backend-go/Dockerfile -t cmk-avrora-erp .
# или через compose: docker compose -f backend/docker-compose.yml --profile prod up -d --build

# ---- 1. Фронтенд: vite build → /fe/dist ----
FROM node:22-alpine AS frontend
WORKDIR /fe
COPY frontend/package.json frontend/package-lock.json* ./
# npm install, а не ci: зависимости фронтенда ставятся из корня workspace,
# и frontend/package-lock.json может отстать от корневого — сборка на
# сервере не должна падать из-за этого (см. README, «Деплой»).
RUN npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---- 2. Бэкенд: статический бинарник ----
FROM golang:1.25-alpine AS backend
WORKDIR /src
COPY backend-go/go.mod backend-go/go.sum ./
RUN go mod download
COPY backend-go/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

# ---- 3. Рантайм ----
FROM alpine:3.22
# tzdata обязателен: границы месяцев в дашбордах считаются в локальном
# времени сервера (как у Node), TZ задаётся в compose (Asia/Almaty).
# ca-certificates — исходящие HTTPS к Битрикс24/1С; wget — HEALTHCHECK.
RUN apk add --no-cache ca-certificates tzdata wget && adduser -D -H -u 10001 erp
WORKDIR /app
COPY --from=backend /out/server /app/server
COPY --from=frontend /fe/dist /app/public
ENV GIN_MODE=release \
    GO_PORT=3000 \
    STATIC_DIR=/app/public \
    TZ=Asia/Almaty
USER erp
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${GO_PORT:-3000}/api/v1/health" >/dev/null || exit 1
ENTRYPOINT ["/app/server"]
