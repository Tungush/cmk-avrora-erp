import { PrismaClient, RoutingStage } from '@prisma/client';

/**
 * Сид модуля трудочасов (Этап 3):
 *  - коэффициенты калькуляции из исходника («Спецификации 2022», строка 1 + «ЗП сотр.»);
 *  - участки с базовой ставкой 2 040 ₸ — реальные ставки уточняются у заказчика
 *    (открытый вопрос №2 из 07_ARCHITECTURE_AND_UX.md §7).
 */
export async function seedRouting(prisma: PrismaClient) {
  console.log('Seeding routing module (work centers, costing config)...');

  const existing = await prisma.costingConfig.findFirst({ where: { validTo: null } });
  if (!existing) {
    await prisma.costingConfig.create({
      data: {
        validFrom: new Date('2026-01-01'),
        hourlyRate: 2040,     // «ЗП сотр.»!N9
        logisticsPct: 0.03,   // Спецификации 2022!AJ1
        utilitiesPct: 0.01,   // AK1
        vatPct: 0.12,         // Прайс!M1
        marginPct: 0.1,       // AN1
        paymentTermDays: 30,  // Telecom!AH: (AG+30)-TODAY()
        weldingFactor: 0.02,  // «коэф. сварки» Q1
      },
    });
  }

  const centers: Array<{ code: string; name: string; stage: RoutingStage; hourlyRate: number; capacityPerDay: number }> = [
    { code: 'CUT-1', name: 'Резка-1', stage: RoutingStage.CUTTING, hourlyRate: 2040, capacityPerDay: 16 },
    { code: 'ASM-1', name: 'Сварка-1', stage: RoutingStage.ASSEMBLY, hourlyRate: 2040, capacityPerDay: 24 },
    { code: 'ASM-2', name: 'Сварка-2', stage: RoutingStage.ASSEMBLY, hourlyRate: 2040, capacityPerDay: 24 },
    { code: 'PNT-1', name: 'Покраска-1', stage: RoutingStage.PAINTING, hourlyRate: 2040, capacityPerDay: 16 },
  ];
  for (const wc of centers) {
    await prisma.workCenter.upsert({
      where: { code: wc.code },
      update: {},
      create: wc,
    });
  }

  console.log('Routing module seeded.');
}
