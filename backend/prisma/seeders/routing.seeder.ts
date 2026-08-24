import { PrismaClient, RoutingStage } from '@prisma/client';

/**
 * Сид модуля трудочасов (Этап 3):
 *  - коэффициенты калькуляции из исходника («Спецификации 2022», строка 1 + «ЗП сотр.»);
 *  - ставка часа 24.08.2026 обновлена на 1 268,92 ₸ — «средняя с налогами»
 *    из живого «План Производства.xlsx» (лист «Рабочее время»), актуальнее
 *    прежних 2 040 ₸ из таблицы 2022 года. Разбивка по переделам (резчик /
 *    сварщик / маляр) по-прежнему не известна — открытый вопрос №2.
 */
export async function seedRouting(prisma: PrismaClient) {
  console.log('Seeding routing module (work centers, costing config)...');

  const existing = await prisma.costingConfig.findFirst({ where: { validTo: null } });
  if (!existing) {
    await prisma.costingConfig.create({
      data: {
        validFrom: new Date('2026-01-01'),
        hourlyRate: 1268.92,     // План Производства.xlsx → Рабочее время → «цена за час ср. с налогами» (24.08.2026)
        logisticsPct: 0.03,   // Спецификации 2022!AJ1
        utilitiesPct: 0.01,   // AK1
        vatPct: 0.12,         // Прайс!M1
        // Решение 19.08.2026: маржинальность 35 % ОТ ЦЕНЫ (marginMode MARGIN,
        // цена = себестоимость / (1 − 0.35)). Прежние 0.1 — это ячейка AN1
        // из таблицы 2022 года, а не действующее правило: на себестоимости
        // 5 252 742 ₸ она давала цену 5 836 380 ₸ вместо 8 081 141 ₸.
        // Значение живёт в сиде, поэтому после сноса данных возвращалось бы.
        marginPct: 0.35,
        marginMode: 'MARGIN',
        paymentTermDays: 30,  // Telecom!AH: (AG+30)-TODAY()
        weldingFactor: 0.02,  // «коэф. сварки» Q1
      },
    });
  }

  const centers: Array<{ code: string; name: string; stage: RoutingStage; hourlyRate: number; capacityPerDay: number }> = [
    { code: 'CUT-1', name: 'Резка-1', stage: RoutingStage.CUTTING, hourlyRate: 1268.92, capacityPerDay: 16 },
    { code: 'ASM-1', name: 'Сварка-1', stage: RoutingStage.ASSEMBLY, hourlyRate: 1268.92, capacityPerDay: 24 },
    { code: 'ASM-2', name: 'Сварка-2', stage: RoutingStage.ASSEMBLY, hourlyRate: 1268.92, capacityPerDay: 24 },
    { code: 'PNT-1', name: 'Покраска-1', stage: RoutingStage.PAINTING, hourlyRate: 1268.92, capacityPerDay: 16 },
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
