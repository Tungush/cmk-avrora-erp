@echo off
rem Локальный запуск Go-бэкенда на Windows (аналог backend-go/scripts/dev.sh).
rem Конфиг берётся из backend\.env (DATABASE_URL, ONEC_*, …) — правится там, не здесь.
rem Нужен Go 1.25 в PATH. Порт 3100; фронтенд (npm run dev:frontend) проксирует /api сюда.
setlocal EnableDelayedExpansion
cd /d "%~dp0"
for /f "usebackq eol=# tokens=1,* delims==" %%a in ("backend\.env") do (
  set "k=%%a"
  set "v=%%b"
  if defined v (
    if "!v:~0,1!"=="^"" set "v=!v:~1,-1!"
    if "!v:~0,1!"=="'" set "v=!v:~1,-1!"
  )
  if not defined !k! set "!k!=!v!"
)
if not defined GIN_MODE set "GIN_MODE=release"
if not defined GO_PORT set "GO_PORT=3100"
if not defined DEBUG_ERRORS set "DEBUG_ERRORS=1"
cd /d "%~dp0backend-go"
go run .\cmd\server
