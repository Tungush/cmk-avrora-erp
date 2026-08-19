/**
 * ETL Migration Script: 2025_План Производства.xlsx → ERP database
 *
 * Usage: ts-node prisma/migrate-from-xlsx.ts
 *
 * Rules:
 *  - Does NOT use state-machine validation (seed-mode for historical data)
 *  - Does NOT write Calculated fields directly (let service formulas recalc)
 *  - Logs everything to migration_report.md
 */

import * as ExcelJS from 'exceljs';
import * as bcrypt from 'bcrypt';
import * as path from 'path';
import * as fs from 'fs';
import { PrismaClient, OrderStatus, OrderType, MaterialCategory, OperationType, StockMovementType, CustomerType } from '@prisma/client';

const prisma = new PrismaClient();

// ─── Report accumulator ────────────────────────────────────────────────────────
interface EntityStats {
  created: number;
  skipped: number;
  errors: string[];
}
const report: Record<string, EntityStats> = {};

function stat(entity: string): EntityStats {
  if (!report[entity]) report[entity] = { created: 0, skipped: 0, errors: [] };
  return report[entity];
}

function logSkip(entity: string, reason: string) {
  stat(entity).skipped++;
  if (stat(entity).errors.length < 20) stat(entity).errors.push(reason);
}

function logCreate(entity: string) {
  stat(entity).created++;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function safeStr(val: any): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'object' && val.result !== undefined) return safeStr(val.result);
  if (typeof val === 'object' && val.error !== undefined) return ''; // #REF! etc.
  return String(val).trim();
}

function safeNum(val: any, fallback = 0): number {
  const s = safeStr(val);
  const n = parseFloat(s.replace(/\s/g, '').replace(',', '.'));
  return isNaN(n) ? fallback : n;
}

