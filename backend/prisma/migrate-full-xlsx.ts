/**
 * Full ETL: 2025_План Производства (1).xlsx → PostgreSQL
 * - Phase 1: Every sheet, every row → spreadsheet_rows (100% fidelity)
 * - Phase 2: Domain mapping (articles, orders, materials, payments)
 *
 * Usage: npm run migrate:full
 */

import * as ExcelJS from 'exceljs';
import * as bcrypt from 'bcrypt';
import * as path from 'path';
import * as fs from 'fs';
import { PrismaClient, OrderStatus, OrderType, MaterialCategory, CustomerType } from '@prisma/client';

const prisma = new PrismaClient();
const BATCH = 300;

// Known header rows per sheet (from Google Sheets structure)
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
function stat(e: string) {
  if (!report[e]) report[e] = { created: 0, skipped: 0, errors: [] };
  return report[e];
}
function logSkip(e: string, r: string) {
  stat(e).skipped++;
  if (stat(e).errors.length < 30) stat(e).errors.push(r);
}
function logCreate(e: string, n = 1) {
  stat(e).created += n;
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

function safeNum(val: unknown, fallback = 0): number {
  const s = safeStr(val).replace(/\s/g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : fallback;
}

function safeDate(val: unknown): Date | null {
  if (!val) return null;
  if (val instanceof Date && !isNaN(val.getTime())) return val;
  const s = safeStr(val);
  if (!s || s.startsWith('#')) return null;
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return new Date(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
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

// ─── Phase 1: Full spreadsheet import ───────────────────────────────────────
async function importAllSheets(wb: ExcelJS.Workbook, sourceFile: string) {
  console.log('\n[Phase 1] Importing ALL sheets with full fidelity...');

  const imp = await prisma.spreadsheetImport.create({
    data: {
      sourceFile,
      status: 'in_progress',
      totalSheets: wb.worksheets.length,
    },
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
    const allRows: {
      sheetId: string;
      rowNumber: number;
      cells: object;
      data: object;
      isEmpty: boolean;
    }[] = [];

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

    await prisma.spreadsheetSheet.update({
      where: { id: sheet.id },
      data: { rowCount: imported },
    });

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

// ─── Phase 2: Domain mapping ────────────────────────────────────────────────
const articleMap = new Map<string, string>();
const customerMap = new Map<string, string>();
let binCounter = 900000000000;

const SYSTEM_ROLES = [
  { code: 'sales_manager', name: 'Менеджер по продажам' },
  { code: 'planner', name: 'Плановик' },
  { code: 'engineer', name: 'Конструктор' },
  { code: 'procurement', name: 'Закупщик' },
  { code: 'warehouse_material', name: 'Кладовщик (сырьё)' },
  { code: 'warehouse_fg', name: 'Кладовщик (ГП)' },
  { code: 'shop_foreman', name: 'Мастер цеха' },
  { code: 'accountant', name: 'Бухгалтер' },
  { code: 'director', name: 'Директор' },
  { code: 'admin', name: 'Администратор' },
];

const TEST_USERS = [
  { email: 'admin@avh.kz', password: 'Admin@2025!', roles: ['admin'] },
  { email: 'sales@avh.kz', password: 'Sales@2025!', roles: ['sales_manager'] },
  { email: 'planner@avh.kz', password: 'Plan@2025!', roles: ['planner'] },
];

async function seedUsers() {
  for (const r of SYSTEM_ROLES) {
    await prisma.role.upsert({ where: { code: r.code }, update: {}, create: r });
  }
  const roles = await prisma.role.findMany();
  const roleMap = new Map(roles.map((r) => [r.code, r.id]));
  for (const u of TEST_USERS) {
    const hash = await bcrypt.hash(u.password, 10);
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: { passwordHash: hash },
      create: { email: u.email, passwordHash: hash },
    });
    await prisma.userRole.deleteMany({ where: { userId: user.id } });
    for (const rc of u.roles) {
      const rid = roleMap.get(rc);
      if (rid) await prisma.userRole.create({ data: { userId: user.id, roleId: rid } });
    }
  }
}

async function mapArticlesFromSheet(_sheetId: string) {
  console.log('\n[Phase 2a] Mapping articles from "Артикулы" + "Прайс"...');
  for (const sheetName of ['Артикулы', 'Прайс', 'Прайс 2024']) {
    const sheet = await prisma.spreadsheetSheet.findFirst({ where: { name: sheetName } });
    if (!sheet) continue;

    const rows = await prisma.spreadsheetRow.findMany({
      where: { sheetId: sheet.id, isEmpty: false },
      orderBy: { rowNumber: 'asc' },
    });

    for (const row of rows) {
      const cells = row.cells as (string | null)[];
      const d = row.data as Record<string, string | null>;

      let code = '';
      let name = '';

      if (sheetName === 'Артикулы') {
        code = cells[0] || cells[2] || '';
        name = cells[1] || '';
      } else {
        code = cells[2] || d['Арт. / №'] || d['Арт.'] || '';
        name = cells[3] || d['Наименование'] || '';
      }

      if (!name || name.toLowerCase().includes('наименование') || name.toLowerCase().includes('итого') || name === '№') {
        logSkip('articles', `${sheetName} R${row.rowNumber}: skip`);
        continue;
      }

      if (!code) code = `GEN-${row.rowNumber}`;
      const articleCode = /^[a-z]-\d/i.test(code) ? code.toLowerCase() : code.replace(/\s+/g, '-').substring(0, 20);

      const weightKg = safeNum(cells[4] || cells[5]);
      const approvedPrice = safeNum(cells[7] || cells[8] || cells[6]);

      try {
        const art = await prisma.article.upsert({
          where: { articleCode },
          update: { name, weightKg: weightKg || undefined, approvedPrice: approvedPrice || undefined },
          create: {
            articleCode,
            name,
            weightKg,
            approvedPrice,
            legacyCode: cells[3] || null,
            isActive: true,
          },
        });
        articleMap.set(articleCode, art.id);
        articleMap.set(name, art.id);
        if (code) articleMap.set(code, art.id);
        logCreate('articles');
      } catch (e: unknown) {
        logSkip('articles', `${sheetName} R${row.rowNumber}: ${(e as Error).message?.substring(0, 60)}`);
      }
    }
  }
  console.log(`  Articles mapped: ${articleMap.size} keys`);
}

async function getOrCreateCustomer(name: string, binRaw = ''): Promise<string | null> {
  if (!name.trim()) return null;
  if (customerMap.has(name)) return customerMap.get(name)!;

  let bin = binRaw.replace(/\D/g, '');
  if (!bin || bin.length < 9) bin = String(++binCounter);

  let cust = await prisma.customer.findUnique({ where: { binIin: bin } });
  if (!cust) {
    cust = await prisma.customer.create({
      data: { name, binIin: bin, customerType: CustomerType.OUTSIDE },
    });
    logCreate('customers');
  }
  customerMap.set(name, cust.id);
  customerMap.set(bin, cust.id);
  return cust.id;
}

async function mapOrdersFromSheet(sheetName: string, prefix: string) {
  console.log(`\n[Phase 2b] Mapping orders from "${sheetName}"...`);
  const sheet = await prisma.spreadsheetSheet.findFirst({ where: { name: sheetName } });
  if (!sheet) { logSkip('orders', `Sheet ${sheetName} not found`); return; }

  const rows = await prisma.spreadsheetRow.findMany({
    where: { sheetId: sheet.id, isEmpty: false },
    orderBy: { rowNumber: 'asc' },
  });

  const orderCache = new Map<string, string>();

  for (const row of rows) {
    const d = row.data as Record<string, string | null>;

    let orderNumber = '';
    let customerName = '';
    let productName = '';
    let articleCode = '';
    let qty = 1;
    let unit = 'шт';
    let region = '';
    let unitPrice = 0;
    let prepayment = 0;
    let plannedDate: Date | null = null;
    let shipDate: Date | null = null;
    let orderType: OrderType = OrderType.FZ;

    if (sheetName === 'Telecom') {
      const cells = row.cells as (string | null)[];
      orderNumber = cells[6] || '';
      customerName = cells[10] || '';
      productName = cells[2] || '';
      articleCode = cells[1] || '';
      qty = safeNum(cells[3], 1);
      unit = cells[4] || 'шт';
      region = cells[8] || '';
      unitPrice = safeNum(cells[11]);
      plannedDate = safeDate(cells[21]);
      shipDate = safeDate(cells[32]);
      const fz = safeStr(cells[20]).toUpperCase();
      if (fz.includes('ВЗ')) orderType = OrderType.VZ;
    } else if (sheetName === 'Др проекты') {
      const cells = row.cells as (string | null)[];
      orderNumber = cells[0] || '';
      customerName = cells[12] || '';
      productName = cells[4] || '';
      articleCode = cells[3] || '';
      qty = safeNum(cells[5], 1);
      unit = cells[6] || 'шт';
      region = cells[11] || '';
      unitPrice = safeNum(cells[16]);
      prepayment = safeNum(cells[22]);
      plannedDate = safeDate(cells[29]);
      shipDate = safeDate(cells[39]);
    }

    if (!orderNumber && !productName && !customerName) {
      logSkip('order_lines', `R${row.rowNumber}: empty`);
      continue;
    }
    if (!orderNumber) orderNumber = `${prefix}-ROW${row.rowNumber}`;
    if (!customerName) customerName = 'Не указан';

    const customerId = await getOrCreateCustomer(customerName);
    if (!customerId) continue;

    let orderId = orderCache.get(orderNumber);
    if (!orderId) {
      let order = await prisma.order.findUnique({ where: { orderNumber } });
      if (!order) {
        let status: OrderStatus = OrderStatus.CONFIRMED;
        if (shipDate) status = OrderStatus.SHIPPED;
        order = await prisma.order.create({
          data: {
            orderNumber,
            customerId,
            region: region || null,
            orderType,
            status,
            plannedShipmentDate: plannedDate,
            actualShipmentDate: shipDate,
            requestDate: safeDate(d['Дата заявки / col_19'] || d['Дата / col_19'] || d['col_19']),
            sourceSheet: sheetName,
            sourceRowNumber: row.rowNumber,
            rawColumns: d as object,
          },
        });
        logCreate('orders');
      }
      orderId = order.id;
      orderCache.set(orderNumber, orderId);
    }

    let articleId: string | undefined;
    for (const key of [articleCode, productName]) {
      if (key && articleMap.has(key)) { articleId = articleMap.get(key); break; }
      for (const [k, id] of articleMap) {
        if (key && (k.includes(key) || key.includes(k))) { articleId = id; break; }
      }
      if (articleId) break;
    }

    const lineTotal = qty * unitPrice * 1.12;
    await prisma.orderLine.create({
      data: {
        orderId,
        articleId: articleId || null,
        qty,
        unit,
        unitPrice,
        lineTotalVat: lineTotal,
        prepayment,
        balanceDue: Math.max(0, lineTotal - prepayment),
        sourceSheet: sheetName,
        sourceRowNumber: row.rowNumber,
        articleCodeRaw: articleCode || null,
        productNameRaw: productName || null,
        rawColumns: d as object,
      },
    });
    logCreate('order_lines');
  }
}

async function mapMaterials() {
  console.log('\n[Phase 2c] Mapping materials from "База сырья"...');
  const sheet = await prisma.spreadsheetSheet.findFirst({ where: { name: 'База сырья' } });
  if (!sheet) return;

  const rows = await prisma.spreadsheetRow.findMany({
    where: { sheetId: sheet.id, isEmpty: false },
    orderBy: { rowNumber: 'asc' },
  });

  for (const row of rows) {
    const d = row.data as Record<string, string | null>;
    const matCode = d['артикул / col_4'] || d['col_4'] || '';
    const name = d['Товар / col_5'] || d['col_5'] || '';
    if (!name || name.toLowerCase().includes('товар') || name.toLowerCase().includes('наименование')) continue;

    const code = matCode || `MAT-${row.rowNumber}`;
    const catStr = (d['Категория / col_3'] || d['col_3'] || '').toLowerCase();
    let category: MaterialCategory = MaterialCategory.COMPONENTS;
    if (catStr.includes('инструмент')) category = MaterialCategory.INSTRUMENTS;
    else if (catStr.includes('металл')) category = MaterialCategory.METAL;
    else if (catStr.includes('метиз')) category = MaterialCategory.HARDWARE;
    else if (catStr.includes('расход')) category = MaterialCategory.CONSUMABLES;

    try {
      await prisma.material.upsert({
        where: { materialCode: code },
        update: {
          name,
          unit: d['ед.изм / col_9'] || d['col_9'] || 'шт',
          purchasePrice: safeNum(d['Цена из Закупа / col_12'] || d['col_12']),
          unitWeightKg: safeNum(d['вес ед. / col_23'] || d['col_23']),
        },
        create: {
          materialCode: code,
          category,
          name,
          unit: d['ед.изм / col_9'] || d['col_9'] || 'шт',
          purchasePrice: safeNum(d['Цена из Закупа / col_12'] || d['col_12']),
          unitWeightKg: safeNum(d['вес ед. / col_23'] || d['col_23']),
        },
      });
      logCreate('materials');
    } catch (e: unknown) {
      logSkip('materials', `R${row.rowNumber}: ${(e as Error).message?.substring(0, 60)}`);
    }
  }
}

function generateReport(): string {
  const lines = [
    '# Full Migration Report',
    `> ${new Date().toISOString()}`,
    '',
    '| Entity | Created | Skipped |',
    '|---|---|---|',
  ];
  for (const [e, s] of Object.entries(report)) {
    lines.push(`| ${e} | ${s.created} | ${s.skipped} |`);
  }
  return lines.join('\n');
}

async function main() {
  const xlsxPath = path.resolve(__dirname, '..', '..', '2025_План Производства (1).xlsx');
  console.log(`\n${'='.repeat(60)}\n  FULL MIGRATION: ${path.basename(xlsxPath)}\n${'='.repeat(60)}`);

  if (!fs.existsSync(xlsxPath)) {
    console.error(`File not found: ${xlsxPath}`);
    process.exit(1);
  }

  console.log('Opening workbook...');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  console.log(`Sheets: ${wb.worksheets.length}`);

  // Clear previous spreadsheet imports
  await prisma.spreadsheetRow.deleteMany({});
  await prisma.spreadsheetSheet.deleteMany({});
  await prisma.spreadsheetImport.deleteMany({});

  await seedUsers();
  await importAllSheets(wb, path.basename(xlsxPath));

  // Clear old domain data before re-mapping
  console.log('\nClearing old domain data for re-import...');
  await prisma.orderLine.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.materialStockMovement.deleteMany({});
  await prisma.finishedGoodsMovement.deleteMany({});
  await prisma.bomItem.deleteMany({});
  await prisma.minStockLevel.deleteMany({});
  await prisma.productionPlanItem.deleteMany({});
  await prisma.payment.deleteMany({});
  await prisma.paymentDocument.deleteMany({});
  await prisma.material.deleteMany({});
  await prisma.article.deleteMany({});
  await prisma.customer.deleteMany({ where: { binIin: { startsWith: '900000' } } });

  await mapArticlesFromSheet('');
  await mapOrdersFromSheet('Telecom', 'TC');
  await mapOrdersFromSheet('Др проекты', 'DP');
  await mapMaterials();

  const reportMd = generateReport();
  fs.writeFileSync(path.resolve(__dirname, '..', '..', 'migration_report.md'), reportMd);
  console.log('\n' + reportMd);
  console.log('\n✅ Full migration complete.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
