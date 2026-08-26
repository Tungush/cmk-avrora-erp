import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import * as jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../src/common/guards/jwt-auth.guard';
import { PrismaService } from '../src/services/prisma.service';

function generateToken(role: string, userId = `usr-${role}`): string {
  return jwt.sign(
    { userId, email: `${role}@example.com`, roles: [role] },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

/**
 * Заявка на подряд → разнесение по заказам → акт (26.08.2026).
 *
 * Тест идёт против ЖИВОЙ базы, как api-e2e.spec.ts: заказы кладём напрямую
 * через Prisma (эндпоинта создания заказа нет намеренно — заказ рождается
 * сделкой Б24 → документом 1С → синхронизацией), всё остальное — по HTTP.
 *
 * Главный инвариант, ради которого тест написан: сумма акта, разложенная по
 * заказам, сходится с актом КОПЕЙКА В КОПЕЙКУ. Если 1 200 000 ₸ на заказы
 * 4 т и 8 т дадут 1 199 999,99 — расхождение с 1С будет вечным.
 */
describe('Заявки на подряд: разнесение по заказам и деление суммы акта', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const tokens = {
    planner: generateToken('planner'),
    foreman: generateToken('shop_foreman'),
    procurement: generateToken('procurement'),
  };

  // Уникальный суффикс прогона: тест обязан проходить на заполненной базе
  const runId = Date.now().toString(36).toUpperCase();

  // Всё созданное тестом — чтобы за собой подчистить и не тронуть чужое
  const own = {
    articleIds: [] as string[],
    customerIds: [] as string[],
    orderIds: [] as string[],
    contractorIds: [] as string[],
    requestIds: [] as string[],
  };

  const state = {
    orderA: '', orderB: '', lineA: '', lineB: '',
    contractorId: '',
    reqId: '', reqNumber: '',
    reqNoContractorId: '',
    reqRivalId: '',
    workA: '', workB: '',
  };

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    prisma = app.get(PrismaService);

    const article = await prisma.article.create({
      data: {
        articleCode: `A-PDR-${runId}`,
        name: 'Балка под покраску (e2e подряд)',
        weightKg: 800,
        approvedPrice: 1_000_000,
      },
    });
    own.articleIds.push(article.id);

    // Два ЗАКАЗЧИКА и два ЗАКАЗА по одной позиции: партия подряда должна
    // разойтись именно между разными заказами разных клиентов
    const bin = Date.now().toString().slice(-10);
    for (const [i, suffix] of [[0, 'A'], [1, 'B']] as const) {
      const customer = await prisma.customer.create({
        data: {
          name: `E2E Подряд Заказчик ${suffix} ${runId}`,
          binIin: `${bin}${i}9`.slice(-12),
          region: 'Almaty',
        },
      });
      own.customerIds.push(customer.id);

      const order = await prisma.order.create({
        data: {
          orderNumber: `П-PDR-${runId}-${suffix}`,
          customerId: customer.id,
          orderType: 'FZ',
          status: 'CONFIRMED',
          orderLines: { create: [{ articleId: article.id, qty: 2, reservedQty: 2, unit: 'шт' }] },
        },
        include: { orderLines: true },
      });
      own.orderIds.push(order.id);
      if (suffix === 'A') { state.orderA = order.id; state.lineA = order.orderLines[0].id; }
      else { state.orderB = order.id; state.lineB = order.orderLines[0].id; }
    }
  });

  afterAll(async () => {
    // Самоочистка: только то, что завёл тест. Порядок — от строк к справочникам
    if (own.requestIds.length) {
      await prisma.contractorWork.deleteMany({ where: { requestId: { in: own.requestIds } } });
    }
    if (own.orderIds.length) {
      await prisma.contractorWork.deleteMany({ where: { orderId: { in: own.orderIds } } });
    }
    if (own.requestIds.length) {
      await prisma.contractorRequest.deleteMany({ where: { id: { in: own.requestIds } } });
    }
    if (own.orderIds.length) {
      await prisma.orderLine.deleteMany({ where: { orderId: { in: own.orderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: own.orderIds } } });
    }
    if (own.customerIds.length) {
      await prisma.customer.deleteMany({ where: { id: { in: own.customerIds } } });
    }
    if (own.contractorIds.length) {
      await prisma.contractor.deleteMany({ where: { id: { in: own.contractorIds } } });
    }
    if (own.articleIds.length) {
      await prisma.article.deleteMany({ where: { id: { in: own.articleIds } } });
    }
    await app.close();
  });

  it('1. Подрядчика можно завести из системы: POST /contractors', async () => {
    const res = await http()
      .post('/api/v1/contractors')
      .set('Authorization', `Bearer ${tokens.procurement}`)
      .send({
        name: `ТОО Подряд e2e ${runId}`,
        binIin: `77${Date.now().toString().slice(-10)}`,
        defaultRateType: 'PER_TON',
        defaultRate: 100000,
        defaultWorkLocation: 'CONTRACTOR_SITE',
      })
      .expect(201);

    expect(res.body.id).toBeTruthy();
    state.contractorId = res.body.id;
    own.contractorIds.push(res.body.id);

    const list = await http()
      .get('/api/v1/contractors')
      .set('Authorization', `Bearer ${tokens.planner}`)
      .expect(200);
    expect(list.body.some((c: any) => c.id === state.contractorId)).toBe(true);
  });

  it('2. Заявка на подряд заводится партией и получает номер ПОДР-NNN', async () => {
    const res = await http()
      .post('/api/v1/contractor-requests')
      .set('Authorization', `Bearer ${tokens.planner}`)
      .send({
        routingStage: 'PAINTING',
        description: `Увезли красить балки (e2e ${runId})`,
        rateType: 'PER_TON',
        plannedQty: 12,
        rate: 100000,
        contractorId: state.contractorId,
        workLocation: 'CONTRACTOR_SITE',
      })
      .expect(201);

    state.reqId = res.body.id;
    state.reqNumber = res.body.number;
    own.requestIds.push(res.body.id);

    expect(state.reqNumber).toMatch(/^ПОДР-\d{3,}$/);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.routingStage).toBe('PAINTING');
    expect(Number(res.body.plannedQty)).toBe(12);
    expect(Number(res.body.rate)).toBe(100000);
    expect(res.body.workLocation).toBe('CONTRACTOR_SITE');

    // Заявка видна в списке, и партия пока не разнесена ни на один заказ
    const card = await http()
      .get(`/api/v1/contractor-requests/${state.reqId}`)
      .set('Authorization', `Bearer ${tokens.planner}`)
      .expect(200);
    expect(card.body.stageLabel).toBe('Зачистка / покраска');
    expect(card.body.unit).toBe('т');
    expect(card.body.works).toEqual([]);
    expect(card.body.unallocatedQty).toBe(12);
  });

  it('3. Разнесение на первый заказ создаёт строку подряда (3,2 т)', async () => {
    const res = await http()
      .post(`/api/v1/contractor-requests/${state.reqId}/allocate`)
      .set('Authorization', `Bearer ${tokens.foreman}`)
      .send({ orderId: state.orderA, qty: 3.2 })
      .expect(201); // Nest отдаёт 201 на POST: @HttpCode(200) здесь не стоит

    expect(res.body.workId).toBeTruthy();
    expect(res.body.orderNumber).toBe(`П-PDR-${runId}-A`);
    expect(res.body.qty).toBe(3.2);
    expect(res.body.unit).toBe('т');
    expect(res.body.stageLabel).toBe('Зачистка / покраска');
    expect(res.body.remainingQty).toBe(8.8); // 12 плановых − 3,2
    state.workA = res.body.workId;

    // Деньги входят в себестоимость СУЩЕСТВУЮЩИМ путём: обычная строка
    // ContractorWork, привязанная к заявке
    const works = await prisma.contractorWork.findMany({ where: { requestId: state.reqId } });
    expect(works).toHaveLength(1);
    expect(works[0].id).toBe(state.workA);
    expect(works[0].orderId).toBe(state.orderA);
    expect(works[0].requestId).toBe(state.reqId);
    expect(Number(works[0].actualQty)).toBe(3.2);
    expect(Number(works[0].rate)).toBe(100000);
    expect(works[0].rateType).toBe('PER_TON');
    expect(works[0].routingStage).toBe('PAINTING');
    expect(Number(works[0].share)).toBe(1);
    expect(works[0].contractorId).toBe(state.contractorId);
    expect(works[0].workLocation).toBe('CONTRACTOR_SITE');
    expect(works[0].acceptedAt).toBeNull();
  });

  it('4. Повтор по той же паре «заявка + заказ» ОБНОВЛЯЕТ строку, а не плодит вторую', async () => {
    const res = await http()
      .post(`/api/v1/contractor-requests/${state.reqId}/allocate`)
      .set('Authorization', `Bearer ${tokens.foreman}`)
      .send({ orderId: state.orderA, qty: 4 })
      .expect(201);

    expect(res.body.workId).toBe(state.workA); // та же строка
    expect(res.body.qty).toBe(4);

    const works = await prisma.contractorWork.findMany({ where: { requestId: state.reqId } });
    expect(works).toHaveLength(1);
    expect(Number(works[0].actualQty)).toBe(4);

    // И на самом заказе строка ровно одна: двойного счёта подряда нет
    const onOrder = await prisma.contractorWork.findMany({ where: { orderId: state.orderA } });
    expect(onOrder).toHaveLength(1);
  });

  it('5. Разнесение на второй заказ (8 т): партия разошлась на два заказа', async () => {
    const res = await http()
      .post(`/api/v1/contractor-requests/${state.reqId}/allocate`)
      .set('Authorization', `Bearer ${tokens.foreman}`)
      .send({ orderId: state.orderB, qty: 8 })
      .expect(201);

    state.workB = res.body.workId;
    expect(res.body.orderNumber).toBe(`П-PDR-${runId}-B`);
    expect(res.body.remainingQty).toBe(0); // 12 плановых = 4 + 8

    const works = await prisma.contractorWork.findMany({ where: { requestId: state.reqId } });
    expect(works).toHaveLength(2);
    expect(works.map((w) => Number(w.actualQty)).sort((a, b) => a - b)).toEqual([4, 8]);

    const card = await http()
      .get(`/api/v1/contractor-requests/${state.reqId}`)
      .set('Authorization', `Bearer ${tokens.planner}`)
      .expect(200);
    expect(card.body.ordersCount).toBe(2);
    expect(card.body.allocatedQty).toBe(12);
  });

  it('6. ГЛАВНЫЙ ИНВАРИАНТ: сумма акта делится по заказам копейка в копейку', async () => {
    const res = await http()
      .post(`/api/v1/contractor-requests/${state.reqId}/accept`)
      .set('Authorization', `Bearer ${tokens.planner}`)
      .send({ actualQty: 12, actualAmount: 1_200_000 })
      .expect(201);

    expect(res.body.accepted).toBe(true);
    expect(res.body.actualAmount).toBe(1_200_000);
    expect(res.body.allocatedRows).toBe(2);
    expect(res.body.unallocatedQty).toBe(0);

    // Ответ показывает арифметику вслух: 4 т → 400 000, 8 т → 800 000
    const split = [...res.body.split].sort((a: any, b: any) => a.qty - b.qty);
    expect(split).toEqual([
      { orderNumber: `П-PDR-${runId}-A`, qty: 4, amount: 400_000 },
      { orderNumber: `П-PDR-${runId}-B`, qty: 8, amount: 800_000 },
    ]);

    // И то же самое — в базе, откуда деньги возьмёт калькуляция
    const works = await prisma.contractorWork.findMany({ where: { requestId: state.reqId } });
    const byOrder = new Map(works.map((w) => [w.orderId, w]));
    expect(Number(byOrder.get(state.orderA)!.actualAmount)).toBe(400_000);
    expect(Number(byOrder.get(state.orderB)!.actualAmount)).toBe(800_000);

    // Схождение считаем в копейках: 1 199 999,99 здесь — вечное расхождение с 1С
    const kopecks = works.reduce((s, w) => s + Math.round(Number(w.actualAmount) * 100), 0);
    expect(kopecks).toBe(120_000_000);

    // Приёмка заморозила деньги на строках
    expect(works.every((w) => w.acceptedAt != null)).toBe(true);

    const card = await http()
      .get(`/api/v1/contractor-requests/${state.reqId}`)
      .set('Authorization', `Bearer ${tokens.planner}`)
      .expect(200);
    expect(card.body.status).toBe('ALLOCATED');
    expect(card.body.allocatedAmount).toBe(1_200_000);
    expect(card.body.needsAllocation).toBe(false);
  });

  it('7a. Разнесение без объёма отклоняется: QTY_REQUIRED', async () => {
    const res = await http()
      .post(`/api/v1/contractor-requests/${state.reqId}/allocate`)
      .set('Authorization', `Bearer ${tokens.foreman}`)
      .send({ orderId: state.orderA })
      .expect(400);
    expect(res.body.error.code).toBe('QTY_REQUIRED');
  });

  it('7b. Разнести больше принятого нельзя: QTY_OVERFLOW', async () => {
    // Принято 12 т, на второй заказ уже ушло 8 — на первый свободно 4
    const res = await http()
      .post(`/api/v1/contractor-requests/${state.reqId}/allocate`)
      .set('Authorization', `Bearer ${tokens.foreman}`)
      .send({ orderId: state.orderA, qty: 4.5 })
      .expect(400);
    expect(res.body.error.code).toBe('QTY_OVERFLOW');

    // Отказ ничего не сдвинул: на заказе по-прежнему 4 т и 400 000 ₸
    const workA = await prisma.contractorWork.findUnique({ where: { id: state.workA } });
    expect(Number(workA!.actualQty)).toBe(4);
    expect(Number(workA!.actualAmount)).toBe(400_000);
  });

  it('7c. Отменить разнесённую заявку нельзя: HAS_ALLOCATIONS', async () => {
    const res = await http()
      .post(`/api/v1/contractor-requests/${state.reqId}/cancel`)
      .set('Authorization', `Bearer ${tokens.planner}`)
      .expect(409);
    expect(res.body.error.code).toBe('HAS_ALLOCATIONS');

    const req = await prisma.contractorRequest.findUnique({ where: { id: state.reqId } });
    expect(req!.status).not.toBe('CANCELLED');
  });

  it('7d. Разнесение заявки без подрядчика отклоняется: CONTRACTOR_REQUIRED', async () => {
    const created = await http()
      .post('/api/v1/contractor-requests')
      .set('Authorization', `Bearer ${tokens.planner}`)
      .send({
        routingStage: 'CUTTING',
        description: `Резка без подрядчика (e2e ${runId})`,
        rateType: 'PER_TON',
        plannedQty: 5,
        rate: 50000,
      })
      .expect(201);
    state.reqNoContractorId = created.body.id;
    own.requestIds.push(created.body.id);
    expect(created.body.contractorId).toBeNull();

    const res = await http()
      .post(`/api/v1/contractor-requests/${state.reqNoContractorId}/allocate`)
      .set('Authorization', `Bearer ${tokens.foreman}`)
      .send({ orderId: state.orderA, qty: 1 })
      .expect(400);
    expect(res.body.error.code).toBe('CONTRACTOR_REQUIRED');

    // Отказ не оставил после себя строку в 0 ₸
    const works = await prisma.contractorWork.findMany({
      where: { requestId: state.reqNoContractorId },
    });
    expect(works).toHaveLength(0);
  });

  it('8. Больше 100 % одного вида работ по заказу отдать нельзя: SHARE_OVERFLOW', async () => {
    const created = await http()
      .post('/api/v1/contractor-requests')
      .set('Authorization', `Bearer ${tokens.planner}`)
      .send({
        routingStage: 'PAINTING', // тот же вид работ, что и у первой заявки
        description: `Вторая покраска на тот же заказ (e2e ${runId})`,
        rateType: 'PER_TON',
        plannedQty: 2,
        rate: 90000,
        contractorId: state.contractorId,
      })
      .expect(201);
    state.reqRivalId = created.body.id;
    own.requestIds.push(created.body.id);

    // Покраска заказа A уже отдана целиком первой заявкой
    const res = await http()
      .post(`/api/v1/contractor-requests/${state.reqRivalId}/allocate`)
      .set('Authorization', `Bearer ${tokens.foreman}`)
      .send({ orderId: state.orderA, qty: 2, share: 1 })
      .expect(400);
    expect(res.body.error.code).toBe('SHARE_OVERFLOW');

    // Ни строки: 200 % покраски одного заказа в базу не попало
    const onOrder = await prisma.contractorWork.findMany({
      where: { orderId: state.orderA, routingStage: 'PAINTING' },
    });
    expect(onOrder).toHaveLength(1);
    expect(onOrder[0].requestId).toBe(state.reqId);
  });

  it('9. Снятие разнесения: строка исчезает, суммы пересчитываются и снова сходятся с актом', async () => {
    const res = await http()
      .delete(`/api/v1/contractor-requests/${state.reqId}/allocations/${state.workA}`)
      .set('Authorization', `Bearer ${tokens.foreman}`)
      .expect(200);
    expect(res.body.deleted).toBe(true);
    expect(res.body.recalculatedRows).toBe(1);

    const gone = await prisma.contractorWork.findUnique({ where: { id: state.workA } });
    expect(gone).toBeNull();

    const works = await prisma.contractorWork.findMany({ where: { requestId: state.reqId } });
    expect(works).toHaveLength(1);
    expect(works[0].orderId).toBe(state.orderB);

    // После снятия разнесено 8 т из принятых 12 — оставшийся заказ несёт
    // ТОЛЬКО свои 8/12 акта. Раньше на него садились все 1 200 000 ₸, то
    // есть заказ платил за 4 т, которые к нему не приезжали
    const kopecks = works.reduce((s, w) => s + Math.round(Number(w.actualAmount) * 100), 0);
    expect(kopecks).toBe(80_000_000);

    // И эти 400 000 ₸ обязаны быть видны как висящие, а не раствориться
    const summary = await http()
      .get('/api/v1/contractor-requests')
      .set('Authorization', `Bearer ${tokens.foreman}`)
      .expect(200);
    const row = summary.body.data.find((r: any) => r.id === state.reqId);
    expect(row.unallocatedQty).toBeCloseTo(4, 3);
    expect(row.unallocatedAmount).toBeCloseTo(400_000, 2);
    expect(row.needsAllocation).toBe(true);

    // Чужую строку через эту заявку не снять
    const alien = await http()
      .delete(`/api/v1/contractor-requests/${state.reqRivalId}/allocations/${state.workB}`)
      .set('Authorization', `Bearer ${tokens.foreman}`)
      .expect(404);
    expect(alien.body.error.code).toBe('NOT_FOUND');
  });

  /**
   * Регресс на дефекты состязательной проверки 26.08.2026. Каждый из них
   * ставил в себестоимость заказа неверное число, поэтому проверяем число.
   */
  it('10. Разовый подряд виден проверке долей: 200 % одного вида работ в базу не попадает', async () => {
    // Заказ, которого ещё не касались заявки
    const customer = await prisma.customer.create({
      data: { name: `Заказчик разовый ${runId}`, binIin: `${Date.now()}`.slice(-12) },
    });
    own.customerIds.push(customer.id);
    const order = await prisma.order.create({
      data: {
        orderNumber: `П-ADHOC-${runId}`,
        customerId: customer.id,
        orderType: 'FZ',
        status: 'CONFIRMED',
        orderLines: { create: [{ articleId: own.articleIds[0], qty: 3, unit: 'т' }] },
      },
    });
    own.orderIds.push(order.id);

    // Разовый подряд забрал сборку целиком — строка без requestId
    await http()
      .post(`/api/v1/orders/${order.id}/stages/ASSEMBLY/contractor`)
      .set('Authorization', `Bearer ${tokens.planner}`)
      .send({
        contractorId: state.contractorId, share: 1,
        rateType: 'PER_TON', rate: 50_000, workLocation: 'CONTRACTOR_SITE',
      })
      .expect(201);

    // Заявка на ту же сборку того же заказа
    const req2 = await http()
      .post('/api/v1/contractor-requests')
      .set('Authorization', `Bearer ${tokens.planner}`)
      .send({
        routingStage: 'ASSEMBLY', description: `Сборка поверх разового ${runId}`,
        rateType: 'PER_TON', plannedQty: 3, rate: 50_000, contractorId: state.contractorId,
      })
      .expect(201);
    own.requestIds.push(req2.body.id);

    // Prisma-условие NOT: { requestId } выбрасывало строки с request_id IS NULL,
    // и 100 % + 100 % проходило — калькуляция заказа после этого падала
    // INVALID_SHARES и позицию нельзя было пересчитать вообще
    const res = await http()
      .post(`/api/v1/contractor-requests/${req2.body.id}/allocate`)
      .set('Authorization', `Bearer ${tokens.foreman}`)
      .send({ orderId: order.id, qty: 3 })
      .expect(400);
    expect(res.body.error.code).toBe('SHARE_OVERFLOW');

    const rows = await prisma.contractorWork.findMany({
      where: { orderId: order.id, routingStage: 'ASSEMBLY' },
    });
    expect(rows).toHaveLength(1);
    const totalShare = rows.reduce((sum, w) => sum + Number(w.share), 0);
    expect(totalShare).toBeLessThanOrEqual(1);
  });

  it('11. Строку из заявки нельзя принять и удалить мимо заявки', async () => {
    const work = await prisma.contractorWork.findFirst({
      where: { requestId: state.reqId },
    });
    expect(work).not.toBeNull();

    // Приёмка строки отдельно порвала бы «Σ строк = сумма акта» без сигнала
    const acc = await http()
      .patch(`/api/v1/contractor-work/${work!.id}/accept`)
      .set('Authorization', `Bearer ${tokens.foreman}`)
      .send({ actualQty: 99 })
      .expect(400);
    expect(acc.body.error.code).toBe('BELONGS_TO_REQUEST');

    // Удаление мимо заявки оставило бы её суммы неперераспределёнными
    const del = await http()
      .delete(`/api/v1/contractor-work/${work!.id}`)
      .set('Authorization', `Bearer ${tokens.foreman}`)
      .expect(400);
    expect(del.body.error.code).toBe('BELONGS_TO_REQUEST');

    const still = await prisma.contractorWork.findUnique({ where: { id: work!.id } });
    expect(still).not.toBeNull();
    expect(Number(still!.actualQty)).not.toBe(99);
  });
});
