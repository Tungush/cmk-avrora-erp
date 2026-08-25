/**
 * Разовое применение SQL-вью (25.08.2026) — вью из миграции
 * 20260818000000_add_views никогда не применялись к этой БД, потому что
 * проект поднимается через `prisma db push`, а не `prisma migrate`.
 * Из-за этого раздел «Деньги» → «Сверка «заказ ↔ ДО»» падал 500-й ошибкой
 * (v_customer_debts не существует). Идемпотентно (CREATE OR REPLACE VIEW),
 * безопасно перезапускать.
 *
 * Запуск: npx ts-node prisma/apply-views.ts
 */
import { PrismaClient } from '@prisma/client';
import { seedViews } from './seeders/views.seeder';

async function main() {
  const prisma = new PrismaClient();
  await seedViews(prisma);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
