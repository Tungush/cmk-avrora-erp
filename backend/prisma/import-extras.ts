/**
 * Довесок к основной выгрузке (27.08.2026): организации холдинга,
 * менеджеры на заказах, акты приёмки-передачи с составом, исторический
 * приход готовой продукции. Отдельный файл, а не правка import-1c-csv.ts —
 * эти данные пришли позже и по другому набору файлов, смешивать риски
 * основного импорта с этим довеском незачем.
 *
 * Запуск:
 *   npx tsx prisma/import-extras.ts --dir "/Users/Tungush/Downloads/Выгрузки"
 */
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const argv = process.argv.slice(2);
const dirArg = argv.indexOf('--dir');
const DIR = dirArg >= 0 ? argv[dirArg + 1] : null;
if (!DIR) { console.error('Укажите --dir <папка с CSV>'); process.exit(1); }

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const clean = text.replace(/^﻿/, '');
  while (i < clean.length) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
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
function readRows(file: string): Record<string, string>[] {
  const raw = parseCsv(fs.readFileSync(path.join(DIR!, file), 'utf8'));
  const header = raw[0];
  return raw.slice(1).map((r) => Object.fromEntries(header.map((h, idx) => [h, r[idx] ?? ''])));
}
function num(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number(raw.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}
function parseRuDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}):(\d{2}))?$/);
  if (!m) return null;
  const [, d, mo, y, h = '0', mi = '0', s = '0'] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}
// «Назначение» в производстве пишет номер без ведущих нулей («Т7АА-415»),
// а «Номер» в заказах — с ними до 6 цифр («Т7АА-000415»)
function padOrderNumber(raw: string): string {
  const m = /^(Т7АА-)(\d+)$/.exec(raw.trim());
  if (!m) return raw.trim();
  return m[1] + m[2].padStart(6, '0');
}

