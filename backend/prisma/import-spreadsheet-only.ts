/**
 * Разовый импорт (25.08.2026) — только Phase 1 из migrate-full-xlsx.ts
 * (сырые строки листа в spreadsheet_rows/sheets/imports для «Деньги» →
 * «19.20-7п» / «Реестр АПП» / «Приходы др. проектам»), БЕЗ Phase 2.
 *
 * Почему не просто `npm run migrate:full`: тот скрипт следом за Phase 1
 * сносит orderLine/order/material/article/paymentDocument и заново мапит
 * их из этого же xlsx — а это откатило бы весь сегодняшний импорт из 1С
 * (контрагенты, оплаты, остатки, isMaterialResale и т.д.) на более старые
 * и менее точные данные из гугл-таблицы. Этим трём вкладкам нужны только
 * сырые строки листа, домен трогать не нужно.
 *
 * Запуск: npx ts-node prisma/import-spreadsheet-only.ts
 */
import * as ExcelJS from 'exceljs';
import * as path from 'path';
import * as fs from 'fs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const BATCH = 300;

const SHEET_HEADER_ROW: Record<string, number> = {
  'Telecom': 3,
  'Др проекты': 3,
  'План': 5,
  'Прайс': 2,
  'Прайс 2024': 2,
  'Артикулы': 1,
  'База сырья': 1,
  'База сырья (металл)': 1,
  'Спецификации 2022': 4,
  '19.20-7п': 1,
  'Приход ГП': 5,
  'Склад ТМЦ (импорт)': 2,
  'Склад ТМЦ': 2,
  'Минимальные остатки': 3,
  'Инфо3': 1,
  'приходы др проектам': 2,
  'реестр АПП по заказчикам': 1,
};

const report: Record<string, { created: number; skipped: number; errors: string[] }> = {};
function logCreate(e: string, n = 1) {
  if (!report[e]) report[e] = { created: 0, skipped: 0, errors: [] };
  report[e].created += n;
}

function safeStr(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (val instanceof Date) return isNaN(val.getTime()) ? '' : val.toISOString();
  if (typeof val === 'object') {
    const o = val as Record<string, unknown>;
    if (o.result !== undefined) return safeStr(o.result);
    if (o.text) return String(o.text).trim();
    if (o.richText && Array.isArray(o.richText)) {
      return (o.richText as { text: string }[]).map((t) => t.text).join('').trim();
    }
    if (o.formula) return safeStr(o.result ?? '');
    return '';
  }
  return String(val).trim();
}

function isRowEmpty(cells: (string | null)[]): boolean {
  return cells.every((c) => !c || c === '' || c.startsWith('#'));
}

