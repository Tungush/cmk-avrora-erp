/**
 * Общий вход «для остальных» (24.08.2026). Решение пользователя (см.
 * launch-questionnaire в памяти): личный аккаунт только у director и
 * admin, все восемь внутренних операционных ролей (бухгалтер, конструктор,
 * плановик, снабженец, менеджер по продажам, мастер цеха, два кладовщика)
 * входят через ОДИН общий PIN — люди меняются, поимённый учёт не нужен.
 * viewer НЕ входит в объединение: это внешний наблюдатель-заказчик,
 * привязка к конкретному контрагенту, другая природа доступа.
 *
 * Технически — не новая роль и не новый код прав: один пользователь
 * получает все восемь ролей сразу через UserRole (то же самое, что
 * происходило в демо-логине при выборе нескольких ролей через запятую).
 * Существующая матрица прав (field-access.ts) не меняется ни строкой.
 *
 * Запуск: npm run setup-shared-login
 */
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';

const SHARED_EMAIL = 'smena@avh.kz';
const OPERATIONAL_ROLES = [
  'accountant', 'engineer', 'planner', 'procurement',
  'sales_manager', 'shop_foreman', 'warehouse_fg', 'warehouse_material',
];
// Старые логины демо-этапа — по одному на роль, реально не использовались
// (пароли к ним никто так и не получил)
const RETIRE_EMAILS = [...OPERATIONAL_ROLES.map((r) => `${r}@avh.kz`), 'sales@avh.kz'];

function randomPin(digits = 6): string {
  const max = 10 ** digits;
  return crypto.randomInt(0, max).toString().padStart(digits, '0');
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const { count: retired } = await prisma.user.deleteMany({ where: { email: { in: RETIRE_EMAILS } } });
    console.log(`Убрано старых ролевых логинов: ${retired}`);

    const roles = await prisma.role.findMany({ where: { code: { in: OPERATIONAL_ROLES } } });
    if (roles.length !== OPERATIONAL_ROLES.length) {
      throw new Error(`В справочнике ролей найдено ${roles.length} из ${OPERATIONAL_ROLES.length} — проверьте roles.code`);
    }

    const pin = randomPin(6);
    const passwordHash = await bcrypt.hash(pin, 10);

    await prisma.user.deleteMany({ where: { email: SHARED_EMAIL } });
    const user = await prisma.user.create({ data: { email: SHARED_EMAIL, passwordHash } });
    await prisma.userRole.createMany({
      data: roles.map((r) => ({ userId: user.id, roleId: r.id })),
    });

    console.log('\n===== ОБЩИЙ ВХОД ГОТОВ (показан один раз) =====');
    console.log(`  Email:  ${SHARED_EMAIL}`);
    console.log(`  PIN:    ${pin}`);
    console.log(`  Роли:   ${OPERATIONAL_ROLES.join(', ')}`);
    console.log('\nЗапишите сейчас. Директор и admin по-прежнему входят своим личным паролем.');
    console.log('Перевыпустить PIN: npm run setup-shared-login (сгенерирует новый).');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
