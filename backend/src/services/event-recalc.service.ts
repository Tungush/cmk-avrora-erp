import {
  calculateSpecPrice,
  cascadeSpecUpdate,
  calculatePriceDeviationPct,
  calculateLeadTimeDays,
  calculateMinStockLevel,
  calculatePurchaseQty,
  calculateBalanceDue,
  calculateDemandFromOrders,
  calculateQtyToProduce,
} from './formulas.service';

export interface OrderLineCreatedEvent {
  orderLineId: string;
  orderId: string;
  articleId: string;
  qty: number;
  unitPrice: number;
  vatRate: number;
  prepayment: number;
  postPayment1: number;
  postPayment2: number;
  penalty: number;
  periodKey: string;
}

export interface StockMovementPostedEvent {
  movementId: string;
  targetType: 'MATERIAL' | 'FINISHED_GOODS';
  itemId: string;
  qtyChange: number; // Signed (+ for receipt, - for expense)
  movementDate: Date;
}

export interface PriceChangedEvent {
  articleId: string;
  newApprovedPrice: number;
  validFrom: Date;
  changedByUserId: string;
}

export interface BomChangedEvent {
  articleId: string;
  bomItems: { materialId: string; qtyPerUnit: number; purchasePrice: number; laborHours: number; operationType: string }[];
}

export class EventRecalculationService {
  /**
   * 1. Handles OrderLineCreated domain event
   */
  static handleOrderLineCreated(event: OrderLineCreatedEvent) {
    // 1. Recalculate balance due
    const balanceResult = calculateBalanceDue({
      qty: event.qty,
      unitPrice: event.unitPrice,
      vatRate: event.vatRate,
      prepayment: event.prepayment,
      postPayment1: event.postPayment1,
      postPayment2: event.postPayment2,
      penalty: event.penalty,
    });

    // 2. Production plan item updates
    const demand = calculateDemandFromOrders([{ qty: event.qty, shippedQty: 0, reservedQty: 0 }]);

    return {
      type: 'OrderLineCreatedRecalculated',
      lineTotalVat: balanceResult.lineTotalVat,
      balanceDue: balanceResult.balanceDue,
      periodKey: event.periodKey,
      additionalDemand: demand,
    };
  }

  /**
   * 2. Handles StockMovementPosted domain event
   */
  static handleStockMovementPosted(
    event: StockMovementPostedEvent,
    currentStock: number,
    minStockContext?: { baseNorm: number; correctionPct: number }
  ) {
    const updatedStock = currentStock + event.qtyChange;

    let minStockResults = null;
    if (event.targetType === 'FINISHED_GOODS' && minStockContext) {
      minStockResults = calculateMinStockLevel({
        baseNorm: minStockContext.baseNorm,
        correctionPct: minStockContext.correctionPct,
        actualQty: updatedStock,
      });
    }

    return {
      type: 'StockMovementPostedRecalculated',
      targetType: event.targetType,
      itemId: event.itemId,
      updatedStockQty: Number(updatedStock.toFixed(3)),
      minStockResults,
    };
  }

  /**
   * 3. Handles PriceChanged domain event
   * Triggers cascade recalculation: spec_price + price_deviation_pct + lead_time_days
   */
  static handlePriceChanged(event: PriceChangedEvent, currentSpecPrice: number) {
    const cascadeResult = cascadeSpecUpdate(
      [], // BOM items not provided; specPrice already assumed current
      event.newApprovedPrice,
      0 // labor hours 0 when only price changes
    );
    const newSpecPrice = cascadeResult.specPrice;
    const newDeviationPct = cascadeResult.priceDeviationPct ?? calculatePriceDeviationPct(event.newApprovedPrice, currentSpecPrice);

    return {
      type: 'PriceChangedRecalculated',
      articleId: event.articleId,
      newApprovedPrice: event.newApprovedPrice,
      newDeviationPct,
      // Note: existing order_lines.unit_price are NOT updated (historical isolation rule)
      affectsExistingOrderLines: false,
    };
  }

  /**
   * 4. Handles BomChanged domain event
   */
  static handleBomChanged(event: BomChangedEvent, currentApprovedPrice: number) {
    // 1. Recalculate spec_price
    const specPrice = calculateSpecPrice(
      event.bomItems.map((b) => ({ qtyPerUnit: b.qtyPerUnit, purchasePrice: b.purchasePrice }))
    );

    // 2. Recalculate price_deviation_pct
    const deviationPct = calculatePriceDeviationPct(currentApprovedPrice, specPrice);

    // 3. Recalculate lead_time_days
    const leadOperationTypes = ['резка', 'сборка/сварка', 'обшивка'];
    const totalLaborHours = event.bomItems
      .filter((b) => leadOperationTypes.includes(b.operationType))
      .reduce((acc, b) => acc + b.laborHours, 0);

    const leadTimeDays = calculateLeadTimeDays(totalLaborHours);

    return {
      type: 'BomChangedRecalculated',
      articleId: event.articleId,
      specPrice,
      priceDeviationPct: deviationPct,
      leadTimeDays,
    };
  }
}