function dedupeHeader(label: string, col: number, seen: Map<string, number>): string {
  const base = label.replace(/\s+/g, ' ').trim() || `col_${col}`;
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}__${count + 1}`;
}

function extractHeaders(ws: ExcelJS.Worksheet, headerRow: number, colCount: number): {
  headers: string[];
  headerRows: string[][];
} {
  const headerRows: string[][] = [];
  const startRow = Math.max(1, headerRow - 2);
  for (let r = startRow; r <= headerRow; r++) {
    const row: string[] = [];
    for (let c = 1; c <= colCount; c++) {
      row.push(safeStr(ws.getRow(r).getCell(c).value));
    }
    headerRows.push(row);
  }

  const seen = new Map<string, number>();
  const headers: string[] = [];
  for (let c = 1; c <= colCount; c++) {
    const parts: string[] = [];
    for (const hr of headerRows) {
      const p = hr[c - 1];
      if (p && !p.startsWith('#') && !parts.includes(p)) parts.push(p);
    }
    const label = parts.length ? parts.join(' / ') : `col_${c}`;
    headers.push(dedupeHeader(label, c, seen));
  }
  return { headers, headerRows };
}

function rowToCells(row: ExcelJS.Row, colCount: number): (string | null)[] {
  const cells: (string | null)[] = [];
  for (let c = 1; c <= colCount; c++) {
    const s = safeStr(row.getCell(c).value);
    cells.push(s || null);
  }
  return cells;
}

function cellsToData(headers: string[], cells: (string | null)[]): Record<string, string | null> {
  const data: Record<string, string | null> = {};
  headers.forEach((h, i) => {
    data[h] = cells[i] ?? null;
  });
  return data;
}

function detectHeaderRow(ws: ExcelJS.Worksheet, colCount: number): number {
  let best = 1;
  let bestCount = 0;
  for (let r = 1; r <= Math.min(10, ws.rowCount); r++) {
    let count = 0;
    for (let c = 1; c <= colCount; c++) {
      const s = safeStr(ws.getRow(r).getCell(c).value);
      if (s.length > 2 && !s.startsWith('#') && isNaN(Number(s.replace(/\s/g, '')))) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = r;
    }
  }
  return best;
}

async function importAllSheets(wb: ExcelJS.Workbook, sourceFile: string) {
  console.log('\n[Phase 1] Importing ALL sheets with full fidelity...');

  const imp = await prisma.spreadsheetImport.create({
    data: { sourceFile, status: 'in_progress', totalSheets: wb.worksheets.length },
  });

  let totalRows = 0;

  for (const ws of wb.worksheets) {
    const colCount = ws.columnCount || 1;
    const headerRow = SHEET_HEADER_ROW[ws.name] ?? detectHeaderRow(ws, colCount);
    const { headers, headerRows } = extractHeaders(ws, headerRow, colCount);

    const sheet = await prisma.spreadsheetSheet.create({
      data: {
        importId: imp.id,
        name: ws.name,
        headerRow,
        colCount,
        rowCount: 0,
        headers: headers as unknown as object,
        headerRows: headerRows as unknown as object,
      },
    });

    let imported = 0;
    const allRows: { sheetId: string; rowNumber: number; cells: object; data: object; isEmpty: boolean }[] = [];

    ws.eachRow((row, rowNumber) => {
      if (rowNumber <= headerRow) return;
      const cells = rowToCells(row, colCount);
      allRows.push({
        sheetId: sheet.id,
        rowNumber,
        cells: cells as object,
        data: cellsToData(headers, cells) as object,
        isEmpty: isRowEmpty(cells),
      });
    });

    for (let i = 0; i < allRows.length; i += BATCH) {
      const chunk = allRows.slice(i, i + BATCH);
      await prisma.spreadsheetRow.createMany({ data: chunk });
      imported += chunk.length;
    }

    await prisma.spreadsheetSheet.update({ where: { id: sheet.id }, data: { rowCount: imported } });

    totalRows += imported;
    logCreate('spreadsheet_rows', imported);
    console.log(`  ✓ "${ws.name}": ${imported} rows, ${colCount} cols (header row ${headerRow})`);
  }

  await prisma.spreadsheetImport.update({
    where: { id: imp.id },
    data: { totalRows, status: 'completed', report: report as object },
  });

  console.log(`  Total: ${wb.worksheets.length} sheets, ${totalRows} rows`);
  return imp.id;
}

async function main() {
  const xlsxPath = path.resolve(__dirname, '..', '..', '2025_План Производства (1).xlsx');
  if (!fs.existsSync(xlsxPath)) {
    console.error(`File not found: ${xlsxPath}`);
    process.exit(1);
  }

  console.log('Opening workbook...');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  console.log(`Sheets: ${wb.worksheets.length}`);

  await prisma.spreadsheetRow.deleteMany({});
  await prisma.spreadsheetSheet.deleteMany({});
  await prisma.spreadsheetImport.deleteMany({});

  await importAllSheets(wb, path.basename(xlsxPath));

  console.log('\nDone. Domain data (orders/materials/articles/payments) was NOT touched.');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