function safeDate(val: any): Date | null {
  if (!val) return null;
  if (val instanceof Date) return val;
  const s = safeStr(val);
  if (!s) return null;
  // Try DD.MM.YYYY
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return new Date(`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function cleanBin(val: any): string {
  const s = safeStr(val).replace(/\D/g, '');
  return s || '';
}

function genOrderNumber(prefix: string, idx: number): string {
  return `${prefix}-${String(idx).padStart(4, '0')}`;
}

// Formula implementations (mirror of formulas.service.ts)
function calcBalanceDue(qty: number, unitPrice: number, vatRate: number, prepayment: number, post1: number, post2: number, penalty: number): number {
  const lineTotalVat = qty * unitPrice * (1 + vatRate);
  return Math.max(0, lineTotalVat - prepayment - post1 - post2 - penalty);
}

// ─── Excel reader ──────────────────────────────────────────────────────────────
async function openWorkbook(xlsxPath: string): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  return wb;
}

function getSheet(wb: ExcelJS.Workbook, name: string): ExcelJS.Worksheet | null {
  const ws = wb.getWorksheet(name);
  if (!ws) {
    console.warn(`  ⚠ Sheet not found: "${name}"`);
    return null;
  }
  return ws;
}

function rowToObj(row: ExcelJS.Row, headers: string[]): Record<string, any> {
  const obj: Record<string, any> = {};
  headers.forEach((h, i) => {
    obj[h] = row.getCell(i + 1).value;
  });
  return obj;
}

// ─── STEP 0: SYSTEM ROLES ─────────────────────────────────────────────────────
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
  { email: 'engineer@avh.kz', password: 'Eng@2025!', roles: ['engineer'] },
  { email: 'procurement@avh.kz', password: 'Proc@2025!', roles: ['procurement'] },
  { email: 'wh_material@avh.kz', password: 'WhM@2025!', roles: ['warehouse_material'] },
  { email: 'wh_fg@avh.kz', password: 'WhFG@2025!', roles: ['warehouse_fg'] },
  { email: 'foreman@avh.kz', password: 'Fore@2025!', roles: ['shop_foreman'] },
  { email: 'accountant@avh.kz', password: 'Acc@2025!', roles: ['accountant'] },
  { email: 'director@avh.kz', password: 'Dir@2025!', roles: ['director'] },
];

async function seedUsers() {
  console.log('\n[Step 0] Seeding system roles and test users...');

  for (const r of SYSTEM_ROLES) {
    await prisma.role.upsert({ where: { code: r.code }, update: {}, create: r });
  }

  const roleMap = new Map<string, string>();
  const roles = await prisma.role.findMany();
  roles.forEach(r => roleMap.set(r.code, r.id));

  for (const u of TEST_USERS) {
    const hash = await bcrypt.hash(u.password, 10);
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: { passwordHash: hash },
      create: { email: u.email, passwordHash: hash },
    });
    // Clear existing roles
    await prisma.userRole.deleteMany({ where: { userId: user.id } });
    for (const roleCode of u.roles) {
      const roleId = roleMap.get(roleCode);
      if (roleId) {
        await prisma.userRole.create({ data: { userId: user.id, roleId } });
      }
    }
    logCreate('users');
  }
  console.log(`  ✓ ${TEST_USERS.length} test users seeded.`);
}

// ─── STEP 1: ARTICLES (sheet "Прайс") ─────────────────────────────────────────
// Map: articleCode -> id
const articleMap = new Map<string, string>();

async function migrateArticles(wb: ExcelJS.Workbook) {
  console.log('\n[Step 1] Migrating Articles from "Прайс" sheet...');
  const ws = getSheet(wb, 'Прайс');
  if (!ws) { logSkip('articles', 'Sheet "Прайс" not found'); return; }

  let rowIdx = 0;
  ws.eachRow((row, rowNumber) => {
    if (rowNumber <= 2) return; // skip headers
    rowIdx++;

    const legacyCode = safeStr(row.getCell(1).value);
    const name = safeStr(row.getCell(2).value);
    const weightKg = safeNum(row.getCell(3).value);
    const series = safeStr(row.getCell(4).value);
    const approvedPrice = safeNum(row.getCell(5).value);
    const palletCapacity = safeNum(row.getCell(6).value);

    if (!name || name.toLowerCase().includes('итого') || name.toLowerCase().includes('наименование')) {
      logSkip('articles', `Row ${rowNumber}: empty name or header row`);
      return;
    }

    // Generate a canonical article code
    const articleCode = legacyCode
      ? `ART-${legacyCode.replace(/[^\w-]/g, '_').toUpperCase().substring(0, 15)}`
      : `ART-ROW${rowNumber}`;

    // Queue for async creation
    articlesToCreate.push({ legacyCode, articleCode, name, weightKg, series, approvedPrice, palletCapacity });
  });
}

const articlesToCreate: Array<{
  legacyCode: string;
  articleCode: string;
  name: string;
  weightKg: number;
  series: string;
  approvedPrice: number;
  palletCapacity: number;
}> = [];

async function flushArticles() {
  for (const art of articlesToCreate) {
    try {
      const existing = await prisma.article.findUnique({ where: { articleCode: art.articleCode } });
      if (existing) {
        articleMap.set(art.articleCode, existing.id);
        articleMap.set(art.legacyCode, existing.id);
        logSkip('articles', `Duplicate articleCode: ${art.articleCode}`);
        continue;
      }
      const created = await prisma.article.create({
        data: {
          articleCode: art.articleCode,
          legacyCode: art.legacyCode || null,
          name: art.name,
          weightKg: art.weightKg,
          series: art.series || null,
          approvedPrice: art.approvedPrice,
          palletCapacity: art.palletCapacity,
          isActive: true,
        },
      });
      articleMap.set(art.articleCode, created.id);
      if (art.legacyCode) articleMap.set(art.legacyCode, created.id);
      logCreate('articles');
    } catch (e: any) {
      logSkip('articles', `Error: ${e.message?.substring(0, 80)}`);
    }
  }
  console.log(`  ✓ Articles: ${stat('articles').created} created, ${stat('articles').skipped} skipped.`);
}

// ─── STEP 2: MATERIALS (sheet "База сырья" / "База сырья (металл)") ────────────
const materialMap = new Map<string, string>(); // materialCode -> id

async function migrateMaterials(wb: ExcelJS.Workbook) {
  console.log('\n[Step 2] Migrating Materials...');

  const sheets = [
    { name: 'База сырья', category: MaterialCategory.HARDWARE },
    { name: 'База сырья (металл)', category: MaterialCategory.METAL },
  ];

  for (const s of sheets) {
    const ws = getSheet(wb, s.name);
    if (!ws) { logSkip('materials', `Sheet "${s.name}" not found`); continue; }

    let codeIdx = 0;
    const rows: ExcelJS.Row[] = [];
    ws.eachRow(row => rows.push(row));

    for (let r = 2; r < rows.length; r++) {
      const row = rows[r];
      const name = safeStr(row.getCell(2).value) || safeStr(row.getCell(1).value);
      if (!name || name.toLowerCase().includes('наименование') || name.toLowerCase().includes('итого')) {
        logSkip('materials', `Row ${r + 1} in "${s.name}": empty/header`);
        continue;
      }

      const unit = safeStr(row.getCell(3).value) || 'шт';
      const purchasePrice = safeNum(row.getCell(4).value);
      const unitWeightKg = safeNum(row.getCell(5).value);
      codeIdx++;
      const materialCode = `MAT-${s.name.includes('металл') ? 'M' : 'H'}-${String(codeIdx).padStart(4, '0')}`;

      try {
        const existing = await prisma.material.findUnique({ where: { materialCode } });
        if (existing) {
          materialMap.set(materialCode, existing.id);
          materialMap.set(name, existing.id);
          logSkip('materials', `Duplicate: ${materialCode}`);
          continue;
        }
        const created = await prisma.material.create({
          data: {
            materialCode,
            category: s.category,
            name,
            unit,
            unitWeightKg,
            purchasePrice,
          },
        });
        materialMap.set(materialCode, created.id);
        materialMap.set(name, created.id);
        logCreate('materials');
      } catch (e: any) {
        logSkip('materials', `Row ${r + 1}: ${e.message?.substring(0, 80)}`);
      }
    }
  }
  console.log(`  ✓ Materials: ${stat('materials').created} created, ${stat('materials').skipped} skipped.`);
}

// ─── STEP 3: BOM ITEMS (sheet "Спецификации 2022") ────────────────────────────
async function migrateBom(wb: ExcelJS.Workbook) {
  console.log('\n[Step 3] Migrating BOM items from "Спецификации 2022"...');
  const ws = getSheet(wb, 'Спецификации 2022');
  if (!ws) { logSkip('bom_items', 'Sheet not found'); return; }

  let currentArticleId: string | null = null;
  let matSeq = 0;

  const rows: ExcelJS.Row[] = [];
  ws.eachRow(row => rows.push(row));

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const c1 = safeStr(row.getCell(1).value);
    const c2 = safeStr(row.getCell(2).value);

    // Detect article header row (col1 = code, col2 = name, no material details)
    if (c1 && articleMap.has(c1)) {
      currentArticleId = articleMap.get(c1)!;
      matSeq = 0;
      continue;
    }

    if (!currentArticleId) continue;

    const materialName = safeStr(row.getCell(2).value) || safeStr(row.getCell(1).value);
    if (!materialName || materialName.toLowerCase().includes('итого')) continue;

    const qtyPerUnit = safeNum(row.getCell(3).value, 0);
    const laborHours = safeNum(row.getCell(4).value, 0);
    const opTypeStr = safeStr(row.getCell(5).value).toUpperCase();

    if (qtyPerUnit <= 0 && laborHours <= 0) {
      logSkip('bom_items', `Row ${r + 1}: zero qty and labor`);
      continue;
    }

    // Match material by name
    let materialId = materialMap.get(materialName);
    if (!materialId) {
      // Try partial match
      for (const [key, id] of materialMap.entries()) {
        if (materialName.includes(key) || key.includes(materialName)) {
          materialId = id;
          break;
        }
      }
    }

    if (!materialId) {
      // Create a placeholder material
      matSeq++;
      const matCode = `MAT-BOM-${String(matSeq).padStart(5, '0')}`;
      try {
        const created = await prisma.material.create({
          data: {
            materialCode: matCode,
            category: MaterialCategory.COMPONENTS,
            name: materialName,
            unit: 'шт',
          },
        });
        materialId = created.id;
        materialMap.set(materialName, materialId);
        logCreate('materials');
      } catch {
        logSkip('bom_items', `Row ${r + 1}: could not create placeholder material "${materialName}"`);
        continue;
      }
    }

    let operationType: OperationType = OperationType.WELDING_ASSEMBLY;
    if (opTypeStr.includes('РЕЗ') || opTypeStr.includes('CUT')) operationType = OperationType.CUTTING;
    else if (opTypeStr.includes('ОБШ') || opTypeStr.includes('CLAD')) operationType = OperationType.CLADDING;
    else if (opTypeStr.includes('ПОК') || opTypeStr.includes('PAINT')) operationType = OperationType.PAINTING;

    try {
      await prisma.bomItem.upsert({
        where: {
          articleId_materialId_operationType: {
            articleId: currentArticleId,
            materialId,
            operationType,
          },
        },
        update: { qtyPerUnit, laborHours },
        create: {
          articleId: currentArticleId,
          materialId,
          qtyPerUnit,
          laborHours,
          operationType,
        },
      });
      logCreate('bom_items');
    } catch (e: any) {
      logSkip('bom_items', `Row ${r + 1}: ${e.message?.substring(0, 80)}`);
    }
  }
  console.log(`  ✓ BOM items: ${stat('bom_items').created} created, ${stat('bom_items').skipped} skipped.`);
}

// ─── STEP 4: CUSTOMERS & ORDERS (sheets "Telecom", "Др проекты") ───────────────
const customerMap = new Map<string, string>(); // binIin or name -> id
let binCounter = 900000000000; // fallback BIN counter for missing BINs

async function getOrCreateCustomer(name: string, binRaw: string, region?: string): Promise<string | null> {
  if (!name.trim()) return null;

  let bin = cleanBin(binRaw);
  if (!bin || bin.length < 9) {
    // Use name-based dedup
    if (customerMap.has(name)) return customerMap.get(name)!;
    // Generate placeholder bin
    bin = String(++binCounter);
    logSkip('customers', `"${name}": missing/invalid BIN — placeholder bin=${bin}`);
  }

  if (customerMap.has(bin)) return customerMap.get(bin)!;
  if (customerMap.has(name)) return customerMap.get(name)!;

  try {
    let cust = await prisma.customer.findUnique({ where: { binIin: bin } });
    if (!cust) {
      cust = await prisma.customer.create({
        data: {
          name,
          binIin: bin,
          region: region || null,
          customerType: CustomerType.OUTSIDE,
        },
      });
      logCreate('customers');
    }
    customerMap.set(bin, cust.id);
    customerMap.set(name, cust.id);
    return cust.id;
  } catch (e: any) {
    logSkip('customers', `"${name}" bin=${bin}: ${e.message?.substring(0, 80)}`);
    return null;
  }
}

async function migrateOrdersFromSheet(wb: ExcelJS.Workbook, sheetName: string, orderPrefix: string) {
  const ws = getSheet(wb, sheetName);
  if (!ws) { logSkip('orders', `Sheet "${sheetName}" not found`); return; }

  console.log(`\n  Processing orders from sheet "${sheetName}"...`);

  // Detect header row - look for keywords
  let headerRow = 1;
  const allRows: ExcelJS.Row[] = [];
  ws.eachRow(row => allRows.push(row));

  // Build column index by scanning first few rows for headers
  const colMap: Record<string, number> = {};
  for (let r = 0; r < Math.min(5, allRows.length); r++) {
    const row = allRows[r];
    for (let c = 1; c <= 30; c++) {
      const cell = safeStr(row.getCell(c).value).toLowerCase();
      if (cell.includes('заказчик') || cell.includes('клиент')) colMap['customer'] = c;
      if (cell.includes('бин') || cell.includes('инн') || cell.includes('iin')) colMap['bin'] = c;
      if (cell.includes('регион')) colMap['region'] = c;
      if (cell.includes('номер') && (cell.includes('заказ') || cell.includes('дог'))) colMap['orderNum'] = c;
      if (cell.includes('артикул') || cell.includes('изделие') || cell.includes('продукция') || cell.includes('наименование')) colMap['article'] = c;
      if (cell.includes('кол') && (cell.includes('во') || cell.includes('-во'))) colMap['qty'] = c;
      if (cell.includes('предопл') || cell.includes('аванс')) colMap['prepay'] = c;
      if (cell.includes('план') && cell.includes('вывоз')) colMap['planned'] = c;
      if (cell.includes('дата') && (cell.includes('отгр') || cell.includes('отправ'))) colMap['shipped'] = c;
      if (cell.includes('статус')) colMap['status'] = c;
      if (cell.includes('акт') || cell.includes('апп')) colMap['act'] = c;
    }
    if (Object.keys(colMap).length > 3) { headerRow = r + 1; break; }
  }

  // Defaults for common structures
  if (!colMap['customer']) colMap['customer'] = 2;
  if (!colMap['article']) colMap['article'] = 4;
  if (!colMap['qty']) colMap['qty'] = 5;

  let orderSeq = 0;
  for (let r = headerRow; r < allRows.length; r++) {
    const row = allRows[r];
    const customerName = safeStr(row.getCell(colMap['customer']).value);
    if (!customerName || customerName.toLowerCase().includes('итого') || customerName.toLowerCase().includes('заказчик')) {
      logSkip('orders', `Row ${r + 1} in "${sheetName}": empty customer`);
      continue;
    }

    const binRaw = colMap['bin'] ? safeStr(row.getCell(colMap['bin']).value) : '';
    const region = colMap['region'] ? safeStr(row.getCell(colMap['region']).value) : '';
    const customerId = await getOrCreateCustomer(customerName, binRaw, region);
    if (!customerId) { logSkip('orders', `Row ${r + 1}: no customer`); continue; }

    orderSeq++;
    const existingOrderNum = colMap['orderNum'] ? safeStr(row.getCell(colMap['orderNum']).value) : '';
    const orderNumber = existingOrderNum
      ? `${orderPrefix}-${existingOrderNum.replace(/[^\w-]/g, '').substring(0, 20)}`
      : genOrderNumber(orderPrefix, orderSeq);

    const articleName = colMap['article'] ? safeStr(row.getCell(colMap['article']).value) : '';
    const qty = safeNum(row.getCell(colMap['qty']).value, 1);
    const prepayment = colMap['prepay'] ? safeNum(row.getCell(colMap['prepay']).value) : 0;
    const plannedDate = colMap['planned'] ? safeDate(row.getCell(colMap['planned']).value) : null;
    const actualShipDate = colMap['shipped'] ? safeDate(row.getCell(colMap['shipped']).value) : null;

    // Determine status from columns
    let status: OrderStatus = OrderStatus.CONFIRMED;
    const statusCell = colMap['status'] ? safeStr(row.getCell(colMap['status']).value).toLowerCase() : '';
    const hasAct = colMap['act'] ? !!safeStr(row.getCell(colMap['act']).value) : false;
    if (actualShipDate || statusCell.includes('отгруж')) status = OrderStatus.SHIPPED;
    if (hasAct && prepayment === 0) status = OrderStatus.CLOSED;
    if (statusCell.includes('отмен') || statusCell.includes('cancel')) status = OrderStatus.CANCELLED;
    if (statusCell.includes('производ')) status = OrderStatus.IN_PRODUCTION;

    // Resolve article
    let articleId: string | undefined;
    for (const [key, id] of articleMap.entries()) {
      if (articleName && (key === articleName || articleName.includes(key) || key.includes(articleName))) {
        articleId = id;
        break;
      }
    }

    try {
      // Check if order number already exists
      const existing = await prisma.order.findUnique({ where: { orderNumber } });
      if (existing) {
        logSkip('orders', `Duplicate orderNumber: ${orderNumber}`);
        continue;
      }

      // Seed-mode: skip state machine, direct upsert
      const order = await prisma.order.create({
        data: {
          orderNumber,
          customerId,
          region: region || null,
          orderType: OrderType.FZ,
          status, // historical status, no validation
          plannedShipmentDate: plannedDate,
          actualShipmentDate: actualShipDate,
          requestDate: plannedDate,
        },
      });
      logCreate('orders');

      // Create order line if we have an article
      if (articleId && qty > 0) {
        const article = await prisma.article.findUnique({ where: { id: articleId } });
        const unitPrice = Number(article?.approvedPrice ?? 0);
        const balanceDue = calcBalanceDue(qty, unitPrice, 0.12, prepayment, 0, 0, 0);

        await prisma.orderLine.create({
          data: {
            orderId: order.id,
            articleId,
            qty,
            unit: 'шт',
            prepayment,
            // Calculated fields will be recalculated by service layer
            // We set unitPrice here as Input-like denormalized value
            unitPrice,
            lineTotalVat: qty * unitPrice * 1.12,
            balanceDue,
          },
        });
        logCreate('order_lines');
      } else {
        logSkip('order_lines', `Order ${orderNumber}: article "${articleName}" not found in articleMap`);
      }
    } catch (e: any) {
      logSkip('orders', `Row ${r + 1} "${orderNumber}": ${e.message?.substring(0, 80)}`);
    }
  }
}

// ─── STEP 5: PAYMENT DOCUMENTS (sheet "19.20-7п") ─────────────────────────────
async function migratePayments(wb: ExcelJS.Workbook) {
  console.log('\n[Step 5] Migrating Payment Documents from "19.20-7п" sheet...');
  const ws = getSheet(wb, '19.20-7п');
  if (!ws) { logSkip('payment_documents', 'Sheet "19.20-7п" not found'); return; }

  const rows: ExcelJS.Row[] = [];
  ws.eachRow(row => rows.push(row));

  let seq = 0;
  for (let r = 2; r < rows.length; r++) {
    const row = rows[r];
    const doNumber = safeStr(row.getCell(1).value);
    const contractorName = safeStr(row.getCell(2).value);
    const doDateRaw = row.getCell(3).value;
    const totalAmount = safeNum(row.getCell(4).value);
    const paidAmount = safeNum(row.getCell(5).value);

    if (!contractorName || !totalAmount) {
      logSkip('payment_documents', `Row ${r + 1}: missing contractor or amount`);
      continue;
    }

    const binRaw = safeStr(row.getCell(6).value);
    const contractorId = await getOrCreateCustomer(contractorName, binRaw);
    if (!contractorId) { logSkip('payment_documents', `Row ${r + 1}: no contractor`); continue; }

    seq++;
    const docNumber = doNumber || `DO-MIGR-${String(seq).padStart(4, '0')}`;
    const doDate = safeDate(doDateRaw);
    const unpaid = Math.max(0, totalAmount - paidAmount);

    try {
      const existing = await prisma.paymentDocument.findUnique({ where: { doNumber: docNumber } });
      if (existing) { logSkip('payment_documents', `Duplicate: ${docNumber}`); continue; }

      const doc = await prisma.paymentDocument.create({
        data: {
          doNumber: docNumber,
          doDate,
          contractorId,
          totalAmount,
          // Calculated fields: paidAmount, unpaidAmount will be kept as loaded for historical accuracy
          paidAmount,
          unpaidAmount: unpaid,
          currency: 'KZT',
          status: unpaid <= 0 ? 'PAID' : paidAmount > 0 ? 'PARTIALLY_PAID' : 'UNPAID',
        },
      });
      logCreate('payment_documents');

      if (paidAmount > 0) {
        await prisma.payment.create({
          data: {
            paymentDocumentId: doc.id,
            amount: paidAmount,
            paymentDate: doDate || new Date(),
          },
        });
        logCreate('payments');
      }
    } catch (e: any) {
      logSkip('payment_documents', `Row ${r + 1}: ${e.message?.substring(0, 80)}`);
    }
  }
  console.log(`  ✓ PaymentDocs: ${stat('payment_documents').created}, Payments: ${stat('payments').created}`);
}

// ─── STEP 6: MATERIAL STOCK MOVEMENTS ─────────────────────────────────────────
async function migrateMaterialMovements(wb: ExcelJS.Workbook) {
  console.log('\n[Step 6] Migrating Material Stock Movements...');
  const sheets = ['Склад ТМЦ (импорт)', 'Склад ТМЦ'];

  for (const sheetName of sheets) {
    const ws = getSheet(wb, sheetName);
    if (!ws) continue;

    const rows: ExcelJS.Row[] = [];
    ws.eachRow(row => rows.push(row));

    for (let r = 2; r < rows.length; r++) {
      const row = rows[r];
      const matName = safeStr(row.getCell(2).value) || safeStr(row.getCell(1).value);
      if (!matName || matName.toLowerCase().includes('наименование')) {
        logSkip('material_movements', `Row ${r + 1}: no material name`);
        continue;
      }

      let materialId = materialMap.get(matName);
      if (!materialId) {
        // Create placeholder
        const code = `MAT-STOCK-${String(r).padStart(5, '0')}`;
        try {
          const m = await prisma.material.create({
            data: { materialCode: code, category: MaterialCategory.COMPONENTS, name: matName, unit: 'шт' },
          });
          materialId = m.id;
          materialMap.set(matName, materialId);
          logCreate('materials');
        } catch {
          logSkip('material_movements', `Row ${r + 1}: can't create placeholder material`);
          continue;
        }
      }

      const qty = safeNum(row.getCell(3).value);
      const unitPrice = safeNum(row.getCell(4).value);
      const moveDateRaw = row.getCell(5).value;
      const moveDate = safeDate(moveDateRaw) || new Date('2025-01-01');
      const typeStr = safeStr(row.getCell(6).value).toUpperCase();
      const movType = typeStr.includes('РАСХ') || typeStr.includes('OUT')
        ? StockMovementType.EXPENSE
        : StockMovementType.RECEIPT;

      if (qty <= 0) { logSkip('material_movements', `Row ${r + 1}: zero qty`); continue; }

      try {
        await prisma.materialStockMovement.create({
          data: {
            itemId: materialId,
            movementType: movType,
            qty,
            unitPrice,
            movementDate: moveDate,
          },
        });
        logCreate('material_movements');

        // Update denormalized stockQty
        const delta = movType === StockMovementType.RECEIPT ? qty : -qty;
        await prisma.material.update({
          where: { id: materialId },
          data: { stockQty: { increment: delta } },
        });
      } catch (e: any) {
        logSkip('material_movements', `Row ${r + 1}: ${e.message?.substring(0, 80)}`);
      }
    }
  }
  console.log(`  ✓ Material movements: ${stat('material_movements').created} created.`);
}

