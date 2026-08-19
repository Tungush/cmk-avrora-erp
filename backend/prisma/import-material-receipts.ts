/**
 * Импорт приходов металла из листа «База сырья (металл)».
 *
 * Лист — это журнал закупа: заявка → что заказали → почём → сколько пришло.
 * Колонки: [1] Дата заявки, [2] Номер заявки, [4] Товар и услуги,
 *          [5] Кол-во заяв, [6] Ед. изм, [7] Цена, [8] Кол-во прих, [10] Дата прих.
 *
 * Металл в исходнике не имеет артикулов (в отличие от «Базы сырья»),
 * поэтому номенклатура заводится по наименованию с кодом MET-NNN.
 * Учётная цена материала — средневзвешенная по всем приходам: именно она
 * идёт в себестоимость при сборке спецификации.
 *
 * Запуск: npm run migrate:receipts
 */
import { PrismaClient, MaterialCategory } from '@prisma/client';

const prisma = new PrismaClient();

const num = (v: unknown): number => {
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

const str = (v: unknown): string => (v == null ? '' : String(v).trim());

/** В листе даты вперемешку: ISO и «18.сен» — берём только распознаваемые */
function parseDate(v: unknown): Date | null {
  const raw = str(v);
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

async function main() {
  const sheet = await prisma.spreadsheetSheet.findFirst({ where: { name: 'База сырья (металл)' } });
  if (!sheet) throw new Error('Лист «База сырья (металл)» не найден — сначала npm run migrate:full');

  const rows = await prisma.spreadsheetRow.findMany({
    where: { sheetId: sheet.id, rowNumber: { gte: 2 } },
    orderBy: { rowNumber: 'asc' },
  });
  console.log(`Строк листа: ${rows.length}`);

  // Существующая номенклатура — ищем по имени, но только при совпадении единицы:
  // в листе металла закуп идёт в тоннах, а на складе та же позиция может
  // числиться в метрах. Сопоставить их без веса погонного метра нельзя,
  // а перезапись цены «тонна вместо метра» ломает всю себестоимость.
  const materials = await prisma.material.findMany({ select: { id: true, materialCode: true, name: true, unit: true } });
  const materialByNameUnit = new Map(
    materials.map((m) => [`${m.name.trim().toLowerCase()}|${m.unit.trim().toLowerCase()}`, m.id]),
  );
  let metalSeq = materials.filter((m) => m.materialCode.startsWith('MET-')).length;

  // Уже импортированные приходы — чтобы повторный запуск не задвоил
  const existing = await prisma.materialStockMovement.findMany({
    where: { movementType: 'RECEIPT', documentNumber: { not: null } },
    select: { itemId: true, documentNumber: true, qty: true },
  });
  const seen = new Set(existing.map((e) => `${e.itemId}|${e.documentNumber}|${Number(e.qty)}`));

  let materialsCreated = 0;
  let receipts = 0;
  let skipped = 0;
  // materialId → накопленные приход/сумма для средневзвешенной цены
  const totals = new Map<string, { qty: number; amount: number; lastPrice: number; lastDate: Date | null }>();

  for (const row of rows) {
    const c = row.cells as unknown[];
    const name = str(c[4]);
    const qty = num(c[8]) || num(c[5]); // пришло; если не заполнено — заявлено
    const price = num(c[7]);
    if (!name || qty <= 0) { skipped++; continue; }

    const unit = str(c[6]).slice(0, 10) || 'тн';
    let materialId = materialByNameUnit.get(`${name.toLowerCase()}|${unit.toLowerCase()}`);
    if (!materialId) {
      metalSeq += 1;
      const created = await prisma.material.create({
        data: {
          materialCode: `MET-${String(metalSeq).padStart(3, '0')}`,
          category: MaterialCategory.METAL,
          name,
          unit,
          purchasePrice: price,
        },
      });
      materialId = created.id;
      materialByNameUnit.set(`${name.toLowerCase()}|${unit.toLowerCase()}`, created.id);
      materialsCreated++;
    }

    const docNumber = str(c[2]).slice(0, 50) || null;
    const key = `${materialId}|${docNumber}|${qty}`;
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);

    const movementDate = parseDate(c[10]) ?? parseDate(c[1]) ?? new Date();
    await prisma.materialStockMovement.create({
      data: {
        itemId: materialId,
        movementType: 'RECEIPT',
        qty,
        unitPrice: price,
        movementDate,
        documentNumber: docNumber,
        comment: str(c[3]) || null,
      },
    });
    receipts++;

    const t = totals.get(materialId) ?? { qty: 0, amount: 0, lastPrice: 0, lastDate: null };
    t.qty += qty;
    t.amount += qty * price;
    if (price > 0 && (!t.lastDate || movementDate >= t.lastDate)) {
      t.lastPrice = price;
      t.lastDate = movementDate;
    }
    totals.set(materialId, t);
  }

  // Учётная цена = средневзвешенная по приходам; отдельно — цена последнего закупа
  for (const [materialId, t] of totals) {
    if (t.qty <= 0) continue;
    const avg = t.amount > 0 ? Math.round((t.amount / t.qty) * 100) / 100 : 0;
    await prisma.material.update({
      where: { id: materialId },
      data: {
        stockQty: { increment: t.qty },
        ...(avg > 0 ? { purchasePrice: avg, purchasePriceUpdatedAt: t.lastDate ?? undefined } : {}),
        ...(t.lastPrice > 0 ? { lastPurchasePrice: t.lastPrice, lastPurchaseDate: t.lastDate ?? undefined } : {}),
      },
    });
  }

  console.log('\n| Метрика | Значение |');
  console.log('|---|---|');
  console.log(`| Приходов создано | ${receipts} |`);
  console.log(`| Номенклатуры металла заведено | ${materialsCreated} |`);
  console.log(`| Материалов с обновлённой ценой | ${totals.size} |`);
  console.log(`| Пропущено строк | ${skipped} |`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
