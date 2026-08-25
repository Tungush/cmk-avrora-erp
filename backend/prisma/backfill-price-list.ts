/**
 * Утверждённая цена продажи (24.08.2026) — Номенклатура.csv несёт колонку
 * «ВидЦены», где «Прайс-лист» — ровно то, что искали на листе «Прайс 2024»
 * (Article.approvedPrice был заполнен только у 22 из 2315 карточек).
 * Первый импорт (import-1c-csv.ts) эту колонку не читал вовсе.
 *
 * Дозаполняет ТОЛЬКО пустые (0) approvedPrice — уже заполненные из Excel
 * не трогает, чтобы не затереть вручную согласованные цены свежей 1С-ценой
 * без объяснения расхождения.
 *
 * Запуск: npm run backfill:price-list -- --nomenclature "…Номенклатура.csv"
 */
import * as fs from 'fs';
import { PrismaClient } from '@prisma/client';
import { normalizeName } from '../src/common/nomenclature';

const argv = process.argv.slice(2);
function arg(flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let field = ''; let inQuotes = false; let i = 0;
  const clean = text.replace(/^﻿/, '');
  while (i < clean.length) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') { if (clean[i + 1] === '"') { field += '"'; i += 2; continue; } inQuotes = false; i += 1; continue; }
      field += c; i += 1; continue;
    }
    if (c === '"') { inQuotes = true; i += 1; continue; }
    if (c === ';') { row.push(field); field = ''; i += 1; continue; }
    if (c === '\r') { i += 1; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
    field += c; i += 1;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v !== ''));
}
function readRows(path: string): Record<string, string>[] {
  const raw = parseCsv(fs.readFileSync(path, 'utf8'));
  const header = raw[0];
  return raw.slice(1).map((r) => Object.fromEntries(header.map((h, idx) => [h, r[idx] ?? ''])));
}
function num(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number(raw.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

async function main() {
  const nomPath = arg('--nomenclature');
  if (!nomPath) { console.log('Использование: npm run backfill:price-list -- --nomenclature <файл>'); process.exit(1); }

  const rows = readRows(nomPath);
  const priceByName = new Map<string, number>();
  for (const r of rows) {
    if (r['ВидЦены']?.trim() !== 'Прайс-лист') continue;
    const price = num(r['Цена']);
    if (price <= 0) continue;
    const key = normalizeName(r['Наименование']);
    if (!key) continue;
    priceByName.set(key, price); // последняя строка по этому имени побеждает
  }
  console.log(`«Прайс-лист» в выгрузке: ${priceByName.size} позиций с ценой`);

  const prisma = new PrismaClient();
  try {
    const articles = await prisma.article.findMany({ where: { approvedPrice: 0 }, select: { id: true, name: true } });
    let updated = 0;
    for (const a of articles) {
      const price = priceByName.get(normalizeName(a.name));
      if (price == null) continue;
      await prisma.article.update({ where: { id: a.id }, data: { approvedPrice: price } });
      updated += 1;
    }
    console.log(`Обновлено карточек (было 0, теперь есть цена): ${updated} из ${articles.length} без цены`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