// ─── STEP 7: FINISHED GOODS MOVEMENTS ("Приход ГП") ──────────────────────────
async function migrateFinishedGoodsMovements(wb: ExcelJS.Workbook) {
  console.log('\n[Step 7] Migrating Finished Goods Movements from "Приход ГП"...');
  const ws = getSheet(wb, 'Приход ГП');
  if (!ws) { logSkip('fg_movements', 'Sheet "Приход ГП" not found'); return; }

  const rows: ExcelJS.Row[] = [];
  ws.eachRow(row => rows.push(row));

  for (let r = 2; r < rows.length; r++) {
    const row = rows[r];
    const artName = safeStr(row.getCell(2).value) || safeStr(row.getCell(1).value);
    if (!artName || artName.toLowerCase().includes('наименование') || artName.toLowerCase().includes('артикул')) {
      logSkip('fg_movements', `Row ${r + 1}: no article name`);
      continue;
    }

    let articleId = articleMap.get(artName);
    if (!articleId) {
      for (const [key, id] of articleMap.entries()) {
        if (artName.includes(key) || key.includes(artName)) { articleId = id; break; }
      }
    }

    if (!articleId) { logSkip('fg_movements', `Row ${r + 1}: article "${artName}" not found`); continue; }

    const qty = safeNum(row.getCell(3).value);
    const movDateRaw = row.getCell(4).value;
    const moveDate = safeDate(movDateRaw) || new Date('2025-01-01');
    if (qty <= 0) { logSkip('fg_movements', `Row ${r + 1}: zero qty`); continue; }

    try {
      await prisma.finishedGoodsMovement.create({
        data: {
          itemId: articleId,
          movementType: StockMovementType.RECEIPT,
          qty,
          movementDate: moveDate,
        },
      });
      logCreate('fg_movements');
    } catch (e: any) {
      logSkip('fg_movements', `Row ${r + 1}: ${e.message?.substring(0, 80)}`);
    }
  }
  console.log(`  ✓ FG movements: ${stat('fg_movements').created} created.`);
}

