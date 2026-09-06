/**
 * Проверка заполненности базы: что готово, чего не хватает и кто это
 * заполняет. Запускать после каждой загрузки и раз в неделю на пилоте.
 *
 *   npm run check:data
 *   npm run check:data -- --list   # выписать коды, которые надо добить
 *
 * Ничего не меняет. Код возврата 1, если есть блокеры — то, без чего
 * экран показывает пустоту или неверную цифру.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const LIST = process.argv.includes('--list');
const ACTIVE = `status NOT IN ('CLOSED','CANCELLED')`;

const q = async <T = Record<string, unknown>>(sql: string): Promise<T[]> =>
  prisma.$queryRawUnsafe<T[]>(sql);
const one = async (sql: string): Promise<number> => {
  const r = await q<{ n: bigint | number }>(sql);
  return Number(r[0]?.n ?? 0);
};

interface Line { ok: boolean; blocker: boolean; text: string; hint?: string }
const lines: Line[] = [];
/** Печатает строку сразу — отчёт читается сверху вниз, а не двумя проходами */
function say(ok: boolean, text: string, hint?: string, blocker = false) {
  const isBlocker = blocker && !ok;
  lines.push({ ok, blocker: isBlocker, text, hint });
  console.log(`  ${ok ? 'ok  ' : isBlocker ? 'СТОП' : '~   '} ${text}`);
  if (!ok && hint) console.log(`        ${hint}`);
}

