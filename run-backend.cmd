@echo off
rem Конфиг берётся из backend\.env (DATABASE_URL, ONEC_*) — правится там, не здесь.
cd /d "C:\Users\22881\Desktop\cmk-avrora-erp\backend"
call node_modules\.bin\ts-node.cmd src\main.ts