// ─── STEP 8: MIN STOCK LEVELS ("Минимальные остатки") ─────────────────────────
async function migrateMinStockLevels(wb: ExcelJS.Workbook) {
  console.log('\n[Step 8] Migrating Min Stock Levels...');
  const ws = getSheet(wb, 'Минимальные остатки');
  if (!ws) { logSkip('min_stock_levels', 'Sheet not found'); return; }

  const rows: ExcelJS.Row[] = [];
  ws.eachRow(row => rows.push(row));

  for (let r = 2; r < rows.length; r++) {
    const row = rows[r];
    const artCode = safeStr(row.getCell(1).value);
    const artName = safeStr(row.getCell(2).value);
    const targetQty = safeNum(row.getCell(3).value);
    const periodMonths = safeNum(row.getCell(4).value, 0.517);

    let articleId = articleMap.get(artCode) || articleMap.get(artName);
    if (!articleId) { logSkip('min_stock_levels', `Row ${r + 1}: article "${artCode}/${artName}" not found`); continue; }

    try {
      await prisma.minStockLevel.upsert({
        where: { articleId },
        update: { targetQty, periodMonths },
        create: { articleId, targetQty, periodMonths },
      });
      logCreate('min_stock_levels');
    } catch (e: any) {
      logSkip('min_stock_levels', `Row ${r + 1}: ${e.message?.substring(0, 80)}`);
    }
  }
  console.log(`  ✓ Min stock levels: ${stat('min_stock_levels').created} created.`);
}