async function main() {
  const report: Record<string, number> = {};

  // ---------- 1. Организации холдинга ----------
  console.log('\n===== ОРГАНИЗАЦИИ =====');
  const orgs = readRows('Организации.csv');
  let orgsCreated = 0;
  for (const o of orgs) {
    const name = o['Наименование']?.trim();
    const bin = o['БИН']?.trim() || null;
    if (!name) continue;
    const existing = bin
      ? await prisma.organization.findUnique({ where: { binIin: bin } })
      : await prisma.organization.findFirst({ where: { name } });
    if (!existing) {
      await prisma.organization.create({ data: { name, binIin: bin } });
      orgsCreated += 1;
    }
  }
  report['Организации: заведено'] = orgsCreated;
  console.log(`Заведено организаций: ${orgsCreated} из ${orgs.length}`);

  // Свои/чужие: контрагент, чей БИН совпал с юрлицом холдинга, — INSIDE.
  // Раньше все 384 заказчика были OUTSIDE, хотя часть из них — сама Аврора
  const holdingBins = new Set(orgs.map((o) => o['БИН']?.trim()).filter(Boolean));
  const customers = await prisma.customer.findMany({ select: { id: true, binIin: true, customerType: true } });
  let markedInside = 0;
  for (const c of customers) {
    if (holdingBins.has(c.binIin) && c.customerType !== 'INSIDE') {
      await prisma.customer.update({ where: { id: c.id }, data: { customerType: 'INSIDE' } });
      markedInside += 1;
    }
  }
  report['Контрагенты: помечено «свои»'] = markedInside;
  console.log(`Отмечено «внутренний» по БИН холдинга: ${markedInside}`);

  // ---------- 2. Сотрудники: только реально связанные с заказами менеджеры ----------
  // 17038 строк без подразделения/должности заводить целиком бессмысленно —
  // это шум. Заводим по факту использования: имя менеджера на заказе есть
  // в справочнике 1С («21652 - Иванов Иван») — сотрудника создаём под этим
  // ФИО и связываем существующие заказы
  console.log('\n===== СОТРУДНИКИ (только менеджеры заказов) =====');
  const empRows = readRows('Сотрудники.csv');
  const empByName = new Map<string, string>(); // ФИО -> табельный номер
  for (const e of empRows) {
    const fio = e['ФИО']?.trim();
    if (fio) empByName.set(fio, e['ТабельныйНомер']?.trim() ?? '');
  }

  const headers = readRows('ЗаказыШапки.csv');
  const managerNameByOrder = new Map<string, string>(); // orderNumber -> ФИО
  for (const h of headers) {
    if (h['Тип'] !== 'Клиенту') continue;
    const m = /^\d+\s*-\s*(.+)$/.exec(h['Менеджер']?.trim() ?? '');
    if (m) managerNameByOrder.set(h['Номер']?.trim(), m[1].trim());
  }

  const employeeIdByName = new Map<string, string>();
  let employeesCreated = 0;
  for (const fio of new Set(managerNameByOrder.values())) {
    let emp = await prisma.employee.findFirst({ where: { name: fio } });
    if (!emp) {
      emp = await prisma.employee.create({ data: { name: fio, role: 'sales_manager' } });
      employeesCreated += 1;
    }
    employeeIdByName.set(fio, emp.id);
  }
  report['Сотрудники: заведено (менеджеры)'] = employeesCreated;
  console.log(`Заведено сотрудников-менеджеров: ${employeesCreated}, найдено в 1С по имени: ${empByName.size ? [...managerNameByOrder.values()].filter((n) => empByName.has(n)).length : 0} из ${new Set(managerNameByOrder.values()).size}`);

  let ordersLinked = 0;
  const allOrders = await prisma.order.findMany({ select: { id: true, orderNumber: true, managerId: true } });
  const orderByNumber = new Map(allOrders.map((o) => [o.orderNumber, o]));
  for (const [orderNum, fio] of managerNameByOrder) {
    const order = orderByNumber.get(orderNum);
    const empId = employeeIdByName.get(fio);
    if (!order || !empId || order.managerId) continue;
    await prisma.order.update({ where: { id: order.id }, data: { managerId: empId } });
    ordersLinked += 1;
  }
  report['Заказы: привязан менеджер'] = ordersLinked;
  console.log(`Заказов со связанным менеджером: ${ordersLinked}`);

  // ---------- 3. Акты приёмки-передачи («Реализации») ----------
  // ВАЖНО: «Номер» — не уникальный ключ документа. Серия 1С сбрасывается
  // по годам (тот же дефект, что и в заказах): «Т7АА-000032» встретился
  // дважды с РАЗНЫМ БИН и датами в пять месяцев друг от друга — это два
  // независимых документа, а не один акт на два заказа. Различить их можно
  // только по НомерЗаказа: у каждого физического документа он свой, и он
  // же (без пропусков) стоит у каждой его строки состава. Проверено:
  // сумма строк с этим НомерЗаказа сходится с СуммаДокумента до тенге.
  console.log('\n===== АКТЫ ПРИЁМКИ-ПЕРЕДАЧИ =====');
  const actHeaders = readRows('Реализации.csv');
  const actLines = readRows('РеализацииСтроки.csv');
  const docKey = (rawNumber: string, orderNum: string) => `${rawNumber}::${orderNum}`;
  const linesByDoc = new Map<string, typeof actLines>();
  for (const l of actLines) {
    const num = l['НомерДокумента']?.trim();
    const ord = l['НомерЗаказа']?.trim();
    if (!num) continue;
    const k = docKey(num, ord);
    (linesByDoc.get(k) ?? linesByDoc.set(k, []).get(k)!).push(l);
  }

  // Контрагент акта опознаётся по БИН — тем же справочником, что заказы
  const custByBin = new Map<string, string>();
  for (const c of await prisma.customer.findMany({ select: { id: true, binIin: true } })) {
    custByBin.set(c.binIin, c.id);
  }
  const artByCode = new Map<string, string>();
  for (const a of await prisma.article.findMany({ select: { id: true, articleCode: true } })) {
    artByCode.set(a.articleCode, a.id);
  }
  // GUID -> код артикула, из полного справочника номенклатуры
  const nomRows = fs.existsSync(path.join(DIR!, 'Номенклатура.csv')) ? readRows('Номенклатура.csv') : [];
  const articleCodeByGuid = new Map<string, string>();
  for (const n of nomRows) {
    const guid = n['GUID']?.trim();
    const code = n['Артикул']?.trim();
    if (guid && code) articleCodeByGuid.set(guid, code);
  }

  let actsCreated = 0;
  let actsSkippedNoCustomer = 0;
  let actLinesCreated = 0;
  for (const h of actHeaders) {
    const rawNumber = h['Номер']?.trim();
    const actDate = parseRuDate(h['Дата']);
    const bin = h['БИН']?.trim();
    const hOrderNum = h['НомерЗаказа']?.trim();
    if (!rawNumber || !actDate || !bin) continue;

    // Уникальный номер акта в базе — «Номер» плюс заказ, когда заказ
    // известен: это и разводит коллизию серии, и не плодит фиктивный
    // суффикс там, где документ один и коллизии нет вовсе
    const appNumber = hOrderNum ? `${rawNumber}-${hOrderNum}` : rawNumber;
    const existing = await prisma.acceptanceAct.findUnique({ where: { appNumber } });
    if (existing) continue;

    let customerId = custByBin.get(bin);
    if (!customerId) {
      // Контрагент акта не встречался среди заказчиков — заводим по БИН,
      // иначе акт пришлось бы отбросить, а сумма реальна
      const created = await prisma.customer.create({
        data: { name: h['Контрагент']?.trim() || bin, binIin: bin },
      });
      customerId = created.id;
      custByBin.set(bin, created.id);
    }

    const orderNumber = hOrderNum ? padOrderNumber(hOrderNum) : null;
    const order = orderNumber ? orderByNumber.get(orderNumber) : null;

    const managerFio = /^\d+\s*-\s*(.+)$/.exec(h['Менеджер']?.trim() ?? '')?.[1]?.trim() ?? null;
    const managerId = managerFio ? employeeIdByName.get(managerFio) ?? null : null;

    const act = await prisma.acceptanceAct.create({
      data: {
        appNumber,
        customerId,
        orderId: order?.id ?? null,
        actDate,
        totalAmount: num(h['СуммаДокумента']),
        warehouse: h['Склад']?.trim() || null,
        division: h['Подразделение']?.trim() || null,
        businessDirection: h['НаправлениеДеятельности']?.trim() || null,
        managerName: managerFio,
        managerId,
        status: h['СтатусДокумента']?.trim() || null,
        isPosted: h['Проведён']?.trim() === 'Да',
        rawColumns: h as any,
      },
    });
    actsCreated += 1;

    const lines = linesByDoc.get(docKey(rawNumber, hOrderNum)) ?? [];
    for (const l of lines) {
      const guid = l['GUIDНоменклатуры']?.trim();
      const code = guid ? articleCodeByGuid.get(guid) : null;
      const articleId = code ? artByCode.get(code) ?? null : null;
      await prisma.acceptanceActLine.create({
        data: {
          actId: act.id,
          lineNo: Number(l['НомерСтроки']) || 1,
          itemName: l['Номенклатура']?.trim() || '—',
          articleId,
          qty: num(l['Количество']) || null,
          unitPrice: num(l['Цена']) || null,
          amount: num(l['Сумма']) || null,
          vatRate: l['СтавкаНДС']?.trim() || null,
          orderNumber: l['НомерЗаказа']?.trim() ? padOrderNumber(l['НомерЗаказа']) : null,
        },
      });
      actLinesCreated += 1;
    }
  }
  report['Акты: заведено'] = actsCreated;
  report['Акты: пропущено (нет БИН/даты)'] = actHeaders.length - actsCreated;
  report['Строк актов: заведено'] = actLinesCreated;
  console.log(`Заведено актов: ${actsCreated} из ${actHeaders.length}, строк: ${actLinesCreated}`);

  // ---------- 4. Исторический приход ГП («Производство без заказа») ----------
  console.log('\n===== ПРИХОД ГОТОВОЙ ПРОДУКЦИИ (историческая заливка) =====');
  const releaseHeaders = readRows('ВыпускГПШапки.csv');
  const releaseLines = readRows('ВыпускГПСтроки.csv');
  const relLinesByDoc = new Map<string, typeof releaseLines>();
  for (const l of releaseLines) {
    const k = l['НомерДокумента']?.trim();
    if (!k) continue;
    (relLinesByDoc.get(k) ?? relLinesByDoc.set(k, []).get(k)!).push(l);
  }

  // Поле под номер документа отдельного нет — используем project (VarChar,
  // свободный текст), с префиксом, чтобы не спутать с проектами заказов
  const docTag = (docNum: string) => `1С-выпуск:${docNum}`;
  const existingMovementDocs = new Set(
    (await prisma.finishedGoodsMovement.findMany({ where: { project: { startsWith: '1С-выпуск:' } }, select: { project: true } }))
      .map((m) => m.project).filter(Boolean),
  );

  let fgCreated = 0;
  let fgSkippedNoArticle = 0;
  for (const h of releaseHeaders) {
    const docNum = h['Номер']?.trim();
    const when = parseRuDate(h['Дата']);
    if (!docNum || !when || existingMovementDocs.has(docTag(docNum))) continue;
    const lines = relLinesByDoc.get(docNum) ?? [];
    for (const l of lines) {
      const guid = l['GUIDНоменклатуры']?.trim();
      const code = guid ? articleCodeByGuid.get(guid) : null;
      const articleId = code ? artByCode.get(code) : null;
      const qty = num(l['Количество']);
      if (!articleId || !(qty > 0)) { fgSkippedNoArticle += 1; continue; }
      const orderNumRaw = l['НомерЗаказа']?.trim();
      const order = orderNumRaw ? orderByNumber.get(padOrderNumber(orderNumRaw)) : null;
      await prisma.finishedGoodsMovement.create({
        data: {
          itemId: articleId,
          qty,
          movementType: 'FROM_PRODUCTION',
          movementDate: when,
          orderId: order?.id ?? null,
          project: docTag(docNum),
        },
      });
      fgCreated += 1;
    }
  }
  report['Приход ГП: заведено движений'] = fgCreated;
  report['Приход ГП: пропущено (нет артикула/кол-ва)'] = fgSkippedNoArticle;
  console.log(`Заведено движений ГП: ${fgCreated}, пропущено: ${fgSkippedNoArticle}`);

  // ---------- 5. Склады 1С ----------
  console.log('\n===== СКЛАДЫ =====');
  const whRows = fs.existsSync(path.join(DIR!, 'Склады.csv')) ? readRows('Склады.csv') : [];
  let whCreated = 0;
  for (const w of whRows) {
    const code = w['Наименование']?.trim();
    if (!code) continue;
    const existing = await prisma.warehouse.findUnique({ where: { code } });
    if (existing) continue;
    await prisma.warehouse.create({
      data: {
        code,
        name: code,
        warehouseType: w['ТипСклада']?.trim() || null,
        division: w['Подразделение']?.trim() || null,
        site: w['Площадка']?.trim() || null,
        isDeleted: w['ПометкаУдаления']?.trim() === 'Да',
      },
    });
    whCreated += 1;
  }
  report['Склады: заведено'] = whCreated;
  console.log(`Заведено складов: ${whCreated} из ${whRows.length}`);

  // ---------- 6. Движения сырья между складами (без цены — только объём) ----------
  console.log('\n===== ДВИЖЕНИЯ СЫРЬЯ =====');
  const moveRows = fs.existsSync(path.join(DIR!, 'ДвиженияСырья.csv')) ? readRows('ДвиженияСырья.csv') : [];
  const materials = await prisma.material.findMany({ select: { id: true, materialCode: true } });
  const materialByGuid = new Map<string, string>(); // GUID -> materialId, через код артикула номенклатуры
  const materialCodeByArticleCode = new Map(materials.map((m) => [m.materialCode, m.id]));
  for (const n of nomRows) {
    const guid = n['GUID']?.trim();
    const code = n['Артикул']?.trim();
    if (guid && code && materialCodeByArticleCode.has(code)) {
      materialByGuid.set(guid, materialCodeByArticleCode.get(code)!);
    }
  }
  const existingMoveDocs = new Set(
    (await prisma.materialStockMovement.findMany({ where: { project: { startsWith: '1С-перемещение:' } }, select: { project: true } }))
      .map((m) => m.project).filter(Boolean),
  );
  const moveTag = (docNum: string) => `1С-перемещение:${docNum}`;
  let movesCreated = 0;
  let movesSkippedNoMaterial = 0;
  for (const m of moveRows) {
    const docNum = m['Номер']?.trim();
    const when = parseRuDate(m['Дата']);
    if (!docNum || !when || existingMoveDocs.has(moveTag(docNum))) continue;
    const guid = m['GUIDНоменклатуры']?.trim();
    const materialId = guid ? materialByGuid.get(guid) : null;
    const qty = num(m['Количество']);
    if (!materialId || !(qty > 0)) { movesSkippedNoMaterial += 1; continue; }
    // Нет цены в отчёте — движение только по объёму, себестоимость не двигает.
    // Куда важнее сам факт: сырьё физически ушло со склада на склад/в цех
    await prisma.materialStockMovement.create({
      data: {
        itemId: materialId,
        movementType: 'TO_PRODUCTION',
        qty,
        unitPrice: 0,
        movementDate: when,
        project: moveTag(docNum),
        supplierName: [m['СкладОтправитель']?.trim(), m['СкладПолучатель']?.trim()]
          .filter(Boolean).join(' → ') || null,
      },
    });
    movesCreated += 1;
  }
  report['Движения сырья: заведено'] = movesCreated;
  report['Движения сырья: пропущено (материал не опознан)'] = movesSkippedNoMaterial;
  console.log(`Заведено движений сырья: ${movesCreated}, пропущено: ${movesSkippedNoMaterial}`);

  // ---------- 7. Оплаты от клиентов с точной привязкой к заказу ----------
  // Раньше onecPaidAmount ставился по нечёткому совпадению короткого номера
  // документа + ближайшей даты (resolveOrderId в import-1c-csv.ts) — здесь
  // номер заказа указан прямым текстом («Заказ клиента Т7АА-002040 от …»),
  // это точнее и перебивает нечёткое совпадение там, где оно есть
  console.log('\n===== ОПЛАТЫ ОТ КЛИЕНТОВ (точная привязка) =====');
  const incomeRows = fs.existsSync(path.join(DIR!, 'ОплатыПриход.csv')) ? readRows('ОплатыПриход.csv') : [];
  const orderRefPattern = /Заказ клиента\s+(\S+АА-\d+)\s+от/;
  const paidByOrder = new Map<string, number>();
  let incomeMatched = 0;
  let incomeUnmatched = 0;
  for (const r of incomeRows) {
    const m = orderRefPattern.exec(r['Заказ'] ?? '');
    if (!m) { incomeUnmatched += 1; continue; }
    const orderNum = padOrderNumber(m[1]);
    const order = orderByNumber.get(orderNum);
    if (!order) { incomeUnmatched += 1; continue; }
    paidByOrder.set(order.id, (paidByOrder.get(order.id) ?? 0) + num(r['Сумма']));
    incomeMatched += 1;
  }
  let ordersPaidUpdated = 0;
  for (const [orderId, paid] of paidByOrder) {
    await prisma.order.update({ where: { id: orderId }, data: { onecPaidAmount: paid } });
    ordersPaidUpdated += 1;
  }
  report['Оплаты клиентов: строк с точным заказом'] = incomeMatched;
  report['Оплаты клиентов: не привязано'] = incomeUnmatched;
  report['Заказы: обновлена сумма оплаты'] = ordersPaidUpdated;
  console.log(`Привязано платежей: ${incomeMatched} из ${incomeRows.length}, обновлено заказов: ${ordersPaidUpdated}`);

  console.log('\n===== ИТОГ =====');
  for (const [k, v] of Object.entries(report)) console.log(`  ${k}: ${v}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
