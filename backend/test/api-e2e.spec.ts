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

    // 3. Sales Manager creates Order (Status: DRAFT)
    const orderRes = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${tokens.sales}`)
      .send({
        customerId,
        orderType: 'ФЗ',
        lines: [
          {
            articleId,
            qty: 5,
            reservedQty: 5,
          },
        ],
      })
      .expect(201);

    const orderId = orderRes.body.id;
    expect(orderRes.body.status).toBe('DRAFT');

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

    // 5. Shop Foreman updates a production stage to in_progress
    await request(app.getHttpServer())
      .patch(`/api/v1/orders/${orderId}/production-stages/CUTTING`)
      .set('Authorization', `Bearer ${tokens.foreman}`)
      .send({ status: 'in_progress' })
      .expect(200);

    // 6. Planner transitions order to IN_PRODUCTION
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${tokens.planner}`)
      .send({ toStatus: 'IN_PRODUCTION' })
      .expect(200);

    // 7. Shop Foreman completes all production stages to done
    const stageCodes = ['OS_WITH_CUSTOMER', 'GENERAL_VIEW', 'DRAWINGS', 'PROCUREMENT', 'CUTTING', 'WELDING_ASSEMBLY', 'PAINTING', 'CLADDING'];
    for (const code of stageCodes) {
      await request(app.getHttpServer())
        .patch(`/api/v1/orders/${orderId}/production-stages/${code}`)
        .set('Authorization', `Bearer ${tokens.foreman}`)
        .send({ status: 'done' })
        .expect(200);
    }

    // 8. Warehouse FG transitions order to READY_TO_SHIP (per 04_ROLES_PERMISSIONS.md)
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${tokens.warehouseFg}`)
      .send({ toStatus: 'READY_TO_SHIP' })
      .expect(200);

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
