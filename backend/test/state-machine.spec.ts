import { OrderStatus } from '@prisma/client';
import {
  OrderStateMachine, OrderStateContext, deriveStatusFromStages,
} from '../src/services/order-state-machine.service';
import { BusinessGuardError } from '../src/services/guards.service';

describe('Order State Machine Unit Tests', () => {
  const baseContext: OrderStateContext = {
    orderId: 'ord-uuid-100',
    currentStatus: OrderStatus.DRAFT,
    lines: [{ qty: 10, reservedQty: 10, articleCode: 'ART-001' }],
    customerBinIin: '123456789012',
    productionStages: [
      { stageCode: 'PRODUCTION', routingStage: 'CUTTING', status: 'in_progress' },
      { stageCode: 'PRODUCTION', routingStage: 'PAINTING', status: 'not_started' },
    ],
    finishedGoodsShipped: true,
    balanceDue: 0,
    hasAcceptanceAct: true,
  };

  it('Happy Path: DRAFT -> CONFIRMED', () => {
    const audit = OrderStateMachine.transition(baseContext, {
      targetStatus: OrderStatus.CONFIRMED,
      userId: 'usr-1',
      userRole: 'sales_manager',
    });

    expect(audit.before.status).toBe(OrderStatus.DRAFT);
    expect(audit.after.status).toBe(OrderStatus.CONFIRMED);
    expect(audit.entityType).toBe('Order');
  });

  it('DRAFT -> CONFIRMED fail if customer BIN is missing', () => {
    const invalidCtx = { ...baseContext, customerBinIin: null };
    expect(() =>
      OrderStateMachine.transition(invalidCtx, {
        targetStatus: OrderStatus.CONFIRMED,
        userId: 'usr-1',
        userRole: 'sales_manager',
      })
    ).toThrow('customer BIN/IIN is required');
  });

  it('Happy Path: CONFIRMED -> IN_PRODUCTION', () => {
    const ctx = { ...baseContext, currentStatus: OrderStatus.CONFIRMED };
    const audit = OrderStateMachine.transition(ctx, {
      targetStatus: OrderStatus.IN_PRODUCTION,
      userId: 'usr-2',
      userRole: 'planner',
    });
    expect(audit.after.status).toBe(OrderStatus.IN_PRODUCTION);
  });

  it('Happy Path: IN_PRODUCTION -> READY_TO_SHIP when all stages are done', () => {
    const doneStages = [
      { stageCode: 'DESIGN', routingStage: null, status: 'done' },
      { stageCode: 'SUPPLY', routingStage: null, status: 'done' },
      { stageCode: 'PRODUCTION', routingStage: 'CUTTING', status: 'done' },
      { stageCode: 'PRODUCTION', routingStage: 'ASSEMBLY', status: 'done' },
      { stageCode: 'PRODUCTION', routingStage: 'PAINTING', status: 'done' },
    ];
    const ctx = { ...baseContext, currentStatus: OrderStatus.IN_PRODUCTION, productionStages: doneStages };
    const audit = OrderStateMachine.transition(ctx, {
      targetStatus: OrderStatus.READY_TO_SHIP,
      userId: 'usr-3',
      userRole: 'shop_foreman',
    });
    expect(audit.after.status).toBe(OrderStatus.READY_TO_SHIP);
  });

  it('IN_PRODUCTION -> READY_TO_SHIP fail if stages are unfinished', () => {
    const ctx = { ...baseContext, currentStatus: OrderStatus.IN_PRODUCTION };
    expect(() =>
      OrderStateMachine.transition(ctx, {
        targetStatus: OrderStatus.READY_TO_SHIP,
        userId: 'usr-3',
        userRole: 'shop_foreman',
      })
    ).toThrow(/закрыто \d+ из 5 этапов/);
  });

  // Режим LINE: шаг закрыт, только когда отмечены ВСЕ позиции заказа.
  // Иначе одна отмеченная позиция из трёх закрывала шаг целиком.
  it('в режиме LINE одна отмеченная позиция не закрывает шаг', () => {
    const allFiveButOneLine = [
      { stageCode: 'DESIGN', routingStage: null, orderLineId: 'l1', status: 'done' },
      { stageCode: 'SUPPLY', routingStage: null, orderLineId: 'l1', status: 'done' },
      { stageCode: 'PRODUCTION', routingStage: 'CUTTING', orderLineId: 'l1', status: 'done' },
      { stageCode: 'PRODUCTION', routingStage: 'ASSEMBLY', orderLineId: 'l1', status: 'done' },
      { stageCode: 'PRODUCTION', routingStage: 'PAINTING', orderLineId: 'l1', status: 'done' },
    ];
    // Одна позиция из трёх — заказ не готов
    expect(deriveStatusFromStages(OrderStatus.IN_PRODUCTION, allFiveButOneLine, 3)).toBeNull();
    // Тот же набор при единственной позиции — готов
    expect(deriveStatusFromStages(OrderStatus.IN_PRODUCTION, allFiveButOneLine, 1))
      .toBe(OrderStatus.READY_TO_SHIP);
  });

  it('вывод статуса не трогает отгруженный и закрытый заказ', () => {
    const done = [
      { stageCode: 'DESIGN', routingStage: null, status: 'done' },
      { stageCode: 'SUPPLY', routingStage: null, status: 'done' },
      { stageCode: 'PRODUCTION', routingStage: 'CUTTING', status: 'done' },
      { stageCode: 'PRODUCTION', routingStage: 'ASSEMBLY', status: 'done' },
      { stageCode: 'PRODUCTION', routingStage: 'PAINTING', status: 'done' },
    ];
    expect(deriveStatusFromStages(OrderStatus.SHIPPED, done)).toBeNull();
    expect(deriveStatusFromStages(OrderStatus.CLOSED, done)).toBeNull();
    expect(deriveStatusFromStages(OrderStatus.NEW, done)).toBeNull();
  });

  // Строки этапов создаются лениво: раньше `every(done)` по одной отметке
  // «резка готова» пропускал заказ вперёд, минуя сборку и покраску
  it('одна отметка «готово» не считается «все этапы закрыты»', () => {
    const ctx = {
      ...baseContext,
      currentStatus: OrderStatus.IN_PRODUCTION,
      productionStages: [{ stageCode: 'PRODUCTION', routingStage: 'CUTTING', status: 'done' }],
    };
    expect(() =>
      OrderStateMachine.transition(ctx, {
        targetStatus: OrderStatus.READY_TO_SHIP,
        userId: 'usr-3',
        userRole: 'shop_foreman',
      })
    ).toThrow(/закрыто 1 из 5 этапов/);
  });

  it('Happy Path: READY_TO_SHIP -> SHIPPED', () => {
    const ctx = { ...baseContext, currentStatus: OrderStatus.READY_TO_SHIP };
    const audit = OrderStateMachine.transition(ctx, {
      targetStatus: OrderStatus.SHIPPED,
      userId: 'usr-4',
      userRole: 'warehouse_fg',
    });
    expect(audit.after.status).toBe(OrderStatus.SHIPPED);
  });

  it('READY_TO_SHIP -> SHIPPED fail if reservation incomplete', () => {
    const incompleteResCtx = {
      ...baseContext,
      currentStatus: OrderStatus.READY_TO_SHIP,
      lines: [{ qty: 10, reservedQty: 4, articleCode: 'ART-001' }],
    };
    expect(() =>
      OrderStateMachine.transition(incompleteResCtx, {
        targetStatus: OrderStatus.SHIPPED,
        userId: 'usr-4',
        userRole: 'warehouse_fg',
      })
    ).toThrow('INSUFFICIENT_RESERVED_QTY');
  });

  it('Happy Path: SHIPPED -> CLOSED', () => {
    const ctx = { ...baseContext, currentStatus: OrderStatus.SHIPPED };
    const audit = OrderStateMachine.transition(ctx, {
      targetStatus: OrderStatus.CLOSED,
      userId: 'usr-5',
      userRole: 'accountant',
    });
    expect(audit.after.status).toBe(OrderStatus.CLOSED);
  });

  it('SHIPPED -> CLOSED fail if balanceDue > 0', () => {
    const unpaidCtx = { ...baseContext, currentStatus: OrderStatus.SHIPPED, balanceDue: 1500 };
    expect(() =>
      OrderStateMachine.transition(unpaidCtx, {
        targetStatus: OrderStatus.CLOSED,
        userId: 'usr-5',
        userRole: 'accountant',
      })
    ).toThrow('balance due is 1500');
  });

  it('Any Status -> CANCELLED: requires manager role + mandatory comment', () => {
    const ctx = { ...baseContext, currentStatus: OrderStatus.IN_PRODUCTION };

    // Fail without comment
    expect(() =>
      OrderStateMachine.transition(ctx, {
        targetStatus: OrderStatus.CANCELLED,
        userId: 'usr-1',
        userRole: 'sales_manager',
      })
    ).toThrow('mandatory non-empty comment');

    // Fail with unauthorized role
    expect(() =>
      OrderStateMachine.transition(ctx, {
        targetStatus: OrderStatus.CANCELLED,
        userId: 'usr-1',
        userRole: 'shop_foreman',
        comment: 'Client requested cancellation',
      })
    ).toThrow('is not authorized to cancel');

    // Success with valid role and comment
    const audit = OrderStateMachine.transition(ctx, {
      targetStatus: OrderStatus.CANCELLED,
      userId: 'usr-1',
      userRole: 'sales_manager',
      comment: 'Customer cancelled project contract',
    });
    expect(audit.after.status).toBe(OrderStatus.CANCELLED);
    expect(audit.comment).toBe('Customer cancelled project contract');
  });
});
