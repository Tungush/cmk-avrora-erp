/**
 * Импорт материалов («База сырья») и составов изделий («Спецификации 2022»)
 * из spreadsheet_rows в materials / bom_items.
 *
 * «База сырья»:        [2] Категория, [3] артикул, [4] Товар, [7] Кол-во,
 *                      [8] ед.изм, [9] Цена ед., [11] Цена из Закупа, [13] Цена из Прайса
 * «Спецификации 2022»: блок = строка изделия (назв [2], материал пуст),
 *                      под ней строки материалов: [4] код материала, [5] имя,
 *                      [6] расход на ед.
 *
 * Составы пишутся только изделиям с пустым BOM — ручные правки не затираются.
 * Запуск: npm run migrate:bom
 */
import { PrismaClient, MaterialCategory, OperationType, RoutingStage } from '@prisma/client';

const prisma = new PrismaClient();

const CATEGORY_MAP: Record<string, MaterialCategory> = {
  'Инструменты': MaterialCategory.INSTRUMENTS,
  'Металл': MaterialCategory.METAL,
  'Метизы': MaterialCategory.HARDWARE,
  'Комплектующие': MaterialCategory.COMPONENTS,
  'Расходники': MaterialCategory.CONSUMABLES,
};

const num = (v: unknown): number => {
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

const str = (v: unknown): string => (v == null ? '' : String(v).trim());

/** Передел по коду материала: С — резка металла, Л — покраска, остальное — сборка */
function operationFor(code: string, name: string): OperationType {
  const p = code[0]?.toUpperCase() ?? '';
  if (p === 'С') return OperationType.CUTTING;
  if (p === 'Л') return OperationType.PAINTING;
  if (p === 'Р' && name.toLowerCase().includes('диск')) return OperationType.CUTTING;
  return OperationType.WELDING_ASSEMBLY;
}

async function sheetRows(name: string) {
  const sheet = await prisma.spreadsheetSheet.findFirst({ where: { name } });
  if (!sheet) throw new Error(`Лист «${name}» не найден — сначала npm run migrate:full`);
  return prisma.spreadsheetRow.findMany({
    where: { sheetId: sheet.id, rowNumber: { gte: 3 } },
    orderBy: { rowNumber: 'asc' },
  });
}

async function importMaterials() {
  const rows = await sheetRows('База сырья');
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const c = row.cells as unknown[];
    const code = str(c[3]).slice(0, 20);
    const name = str(c[4]);
    if (!code || !name) { skipped++; continue; }

    const purchase = num(c[11]) || num(c[9]);
    const data = {
      category: CATEGORY_MAP[str(c[2])] ?? MaterialCategory.CONSUMABLES,
      name,
      unit: str(c[8]).slice(0, 10) || 'шт',
      purchasePrice: purchase,
      priceListPrice: num(c[13]) || purchase,
      stockQty: num(c[7]),
    };
    try {
      const existing = await prisma.material.findUnique({ where: { materialCode: code } });
      if (existing) {
        await prisma.material.update({ where: { materialCode: code }, data });
        updated++;
      } else {
        await prisma.material.create({ data: { materialCode: code, ...data } });
        created++;
      }
    } catch {
      skipped++;
    }
  }
  return { created, updated, skipped };
}