async function main() {
  console.log('\n== ЧТО ПРИШЛО ИЗ 1С ==');
  const orders = await one(`SELECT count(*) n FROM orders`);
  const active = await one(`SELECT count(*) n FROM orders WHERE ${ACTIVE}`);
  const lines1c = await one(`SELECT count(*) n FROM order_lines`);
  say(orders > 0, `Заказы: ${orders}, из них активных ${active}, позиций ${lines1c}`,
    'Пусто — сделайте выгрузку из 1С и залейте: npm run import:1c-csv', true);

  const noArticle = await one(`SELECT count(*) n FROM order_lines ol JOIN orders o ON o.id=ol.order_id WHERE o.${ACTIVE} AND ol.article_id IS NULL`);
  say(noArticle === 0, `Позиции активных заказов без изделия в справочнике: ${noArticle}`,
    'Такую позицию нельзя считать и отмечать в цеху. Заведите изделие или заявку на номенклатуру в карточке заказа');

  const noPlanDate = await one(`SELECT count(*) n FROM orders WHERE ${ACTIVE} AND planned_shipment_date IS NULL`);
  say(noPlanDate === 0, `Активные заказы без плановой даты вывоза: ${noPlanDate} из ${active}`,
    'Без даты заказ не попадает в просрочку и в план по неделям. Дата приходит из 1С — заполните её там и перезалейте');

  const customers = await one(`SELECT count(*) n FROM customers`);
  const noBin = await one(`SELECT count(*) n FROM customers WHERE bin_iin IS NULL OR bin_iin = ''`);
  say(noBin === 0, `Контрагенты: ${customers}, без БИН/ИИН ${noBin}`,
    'Заказ такого контрагента нельзя принять в производство');

  const docs = await one(`SELECT count(*) n FROM payment_documents`);
  const acts = await one(`SELECT count(*) n FROM acceptance_acts`);
  const batches = await one(`SELECT count(*) n FROM material_batches`);
  const warehouses = await one(`SELECT count(*) n FROM warehouses`);
  say(docs > 0 && batches > 0, `Договоры-основания ${docs}, акты ${acts}, партии материалов ${batches}, склады ${warehouses}`);

  const noPaid = await one(`SELECT count(*) n FROM orders WHERE ${ACTIVE} AND onec_paid_amount IS NULL`);
  say(noPaid === 0, `Активные заказы без данных об оплате из 1С: ${noPaid} из ${active}`,
    'Они не считаются долгом, показываются отдельно как «оплата неизвестна». Чтобы долг был полным, нужна выгрузка оплат');

  console.log('\n== ЧТО ЗАПОЛНЯЕТ ИНЖЕНЕР (1С этого не знает) ==');
  const need = await q<{ article_code: string; has_bom: boolean; has_norms: boolean }>(`
    SELECT a.article_code,
           EXISTS (SELECT 1 FROM bom_items b WHERE b.article_id = a.id) AS has_bom,
           EXISTS (SELECT 1 FROM routing_operations r WHERE r.article_id = a.id) AS has_norms
    FROM articles a
    WHERE EXISTS (SELECT 1 FROM order_lines ol JOIN orders o ON o.id = ol.order_id
                  WHERE ol.article_id = a.id AND o.${ACTIVE})
    ORDER BY a.article_code`);
  const noBom = need.filter((r) => !r.has_bom);
  const noNorms = need.filter((r) => !r.has_norms);
  say(noBom.length === 0, `Изделия в активных заказах: ${need.length}, без состава ${noBom.length}`,
    'Без состава не считается себестоимость и не планируется закуп. Заполнить в «Изделиях» или загрузить: npm run import:catalog -- --bom состав.csv', true);
  say(noNorms.length === 0, `Из них без норм труда: ${noNorms.length}`,
    'Без норм не считается труд и загрузка цеха. Загрузить: npm run import:catalog -- --norms нормы.csv', true);

  // Цену и себестоимость меряем по тем изделиям, что реально в работе:
  // «176 из 2152» звучит как провал, хотя каталог на 90 % архивный
  const needPriced = await one(`SELECT count(*) n FROM articles a WHERE approved_price > 0
    AND EXISTS (SELECT 1 FROM order_lines ol JOIN orders o ON o.id=ol.order_id WHERE ol.article_id=a.id AND o.${ACTIVE})`);
  say(needPriced >= need.length / 2, `Утверждённая цена: у ${needPriced} изделий из ${need.length} в работе`,
    'Без неё не видно отклонения расчёта от принятой цены. Загрузить: npm run import:price-list');

  const needCosted = await one(`SELECT count(*) n FROM articles a WHERE spec_price > 0
    AND EXISTS (SELECT 1 FROM order_lines ol JOIN orders o ON o.id=ol.order_id WHERE ol.article_id=a.id AND o.${ACTIVE})`);
  const withBom = need.length - noBom.length;
  say(withBom > 0 && needCosted >= withBom, `Посчитана себестоимость: у ${needCosted} изделий из ${withBom} с составом`,
    'После загрузки состава и норм: npm run recalc:costing');

  const noPrice = await one(`SELECT count(*) n FROM materials m WHERE m.purchase_price = 0
    AND EXISTS (SELECT 1 FROM bom_items b WHERE b.material_id = m.id)`);
  say(noPrice === 0, `Материалы в составах с нулевой ценой закупа: ${noPrice}`,
    'Они входят в себестоимость нулём и молча её занижают. Цена приходит из 1С вместе с приходом');

  console.log('\n== ЗАПОЛНЯЕТСЯ ПО ХОДУ РАБОТЫ, ДЛЯ СТАРТА НЕ ОБЯЗАТЕЛЬНО ==');
  const plan = await one(`SELECT count(*) n FROM production_plan_items`);
  const minStock = await one(`SELECT count(*) n FROM min_stock_levels`);
  const offcuts = await one(`SELECT count(*) n FROM offcuts`);
  const users = await one(`SELECT count(*) n FROM users`);
  console.log(`  План производства: ${plan} строк (ставит плановик)`);
  console.log(`  Минимальные остатки: ${minStock} (ведёт кладовщик по расходникам)`);
  console.log(`  Склад обрезков: ${offcuts} (ведёт кладовщик по факту)`);
  console.log(`  Учётные записи: ${users}`);

  const blockers = lines.filter((l) => l.blocker).length;
  const warns = lines.filter((l) => !l.ok && !l.blocker).length;

  if (LIST && (noBom.length || noNorms.length)) {
    console.log('\n== ЧТО ДОБИТЬ (коды изделий) ==');
    if (noBom.length) console.log(`Без состава:\n${noBom.map((r) => r.article_code).join(', ')}`);
    if (noNorms.length) console.log(`Без норм:\n${noNorms.map((r) => r.article_code).join(', ')}`);
  }

  console.log(
    blockers === 0
      ? `\nБлокеров нет, замечаний: ${warns}. Работать можно.`
      : `\nБлокеров: ${blockers}, замечаний: ${warns}. Эти цифры на экранах будут неполными.`,
  );
  process.exit(blockers === 0 ? 0 : 1);
}

main()
  .catch((e) => { console.error(e); process.exit(2); })
  .finally(() => prisma.$disconnect());
