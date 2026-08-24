/**
 * Демо-сценарии для презентации (решение 22.08.2026, гриль-сессия).
 *
 * Сырые Excel-заказы прячутся флагом isArchived (не удаляются), поверх
 * создаются сквозные заказы DEMO-*, каждый — слайд презентации:
 *   1. Инбокс: заказ из 1С ждёт приёма (один готов, у второго блокеры)
 *   2. Принятый заказ: этапы КД → Снабжение → Производство
 *   3. Подряд: сварка на 60 % подрядчиком, журнал работ, сверка с актом 1С
 *   4. Давальческий: металл заказчика (партия TOLLING, цена 0) + наши метизы
 *   5. Рост цены: две партии одного металла, две версии калькуляции
 *   6. Перехват партии: запрос на чужой резерв, ждёт директора
 *   7. Заявки на номенклатуру: зависшая (SLA) и закрытая с алиасом
 *
 * Идемпотентен: всё демо помечено префиксом DEMO- и пересоздаётся заново.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const R = (n: number) => Math.round(n * 100) / 100;
/** Цена при марже 35 % ОТ ЦЕНЫ (не наценке): price = cost / (1 - 0.35) */
const priceOf = (cost: number) => R(cost / (1 - 0.35));

const RATES = {
  hourlyRate: 2500,
  logisticsPct: 0.03,
  utilitiesPct: 0.02,
  marginPct: 0.35,
  marginMode: 'MARGIN' as const,
  vatPct: 0.12,
};

