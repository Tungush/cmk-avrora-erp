import {
  EventRecalculationService,
  OrderLineCreatedEvent,
  StockMovementPostedEvent,
  PriceChangedEvent,
  BomChangedEvent,
} from '../src/services/event-recalc.service';

describe('Event Recalculation Service Unit Tests', () => {
  it('should handle OrderLineCreated event and calculate line VAT & balance due', () => {
    const event: OrderLineCreatedEvent = {
      orderLineId: 'line-1',
      orderId: 'ord-1',
      articleId: 'art-1',
      qty: 10,
      unitPrice: 1000,
      vatRate: 0.12,
      prepayment: 2000,
      postPayment1: 1000,
      postPayment2: 0,
      penalty: 0,
      periodKey: '2026-W33',
    };

    const res = EventRecalculationService.handleOrderLineCreated(event);
    expect(res.type).toBe('OrderLineCreatedRecalculated');
    expect(res.lineTotalVat).toBe(11200); // 10 * 1000 * 1.12
    expect(res.balanceDue).toBe(8200);   // 11200 - 3000
    expect(res.periodKey).toBe('2026-W33');
  });

  it('should handle StockMovementPosted event and update stock & min stock deficit', () => {
    const event: StockMovementPostedEvent = {
      movementId: 'mov-1',
      targetType: 'FINISHED_GOODS',
      itemId: 'art-10',
      qtyChange: 25, // Receipt of 25 units
      movementDate: new Date('2026-08-11'),
    };

    const currentStock = 50;
    const minStockContext = { baseNorm: 100, correctionPct: 0 };

    const res = EventRecalculationService.handleStockMovementPosted(event, currentStock, minStockContext);
    expect(res.updatedStockQty).toBe(75);
    expect(res.minStockResults?.readinessPct).toBe(0.75); // 75 / 100
    expect(res.minStockResults?.deficitQty).toBe(25);      // 100 - 75
  });

  it('should handle PriceChanged event and recalculate price deviation pct without altering existing lines', () => {
    const event: PriceChangedEvent = {
      articleId: 'art-1',
      newApprovedPrice: 1200,
      validFrom: new Date('2026-08-11'),
      changedByUserId: 'usr-admin',
    };

    const currentSpecPrice = 1000;
    const res = EventRecalculationService.handlePriceChanged(event, currentSpecPrice);

    expect(res.newApprovedPrice).toBe(1200);
    expect(res.newDeviationPct).toBe(0.20); // (1200 / 1000) - 1 = +20%
    expect(res.affectsExistingOrderLines).toBe(false);
  });

  it('should handle BomChanged event and update spec_price, deviation, and lead_time_days', () => {
    const event: BomChangedEvent = {
      articleId: 'art-1',
      bomItems: [
        { materialId: 'mat-1', qtyPerUnit: 2, purchasePrice: 200, laborHours: 4, operationType: 'резка' },
        { materialId: 'mat-2', qtyPerUnit: 5, purchasePrice: 50, laborHours: 12, operationType: 'сборка/сварка' },
      ],
    };

    const currentApprovedPrice = 750;
    const res = EventRecalculationService.handleBomChanged(event, currentApprovedPrice);

    expect(res.specPrice).toBe(650); // (2*200) + (5*50) = 400 + 250 = 650
    expect(res.priceDeviationPct).toBe(0.1538); // (750 / 650) - 1 = +15.38%
    expect(res.leadTimeDays).toBe(2); // (4 + 12) / 8 = 16 / 8 = 2 days
  });
});
