/**
 * Загрузка «Прайс - Лист1.csv» (31.08.2026) — официальный прайс-лист,
 * которого в системе не было вовсе (approvedPrice пуст у большинства
 * карточек). Колонка «Арт.» матчится с Article.articleCode напрямую —
 * это не 1С-выгрузка, а ручной файл с кодами каталога.
 *
 * Каждое фактическое изменение цены пишет строку в PriceHistory
 * (changedBy = директор — УТВ цена в файле уже была решением директора,
 * это перенос его решения, а не новое). Совпадающие цены не трогает —
 * это не «изменение», логировать нечего.
 *
 * Запуск: npm run import:price-list -- --file "…Прайс - Лист1.csv"
 */
import * as fs from 'fs';
import { PrismaClient } from '@prisma/client';

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
    if (c === ',') { row.push(field); field = ''; i += 1; continue; }
    if (c === '\r') { i += 1; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
    field += c; i += 1;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function parsePrice(raw: string | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/ /g, '').replace(/\s/g, '').replace(',', '.');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function main() {
  const filePath = arg('--file');
  if (!filePath) { console.log('Использование: npm run import:price-list -- --file <файл>'); process.exit(1); }

  // Первые две строки — служебный свод и шапка таблицы, данные с третьей
  const raw = parseCsv(fs.readFileSync(filePath, 'utf8'));
  const dataRows = raw.slice(2);

  const rows: Array<{ code: string; price: number }> = [];
  for (const r of dataRows) {
    const code = (r[1] ?? '').trim();
    const price = parsePrice(r[6]);
    if (!code || price == null) continue;
    rows.push({ code, price });
  }
  console.log(`Строк с кодом и ценой в файле: ${rows.length}`);

  const prisma = new PrismaClient();
  try {
    const director = await prisma.user.findUnique({ where: { email: 'director@avh.kz' } });
    if (!director) throw new Error('Учётка director@avh.kz не найдена — некому приписать PriceHistory');

    const codes = rows.map((r) => r.code.toLowerCase());
    const articles = await prisma.article.findMany({
      where: { articleCode: { in: codes, mode: 'insensitive' } },
      select: { id: true, articleCode: true, approvedPrice: true },
    });
    const byCode = new Map(articles.map((a) => [a.articleCode.trim().toLowerCase(), a]));

    let updated = 0; let same = 0; let notFound = 0;
    const today = new Date(); today.setHours(0, 0, 0, 0);

    for (const r of rows) {
      const a = byCode.get(r.code.toLowerCase());
      if (!a) { notFound += 1; continue; }
      const current = Number(a.approvedPrice);
      if (Math.abs(current - r.price) < 1) { same += 1; continue; }

      await prisma.$transaction([
        prisma.article.update({ where: { id: a.id }, data: { approvedPrice: r.price } }),
        prisma.priceHistory.create({
          data: { articleId: a.id, price: r.price, validFrom: today, changedBy: director.id },
        }),
      ]);
      updated += 1;
    }

    console.log(`Обновлено (новая цена + запись в историю): ${updated}`);
    console.log(`Совпало с уже утверждённой — не тронуто: ${same}`);
    console.log(`Код из файла не найден в каталоге: ${notFound}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
