/**
 * Разовая пометка «прямая продажа сырья» (25.08.2026, исправлено в тот же день) —
 * карточки «Изделий», у которых articleCode совпадает с кодом реального материала
 * (найдено аудитом честности) И при этом нет ни одной строки состава.
 * Решение пользователя: отдельный тип позиции, не автосостав «1 к 1».
 *
 * ВАЖНО: совпадение кода само по себе НЕ значит «это сырьё» — проверено на
 * z-227 (2КТПБ-2000/10-0,4кВ), у которого совпадение кода есть, но в BOM
 * 58 реальных позиций: это настоящее изделие, а не сырьё. Из первых 1002
 * совпадений 906 (90%) оказались такими же ложными срабатываниями —
 * казармы, мачты, контейнеры с 40-74 позициями состава. Поэтому здесь
 * дополнительно исключены артикулы с непустым составом.
 *
 * Запуск: npm run mark:material-resale [-- --dry-run]
 */
import { PrismaClient } from '@prisma/client';

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const prisma = new PrismaClient();
  try {
    const matches = await prisma.$queryRaw<Array<{ id: string; article_code: string; name: string }>>`
      SELECT a.id, a.article_code, a.name
      FROM articles a
      JOIN materials m ON a.article_code = m.material_code
      WHERE a.is_material_resale = false
        AND NOT EXISTS (SELECT 1 FROM bom_items bi WHERE bi.article_id = a.id)
    `;
    console.log(`Найдено совпадений код артикула = код материала (без состава): ${matches.length}`);

    if (!dryRun && matches.length) {
      const { count } = await prisma.article.updateMany({
        where: { id: { in: matches.map((m) => m.id) } },
        data: { isMaterialResale: true },
      });
      console.log(`Помечено: ${count}`);
    } else if (dryRun) {
      console.log('--dry-run: запись в базу пропущена.');
      matches.slice(0, 10).forEach((m) => console.log(`  · ${m.article_code} ${m.name}`));
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
