/**
 * Разовая чистка задвоенных позиций заказов (26.08.2026).
 *
 * Импорт 1С создавал строки заказа без дедупликации, поэтому второй прогон
 * по той же выгрузке удвоил каждую позицию: в базе 3626 строк вместо 1812
 * из «ЗаказыСтроки.csv». Удвоены количества, суммы и всё, что считается от
 * них — себестоимость, маржа, потребность в сырье, очередь цеха.
 *
 * Сам импорт починен (позиции затронутых заказов теперь сносятся перед
 * загрузкой), этот скрипт приводит в порядок уже накопленное.
 *
 * Что делает: в каждой группе одинаковых строк одного заказа
 * (изделие + количество + цена + название из 1С) с ЧЁТНЫМ числом копий
 * оставляет первую половину. Нечётные группы не трогает вовсе — это не
 * след повторного прогона, там нужен человек.
 *
 *   npx tsx prisma/dedupe-order-lines.ts            # показать, что будет удалено
 *   npx tsx prisma/dedupe-order-lines.ts --apply    # удалить
 *
 * Откат: backups/order-lines-before-dedup.json — полный слепок таблицы
 * до чистки (3626 строк).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.slice(2).includes('--apply');

async function main() {
  const before = await prisma.orderLine.count();

  const groups: Array<{ cnt: bigint; groups: bigint }> = await prisma.$queryRawUnsafe(`
    SELECT cnt, count(*) AS groups FROM (
      SELECT order_id, article_id, qty, unit_price, coalesce(product_name_raw,'') AS nm, count(*) AS cnt
      FROM order_lines GROUP BY 1,2,3,4,5
    ) g GROUP BY cnt ORDER BY cnt`);

  console.log(`Строк заказов сейчас: ${before}`);
  console.log('Копий в группе → сколько таких групп:');
  for (const g of groups) console.log(`  ${Number(g.cnt)} → ${Number(g.groups)}`);

  const doomed: Array<{ id: string }> = await prisma.$queryRawUnsafe(`
    WITH g AS (
      SELECT id,
             row_number() OVER (
               PARTITION BY order_id, article_id, qty, unit_price, coalesce(product_name_raw,'')
               ORDER BY id) AS rn,
             count(*) OVER (
               PARTITION BY order_id, article_id, qty, unit_price, coalesce(product_name_raw,'')) AS cnt
      FROM order_lines
    )
    SELECT id FROM g WHERE cnt % 2 = 0 AND rn > cnt / 2`);

  console.log(`\nК удалению: ${doomed.length} строк, останется ${before - doomed.length}`);

  // Заказы, которые чистка НЕ выравнивает: там дубли нечётные, руками
  const odd: Array<{ order_number: string; cnt: bigint }> = await prisma.$queryRawUnsafe(`
    SELECT o.order_number, g.cnt FROM (
      SELECT order_id, count(*) AS cnt
      FROM order_lines GROUP BY order_id, article_id, qty, unit_price, coalesce(product_name_raw,'')
      HAVING count(*) % 2 = 1 AND count(*) > 1
    ) g JOIN orders o ON o.id = g.order_id`);
  if (odd.length > 0) {
    console.log('\nНечётные повторы — оставлены как есть, посмотреть глазами:');
    for (const r of odd) console.log(`  ${r.order_number}: ${Number(r.cnt)} копий`);
  }

  if (!APPLY) {
    console.log('\nЭто примерка. Запустить удаление: npx tsx prisma/dedupe-order-lines.ts --apply');
    return;
  }

  // Отметки цеха ссылаются на строки — снимаем те, что указывают на удаляемые,
  // иначе внешний ключ уронит транзакцию посреди чистки
  const ids = doomed.map((d) => d.id);
  const CHUNK = 500;
  let removed = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    await prisma.productionStage.deleteMany({ where: { orderLineId: { in: part } } });
    const r = await prisma.orderLine.deleteMany({ where: { id: { in: part } } });
    removed += r.count;
  }
  console.log(`\nУдалено: ${removed}. Строк заказов осталось: ${await prisma.orderLine.count()}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
