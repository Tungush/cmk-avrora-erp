#!/usr/bin/env node
/**
 * Заполняет пустые секреты в backend/.env перед запуском сервера
 * (`npm run pilot`, `npm run prod:up`).
 *
 * Зачем: контейнер стартует с REQUIRE_SECRETS=1 и отказывается работать с
 * секретами по умолчанию из кода — иначе любой в сети выпишет себе
 * admin-токен. Руками придумывать 64-значные строки никто не будет, поэтому
 * они генерируются здесь и один раз записываются в backend/.env (файл не в
 * git). Уже заданные значения не трогаются: смена JWT_SECRET разлогинивает
 * всех, а смена INTEGRATION_1C_SECRET ломает подпись вебхуков 1С.
 *
 * ENV_FILE=/путь/к/.env — проверить на другом файле (для тестов).
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const envFile = process.env.ENV_FILE || fileURLToPath(new URL('../backend/.env', import.meta.url));
const example = fileURLToPath(new URL('../backend/.env.example', import.meta.url));

if (!existsSync(envFile)) {
  copyFileSync(example, envFile);
  console.log(`создан ${envFile} из .env.example — проверьте DATABASE_URL и адрес 1С`);
}

// Значения, с которыми наружу выходить нельзя: пустые и дефолты из кода
const WEAK = new Set(['', 'dev-1c-secret', 'erp_super_secret_jwt_key', 'change-me']);
const KEYS = ['JWT_SECRET', 'INTEGRATION_1C_SECRET'];

let text = readFileSync(envFile, 'utf8');
const changed = [];
for (const key of KEYS) {
  const re = new RegExp(`^${key}=(.*)$`, 'm');
  const m = text.match(re);
  const current = m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  if (!WEAK.has(current)) continue;
  const value = randomBytes(32).toString('hex'); // без $ и кавычек — безопасно для dotenv и compose
  text = m ? text.replace(re, `${key}=${value}`) : `${text.replace(/\s*$/, '')}\n${key}=${value}\n`;
  changed.push(key);
}

if (changed.length) {
  writeFileSync(envFile, text);
  console.log(`секреты заданы: ${changed.join(', ')} → ${envFile}`);
} else {
  console.log('секреты уже заданы, ничего не менял');
}