// ─── STEP 9: RECALC SPEC PRICES ───────────────────────────────────────────────
async function recalcArticleSpecPrices() {
  console.log('\n[Step 9] Recalculating spec_price and lead_time_days for all articles...');

  const articles = await prisma.article.findMany({
    include: { bomItems: { include: { material: true } } },
  });

  let updated = 0;
  for (const article of articles) {
    const specPrice = article.bomItems.reduce((sum, bom) => {
      return sum + Number(bom.qtyPerUnit) * Number(bom.material.purchasePrice);
    }, 0);
    const totalLaborHours = article.bomItems.reduce((sum, bom) => sum + Number(bom.laborHours), 0);
    const leadTimeDays = totalLaborHours > 0 ? Math.ceil(totalLaborHours / 8) : 0;
    const priceDeviationPct = specPrice > 0 && Number(article.approvedPrice) > 0
      ? Number(article.approvedPrice) / specPrice - 1
      : 0;

    if (specPrice > 0 || leadTimeDays > 0) {
      await prisma.article.update({
        where: { id: article.id },
        data: { specPrice, leadTimeDays, priceDeviationPct },
      });
      updated++;
    }
  }
  console.log(`  ✓ Recalculated ${updated} articles.`);
}

// ─── REPORT GENERATOR ─────────────────────────────────────────────────────────
function generateReport(): string {
  const lines: string[] = [
    '# Migration Report',
    `> Generated: ${new Date().toISOString()}`,
    '',
    '## Summary',
    '',
    '| Entity | Created | Skipped | Top Errors |',
    '|---|---|---|---|',
  ];

  for (const [entity, s] of Object.entries(report)) {
    const topErrors = s.errors.slice(0, 3).map(e => e.replace(/\|/g, '\\|')).join('; ');
    lines.push(`| ${entity} | ${s.created} | ${s.skipped} | ${topErrors || '—'} |`);
  }

  lines.push('');
  lines.push('## Test User Credentials');
  lines.push('');
  lines.push('| Email | Password | Role |');
  lines.push('|---|---|---|');
  for (const u of TEST_USERS) {
    lines.push(`| ${u.email} | ${u.password} | ${u.roles.join(', ')} |`);
  }

  lines.push('');
  lines.push('## Detailed Skip Reasons (top 20 per entity)');
  for (const [entity, s] of Object.entries(report)) {
    if (s.errors.length > 0) {
      lines.push(`\n### ${entity}`);
      s.errors.forEach((e, i) => lines.push(`${i + 1}. ${e}`));
    }
  }

  return lines.join('\n');
}

