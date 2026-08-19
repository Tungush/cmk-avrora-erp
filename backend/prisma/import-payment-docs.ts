/**
 * Импорт договоров-оснований (ДО) из листа «19.20-7п» в payment_documents.
 *
 * Источник — spreadsheet_rows (полная копия листа уже в БД после migrate:full).
 * Колонки листа: [1] № ДО, [2] Дата ДО, [8] Заказчик, [9] Поставщик,
 * [11] Валюта, [12] Общая стоимость, [13] Оплачено 1С, [14] Не оплачено 1С,
 * [15] Категория, [16] Заказ на продажу (П-NNNNN-YY), [18] ИИН/БИН,
 * [21] Статус оплаты.
 *
 * Поставщики заводятся в customers (реестр контрагентов) по БИН.
 * Запуск: npm run migrate:payment-docs
 */
import { PrismaClient, PaymentDocStatus } from '@prisma/client';

const prisma = new PrismaClient();

const STATUS_MAP: Record<string, PaymentDocStatus> = {
  'Оплачено': PaymentDocStatus.PAID,
  'Частично оплачен': PaymentDocStatus.PARTIALLY_PAID,
  'Частично оплачено': PaymentDocStatus.PARTIALLY_PAID,
  'Не оплачен': PaymentDocStatus.UNPAID,
  'Не оплачено': PaymentDocStatus.UNPAID,
  'Исполнен': PaymentDocStatus.EXECUTED,
};

const num = (v: unknown): number => {
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

/** Псевдо-БИН для поставщиков без ИИН/БИН — детерминированный, ≤ 20 символов */
function pseudoBin(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `SUP-${h.toString(36).toUpperCase()}`;
}

async function main() {
  const sheet = await prisma.spreadsheetSheet.findFirst({ where: { name: '19.20-7п' } });
  if (!sheet) throw new Error('Лист «19.20-7п» не найден — сначала npm run migrate:full');

  const rows = await prisma.spreadsheetRow.findMany({
    where: { sheetId: sheet.id, rowNumber: { gte: 3 } },
    orderBy: { rowNumber: 'asc' },
  });
  console.log(`Строк листа: ${rows.length}`);

  // Существующие заказы: № → id (привязка «Заказ на продажу»)
  const orders = await prisma.order.findMany({ select: { id: true, orderNumber: true } });
  const orderByNumber = new Map(orders.map((o) => [o.orderNumber, o.id]));

  // Контрагенты по БИН и по имени
  const customers = await prisma.customer.findMany({ select: { id: true, binIin: true, name: true } });
  const customerByBin = new Map(customers.map((c) => [c.binIin, c.id]));
  const customerByName = new Map(customers.map((c) => [c.name.trim().toLowerCase(), c.id]));

  let created = 0;
  let skipped = 0;
  let suppliersCreated = 0;
  let linkedToOrders = 0;

  for (const row of rows) {
    const cells = row.cells as unknown[];
    const doNumber = String(cells[1] ?? '').trim().slice(0, 30);
    const total = num(cells[12]);
    if (!doNumber || total <= 0) { skipped++; continue; }

    const supplierName = String(cells[9] ?? '').trim() || 'Поставщик не указан';
    const bin = String(cells[18] ?? '').trim().slice(0, 20) || pseudoBin(supplierName);

    // Поставщик — контрагент в customers; сначала по БИН, затем по имени
    let contractorId = customerByBin.get(bin) ?? customerByName.get(supplierName.toLowerCase());
    if (!contractorId) {
      try {
        const c = await prisma.customer.create({
          data: { name: supplierName, binIin: bin, customerType: 'OUTSIDE' },
        });
        contractorId = c.id;
        customerByBin.set(bin, c.id);
        customerByName.set(supplierName.toLowerCase(), c.id);
        suppliersCreated++;
      } catch {
        skipped++;
        continue;
      }
    }

    const paid = num(cells[13]);
    const unpaidRaw = num(cells[14]);
    const unpaid = unpaidRaw > 0 ? unpaidRaw : Math.max(0, total - paid);

    const orderNum = String(cells[16] ?? '').trim();
    const orderId = orderByNumber.get(orderNum) ?? null;
    if (orderId) linkedToOrders++;

    const doDateRaw = cells[2] ? new Date(String(cells[2])) : null;
    const currency = (String(cells[11] ?? 'KZT').trim().toUpperCase() || 'KZT').slice(0, 3);

    try {
      await prisma.paymentDocument.create({
        data: {
          doNumber,
          doDate: doDateRaw && !isNaN(doDateRaw.getTime()) ? doDateRaw : null,
          contractorId,
          currency,
          totalAmount: total,
          paidAmount: paid,
          unpaidAmount: unpaid,
          category: String(cells[15] ?? '').trim().slice(0, 30) || null,
          status: STATUS_MAP[String(cells[21] ?? '').trim()] ?? PaymentDocStatus.UNPAID,
          orderId,
        },
      });
      created++;
    } catch (e: any) {
      // дубликат № ДО (повторный запуск) — пропускаем
      if (e?.code === 'P2002') { skipped++; continue; }
      throw e;
    }
  }

  console.log('\n| Метрика | Значение |');
  console.log('|---|---|');
  console.log(`| Создано ДО | ${created} |`);
  console.log(`| Пропущено | ${skipped} |`);
  console.log(`| Новых поставщиков | ${suppliersCreated} |`);
  console.log(`| Привязано к заказам | ${linkedToOrders} |`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
