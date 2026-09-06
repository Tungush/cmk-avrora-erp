#!/usr/bin/env node
/**
 * Дымовой прогон API на работающем сервере (`npm run smoke [адрес]`).
 * По умолчанию http://localhost:3000 (пилот/прод в Docker); для локальной
 * разработки: `npm run smoke http://localhost:3100`.
 *
 * Сам тест — backend-go/smoke/smoke_test.go: проверяет здоровье, вход без
 * токена, основные GET-ручки ролей, JSON-конверт ошибок и раздачу
 * фронтенда. Ничего не пишет в базу.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] || process.env.SMOKE_BASE_URL || 'http://localhost:3000';
const goBin = process.env.GO || 'go';
const cwd = fileURLToPath(new URL('../backend-go/', import.meta.url));

// Тест подписывает свои токены тем же секретом, что и сервер: берём
// JWT_SECRET из backend/.env, если он не задан в окружении.
const env = { ...process.env, SMOKE_BASE_URL: base };
const envFile = fileURLToPath(new URL('../backend/.env', import.meta.url));
if (!env.JWT_SECRET && existsSync(envFile)) {
  const m = readFileSync(envFile, 'utf8').match(/^JWT_SECRET=(.*)$/m);
  const v = m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  if (v) env.JWT_SECRET = v;
}
// Локальный dev-сервер (:3100) фронтенд не раздаёт — не требовать SPA
if (!env.SMOKE_SPA && /:3100\b/.test(base)) env.SMOKE_SPA = '0';

const r = spawnSync(goBin, ['test', './smoke', '-count=1', '-v'], {
  cwd,
  stdio: 'inherit',
  env,
});
if (r.error) {
  console.error(`не удалось запустить go: ${r.error.message} (укажите GO=/путь/к/go)`);
  process.exit(1);
}
process.exit(r.status ?? 1);
