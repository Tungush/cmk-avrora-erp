/**
 * Что в каталоге «Изделия» — продукция, а что нет (запрос 26.08.2026:
 * «отсортировать что сырьё, а что готовая продукция… там должна быть
 * только продукция ГП»).
 *
 * Источник правды — колонка «Тип» листа Telecom в файле производства:
 * сам завод помечает каждую строку ГП или ТМЦ. Догадки по названию не
 * годятся, и это проверено: «12У Швеллер» и «L-болт под уголок» выглядят
 * как сырьё, но лист говорит ГП — завод их изготавливает. Обратно тоже:
 * по одному лишь совпадению имени с материалом под нож попали бы «БМЗ для
 * КТПБ» и «Ограждения спортплощадки», а это продукция.
 *
 * Для того, чего в листе нет вообще (825 артикулов), работает второе
 * правило — по виду кода. Оно проверено на 1650 строках, где ответ листа
 * известен, и совпало 100 % (1432/1432 ГП и 218/218 ТМЦ): собственный код
 * завода выглядит как «n-182», «k-023», «z-519», а позиция справочника 1С —
 * как «С0806», «TLCM004495», «ERP0001115», «АА-00028667». Правило применяем
 * с дополнительной страховкой: только если у артикула нет ни состава, ни
 * норм труда — то есть система не знает его как изготавливаемое изделие.
 *
 * Скрипт идемпотентный: снимает ошибочные пометки и ставит недостающие.
 *
 * Запуск: npx ts-node prisma/classify-articles-by-sheet.ts [-- --dry-run]
 */
import * as ExcelJS from 'exceljs';
import { PrismaClient } from '@prisma/client';

const XLSX = '/Users/Tungush/Downloads/2025_План Производства (2).xlsx';
const dryRun = process.argv.includes('--dry-run');

const str = (v: any): string => {
  if (v == null) return '';
  if (typeof v === 'object') {
    const o: any = v;
    if (o.result !== undefined) return str(o.result);
    if (o.text) return String(o.text).trim();
    if (o.richText) return o.richText.map((t: any) => t.text).join('').trim();
    return '';
  }
  return String(v).trim();
};

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX);
  const ws = wb.getWorksheet('Telecom');
  if (!ws) throw new Error('Лист Telecom не найден');

  // Артикул → какими типами он встречался в листе
  const byCode = new Map<string, Set<string>>();
  ws.eachRow((row, rn) => {
    if (rn <= 3) return; // строка 3 — заголовок
    const type = str(row.getCell(1).value);
    const code = str(row.getCell(2).value);
    if (!type || !code) return;
    if (!byCode.has(code)) byCode.set(code, new Set());
    byCode.get(code)!.add(type);
  });

  // Однозначные: встречался только как ГП / только как ТМЦ. Смешанные
  // (и так и так) не трогаем — по ним у самого завода нет одного ответа.
  const onlyIs = (code: string, t: string) => {
    const s = byCode.get(code);
    return !!s && s.size === 1 && s.has(t);
  };

  // Собственный код завода: «n-182», «k-023», «z-519», «m-043»
  const isFactoryCode = (code: string) => /^[a-zA-Z]{1,3}-\d+$/.test(code);

  const prisma = new PrismaClient();
  const arts = await prisma.article.findMany({
    select: {
      id: true, articleCode: true, name: true, isMaterialResale: true,
      _count: { select: { bomItems: true, routingOperations: true } },
    },
  });
  const isMade = (a: typeof arts[number]) =>
    a._count.bomItems > 0 || a._count.routingOperations > 0;

  const toShow = arts.filter((a) => a.isMaterialResale && onlyIs(a.articleCode, 'ГП'));
  const toHide = arts.filter((a) => !a.isMaterialResale && onlyIs(a.articleCode, 'ТМЦ'));
  const unknown = arts.filter((a) => !byCode.has(a.articleCode));
  // Правило по виду кода — только для тех, кого лист не знает, и только
  // если система не знает их как изготавливаемые (нет состава и норм)
  const byCodeShape = unknown.filter(
    (a) => !a.isMaterialResale && !isFactoryCode(a.articleCode) && !isMade(a),
  );

  console.log(`Артикулов в каталоге: ${arts.length}`);
  console.log(`  вернуть в продукцию (лист: ГП, а мы прятали): ${toShow.length}`);
  console.log(`  убрать из продукции (лист: ТМЦ): ${toHide.length}`);
  console.log(`  убрать по виду кода (1С-код, нет состава и норм): ${byCodeShape.length}`);
  console.log(`  нет в листе, но код заводской или есть состав — оставляем: ${unknown.length - byCodeShape.length}`);

  if (toShow.length) {
    console.log('\nВозвращаются в каталог:');
    toShow.slice(0, 15).forEach((a) => console.log(`   ${a.articleCode.padEnd(14)} ${a.name.slice(0, 55)}`));
  }
  if (toHide.length) {
    console.log('\nУбираются из каталога (лист: ТМЦ):');
    toHide.forEach((a) => console.log(`   ${a.articleCode.padEnd(14)} ${a.name.slice(0, 55)}`));
  }
  if (byCodeShape.length) {
    console.log('\nУбираются из каталога (1С-код, не изготавливается):');
    byCodeShape.slice(0, 20).forEach((a) => console.log(`   ${a.articleCode.padEnd(16)} ${a.name.slice(0, 52)}`));
    if (byCodeShape.length > 20) console.log(`   … и ещё ${byCodeShape.length - 20}`);
  }

  if (dryRun) {
    console.log('\n--dry-run: база не изменена.');
    await prisma.$disconnect();
    return;
  }

  if (toShow.length) {
    await prisma.article.updateMany({
      where: { id: { in: toShow.map((a) => a.id) } },
      data: { isMaterialResale: false },
    });
  }
  const hideIds = [...toHide, ...byCodeShape].map((a) => a.id);
  if (hideIds.length) {
    await prisma.article.updateMany({
      where: { id: { in: hideIds } },
      data: { isMaterialResale: true },
    });
  }
  console.log(`\nГотово: возвращено ${toShow.length}, убрано ${hideIds.length}.`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