// ─── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  const xlsxPath = path.resolve(__dirname, '..', '..', '2025_План Производства (1).xlsx');
  console.log(`\n====================================================`);
  console.log(`  ETL Migration: ${path.basename(xlsxPath)}`);
  console.log(`====================================================\n`);

  if (!fs.existsSync(xlsxPath)) {
    console.error(`❌ File not found: ${xlsxPath}`);
    console.error('   Place the xlsx file in the project root and retry.');
    process.exit(1);
  }

  console.log('Opening workbook (this may take 10-30s for large files)...');
  const wb = await openWorkbook(xlsxPath);

  const sheetNames = wb.worksheets.map(ws => ws.name);
  console.log(`  Sheets found: ${sheetNames.join(', ')}`);

  // Step 0: Users
  await seedUsers();

  // Step 1: Articles
  await migrateArticles(wb);
  await flushArticles();

  // Step 2: Materials
  await migrateMaterials(wb);

  // Step 3: BOM
  await migrateBom(wb);

  // Step 4: Customers & Orders
  await migrateOrdersFromSheet(wb, 'Telecom', 'TC');
  await migrateOrdersFromSheet(wb, 'Др проекты', 'DP');

  // Step 5: Payment docs
  await migratePayments(wb);

  // Step 6: Material movements
  await migrateMaterialMovements(wb);

  // Step 7: FG movements
  await migrateFinishedGoodsMovements(wb);

  // Step 8: Min stock levels
  await migrateMinStockLevels(wb);

  // Step 9: Recalc
  await recalcArticleSpecPrices();

  // Generate report
  const reportDir = path.resolve(__dirname, '..', '..');
  const reportPath = path.join(reportDir, 'migration_report.md');
  const reportContent = generateReport();
  fs.writeFileSync(reportPath, reportContent, 'utf8');

  console.log('\n====================================================');
  console.log('  Migration COMPLETE!');
  console.log(`  Report saved to: ${reportPath}`);
  console.log('====================================================\n');
  console.log(reportContent);
}

main()
  .catch(e => {
    console.error('\n❌ Migration failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