async function importBom() {
  const rows = await sheetRows('Спецификации 2022');

  const articles = await prisma.article.findMany({ select: { id: true, name: true } });
  const articleByName = new Map<string, string>();
  for (const a of articles) {
    const key = a.name.trim().toLowerCase();
    if (!articleByName.has(key)) articleByName.set(key, a.id); // при дублях имён — первый
  }

  const materials = await prisma.material.findMany({ select: { id: true, materialCode: true, purchasePrice: true } });
  const materialByCode = new Map(materials.map((m) => [m.materialCode, m]));

  // Не затираем изделия, где состав уже есть
  const withBom = await prisma.bomItem.groupBy({ by: ['articleId'], _count: { _all: true } });
  const hasBom = new Set(withBom.map((b) => b.articleId));

  let currentArticleId: string | null = null;
  // Нормы труда лежат в строке-заголовке блока: [24,25] резка, [27,28] сборка, [30,31] покраска
  const norms = new Map<string, Array<{ stage: RoutingStage; workers: number; hours: number }>>();
  const unmatchedNames = new Set<string>();
  const unmatchedMaterials = new Set<string>();
  // (articleId|materialId|op) → qty: дубли материала в блоке суммируются
  const items = new Map<string, { articleId: string; materialId: string; op: OperationType; qty: number; price: number }>();

  for (const row of rows) {
    const c = row.cells as unknown[];
    const name = str(c[2]);
    const materialName = str(c[5]);

    if (name && !materialName) {
      // Заголовок блока изделия
      const id = articleByName.get(name.toLowerCase()) ?? null;
      if (!id) unmatchedNames.add(name);

      // Нормы берём даже у изделий, чей состав уже заполнен вручную
      if (id && !norms.has(id)) {
        const stages: Array<{ stage: RoutingStage; workers: number; hours: number }> = [];
        const cols: Array<[RoutingStage, number, number]> = [
          [RoutingStage.CUTTING, 24, 25],
          [RoutingStage.ASSEMBLY, 27, 28],
          [RoutingStage.PAINTING, 30, 31],
        ];
        for (const [stage, wi, hi] of cols) {
          const workers = num(c[wi]);
          const hours = num(c[hi]);
          if (workers > 0 && hours > 0) stages.push({ stage, workers, hours });
        }
        if (stages.length > 0) norms.set(id, stages);
      }

      currentArticleId = id && !hasBom.has(id) ? id : null;
      continue;
    }
    if (!currentArticleId || !materialName) continue;

    const code = str(c[4]);
    const material = materialByCode.get(code);
    if (!material) { if (code) unmatchedMaterials.add(code); continue; }

    const qty = num(c[6]);
    if (qty <= 0) continue;

    const op = operationFor(code, materialName);
    const key = `${currentArticleId}|${material.id}|${op}`;
    const prev = items.get(key);
    if (prev) prev.qty += qty;
    else items.set(key, { articleId: currentArticleId, materialId: material.id, op, qty, price: Number(material.purchasePrice) });
  }

  const data = [...items.values()].map((i) => ({
    articleId: i.articleId,
    materialId: i.materialId,
    operationType: i.op,
    qtyPerUnit: Math.round(i.qty * 10000) / 10000,
    laborHours: 0,
    lineCost: Math.round(i.qty * i.price * 100) / 100,
  }));

  let createdItems = 0;
  for (let i = 0; i < data.length; i += 1000) {
    const res = await prisma.bomItem.createMany({ data: data.slice(i, i + 1000), skipDuplicates: true });
    createdItems += res.count;
  }

  const articlesFilled = new Set(data.map((d) => d.articleId)).size;

  // Нормы труда: не затираем уже заданные вручную (правка инженера важнее импорта)
  const withNorms = await prisma.routingOperation.findMany({
    select: { articleId: true }, distinct: ['articleId'],
  });
  const hasNorms = new Set(withNorms.map((r) => r.articleId));
  const STAGE_ORDER: Record<string, number> = { CUTTING: 0, ASSEMBLY: 1, PAINTING: 2 };

  const normRows = [...norms.entries()]
    .filter(([articleId]) => !hasNorms.has(articleId))
    .flatMap(([articleId, stages]) =>
      stages.map((s) => ({
        articleId,
        stage: s.stage,
        sortOrder: STAGE_ORDER[s.stage] ?? 0,
        workers: s.workers,
        hoursPerUnit: s.hours,
      })),
    );

  let createdNorms = 0;
  for (let i = 0; i < normRows.length; i += 1000) {
    const res = await prisma.routingOperation.createMany({ data: normRows.slice(i, i + 1000), skipDuplicates: true });
    createdNorms += res.count;
  }
  const articlesWithNorms = new Set(normRows.map((r) => r.articleId)).size;

  return {
    createdItems, articlesFilled,
    createdNorms, articlesWithNorms,
    unmatchedNames: unmatchedNames.size, unmatchedMaterials: unmatchedMaterials.size,
  };
}

async function main() {
  console.log('Импорт материалов из «База сырья»...');
  const m = await importMaterials();
  console.log(`  материалы: создано ${m.created}, обновлено ${m.updated}, пропущено ${m.skipped}`);

  console.log('Импорт составов из «Спецификации 2022»...');
  const b = await importBom();
  console.log('\n| Метрика | Значение |');
  console.log('|---|---|');
  console.log(`| Позиций состава создано | ${b.createdItems} |`);
  console.log(`| Изделий наполнено | ${b.articlesFilled} |`);
  console.log(`| Норм труда создано | ${b.createdNorms} |`);
  console.log(`| Изделий с нормами | ${b.articlesWithNorms} |`);
  console.log(`| Изделий из листа не найдено в артикулах | ${b.unmatchedNames} |`);
  console.log(`| Кодов материалов не найдено | ${b.unmatchedMaterials} |`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