async function wipeDemo() {
  const demoOrders = await prisma.order.findMany({
    where: { orderNumber: { startsWith: 'DEMO-' } },
    select: { id: true },
  });
  const ids = demoOrders.map((o) => o.id);
  if (ids.length) {
    // Партии, чьи движения создавал этот сид, удаляем до заказов
    await prisma.materialBatch.deleteMany({ where: { documentNumber: { startsWith: 'DEMO-' } } });
    await prisma.contractorWork.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.paymentDocument.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.order.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.materialBatch.deleteMany({ where: { documentNumber: { startsWith: 'DEMO-' } } });
  await prisma.paymentDocument.deleteMany({ where: { doNumber: { startsWith: 'DEMO-' } } });
  await prisma.nomenclatureRequest.deleteMany({ where: { requestedBy: 'demo-seed' } });
  await prisma.materialStockMovement.deleteMany({ where: { project: 'DEMO' } });
}

async function main() {
  console.log('— Демо-сценарии: подготовка —');

  // 0. Excel-архив: скрыть, не удалять
  const archived = await prisma.order.updateMany({
    where: { sourceSheet: { not: null }, isArchived: false },
    data: { isArchived: true },
  });
  console.log(`Архивировано Excel-заказов: ${archived.count}`);

  await wipeDemo();

  // --- Справочная основа: живые артикулы с составом и материалы из них
  const articles = await prisma.article.findMany({
    where: { isActive: true, bomItems: { some: {} }, weightKg: { gt: 0 } },
    include: { bomItems: { include: { material: true }, take: 6 } },
    take: 8,
    orderBy: { articleCode: 'asc' },
  });
  if (articles.length < 4) {
    throw new Error('Мало артикулов с составом — сначала выполните миграцию BOM (npm run migrate:bom)');
  }
  const metalOf = (a: (typeof articles)[number]) =>
    a.bomItems.find((b) => b.material.category === 'METAL') ?? a.bomItems[0];

  // --- Люди и контрагенты
  const manager = await prisma.employee.findFirst({ orderBy: { name: 'asc' } });

  const customers = await Promise.all([
    prisma.customer.upsert({
      where: { binIin: '990140000101' },
      update: {},
      create: { binIin: '990140000101', name: 'ТОО «Казахтелеком Строй»', customerType: 'OUTSIDE', region: 'Астана' },
    }),
    prisma.customer.upsert({
      where: { binIin: '020840001202' },
      update: {},
      create: { binIin: '020840001202', name: 'АО «Транстелеком»', customerType: 'OUTSIDE', region: 'Караганда' },
    }),
    prisma.customer.upsert({
      where: { binIin: '050940002303' },
      update: {},
      create: { binIin: '050940002303', name: 'ТОО «КМГ Инжиниринг»', customerType: 'OUTSIDE', region: 'Атырау' },
    }),
  ]);

  // Подрядчик — для 1С точно такой же контрагент-поставщик, просто продаёт
  // работы, а не металл. Совпадающий БИН — единственная связь Contractor↔Customer,
  // по нему сверка находит ДО (PaymentDocument) этого подрядчика (уточнение 22.08.2026).
  const contractorAsCustomer = await prisma.customer.upsert({
    where: { binIin: '111240003404' },
    update: {},
    create: { binIin: '111240003404', name: 'ТОО «СварМонтаж Астана»', customerType: 'OUTSIDE' },
  });
  const contractor = await prisma.contractor.upsert({
    where: { binIin: '111240003404' },
    update: {},
    create: {
      binIin: '111240003404',
      name: 'ТОО «СварМонтаж Астана»',
      defaultRateType: 'PER_HOUR',
      defaultRate: 2500,
      defaultWorkLocation: 'OUR_SHOP',
    },
  });

  const today = new Date();
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
  const daysAhead = (n: number) => new Date(Date.now() + n * 86_400_000);

  // ===== Сценарий 1а. Инбокс: заказ из 1С, готов к приёму =====
  const a1 = articles[0];
  const inboxReady = await prisma.order.create({
    data: {
      orderNumber: 'DEMO-1001',
      customerId: customers[0].id,
      orderType: 'FZ',
      status: 'NEW',
      managerId: manager?.id,
      onecNum: 'Т7АА-000301',
      onecStatus: 'К выполнению',
      plannedShipmentDate: daysAhead(30),
      requestDate: daysAgo(2),
      orderLines: {
        create: [{ articleId: a1.id, qty: 12, unit: 'шт', unitPrice: 0 }],
      },
    },
  });

  // ===== Сценарий 1б. Инбокс: заказ с блокерами (позиция без артикула) =====
  await prisma.order.create({
    data: {
      orderNumber: 'DEMO-1002',
      customerId: customers[1].id,
      orderType: 'FZ',
      status: 'NEW',
      onecNum: 'Т7АА-000302',
      onecStatus: 'К выполнению',
      requestDate: daysAgo(1),
      orderLines: {
        create: [
          { articleId: articles[1].id, qty: 4, unit: 'шт', unitPrice: 0 },
          // Позиция, которую 1С прислала, а у нас такого артикула нет:
          // ровно случай «завели по-другому» — повод для заявки на номенклатуру
          { qty: 2, unit: 'шт', unitPrice: 0, productNameRaw: 'Ферма Ф-24 нестандартная (по чертежу заказчика)', articleCodeRaw: '00-00017777' },
        ],
      },
    },
  });

  /** Калькуляция позиции: строит связные цифры из реального состава */
  async function makeCosting(opts: {
    orderId: string; orderLineId: string; articleId: string; qty: number;
    version: number; status: 'APPROVED' | 'DRAFT';
    bom: Array<{ materialId: string; code: string | null; name: string; qtyPerUnit: number; unitPrice: number;
      batchId?: string | null; priceState?: 'ESTIMATE' | 'ORDERED' | 'ACTUAL'; supplierOrderNumber?: string | null }>;
    laborContractorShare?: number; calculatedAt?: Date; baseCostingId?: string | null;
  }) {
    const materialRows = opts.bom.map((b) => {
      const qtyTotal = R(b.qtyPerUnit * opts.qty);
      return {
        materialId: b.materialId,
        materialCodeSnapshot: b.code,
        materialNameSnapshot: b.name,
        qtyPerUnit: b.qtyPerUnit,
        qtyTotal,
        unitPrice: b.unitPrice,
        lineCost: R(qtyTotal * b.unitPrice),
        priceSource: (b.batchId ? 'SPECIFIC_BATCH' : 'LAST_PURCHASE') as any,
        batchId: b.batchId ?? null,
        priceDate: opts.calculatedAt ?? today,
        allocations: b.batchId ? [{ batchId: b.batchId, qty: qtyTotal, unitPrice: b.unitPrice, lineCost: R(qtyTotal * b.unitPrice) }] : undefined,
        priceState: (b.priceState ?? (b.batchId ? 'ACTUAL' : 'ESTIMATE')) as any,
        supplierOrderNumber: b.supplierOrderNumber ?? null,
        priceStateChangedAt: opts.calculatedAt ?? today,
      };
    });
    const materialCost = R(materialRows.reduce((s, m) => s + Number(m.lineCost), 0));

    const share = opts.laborContractorShare ?? 0;
    const hours = { CUTTING: 1.5, ASSEMBLY: 6, PAINTING: 2 };
    const laborRows: any[] = [];
    for (const [stage, hPerUnit] of Object.entries(hours)) {
      const manHours = R(hPerUnit * opts.qty);
      if (stage === 'ASSEMBLY' && share > 0) {
        laborRows.push({
          stage, laborKind: 'STAFF', share: R(1 - share), rateType: 'PER_HOUR', rate: RATES.hourlyRate,
          manHours: R(manHours * (1 - share)), lineCost: R(manHours * (1 - share) * RATES.hourlyRate),
          countInShopHours: true, workers: 4, hoursPerUnit: hPerUnit,
        });
        laborRows.push({
          stage, laborKind: 'CONTRACTOR', contractorId: contractor.id, share, rateType: 'PER_HOUR', rate: 2500,
          manHours: R(manHours * share), lineCost: R(manHours * share * 2500),
          countInShopHours: true, workers: 5, hoursPerUnit: hPerUnit,
        });
      } else {
        laborRows.push({
          stage, laborKind: 'STAFF', share: 1, rateType: 'PER_HOUR', rate: RATES.hourlyRate,
          manHours, lineCost: R(manHours * RATES.hourlyRate),
          countInShopHours: true, workers: 3, hoursPerUnit: hPerUnit,
        });
      }
    }
    const laborCost = R(laborRows.reduce((s, l) => s + l.lineCost, 0));
    const contractorCost = R(laborRows.filter((l) => l.laborKind === 'CONTRACTOR').reduce((s, l) => s + l.lineCost, 0));
    const logisticsCost = R(materialCost * RATES.logisticsPct);
    const utilitiesCost = R(materialCost * RATES.utilitiesPct);
    const totalCost = R(materialCost + laborCost + logisticsCost + utilitiesCost);
    const price = priceOf(totalCost);
    const margin = R(price - totalCost);

    return prisma.orderCosting.create({
      data: {
        orderId: opts.orderId,
        orderLineId: opts.orderLineId,
        articleId: opts.articleId,
        qty: opts.qty,
        version: opts.version,
        status: opts.status,
        calculatedAt: opts.calculatedAt ?? today,
        approvedAt: opts.status === 'APPROVED' ? opts.calculatedAt ?? today : null,
        baseCostingId: opts.baseCostingId ?? null,
        hourlyRate: RATES.hourlyRate,
        logisticsPct: RATES.logisticsPct,
        utilitiesPct: RATES.utilitiesPct,
        marginPct: RATES.marginPct,
        marginMode: RATES.marginMode,
        vatPct: RATES.vatPct,
        materialCost, laborCost, contractorCost, logisticsCost, utilitiesCost,
        totalCost, margin, price,
        totalManHours: R(laborRows.reduce((s, l) => s + l.manHours, 0)),
        materials: { create: materialRows },
        labor: { create: laborRows },
      },
    });
  }

  const bomOf = (a: (typeof articles)[number], priceFactor = 1) => a.bomItems.map((b) => ({
    materialId: b.materialId,
    code: b.material.materialCode,
    name: b.material.name,
    qtyPerUnit: Number(b.qtyPerUnit) || 0.5,
    unitPrice: R((Number(b.material.lastPurchasePrice) || Number(b.material.purchasePrice) || 120000) * priceFactor),
  }));

  // ===== Сценарий 2. Принятый заказ: этапы, калькуляция, ДО =====
  const a2 = articles[1];
  const accepted = await prisma.order.create({
    data: {
      orderNumber: 'DEMO-1003',
      customerId: customers[0].id,
      orderType: 'FZ',
      status: 'IN_PRODUCTION',
      managerId: manager?.id,
      onecNum: 'Т7АА-000287',
      onecStatus: 'К выполнению / В резерве',
      acceptedAt: daysAgo(14),
      plannedShipmentDate: daysAhead(12),
      requestDate: daysAgo(20),
      orderLines: { create: [{ articleId: a2.id, qty: 8, unit: 'шт', unitPrice: 0 }] },
      productionStages: {
        create: [
          { stageCode: 'DESIGN', status: 'DONE', completedAt: daysAgo(10) },
          { stageCode: 'SUPPLY', status: 'DONE', completedAt: daysAgo(6) },
          { stageCode: 'PRODUCTION', routingStage: 'CUTTING', status: 'DONE', completedAt: daysAgo(3), actualWorkers: 3, actualHours: 14 },
          { stageCode: 'PRODUCTION', routingStage: 'ASSEMBLY', status: 'IN_PROGRESS', actualWorkers: 6 },
        ],
      },
    },
    include: { orderLines: true },
  });
  const acceptedCosting = await makeCosting({
    orderId: accepted.id, orderLineId: accepted.orderLines[0].id, articleId: a2.id,
    qty: 8, version: 1, status: 'APPROVED', bom: bomOf(a2), calculatedAt: daysAgo(14),
  });
  await prisma.paymentDocument.create({
    data: {
      doNumber: 'DEMO-ДО-4501', doDate: daysAgo(13), contractorId: customers[0].id,
      totalAmount: Number(acceptedCosting.price), paidAmount: R(Number(acceptedCosting.price) * 0.3),
      unpaidAmount: R(Number(acceptedCosting.price) * 0.7), status: 'PARTIALLY_PAID', orderId: accepted.id,
    },
  });

  // ===== Сценарий 3. Подряд: журнал работ + сверка с актом =====
  const a3 = articles[2];
  const withContract = await prisma.order.create({
    data: {
      orderNumber: 'DEMO-1004',
      customerId: customers[1].id,
      orderType: 'FZ',
      status: 'IN_PRODUCTION',
      managerId: manager?.id,
      onecNum: 'Т7АА-000290',
      onecStatus: 'К выполнению / В резерве',
      acceptedAt: daysAgo(21),
      plannedShipmentDate: daysAhead(5),
      requestDate: daysAgo(30),
      orderLines: { create: [{ articleId: a3.id, qty: 20, unit: 'шт', unitPrice: 0 }] },
      productionStages: {
        create: [
          { stageCode: 'DESIGN', status: 'DONE', completedAt: daysAgo(18) },
          { stageCode: 'SUPPLY', status: 'DONE', completedAt: daysAgo(12) },
          { stageCode: 'PRODUCTION', routingStage: 'CUTTING', status: 'DONE', completedAt: daysAgo(8) },
          { stageCode: 'PRODUCTION', routingStage: 'ASSEMBLY', status: 'IN_PROGRESS' },
        ],
      },
    },
    include: { orderLines: true },
  });
  await makeCosting({
    orderId: withContract.id, orderLineId: withContract.orderLines[0].id, articleId: a3.id,
    qty: 20, version: 1, status: 'APPROVED', bom: bomOf(a3),
    laborContractorShare: 0.6, calculatedAt: daysAgo(21),
  });
  // Подряд на сборке: 60 % объёма отдано, остаток делает штат по норме —
  // «штат 40 %» нигде не заведён, он выводится (решение 23.08.2026).
  // Работа принята: 112 ч × 2 500 = 280 000 ₸ заморожены.
  await prisma.contractorWork.create({
    data: {
      orderId: withContract.id, routingStage: 'ASSEMBLY', contractorId: contractor.id,
      share: 0.6, rateType: 'PER_HOUR', rate: 2500, workLocation: 'OUR_SHOP',
      actualQty: 112, actualWorkers: 5, actualAmount: 280_000,
      decidedAt: daysAgo(21), acceptedAt: daysAgo(2),
      reason: 'Своих сварщиков не хватает — двое в отпуске',
    },
  });
  // ДО из 1С («Заказ поставщику» на СМР) — на 20 000 меньше, чем внесено
  // мастером: расхождение видно в сверке. Реальная категория из исторических
  // данных — «Строительно-монтажные работы» (проверено на 4 682 загруженных ДО).
  await prisma.paymentDocument.create({
    data: {
      doNumber: 'DEMO-АСАА-000986', contractorId: contractorAsCustomer.id,
      orderId: withContract.id, doDate: daysAgo(1),
      totalAmount: 260_000, paidAmount: 260_000, unpaidAmount: 0, status: 'PAID',
      category: 'Строительно-монтажные работы',
    },
  });

  // ===== Сценарий 4. Давальческий: металл заказчика + наши метизы =====
  const a4 = articles[3];
  const tolling = await prisma.order.create({
    data: {
      orderNumber: 'DEMO-1005',
      customerId: customers[2].id,
      orderType: 'FZ',
      status: 'CONFIRMED',
      managerId: manager?.id,
      onecNum: 'Т7АА-000295',
      onecStatus: 'К выполнению',
      acceptedAt: daysAgo(7),
      plannedShipmentDate: daysAhead(25),
      requestDate: daysAgo(9),
      orderLines: { create: [{ articleId: a4.id, qty: 10, unit: 'шт', unitPrice: 0 }] },
      productionStages: {
        create: [
          { stageCode: 'DESIGN', status: 'IN_PROGRESS' },
        ],
      },
    },
    include: { orderLines: true },
  });
  const metal4 = metalOf(a4);
  const tollingMovement = await prisma.materialStockMovement.create({
    data: {
      itemId: metal4.materialId, movementType: 'RECEIPT', qty: 6.5, unitPrice: 0,
      movementDate: daysAgo(5), project: 'DEMO',
    },
  });
  const tollingBatch = await prisma.materialBatch.create({
    data: {
      materialId: metal4.materialId, receiptDate: daysAgo(5), unitPrice: 0,
      qtyReceived: 6.5, qtyRemaining: 6.5,
      supplierName: customers[2].name, documentNumber: 'DEMO-ДАВ-14',
      sourceMovementId: tollingMovement.id,
      batchType: 'TOLLING', ownerOrderId: tolling.id,
    },
  });
  const bom4 = bomOf(a4).map((b) =>
    b.materialId === metal4.materialId
      ? { ...b, unitPrice: 0, batchId: tollingBatch.id, priceState: 'ACTUAL' as const }
      : b,
  );
  await makeCosting({
    orderId: tolling.id, orderLineId: tolling.orderLines[0].id, articleId: a4.id,
    qty: 10, version: 1, status: 'APPROVED', bom: bom4, calculatedAt: daysAgo(6),
  });

  // ===== Сценарий 5. Рост цены: две партии, две версии калькуляции =====
  const a5 = articles[4] ?? articles[0];
  const metal5 = metalOf(a5);
  const basePrice = Number(metal5.material.lastPurchasePrice) || Number(metal5.material.purchasePrice) || 420_000;

  const mv1 = await prisma.materialStockMovement.create({
    data: { itemId: metal5.materialId, movementType: 'RECEIPT', qty: 12, unitPrice: basePrice, movementDate: daysAgo(100), project: 'DEMO' },
  });
  const batchOld = await prisma.materialBatch.create({
    data: {
      materialId: metal5.materialId, receiptDate: daysAgo(100), unitPrice: basePrice,
      qtyReceived: 12, qtyRemaining: 3.5, supplierName: 'ТОО «МеталлТрейд»',
      documentNumber: 'DEMO-Т7АА-000151', sourceMovementId: mv1.id,
    },
  });
  const newPrice = R(basePrice * 1.21);
  const mv2 = await prisma.materialStockMovement.create({
    data: { itemId: metal5.materialId, movementType: 'RECEIPT', qty: 15, unitPrice: newPrice, movementDate: daysAgo(12), project: 'DEMO' },
  });
  const batchNew = await prisma.materialBatch.create({
    data: {
      materialId: metal5.materialId, receiptDate: daysAgo(12), unitPrice: newPrice,
      qtyReceived: 15, qtyRemaining: 15, supplierName: 'ТОО «МеталлТрейд»',
      documentNumber: 'DEMO-Т7АА-000209', sourceMovementId: mv2.id,
    },
  });

  const priceRise = await prisma.order.create({
    data: {
      orderNumber: 'DEMO-1006',
      customerId: customers[0].id,
      orderType: 'FZ',
      status: 'CONFIRMED',
      managerId: manager?.id,
      onecNum: 'Т7АА-000280',
      onecStatus: 'К выполнению',
      acceptedAt: daysAgo(95),
      plannedShipmentDate: daysAhead(18),
      requestDate: daysAgo(98),
      orderLines: { create: [{ articleId: a5.id, qty: 15, unit: 'шт', unitPrice: 0 }] },
      productionStages: { create: [{ stageCode: 'DESIGN', status: 'DONE', completedAt: daysAgo(90) }, { stageCode: 'SUPPLY', status: 'IN_PROGRESS' }] },
    },
    include: { orderLines: true },
  });
  const bomOld = bomOf(a5).map((b) =>
    b.materialId === metal5.materialId
      ? { ...b, unitPrice: basePrice, batchId: batchOld.id, priceState: 'ACTUAL' as const }
      : b,
  );
  const v1 = await makeCosting({
    orderId: priceRise.id, orderLineId: priceRise.orderLines[0].id, articleId: a5.id,
    qty: 15, version: 1, status: 'APPROVED', bom: bomOld, calculatedAt: daysAgo(95),
  });
  // Версия 2: старая партия почти выбрана, метал уже по новой цене; часть
  // позиций — «заказано» по заказу поставщику, ещё не пришло
  const bomNew = bomOf(a5).map((b) =>
    b.materialId === metal5.materialId
      ? { ...b, unitPrice: newPrice, batchId: batchNew.id, priceState: 'ORDERED' as const, supplierOrderNumber: 'Т7АА-000209' }
      : b,
  );
  await makeCosting({
    orderId: priceRise.id, orderLineId: priceRise.orderLines[0].id, articleId: a5.id,
    qty: 15, version: 2, status: 'DRAFT', bom: bomNew, calculatedAt: daysAgo(2),
    baseCostingId: v1.id,
  });

  // Резерв старой (дешёвой) партии под этот заказ
  const reservation = await prisma.batchReservation.create({
    data: {
      batchId: batchOld.id, orderId: priceRise.id, qty: 3.5,
      expiresAt: daysAhead(2), // протухает через 2 дня — попадёт в «требует решения»
    },
  });

  // ===== Сценарий 6. Перехват: другой заказ просит чужой резерв =====
  const a6 = articles[5] ?? articles[2];
  const interceptor = await prisma.order.create({
    data: {
      orderNumber: 'DEMO-1007',
      customerId: customers[1].id,
      orderType: 'FZ',
      status: 'CONFIRMED',
      managerId: manager?.id,
      onecNum: 'Т7АА-000299',
      onecStatus: 'К выполнению',
      acceptedAt: daysAgo(3),
      plannedShipmentDate: daysAhead(8),
      overdueDays: 0,
      requestDate: daysAgo(4),
      orderLines: { create: [{ articleId: a6.id, qty: 6, unit: 'шт', unitPrice: 0 }] },
    },
  });
  await prisma.batchOverrideRequest.create({
    data: {
      reservationId: reservation.id,
      requestedByOrderId: interceptor.id,
      qtyRequested: 2.0,
      reason: 'Отгрузка DEMO-1007 через 8 дней, новая партия металла придёт только через 12. Прошу передать 2 т из резерва DEMO-1006 — тот отгружается позже.',
    },
  });

  // ===== Сценарий 7. Заявки на номенклатуру =====
  const anyMaterial = await prisma.material.findFirst({
    where: { name: { contains: 'Уголок', mode: 'insensitive' } },
  });
  await prisma.nomenclatureRequest.create({
    data: {
      proposedName: 'Ферма Ф-24 нестандартная (по чертежу заказчика)',
      description: 'Пролёт 24 м, из заказа DEMO-1002',
      reason: 'В справочнике не нашёл — возможно, называется иначе',
      status: 'WAITING_1C',
      requestedBy: 'demo-seed',
      createdAt: daysAgo(9),
      slaDueAt: daysAgo(2), // просрочена — подсветится в SLA-контроле и у директора
      bitrixTaskId: '4471',
      bitrixTaskCreatedAt: daysAgo(9),
    },
  });
  if (anyMaterial) {
    await prisma.nomenclatureRequest.create({
      data: {
        proposedName: 'уголок 50х50 ст3',
        status: 'SYNCED',
        requestedBy: 'demo-seed',
        createdAt: daysAgo(40),
        syncedAt: daysAgo(37),
        onecCode: '00-00012345',
        onecName: anyMaterial.name,
        linkedMaterialId: anyMaterial.id,
        bitrixTaskId: '4390',
        bitrixTaskCreatedAt: daysAgo(40),
      },
    });
    // Слова заявителя живут вечно как алиас (09 §7.4)
    const exists = await prisma.materialAlias.findFirst({
      where: { materialId: anyMaterial.id, alias: 'уголок 50х50 ст3' },
    });
    if (!exists) {
      await prisma.materialAlias.create({
        data: {
          materialId: anyMaterial.id,
          alias: 'уголок 50х50 ст3',
          normalized: 'уголок 50×50 ст3',
          source: 'REQUEST',
        },
      });
    }
  }

  // ===== Дополнительно: закрытые заказы для воронки и денег =====
  const a7 = articles[6] ?? articles[0];
  const closed = await prisma.order.create({
    data: {
      orderNumber: 'DEMO-0901',
      customerId: customers[2].id,
      orderType: 'FZ',
      status: 'SHIPPED',
      managerId: manager?.id,
      actualShipmentDate: daysAgo(6),
      plannedShipmentDate: daysAgo(8),
      overdueDays: 2,
      requestDate: daysAgo(60),
      orderLines: { create: [{ articleId: a7.id, qty: 5, unit: 'шт', unitPrice: 0 }] },
      productionStages: {
        create: [
          { stageCode: 'DESIGN', status: 'DONE', completedAt: daysAgo(50) },
          { stageCode: 'SUPPLY', status: 'DONE', completedAt: daysAgo(40) },
          { stageCode: 'PRODUCTION', routingStage: 'CUTTING', status: 'DONE', completedAt: daysAgo(20) },
          { stageCode: 'PRODUCTION', routingStage: 'ASSEMBLY', status: 'DONE', completedAt: daysAgo(12) },
          { stageCode: 'PRODUCTION', routingStage: 'PAINTING', status: 'DONE', completedAt: daysAgo(9) },
        ],
      },
    },
  });
  await prisma.paymentDocument.create({
    data: {
      doNumber: 'DEMO-ДО-4488', doDate: daysAgo(55), contractorId: customers[2].id,
      totalAmount: 9_800_000, paidAmount: 9_800_000, unpaidAmount: 0, status: 'PAID', orderId: closed.id,
    },
  });
  await prisma.paymentDocument.create({
    data: {
      doNumber: 'DEMO-ДО-4502', doDate: daysAgo(20), contractorId: customers[1].id,
      totalAmount: 14_200_000, paidAmount: 4_260_000, unpaidAmount: 9_940_000, status: 'PARTIALLY_PAID', orderId: withContract.id,
    },
  });

  // Просроченный заказ — верх ленты «требует решения»
  await prisma.order.update({
    where: { id: withContract.id },
    data: { overdueDays: 0 },
  });
  await prisma.order.update({
    where: { id: accepted.id },
    data: { overdueDays: 0 },
  });

  console.log('— Демо-сценарии готовы —');
  console.log('Инбокс: DEMO-1001 (готов к приёму), DEMO-1002 (блокеры)');
  console.log('Этапы и ДО: DEMO-1003 · Подряд и сверка: DEMO-1004');
  console.log('Давальческий: DEMO-1005 · Рост цены: DEMO-1006 (v1→v2)');
  console.log('Перехват (ждёт директора): DEMO-1007 → резерв DEMO-1006');
  console.log('Заявки: «Ферма Ф-24» в WAITING_1C с просроченным SLA');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
