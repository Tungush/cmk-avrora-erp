import { PrismaClient, MaterialCategory } from '@prisma/client';

export const SYSTEM_ROLES = [
  { code: 'sales_manager', name: 'Менеджер по продажам / ПМ', description: 'Telecom, Для фиксации: «Руководитель», «ПМ»' },
  { code: 'planner', name: 'Плановик / ПЭО', description: 'План, Минимальные остатки, Рабочее время' },
  { code: 'engineer', name: 'Конструктор / технолог', description: 'Отчет по проектам проект, Спецификации 2022' },
  { code: 'procurement', name: 'Закупщик / снабженец', description: '19.20-7п: «Ответственный закупщик», лист «На закуп»' },
  { code: 'warehouse_material', name: 'Кладовщик (сырьё)', description: 'Склад ТМЦ (импорт)' },
  { code: 'warehouse_fg', name: 'Кладовщик (ГП)', description: 'Склад ГП, Приход ГП' },
  { code: 'shop_foreman', name: 'Мастер цеха', description: 'Отчет по проектам проект: этапы резки/сборки/покраски' },
  { code: 'accountant', name: 'Бухгалтер / финансист', description: '19.20-7п, реестр АПП по заказчикам, Остатки по бух.' },
  { code: 'director', name: 'Директор / руководство', description: 'Сводка, Сводная, Сводная по ГП' },
  { code: 'admin', name: 'Администратор системы', description: 'Permissions, Log, LogErrors' },
];

export async function seedDictionaries(prisma: PrismaClient) {
  console.log('Seeding 10 system roles from 04_ROLES_PERMISSIONS.md...');
  for (const roleData of SYSTEM_ROLES) {
    await prisma.role.upsert({
      where: { code: roleData.code },
      update: { name: roleData.name, description: roleData.description },
      create: roleData,
    });
  }
  console.log('System roles seeded successfully.');
}
