import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import * as jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../src/common/guards/jwt-auth.guard';
import { PrismaService } from '../src/services/prisma.service';

function generateToken(role: string, userId = `usr-${role}`): string {
  return jwt.sign(
    {
      userId,
      email: `${role}@example.com`,
      roles: [role],
    },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

describe('Stage 3 REST API E2E Lifecycle & RBAC Integration Test', () => {
  let app: INestApplication;

  const tokens = {
    sales: generateToken('sales_manager'),
    planner: generateToken('planner'),
    engineer: generateToken('engineer'),
    foreman: generateToken('shop_foreman'),
    warehouseFg: generateToken('warehouse_fg'),
    accountant: generateToken('accountant'),
    director: generateToken('director'),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => {
    // Самоочистка: тест не должен засорять dev-базу своими сущностями
    const prisma = app.get(PrismaService);
    const e2eCustomers = await prisma.customer.findMany({
      where: { name: { startsWith: 'E2E Customer LLC' } },
      select: { id: true },
    });
    const customerIds = e2eCustomers.map((c) => c.id);
    if (customerIds.length > 0) {
      const orders = await prisma.order.findMany({
        where: { customerId: { in: customerIds } },
        select: { id: true },
      });
      const orderIds = orders.map((o) => o.id);
      await prisma.payment.deleteMany({
        where: { paymentDocument: { contractorId: { in: customerIds } } },
      });
      await prisma.paymentDocument.deleteMany({ where: { contractorId: { in: customerIds } } });
      await prisma.acceptanceAct.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderLine.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.productionStage.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.finishedGoodsMovement.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.outboxMessage.deleteMany({ where: { entityId: { in: orderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    }
    await prisma.article.deleteMany({ where: { articleCode: { startsWith: 'A-E2E-' } } });
    await app.close();
  });

  it('Full E2E Scenario: Customer -> Order -> Production -> Shipment -> Payment -> Close with RBAC checks', async () => {
    // Код уникален на каждый прогон: тест должен проходить и на заполненной БД
    const runId = Date.now().toString(36).toUpperCase();

    // 1. Engineer creates Article
    const artRes = await request(app.getHttpServer())
      .post('/api/v1/articles')
      .set('Authorization', `Bearer ${tokens.engineer}`)
      .send({
        articleCode: `A-E2E-${runId}`,
        name: 'E2E Test Container',
        weightKg: 150,
        approvedPrice: 50000,
      })
      .expect(201);

    const articleId = artRes.body.id;

    // Спецификация изделия: без состава и норм цех не имеет права отметить
    // изготовление (правило 26.08.2026) — тестовое изделие должно быть
    // заведено так же, как настоящее
    const prismaSetup = app.get(PrismaService);
    const testMaterial = await prismaSetup.material.create({
      data: {
        materialCode: `M-E2E-${runId}`.slice(0, 20),
        category: 'METAL' as any,
        name: 'E2E Test Steel',
        unit: 'кг',
        purchasePrice: 500,
      },
    });
    await prismaSetup.bomItem.create({
      data: {
        articleId, materialId: testMaterial.id,
        qtyPerUnit: 10, operationType: 'CUTTING' as any,
      },
    });
    await prismaSetup.routingOperation.create({
      data: { articleId, stage: 'CUTTING' as any, workers: 2, hoursPerUnit: 1.5 },
    });

    // 2. Sales Manager creates Customer
    const custRes = await request(app.getHttpServer())
      .post('/api/v1/customers')
      .set('Authorization', `Bearer ${tokens.sales}`)
      .send({
        name: `E2E Customer LLC ${runId}`,
        binIin: Date.now().toString().padStart(12, '0').slice(-12),
        region: 'Almaty',
      })
      .expect(201);

    const customerId = custRes.body.id;

    // 3. Заказ появляется в базе. Эндпоинта создания больше нет намеренно
    //    (решение 23.08.2026): заказ рождается сделкой Б24 → документом 1С →
    //    синхронизацией к нам. Тест про жизненный цикл, а не про заведение,
    //    поэтому кладём заказ напрямую — так же, как это сделает синхронизация.
    const prismaDirect = app.get(PrismaService);
    const createdOrder = await prismaDirect.order.create({
      data: {
        orderNumber: `П-E2E-${runId}`,
        customerId,
        orderType: 'FZ',
        status: 'DRAFT',
        orderLines: { create: [{ articleId, qty: 5, reservedQty: 5, unit: 'шт' }] },
      },
      include: { orderLines: true },
    });

    const orderId = createdOrder.id;
    const lineId = createdOrder.orderLines[0].id;
    expect(createdOrder.status).toBe('DRAFT');

    // RBAC Check 1: Shop Foreman tries to transition status -> MUST BE REJECTED 403
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${tokens.foreman}`)
      .send({ toStatus: 'CONFIRMED' })
      .expect(403);

    // 4. Sales Manager confirms order -> Status: CONFIRMED
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${tokens.sales}`)
      .send({ toStatus: 'CONFIRMED' })
      .expect(200);

    // 5. Мастер начинает работу над изделием. Видов работ цех больше не
    //    отмечает (26.08.2026) — отметка адресуется позиции заказа
    await request(app.getHttpServer())
      .patch(`/api/v1/orders/${orderId}/production-stages/PRODUCTION`)
      .set('Authorization', `Bearer ${tokens.foreman}`)
      .send({ status: 'in_progress', orderLineId: lineId })
      .expect(200);

    // 6. Статус в «в производстве» никто не двигает: заказ занял его сам,
    //    когда мастер отметил «начал» (решение 23.08.2026). Повторный ручной
    //    перевод отклоняется — статус уже тот же.
    const afterStart = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${tokens.planner}`)
      .expect(200);
    expect(afterStart.body.status).toBe('IN_PRODUCTION');

    // 7. Мастер отмечает изделие изготовленным. В заказе одна позиция —
    //    её и достаточно, чтобы заказ был готов
    await request(app.getHttpServer())
      .patch(`/api/v1/orders/${orderId}/production-stages/PRODUCTION`)
      .set('Authorization', `Bearer ${tokens.foreman}`)
      .send({ status: 'done', orderLineId: lineId })
      .expect(200);

    // Изделие без состава и норм отметить нельзя: списывать нечего,
    // себестоимость встала бы в ноль (правило 26.08.2026)
    const bare = await prismaSetup.article.create({
      data: { articleCode: `A-BARE-${runId}`.slice(0, 20), name: 'E2E без спецификации' },
    });
    const bareLine = await prismaSetup.orderLine.create({
      data: { orderId, articleId: bare.id, qty: 1, unit: 'шт' },
    });
    const specRes = await request(app.getHttpServer())
      .patch(`/api/v1/orders/${orderId}/production-stages/PRODUCTION`)
      .set('Authorization', `Bearer ${tokens.foreman}`)
      .send({ status: 'done', orderLineId: bareLine.id })
      .expect(400);
    expect(specRes.body.error.code).toBe('SPEC_REQUIRED');
    // Начать работу по нему можно — запрет только на закрывающую отметку,
    // иначе цех запирается сам и снять ошибочную отметку нечем
    await request(app.getHttpServer())
      .patch(`/api/v1/orders/${orderId}/production-stages/PRODUCTION`)
      .set('Authorization', `Bearer ${tokens.foreman}`)
      .send({ status: 'in_progress', orderLineId: bareLine.id })
      .expect(200);
    await prismaSetup.productionStage.deleteMany({ where: { orderLineId: bareLine.id } });
    await prismaSetup.orderLine.delete({ where: { id: bareLine.id } });
    await prismaSetup.article.delete({ where: { id: bare.id } });
    // Позиция без спецификации уводила заказ из «готов к отгрузке», пока
    // висела в нём: повторяем отметку, чтобы статус пересчитался по факту
    await request(app.getHttpServer())
      .patch(`/api/v1/orders/${orderId}/production-stages/PRODUCTION`)
      .set('Authorization', `Bearer ${tokens.foreman}`)
      .send({ status: 'done', orderLineId: lineId })
      .expect(200);

    // Отметка без позиции и старая веха «Закуп» — отклоняются: без изделия
    // непонятно, что именно изготовлено
    await request(app.getHttpServer())
      .patch(`/api/v1/orders/${orderId}/production-stages/PRODUCTION`)
      .set('Authorization', `Bearer ${tokens.foreman}`)
      .send({ status: 'done' })
      .expect(400);
    await request(app.getHttpServer())
      .patch(`/api/v1/orders/${orderId}/production-stages/SUPPLY`)
      .set('Authorization', `Bearer ${tokens.foreman}`)
      .send({ status: 'done', orderLineId: lineId })
      .expect(400);

    // 8. «Готов к отгрузке» проставился сам — все изделия заказа изготовлены.
    //    Складу больше не нужно повторять работу мастера вручную.
    const afterStages = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${tokens.warehouseFg}`)
      .expect(200);
    expect(afterStages.body.status).toBe('READY_TO_SHIP');

    // 9. Warehouse FG posts finished goods movement and transitions order to SHIPPED
    await request(app.getHttpServer())
      .post('/api/v1/warehouse/finished-goods/movements')
      .set('Authorization', `Bearer ${tokens.warehouseFg}`)
      .send({
        articleId,
        orderId,
        movementType: 'отгрузка',
        qty: 5,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${tokens.warehouseFg}`)
      .send({ toStatus: 'SHIPPED' })
      .expect(200);

    // 10. Accountant posts Payment Document, full Payment, and Acceptance Act
    const pdRes = await request(app.getHttpServer())
      .post('/api/v1/payment-documents')
      .set('Authorization', `Bearer ${tokens.accountant}`)
      .send({
        doNumber: `DO-E2E-${runId}`,
        contractorId: customerId,
        orderId,
        totalAmount: 280000,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/v1/payment-documents/${pdRes.body.id}/payments`)
      .set('Authorization', `Bearer ${tokens.accountant}`)
      .send({ amount: 280000 })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/acceptance-acts')
      .set('Authorization', `Bearer ${tokens.sales}`)
      .send({
        appNumber: `APP-E2E-${runId}`,
        orderId,
        customerId,
        totalAmount: 280000,
      })
      .expect(201);

    // 11. Accountant transitions order to CLOSED
    const closedRes = await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${tokens.accountant}`)
      .send({ toStatus: 'CLOSED' })
      .expect(200);

    expect(closedRes.body.order.status).toBe('CLOSED');

    // 12. Director queries Audit Log
    const auditRes = await request(app.getHttpServer())
      .get('/api/v1/audit-log')
      .set('Authorization', `Bearer ${tokens.director}`)
      .expect(200);

    expect(auditRes.body.data.length).toBeGreaterThan(0);
  });
});
