import { PrismaClient } from '@prisma/client';
import { seedDictionaries } from './seeders/dictionary.seeder';
import { seedWorkCalendar } from './seeders/calendar.seeder';
import { seedRbac } from './seeders/rbac.seeder';
import { seedRouting } from './seeders/routing.seeder';
import { seedViews } from './seeders/views.seeder';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting seed execution...');
  await seedDictionaries(prisma);
  await seedRbac(prisma);
  await seedRouting(prisma);
  await seedViews(prisma);
  await seedWorkCalendar(prisma, {
    startYear: 2026,
    endYear: 2027,
  });
  
  // Демо-данные — только по явной просьбе (07.09.2026). Раньше они лились
  // при каждом `npm run dev`: db:setup зовёт этот сид, а он безусловно
  // заводил демо-заказ ORD-2026-001, изделия BS-001/RM-001 и контрагента
  // «КарТел». В боевой базе они выглядели настоящими, владелец просил их
  // убрать — и после каждого перезапуска они возвращались.
  if (process.env.SEED_DEMO === 'true') {
    const { seedDemoData } = await import('./seeders/demo.seeder');
    await seedDemoData(prisma);
  } else {
    console.log('Демо-данные пропущены (SEED_DEMO=true — чтобы залить их намеренно)');
  }

  console.log('Seed completed successfully.');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
