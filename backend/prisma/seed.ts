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
  
  const { seedDemoData } = await import('./seeders/demo.seeder');
  await seedDemoData(prisma);

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
