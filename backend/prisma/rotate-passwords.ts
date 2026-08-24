/**
 * Смена паролей входа (24.08.2026). Все 11 демо-аккаунтов (по одному на
 * роль) сидятся с одним и тем же паролем 'Test@2025!', зашитым в
 * seeders/demo.seeder.ts — на живых данных это открытая дверь: пароль
 * лежит в гите. Директор и админ получают личные пароли; за восемью
 * ролевыми логинами и дальше стоит команда, но сам пароль больше не
 * угадывается по исходникам.
 *
 * Печатает пароли ОДИН раз и нигде их не сохраняет — записать самому.
 *
 * Запуск:
 *   npm run rotate-passwords                       # все 11 аккаунтов
 *   npm run rotate-passwords -- director@avh.kz admin@avh.kz
 */
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';

// Без похожих на письмо символов (0/O, 1/l/I) — читать вслух проще
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
function randomPassword(length: number): string {
  return Array.from(crypto.randomBytes(length))
    .map((b) => ALPHABET[b % ALPHABET.length])
    .join('');
}

async function main() {
  const requested = process.argv.slice(2);
  const prisma = new PrismaClient();
  try {
    const users = requested.length
      ? await prisma.user.findMany({ where: { email: { in: requested } } })
      : await prisma.user.findMany({ include: { userRoles: { include: { role: true } } } });

    if (!users.length) {
      console.log('Пользователи не найдены.');
      return;
    }

    const rows: Array<{ email: string; password: string }> = [];
    for (const u of users) {
      // Директору и админу — длиннее и заведомо не как у всех
      const isPersonal = u.email === 'director@avh.kz' || u.email === 'admin@avh.kz';
      const password = randomPassword(isPersonal ? 14 : 10);
      const passwordHash = await bcrypt.hash(password, 10);
      await prisma.user.update({ where: { id: u.id }, data: { passwordHash } });
      rows.push({ email: u.email, password });
    }

    console.log('\n===== НОВЫЕ ПАРОЛИ (показаны один раз, нигде не сохранены) =====');
    for (const r of rows) console.log(`  ${r.email.padEnd(28)} ${r.password}`);
    console.log('\nЗапишите сейчас — повторно эту команду выведет уже другие пароли.');
    console.log('director@avh.kz / admin@avh.kz — личные, не передавать; остальные — на команду роли.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
