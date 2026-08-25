import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

/**
 * SQL-вью (v_customer_debts, v_procurement_needed, …) живут в миграции
 * 20260818000000_add_views, но проект поднимается через `prisma db push`,
 * который миграции не выполняет. Сид применяет их идемпотентно
 * (CREATE OR REPLACE VIEW).
 */
export async function seedViews(prisma: PrismaClient) {
  console.log('Applying SQL views (v_customer_debts, v_procurement_needed, ...)...');
  const sqlPath = path.resolve(__dirname, '..', 'migrations', '20260818000000_add_views', 'migration.sql');
  if (!fs.existsSync(sqlPath)) {
    console.warn('  views migration not found, skipping');
    return;
  }
  const sql = fs.readFileSync(sqlPath, 'utf8');
  // Убираем построчные комментарии до разбивки — иначе каждый CREATE VIEW
  // склеен в одном куске со своим предваряющим комментарием и весь кусок
  // отбраковывается как «это просто комментарий» (было: 0 применённых вью).
  const withoutComments = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  // Разбиваем по ';' в конце строки — внутри вью точек с запятой нет
  const statements = withoutComments
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await prisma.$executeRawUnsafe(stmt);
  }
  console.log(`  ${statements.length} view statements applied.`);
}
