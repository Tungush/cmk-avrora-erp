#!/usr/bin/env node
/**
 * Ручной дамп боевой базы из контейнера erp_postgres в backend/backups
 * (`npm run db:backup`). Работает на macOS, Linux и Windows — нужен только
 * Docker. Автоматические ежедневные дампы делает сервис `backup` в
 * backend/docker-compose.yml, этот скрипт — для «перед важным шагом».
 *
 * Восстановление:
 *   docker exec -i erp_postgres pg_restore -U erp_user -d erp_production_db --clean < backend/backups/<файл>.dump
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../backend/backups/', import.meta.url));
mkdirSync(dir, { recursive: true });

const d = new Date();
const p = (n) => String(n).padStart(2, '0');
const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
const file = `${dir}erp_production_db-manual-${stamp}.dump`;

const label = process.argv[2] ? `-${process.argv[2].replace(/[^\w.-]+/g, '_')}` : '';
const target = label ? file.replace('.dump', `${label}.dump`) : file;

const dump = execFileSync(
  'docker',
  ['exec', 'erp_postgres', 'pg_dump', '-U', 'erp_user', '-Fc', 'erp_production_db'],
  { maxBuffer: 1024 * 1024 * 1024 },
);
writeFileSync(target, dump);
const mb = (statSync(target).size / 1024 / 1024).toFixed(1);
console.log(`дамп записан: ${target} (${mb} МБ)`);
