import { PrismaClient, OrderStatus, OrderType, MaterialCategory, OperationType, StockMovementType, CustomerType } from '@prisma/client';
import * as bcrypt from 'bcrypt';

export async function seedDemoData(prisma: PrismaClient) {
  console.log('Seeding realistic demo data...');

  // 1. Create a demo user for each role if not exists
  const roles = await prisma.role.findMany();
  for (const role of roles) {
    const email = `${role.code}@avh.kz`;
    const passwordHash = await bcrypt.hash('Test@2025!', 10);
    
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          passwordHash,
        },
      });
      await prisma.userRole.create({
        data: {
          userId: user.id,
          roleId: role.id,
        },
      });
    }
  }

  // 2. Customers
  const customer = await prisma.customer.upsert({
    where: { binIin: '123456789012' },
    update: {},
    create: {
      binIin: '123456789012',
      name: 'ТОО "Телеком KZ"',
      customerType: CustomerType.OUTSIDE,
    },
  });

  // 3. Materials
  const mat1 = await prisma.material.upsert({
    where: { materialCode: 'MAT-001' },
    update: {},
    create: {
      materialCode: 'MAT-001',
      name: 'Сталь листовая 2мм ст3',
      category: MaterialCategory.METAL,
      unit: 'т',
      purchasePrice: 450000,
      stockQty: 10,
    }
  });

  const mat2 = await prisma.material.upsert({
    where: { materialCode: 'MAT-002' },
    update: {},
    create: {
      materialCode: 'MAT-002',
      name: 'Труба профильная 40х40х2',
      category: MaterialCategory.METAL,
      unit: 'т',
      purchasePrice: 380000,
      stockQty: 5,
    }
  });

  const mat3 = await prisma.material.upsert({
    where: { materialCode: 'MAT-003' },
    update: {},
    create: {
      materialCode: 'MAT-003',
      name: 'Краска порошковая RAL 7035',
      category: MaterialCategory.CONSUMABLES,
      unit: 'кг',
      purchasePrice: 2500,
      stockQty: 100,
    }
  });

  // 4. Articles (Готовая продукция)
  const art1 = await prisma.article.upsert({
    where: { articleCode: 'BS-001' },
    update: {},
    create: {
      articleCode: 'BS-001',
      name: 'Базовая станция "Калина-М"',
      legacyCode: 'БС-Калина',
      approvedPrice: 1200000,
      leadTimeDays: 14,
    }
  });

  const art2 = await prisma.article.upsert({
    where: { articleCode: 'RM-001' },
    update: {},
    create: {
      articleCode: 'RM-001',
      name: 'Шкаф телекоммуникационный 42U',
      legacyCode: 'ШТ-42',
      approvedPrice: 150000,
      leadTimeDays: 5,
    }
  });

  // BOM — только демо-артикулов: реальные составы из импорта не трогаем
  await prisma.bomItem.deleteMany({ where: { articleId: { in: [art1.id, art2.id] } } });
  await prisma.bomItem.createMany({
    data: [
      { articleId: art1.id, materialId: mat1.id, qtyPerUnit: 0.5, operationType: OperationType.CUTTING },
      { articleId: art1.id, materialId: mat2.id, qtyPerUnit: 0.2, operationType: OperationType.WELDING_ASSEMBLY },
      { articleId: art1.id, materialId: mat3.id, qtyPerUnit: 15, operationType: OperationType.PAINTING },
      { articleId: art2.id, materialId: mat1.id, qtyPerUnit: 0.1, operationType: OperationType.CUTTING },
      { articleId: art2.id, materialId: mat3.id, qtyPerUnit: 2, operationType: OperationType.PAINTING },
    ]
  });

  // 5. Orders
  const order1 = await prisma.order.upsert({
    where: { orderNumber: 'ORD-2026-001' },
    update: {},
    create: {
      orderNumber: 'ORD-2026-001',
      customerId: customer.id,
      orderType: OrderType.FZ,
      status: OrderStatus.IN_PRODUCTION,
      createdAt: new Date(),
      orderLines: {
        create: [
          { articleId: art1.id, qty: 2, unit: 'шт', unitPrice: 1200000, lineTotalVat: 2400000 },
          { articleId: art2.id, qty: 1, unit: 'шт', unitPrice: 150000, lineTotalVat: 150000 },
        ]
      }
    }
  });

  // 6. Production Stages — только демо-заказа
  await prisma.productionStage.deleteMany({ where: { orderId: order1.id } });
  await prisma.productionStage.createMany({
    data: [
      { orderId: order1.id, stageCode: 'DRAWINGS', status: 'DONE' },
      { orderId: order1.id, stageCode: 'CUTTING', status: 'IN_PROGRESS' },
      { orderId: order1.id, stageCode: 'WELDING_ASSEMBLY', status: 'NOT_STARTED' },
    ]
  });

  // 7. Warehouse Movements — только демо-материалов
  await prisma.materialStockMovement.deleteMany({ where: { itemId: { in: [mat1.id, mat2.id, mat3.id] } } });
  await prisma.materialStockMovement.createMany({
    data: [
      { itemId: mat1.id, movementType: StockMovementType.RECEIPT, qty: 10, unitPrice: 450000, movementDate: new Date() },
      { itemId: mat2.id, movementType: StockMovementType.RECEIPT, qty: 5, unitPrice: 380000, movementDate: new Date() },
      { itemId: mat3.id, movementType: StockMovementType.RECEIPT, qty: 100, unitPrice: 2500, movementDate: new Date() },
    ]
  });

  await prisma.finishedGoodsMovement.deleteMany({ where: { itemId: art2.id, orderId: null } });
  await prisma.finishedGoodsMovement.create({
    data: { itemId: art2.id, movementType: StockMovementType.RECEIPT, qty: 10, movementDate: new Date() }
  });

  console.log('Demo data seeded successfully!');
}
