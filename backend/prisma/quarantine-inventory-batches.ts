/**
 * Карантин цен задним числом для партий стартового остатка (25.08.2026).
 *
 * Найдено аудитом: «Остатки.csv» создавал партии (BatchOrigin.INVENTORY)
 * напрямую через prisma.materialBatch.create — в обход material-receipt
 * .service, где обычно и запускается проверка isPriceAnomaly. В результате
 * 520 материалов (в основном длинномерный прокат — трубы, швеллеры, уголки)
 * получили партии с ценой, отличающейся от учётной в 10–3700 раз —
 * похоже на перепутанные единицы (тонны/кг из 1С вместо метров ERP) —
 * и ни одна не попала в карантин: экран «Партии и резервы» показывал
 * старые 11 записей и ни одной из сегодняшних.
 *
 * Это НЕ чинит данные — карантин только помечает партию, чтобы её не
 * использовал автоподбор FIFO и чтобы снабжение её увидело и подтвердило
 * или поправило цену. Сами частоты/единицы измерения остаются на решение
 * снабжения — так же, как при обычном приходе из 1С.
 *
 * Запуск: npm run quarantine:inventory-batches [-- --dry-run]
 */
import { PrismaClient } from '@prisma/client';
import { isPriceAnomaly, anomalyFactor } from '../src/common/material-batches';

const ANOMALY_THRESHOLD = 5;
const dryRun = process.argv.includes('--dry-run');

async function main() {
  const prisma = new PrismaClient();
  try {
    const batches = await prisma.materialBatch.findMany({
      where: { origin: 'INVENTORY', unitPrice: { gt: 0 } },
      select: {
        id: true, materialId: true, unitPrice: true, priceAnomaly: true,
        material: { select: { materialCode: true, name: true, purchasePrice: true } },
      },
    });

    let flagged = 0, checked = 0, noReference = 0;
    const examples: string[] = [];

    for (const b of batches) {
      const ref = Number(b.material.purchasePrice);
      if (ref <= 0) { noReference += 1; continue; }
      checked += 1;
      const price = Number(b.unitPrice);
      const anomaly = isPriceAnomaly(price, [ref], ANOMALY_THRESHOLD);
      if (!anomaly || b.priceAnomaly) continue;
      flagged += 1;
      const factor = anomalyFactor(price, [ref]);
      if (examples.length < 15) {
        examples.push(`  · ${b.material.materialCode} ${b.material.name} — партия ${price} ₸, учётная ${ref} ₸ (×${factor})`);
      }
      if (!dryRun) {
        await prisma.materialBatch.update({
          where: { id: b.id },
          data: { priceAnomaly: true, anomalyFactor: factor },
        });
      }
    }

    console.log(`Партий INVENTORY с ценой: ${batches.length}`);
    console.log(`Без учётной цены материала для сравнения (пропущено): ${noReference}`);
    console.log(`Проверено против учётной цены: ${checked}`);
    console.log(`${dryRun ? 'Помечено бы' : 'Помечено'} в карантин: ${flagged}`);
    if (examples.length) {
      console.log('\nПримеры:');
      examples.forEach((e) => console.log(e));
    }
    if (dryRun) console.log('\n--dry-run: запись в базу пропущена.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
