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

  const prisma = new PrismaClient();
  const arts = await prisma.article.findMany({
    select: { id: true, articleCode: true, name: true, isMaterialResale: true },
  });

  const toShow = arts.filter((a) => a.isMaterialResale && onlyIs(a.articleCode, 'ГП'));
  const toHide = arts.filter((a) => !a.isMaterialResale && onlyIs(a.articleCode, 'ТМЦ'));
  const unknown = arts.filter((a) => !byCode.has(a.articleCode));

  console.log(`Артикулов в каталоге: ${arts.length}`);
  console.log(`  вернуть в продукцию (лист: ГП, а мы прятали): ${toShow.length}`);
  console.log(`  убрать из продукции (лист: ТМЦ): ${toHide.length}`);
  console.log(`  нет в листе — не трогаем: ${unknown.length}`);

  if (toShow.length) {
    console.log('\nВозвращаются в каталог:');
    toShow.slice(0, 15).forEach((a) => console.log(`   ${a.articleCode.padEnd(14)} ${a.name.slice(0, 55)}`));
  }
  if (toHide.length) {
    console.log('\nУбираются из каталога:');
    toHide.forEach((a) => console.log(`   ${a.articleCode.padEnd(14)} ${a.name.slice(0, 55)}`));
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
  if (toHide.length) {
    await prisma.article.updateMany({
      where: { id: { in: toHide.map((a) => a.id) } },
      data: { isMaterialResale: true },
    });
  }
  console.log(`\nГотово: возвращено ${toShow.length}, убрано ${toHide.length}.`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
